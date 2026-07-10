//! FIPS Rust ↔ TypeScript interop bridge.
//!
//! Runs one side of a Noise/FSP exchange using the Rust FIPS implementation,
//! exchanging framed bytes over stdin/stdout with the TS test on the other
//! side. If the handshake and a transport-message round-trip succeed, interop
//! is proven for secp256k1 ECDH (SHA-256 of x-coord), Noise IK/XK over
//! secp256k1+ChaChaPoly+SHA256, and the AEAD/KDF chain.
//!
//! Frame format: 4-byte big-endian length, then payload bytes.

use std::env;
use std::io::{self, Read, Write};
use std::process;

use fips_core::TreeCoordinate;
use fips_core::bloom::BloomFilter;
use fips_core::noise::HandshakeState;
use fips_core::protocol::{FilterAnnounce, LookupRequest, LookupResponse};
use fips_identity::{Identity, PeerIdentity};
use secp256k1::{PublicKey, SecretKey};

mod fsp_initiator;

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
    let sk_bytes =
        hex::decode(static_sk_hex).map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk =
        SecretKey::from_slice(&sk_bytes).map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
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
    let sk_bytes =
        hex::decode(static_sk_hex).map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk =
        SecretKey::from_slice(&sk_bytes).map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
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

fn le_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ])
}

fn build_fmp_msg2(sender_idx: u32, receiver_idx: u32, noise_msg2: &[u8]) -> Vec<u8> {
    let payload_len = (4 + 4 + noise_msg2.len()) as u16;
    let mut packet = Vec::with_capacity(4 + payload_len as usize);
    packet.push(0x02);
    packet.push(0x00);
    packet.extend_from_slice(&payload_len.to_le_bytes());
    packet.extend_from_slice(&sender_idx.to_le_bytes());
    packet.extend_from_slice(&receiver_idx.to_le_bytes());
    packet.extend_from_slice(noise_msg2);
    packet
}

fn build_fmp_established(
    receiver_idx: u32,
    counter: u64,
    flags: u8,
    inner_plaintext: &[u8],
    ciphertext: &[u8],
) -> Vec<u8> {
    let payload_len = inner_plaintext.len() as u16;
    let mut packet = Vec::with_capacity(16 + ciphertext.len());
    packet.push(0x00);
    packet.push(flags);
    packet.extend_from_slice(&payload_len.to_le_bytes());
    packet.extend_from_slice(&receiver_idx.to_le_bytes());
    packet.extend_from_slice(&counter.to_le_bytes());
    packet.extend_from_slice(ciphertext);
    packet
}

