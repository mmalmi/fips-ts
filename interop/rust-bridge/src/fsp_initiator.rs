use std::io::{self, Read};

use fips_core::noise::{HandshakeState, NoiseSession};
use fips_core::protocol::SessionMsg3;
use fips_core::{SessionAck, SessionSetup, TreeCoordinate};
use fips_identity::{Identity, PeerIdentity};
use secp256k1::{PublicKey, SecretKey};

use super::{le_u32, le_u64, read_frame, write_frame};

const FSP_PHASE_ESTABLISHED: u8 = 0x00;
const FSP_PHASE_MSG1: u8 = 0x01;
const FSP_PHASE_MSG2: u8 = 0x02;
const FSP_PHASE_MSG3: u8 = 0x03;
const FSP_FLAG_DIRECT_TRANSPORT: u8 = 0x08;
const FSP_MSG_DATA: u8 = 0x10;
const FSP_HEADER_LEN: usize = 12;
const FSP_INNER_HEADER_LEN: usize = 6;
const FSP_DATA_HEADER_LEN: usize = 4;
const AEAD_TAG_LEN: usize = 16;
const DFP1_HEADER_LEN: usize = 20;
const DFP1_MAX_REASSEMBLED_LEN: usize = 72 * 1024;
const DFP1_MAX_FRAGMENTS: usize = 128;
const RUST_SERVICE_BODY_LEN: usize = 16 * 1024;
const MAX_FSP_SERVICE_BODY_LEN: usize =
    u16::MAX as usize - FSP_INNER_HEADER_LEN - FSP_DATA_HEADER_LEN;

fn le_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn build_fsp_handshake(phase: u8, noise_msg: &[u8]) -> io::Result<Vec<u8>> {
    let payload_len = u16::try_from(noise_msg.len())
        .map_err(|_| io::Error::other("FSP handshake payload too large"))?;
    let mut packet = Vec::with_capacity(4 + noise_msg.len());
    packet.push(phase);
    packet.push(0);
    packet.extend_from_slice(&payload_len.to_le_bytes());
    packet.extend_from_slice(noise_msg);
    Ok(packet)
}

fn parse_fsp_handshake(
    packet: &[u8],
    expected_phase: u8,
    expected_noise_len: usize,
) -> io::Result<&[u8]> {
    if packet.len() != 4 + expected_noise_len {
        return Err(io::Error::other(format!(
            "expected FSP msg{expected_phase} of {} bytes, got {}",
            4 + expected_noise_len,
            packet.len(),
        )));
    }
    if packet[0] != expected_phase || packet[1] != 0 {
        return Err(io::Error::other(format!(
            "bad FSP msg{expected_phase} prefix {:02x} {:02x}",
            packet[0], packet[1],
        )));
    }
    if le_u16(&packet[2..4]) as usize != expected_noise_len {
        return Err(io::Error::other(format!(
            "bad FSP msg{expected_phase} payload length",
        )));
    }
    Ok(&packet[4..])
}

fn service_body(len: usize, salt: u8) -> Vec<u8> {
    (0..len)
        .map(|index| {
            salt.wrapping_add((index as u8).wrapping_mul(31))
                .wrapping_add((index >> 8) as u8)
        })
        .collect()
}

fn build_fsp_direct_service_record(
    session: &mut NoiseSession,
    src_port: u16,
    dest_port: u16,
    body: &[u8],
) -> io::Result<Vec<u8>> {
    let mut plaintext = Vec::with_capacity(FSP_INNER_HEADER_LEN + FSP_DATA_HEADER_LEN + body.len());
    plaintext.extend_from_slice(&0u32.to_le_bytes());
    plaintext.push(FSP_MSG_DATA);
    plaintext.push(0);
    plaintext.extend_from_slice(&src_port.to_le_bytes());
    plaintext.extend_from_slice(&dest_port.to_le_bytes());
    plaintext.extend_from_slice(body);

    let payload_len = u16::try_from(plaintext.len())
        .map_err(|_| io::Error::other("FSP service plaintext too large"))?;
    let counter = session.current_send_counter();
    let mut header = [0u8; FSP_HEADER_LEN];
    header[0] = FSP_PHASE_ESTABLISHED;
    header[1] = FSP_FLAG_DIRECT_TRANSPORT;
    header[2..4].copy_from_slice(&payload_len.to_le_bytes());
    header[4..12].copy_from_slice(&counter.to_le_bytes());
    let ciphertext = session
        .encrypt_with_aad(&plaintext, &header)
        .map_err(|e| io::Error::other(format!("FSP encrypt: {e:?}")))?;

    let mut record = Vec::with_capacity(header.len() + ciphertext.len());
    record.extend_from_slice(&header);
    record.extend_from_slice(&ciphertext);
    Ok(record)
}

