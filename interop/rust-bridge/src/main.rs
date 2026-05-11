//! FIPS Rust ↔ TypeScript interop bridge.
//!
//! Runs a Noise IK or XK responder using the Rust FIPS implementation,
//! exchanging framed bytes over stdin/stdout with the TS test on the other
//! side. If the handshake and a transport-message round-trip succeed,
//! interop is proven for: secp256k1 ECDH (SHA-256 of x-coord),
//! Noise IK/XK over secp256k1+ChaChaPoly+SHA256, and the AEAD/KDF chain.
//!
//! Frame format: 4-byte big-endian length, then payload bytes.

use std::env;
use std::io::{self, Read, Write};
use std::process;

use fips_core::noise::HandshakeState;
use fips_identity::Identity;
use secp256k1::SecretKey;

fn read_frame<R: Read>(r: &mut R) -> io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_frame<W: Write>(w: &mut W, data: &[u8]) -> io::Result<()> {
    let len = (data.len() as u32).to_be_bytes();
    w.write_all(&len)?;
    w.write_all(data)?;
    w.flush()
}

fn run_ik(static_sk_hex: &str) -> io::Result<()> {
    let sk_bytes = hex::decode(static_sk_hex)
        .map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk = SecretKey::from_slice(&sk_bytes)
        .map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
    let identity = Identity::from_secret_key(sk);
    let kp = identity.keypair();
    let pubkey = kp.public_key();

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    // 1. Announce our static pubkey (33-byte compressed) so the peer can
    //    target us in IK.
    write_frame(&mut stdout, &pubkey.serialize())?;

    // 2. IK responder. Set a fixed epoch so the test is deterministic.
    let mut hs = HandshakeState::new_responder(kp);
    hs.set_local_epoch([0u8; 8]);
    let msg1 = read_frame(&mut stdin)?;
    if msg1.len() != 106 {
        return Err(io::Error::other(format!(
            "expected IK msg1 of 106 bytes, got {}",
            msg1.len(),
        )));
    }
    hs.read_message_1(&msg1)
        .map_err(|e| io::Error::other(format!("read_message_1: {e:?}")))?;
    let msg2 = hs
        .write_message_2()
        .map_err(|e| io::Error::other(format!("write_message_2: {e:?}")))?;
    write_frame(&mut stdout, &msg2)?;

    let mut session = hs
        .into_session()
        .map_err(|e| io::Error::other(format!("into_session: {e:?}")))?;

    // 3. Transport: read one frame, decrypt, write a reply.
    let ct = read_frame(&mut stdin)?;
    let pt = session
        .decrypt(&ct)
        .map_err(|e| io::Error::other(format!("decrypt: {e:?}")))?;
    if pt != b"ping-from-ts" {
        return Err(io::Error::other(format!(
            "unexpected transport plaintext: {:?}",
            String::from_utf8_lossy(&pt),
        )));
    }
    let reply = session
        .encrypt(b"pong-from-rust")
        .map_err(|e| io::Error::other(format!("encrypt: {e:?}")))?;
    write_frame(&mut stdout, &reply)?;
    Ok(())
}

fn run_xk(static_sk_hex: &str) -> io::Result<()> {
    let sk_bytes = hex::decode(static_sk_hex)
        .map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk = SecretKey::from_slice(&sk_bytes)
        .map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
    let identity = Identity::from_secret_key(sk);
    let kp = identity.keypair();
    let pubkey = kp.public_key();

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    write_frame(&mut stdout, &pubkey.serialize())?;

    let mut hs = HandshakeState::new_xk_responder(kp);
    hs.set_local_epoch([0u8; 8]);

    let msg1 = read_frame(&mut stdin)?;
    if msg1.len() != 33 {
        return Err(io::Error::other(format!(
            "expected XK msg1 of 33 bytes, got {}",
            msg1.len(),
        )));
    }
    hs.read_xk_message_1(&msg1)
        .map_err(|e| io::Error::other(format!("read_xk_message_1: {e:?}")))?;

    let msg2 = hs
        .write_xk_message_2()
        .map_err(|e| io::Error::other(format!("write_xk_message_2: {e:?}")))?;
    write_frame(&mut stdout, &msg2)?;

    let msg3 = read_frame(&mut stdin)?;
    if msg3.len() != 73 {
        return Err(io::Error::other(format!(
            "expected XK msg3 of 73 bytes, got {}",
            msg3.len(),
        )));
    }
    hs.read_xk_message_3(&msg3)
        .map_err(|e| io::Error::other(format!("read_xk_message_3: {e:?}")))?;

    let mut session = hs
        .into_session()
        .map_err(|e| io::Error::other(format!("into_session: {e:?}")))?;

    let ct = read_frame(&mut stdin)?;
    let pt = session
        .decrypt(&ct)
        .map_err(|e| io::Error::other(format!("decrypt: {e:?}")))?;
    if pt != b"ping-from-ts" {
        return Err(io::Error::other(format!(
            "unexpected XK plaintext: {:?}",
            String::from_utf8_lossy(&pt),
        )));
    }
    let reply = session
        .encrypt(b"pong-from-rust")
        .map_err(|e| io::Error::other(format!("encrypt: {e:?}")))?;
    write_frame(&mut stdout, &reply)?;
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: fips-rust-bridge <ik|xk> <responder-sk-hex>");
        process::exit(2);
    }
    let mode = args[1].as_str();
    let sk = args[2].as_str();
    let res = match mode {
        "ik" => run_ik(sk),
        "xk" => run_xk(sk),
        _ => {
            eprintln!("unknown mode {mode}; want 'ik' or 'xk'");
            process::exit(2);
        }
    };
    if let Err(e) = res {
        eprintln!("bridge error: {e}");
        process::exit(1);
    }
}