/// `fmp <responder-sk-hex>`: run Rust as an FMP responder.
///
/// The TypeScript side sends a full FMP Msg1 wire packet, then one encrypted
/// established packet. The bridge replies with a full Msg2 packet, echoes the
/// decrypted inner plaintext for inspection, then sends one encrypted Rust
/// established packet back.
fn run_fmp(static_sk_hex: &str) -> io::Result<()> {
    let sk_bytes =
        hex::decode(static_sk_hex).map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk =
        SecretKey::from_slice(&sk_bytes).map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
    let identity = Identity::from_secret_key(sk);
    let kp = identity.keypair();
    let pubkey = kp.public_key();

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    write_frame(&mut stdout, &pubkey.serialize())?;

    let msg1 = read_frame(&mut stdin)?;
    if msg1.len() != 114 {
        return Err(io::Error::other(format!(
            "expected FMP msg1 of 114 bytes, got {}",
            msg1.len(),
        )));
    }
    if msg1[0] != 0x01 || msg1[1] != 0x00 {
        return Err(io::Error::other(format!(
            "bad FMP msg1 prefix {:02x} {:02x}",
            msg1[0], msg1[1],
        )));
    }
    let payload_len = u16::from_le_bytes([msg1[2], msg1[3]]);
    if payload_len != 110 {
        return Err(io::Error::other(format!(
            "bad FMP msg1 payload_len {payload_len}",
        )));
    }
    let receiver_idx = le_u32(&msg1[4..8]);
    let noise_msg1 = &msg1[8..];

    let mut hs = HandshakeState::new_responder(kp);
    hs.set_local_epoch([0u8; 8]);
    hs.read_message_1(noise_msg1)
        .map_err(|e| io::Error::other(format!("fmp read_message_1: {e:?}")))?;
    let noise_msg2 = hs
        .write_message_2()
        .map_err(|e| io::Error::other(format!("fmp write_message_2: {e:?}")))?;
    let rust_sender_idx = 0x1122_3344u32;
    write_frame(
        &mut stdout,
        &build_fmp_msg2(rust_sender_idx, receiver_idx, &noise_msg2),
    )?;

    let mut session = hs
        .into_session()
        .map_err(|e| io::Error::other(format!("fmp into_session: {e:?}")))?;

    let encrypted = read_frame(&mut stdin)?;
    if encrypted.len() < 32 || encrypted[0] != 0x00 {
        return Err(io::Error::other(format!(
            "expected FMP established frame, got {} bytes",
            encrypted.len(),
        )));
    }
    let counter = le_u64(&encrypted[8..16]);
    let aad = &encrypted[..16];
    let ciphertext = &encrypted[16..];
    let plaintext = session
        .decrypt_with_replay_check_and_aad(ciphertext, counter, aad)
        .map_err(|e| io::Error::other(format!("fmp decrypt: {e:?}")))?;
    write_frame(&mut stdout, &plaintext)?;

    let rust_inner = {
        let payload = b"pong-from-rust-fmp";
        let mut out = Vec::with_capacity(5 + payload.len());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.push(0x00);
        out.extend_from_slice(payload);
        out
    };
    let rust_counter = session.current_send_counter();
    let mut header = Vec::with_capacity(16);
    header.push(0x00);
    header.push(0x00);
    header.extend_from_slice(&(rust_inner.len() as u16).to_le_bytes());
    header.extend_from_slice(&receiver_idx.to_le_bytes());
    header.extend_from_slice(&rust_counter.to_le_bytes());
    let ciphertext = session
        .encrypt_with_aad(&rust_inner, &header)
        .map_err(|e| io::Error::other(format!("fmp encrypt: {e:?}")))?;
    write_frame(
        &mut stdout,
        &build_fmp_established(receiver_idx, rust_counter, 0, &rust_inner, &ciphertext),
    )?;
    Ok(())
}

/// `bloom <numBits> <hashCount> <hex-key>...`: build a BloomFilter with the
/// given parameters, insert each key, and print the resulting bytes as hex
/// on a single stdout line (no framing).
fn run_bloom(args: &[String]) -> io::Result<()> {
    if args.len() < 2 {
        return Err(io::Error::other(
            "usage: bloom <numBits> <hashCount> [key-hex ...]",
        ));
    }
    let num_bits: usize = args[0]
        .parse()
        .map_err(|e| io::Error::other(format!("bad numBits: {e}")))?;
    let hash_count: u8 = args[1]
        .parse()
        .map_err(|e| io::Error::other(format!("bad hashCount: {e}")))?;
    let mut f = BloomFilter::with_params(num_bits, hash_count)
        .map_err(|e| io::Error::other(format!("bloom init: {e:?}")))?;
    for key in &args[2..] {
        let bytes = hex::decode(key).map_err(|e| io::Error::other(format!("bad key hex: {e}")))?;
        f.insert_bytes(&bytes);
    }
    println!("{}", hex::encode(f.as_bytes()));
    Ok(())
}

/// `filter-announce <sequence> [key-hex ...]`: build a v1 FilterAnnounce
/// (8192-bit / 5-hash filter, sequence as u64) and print the full encoded
/// wire bytes as hex on stdout.
fn run_filter_announce(args: &[String]) -> io::Result<()> {
    if args.is_empty() {
        return Err(io::Error::other(
            "usage: filter-announce <sequence> [key-hex ...]",
        ));
    }
    let sequence: u64 = args[0]
        .parse()
        .map_err(|e| io::Error::other(format!("bad sequence: {e}")))?;
    let mut f = BloomFilter::new();
    for key in &args[1..] {
        let bytes = hex::decode(key).map_err(|e| io::Error::other(format!("bad key hex: {e}")))?;
        f.insert_bytes(&bytes);
    }
    let fa = FilterAnnounce::new(f, sequence);
    let encoded = fa
        .encode()
        .map_err(|e| io::Error::other(format!("encode: {e:?}")))?;
    println!("{}", hex::encode(&encoded));
    Ok(())
}