fn read_dfp1_record<R: Read>(reader: &mut R) -> io::Result<(u64, Vec<u8>)> {
    let mut metadata: Option<(u64, usize, usize)> = None;
    let mut fragments: Vec<Option<Vec<u8>>> = Vec::new();
    let mut received_bytes = 0usize;

    loop {
        let fragment = read_frame(reader)?;
        if fragment.len() <= DFP1_HEADER_LEN || &fragment[..4] != b"DFP1" {
            return Err(io::Error::other("expected non-empty DFP1 fragment"));
        }
        let record_id = le_u64(&fragment[4..12]);
        let total_len = le_u32(&fragment[12..16]) as usize;
        let fragment_index = le_u16(&fragment[16..18]) as usize;
        let fragment_count = le_u16(&fragment[18..20]) as usize;
        if total_len == 0
            || total_len > DFP1_MAX_REASSEMBLED_LEN
            || fragment_count <= 1
            || fragment_count > DFP1_MAX_FRAGMENTS
            || fragment_count > total_len
            || fragment_index >= fragment_count
        {
            return Err(io::Error::other("invalid DFP1 fragment header"));
        }

        match metadata {
            None => {
                metadata = Some((record_id, total_len, fragment_count));
                fragments.resize_with(fragment_count, || None);
            }
            Some(expected) if expected != (record_id, total_len, fragment_count) => {
                return Err(io::Error::other("inconsistent DFP1 fragment metadata"));
            }
            Some(_) => {}
        }

        if fragments[fragment_index].is_none() {
            let payload = fragment[DFP1_HEADER_LEN..].to_vec();
            received_bytes = received_bytes
                .checked_add(payload.len())
                .filter(|received| *received <= total_len)
                .ok_or_else(|| io::Error::other("DFP1 payload exceeds declared length"))?;
            fragments[fragment_index] = Some(payload);
        }
        if received_bytes != total_len || fragments.iter().any(Option::is_none) {
            continue;
        }

        let (record_id, _, _) = metadata.expect("DFP1 metadata initialized");
        let mut record = Vec::with_capacity(total_len);
        for payload in fragments {
            record.extend_from_slice(&payload.expect("complete DFP1 fragment set"));
        }
        if record.len() != total_len {
            return Err(io::Error::other("reassembled DFP1 length mismatch"));
        }
        return Ok((record_id, record));
    }
}

fn decrypt_fsp_direct_service_record(
    session: &mut NoiseSession,
    dfp1_record_id: u64,
    record: &[u8],
) -> io::Result<Vec<u8>> {
    if record.len() < FSP_HEADER_LEN + AEAD_TAG_LEN {
        return Err(io::Error::other("FSP established record too short"));
    }
    if record[0] != FSP_PHASE_ESTABLISHED || record[1] != FSP_FLAG_DIRECT_TRANSPORT {
        return Err(io::Error::other("expected direct FSP established record"));
    }
    let payload_len = le_u16(&record[2..4]) as usize;
    let counter = le_u64(&record[4..12]);
    if counter != dfp1_record_id {
        return Err(io::Error::other(
            "DFP1 record id does not match FSP counter",
        ));
    }
    if record.len() != FSP_HEADER_LEN + payload_len + AEAD_TAG_LEN {
        return Err(io::Error::other("FSP established payload length mismatch"));
    }
    let plaintext = session
        .decrypt_with_replay_check_and_aad(
            &record[FSP_HEADER_LEN..],
            counter,
            &record[..FSP_HEADER_LEN],
        )
        .map_err(|e| io::Error::other(format!("FSP decrypt: {e:?}")))?;
    if plaintext.len() != payload_len
        || plaintext.len() < FSP_INNER_HEADER_LEN + FSP_DATA_HEADER_LEN
    {
        return Err(io::Error::other("bad FSP service plaintext length"));
    }
    if plaintext[4] != FSP_MSG_DATA || plaintext[5] != 0 {
        return Err(io::Error::other("expected FSP DataPacket plaintext"));
    }
    if le_u16(&plaintext[6..8]) != 0x3030 || le_u16(&plaintext[8..10]) != 0x4040 {
        return Err(io::Error::other("unexpected FSP service ports"));
    }
    let body = &plaintext[10..];
    let expected = service_body(MAX_FSP_SERVICE_BODY_LEN, 0x72);
    if body != expected {
        return Err(io::Error::other(format!(
            "unexpected FSP service body: got {} bytes",
            body.len(),
        )));
    }
    Ok(body.to_vec())
}