/// `lookup-self <origin-sk-hex>`: emit a Rust-encoded self-targeted lookup
/// request, then verify the TypeScript node's response using Rust codecs and
/// BIP-340 verification.
fn run_lookup_self(origin_sk_hex: &str) -> io::Result<()> {
    let sk_bytes =
        hex::decode(origin_sk_hex).map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk =
        SecretKey::from_slice(&sk_bytes).map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
    let origin = Identity::from_secret_key(sk);
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    let target_public_key = PublicKey::from_slice(&read_frame(&mut stdin)?)
        .map_err(|e| io::Error::other(format!("bad target public key: {e}")))?;
    let target = PeerIdentity::from_pubkey_full(target_public_key);
    let request = LookupRequest::new(
        0x0102_0304_0506_0708,
        *target.node_addr(),
        *origin.node_addr(),
        TreeCoordinate::root(*origin.node_addr()),
        63,
        0,
    );
    let encoded = request.encode();
    write_frame(&mut stdout, &encoded[1..])?;

    let response_payload = read_frame(&mut stdin)?;
    let response = LookupResponse::decode(&response_payload)
        .map_err(|e| io::Error::other(format!("decode LookupResponse: {e}")))?;
    if response.request_id != request.request_id || response.target != request.target {
        return Err(io::Error::other("LookupResponse does not match request"));
    }
    if response.path_mtu != 1200 {
        return Err(io::Error::other(format!(
            "expected path MTU 1200, got {}",
            response.path_mtu,
        )));
    }
    if response
        .target_coords
        .node_addrs()
        .copied()
        .collect::<Vec<_>>()
        != vec![request.target]
    {
        return Err(io::Error::other(
            "LookupResponse did not contain root target coordinates",
        ));
    }
    let proof_data = LookupResponse::proof_bytes(
        response.request_id,
        &response.target,
        &response.target_coords,
    );
    if !target.verify(&proof_data, &response.proof) {
        return Err(io::Error::other("LookupResponse proof verification failed"));
    }
    write_frame(&mut stdout, b"verified")?;
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: fips-rust-bridge <ik|xk|fmp> <responder-sk-hex>");
        eprintln!("       fips-rust-bridge fsp-initiator <initiator-sk-hex>");
        eprintln!("       fips-rust-bridge fsp-session-initiator <initiator-sk-hex>");
        eprintln!("       fips-rust-bridge lookup-self <origin-sk-hex>");
        eprintln!("       fips-rust-bridge bloom <numBits> <hashCount> [key-hex ...]");
        process::exit(2);
    }
    let mode = args[1].as_str();
    let res = match mode {
        "ik" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge ik <responder-sk-hex>");
                process::exit(2);
            }
            run_ik(&args[2])
        }
        "xk" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge xk <responder-sk-hex>");
                process::exit(2);
            }
            run_xk(&args[2])
        }
        "fmp" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge fmp <responder-sk-hex>");
                process::exit(2);
            }
            run_fmp(&args[2])
        }
        "fsp-initiator" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge fsp-initiator <initiator-sk-hex>");
                process::exit(2);
            }
            fsp_initiator::run(&args[2])
        }
        "fsp-session-initiator" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge fsp-session-initiator <initiator-sk-hex>");
                process::exit(2);
            }
            fsp_initiator::run_session(&args[2])
        }
        "lookup-self" => {
            if args.len() != 3 {
                eprintln!("usage: fips-rust-bridge lookup-self <origin-sk-hex>");
                process::exit(2);
            }
            run_lookup_self(&args[2])
        }
        "bloom" => run_bloom(&args[2..]),
        "filter-announce" => run_filter_announce(&args[2..]),
        _ => {
            eprintln!(
                "unknown mode {mode}; want 'ik' | 'xk' | 'fmp' | 'fsp-initiator' | 'fsp-session-initiator' | 'lookup-self' | 'bloom' | 'filter-announce'"
            );
            process::exit(2);
        }
    };
    if let Err(e) = res {
        eprintln!("bridge error: {e}");
        process::exit(1);
    }
}