/// `fsp-initiator <initiator-sk-hex>`: run Rust as an FSP/XK initiator.
///
/// The TS responder supplies its static key, handles Rust's full FSP handshake
/// envelopes, decrypts one direct service record, and returns a maximum-size
/// service record as out-of-order DFP1 fragments. Rust reassembles and decrypts
/// that reply before echoing its service body.
pub(super) fn run(static_sk_hex: &str) -> io::Result<()> {
    run_with_envelope(static_sk_hex, false)
}

/// `fsp-session-initiator <initiator-sk-hex>`: use the routed SessionSetup,
/// SessionAck, and SessionMsg3 envelopes around the same Rust/TS XK exchange.
pub(super) fn run_session(static_sk_hex: &str) -> io::Result<()> {
    run_with_envelope(static_sk_hex, true)
}

fn run_with_envelope(static_sk_hex: &str, session_envelope: bool) -> io::Result<()> {
    let sk_bytes =
        hex::decode(static_sk_hex).map_err(|e| io::Error::other(format!("bad hex: {e}")))?;
    let sk =
        SecretKey::from_slice(&sk_bytes).map_err(|e| io::Error::other(format!("bad sk: {e}")))?;
    let identity = Identity::from_secret_key(sk);
    let kp = identity.keypair();

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    write_frame(&mut stdout, &kp.public_key().serialize())?;
    let responder_static_bytes = read_frame(&mut stdin)?;
    let responder_static = PublicKey::from_slice(&responder_static_bytes)
        .map_err(|e| io::Error::other(format!("bad responder pubkey: {e}")))?;
    let responder = PeerIdentity::from_pubkey_full(responder_static);

    let mut hs = HandshakeState::new_xk_initiator(kp, responder_static);
    hs.set_local_epoch([0u8; 8]);
    let noise_msg1 = hs
        .write_xk_message_1()
        .map_err(|e| io::Error::other(format!("write_xk_message_1: {e:?}")))?;
    if session_envelope {
        let setup = SessionSetup::new(
            TreeCoordinate::root(*identity.node_addr()),
            TreeCoordinate::root(*responder.node_addr()),
        )
        .with_handshake(noise_msg1);
        write_frame(&mut stdout, &setup.encode())?;
    } else {
        write_frame(
            &mut stdout,
            &build_fsp_handshake(FSP_PHASE_MSG1, &noise_msg1)?,
        )?;
    }

    let msg2 = read_frame(&mut stdin)?;
    let noise_msg2 = if session_envelope {
        if msg2.len() < 4 || msg2[0] != FSP_PHASE_MSG2 || msg2[1] != 0 {
            return Err(io::Error::other("bad SessionAck FSP prefix"));
        }
        let ack = SessionAck::decode(&msg2[4..])
            .map_err(|e| io::Error::other(format!("decode SessionAck: {e}")))?;
        ack.handshake_payload
    } else {
        parse_fsp_handshake(&msg2, FSP_PHASE_MSG2, 57)?.to_vec()
    };
    hs.read_xk_message_2(&noise_msg2)
        .map_err(|e| io::Error::other(format!("read_xk_message_2: {e:?}")))?;
    let noise_msg3 = hs
        .write_xk_message_3()
        .map_err(|e| io::Error::other(format!("write_xk_message_3: {e:?}")))?;
    if session_envelope {
        write_frame(&mut stdout, &SessionMsg3::new(noise_msg3).encode())?;
    } else {
        write_frame(
            &mut stdout,
            &build_fsp_handshake(FSP_PHASE_MSG3, &noise_msg3)?,
        )?;
    }

    let mut session = hs
        .into_session()
        .map_err(|e| io::Error::other(format!("into_session: {e:?}")))?;
    let rust_body = service_body(RUST_SERVICE_BODY_LEN, 0x31);
    let rust_record = build_fsp_direct_service_record(&mut session, 0x1010, 0x2020, &rust_body)?;
    write_frame(&mut stdout, &rust_record)?;

    let (record_id, reply_record) = read_dfp1_record(&mut stdin)?;
    let reply_body = decrypt_fsp_direct_service_record(&mut session, record_id, &reply_record)?;
    write_frame(&mut stdout, &reply_body)?;
    Ok(())
}
