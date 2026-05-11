/**
 * Protocol wire-codec tests ported from Rust
 * ~/src/fips/crates/fips-core/src/protocol/{link.rs,filter.rs}.
 */

import { describe, expect, it } from "vitest";

import {
  BloomFilter,
  DEFAULT_FILTER_SIZE_BITS,
  DEFAULT_HASH_COUNT,
  Disconnect,
  DisconnectReason,
  HandshakeMessageType,
  LinkMessageType,
  SESSION_DATAGRAM_HEADER_SIZE,
  V1_SIZE_CLASS,
  buildFilterAnnounce,
  bytesEqual,
  decodeDisconnect,
  decodeFilterAnnounce,
  decodeSessionDatagram,
  decrementTtl,
  disconnectReasonFromByte,
  encodeDisconnect,
  encodeFilterAnnounce,
  encodeSessionDatagram,
  handshakeMessageTypeFromByte,
  isHandshakeMessageType,
  linkMessageTypeFromByte,
} from "../src/index.js";

describe("HandshakeMessageType (Rust protocol/link.rs)", () => {
  it("test_handshake_message_type_roundtrip", () => {
    for (const v of [HandshakeMessageType.NoiseIKMsg1, HandshakeMessageType.NoiseIKMsg2]) {
      expect(handshakeMessageTypeFromByte(v)).toBe(v);
    }
  });

  it("test_handshake_message_type_invalid", () => {
    expect(handshakeMessageTypeFromByte(0x00)).toBeUndefined();
    expect(handshakeMessageTypeFromByte(0x03)).toBeUndefined();
    expect(handshakeMessageTypeFromByte(0xff)).toBeUndefined();
  });

  it("test_handshake_message_type_is_handshake", () => {
    expect(isHandshakeMessageType(0x01)).toBe(true);
    expect(isHandshakeMessageType(0x02)).toBe(true);
    expect(isHandshakeMessageType(0x00)).toBe(false);
    expect(isHandshakeMessageType(0x50)).toBe(false);
  });
});

describe("LinkMessageType", () => {
  it("test_link_message_type_roundtrip: known bytes survive round-trip", () => {
    const known = [
      LinkMessageType.SessionDatagram,
      LinkMessageType.SenderReport,
      LinkMessageType.ReceiverReport,
      LinkMessageType.TreeAnnounce,
      LinkMessageType.FilterAnnounce,
      LinkMessageType.LookupRequest,
      LinkMessageType.LookupResponse,
      LinkMessageType.Disconnect,
      LinkMessageType.Heartbeat,
    ];
    for (const v of known) expect(linkMessageTypeFromByte(v)).toBe(v);
  });

  it("test_link_message_type_invalid: unknown byte returns undefined", () => {
    expect(linkMessageTypeFromByte(0x03)).toBeUndefined();
    expect(linkMessageTypeFromByte(0x4f)).toBeUndefined();
    expect(linkMessageTypeFromByte(0xff)).toBeUndefined();
  });
});

describe("DisconnectReason + Disconnect codec", () => {
  it("test_disconnect_reason_roundtrip: each known reason survives", () => {
    for (const r of [
      DisconnectReason.Shutdown,
      DisconnectReason.Restart,
      DisconnectReason.ProtocolError,
      DisconnectReason.TransportFailure,
      DisconnectReason.ResourceExhaustion,
      DisconnectReason.SecurityViolation,
    ]) {
      expect(disconnectReasonFromByte(r)).toBe(r);
    }
  });

  it("test_disconnect_reason_unknown_byte: unknown maps to Other (0xff)", () => {
    expect(disconnectReasonFromByte(0x99)).toBe(DisconnectReason.Other);
    expect(disconnectReasonFromByte(0x77)).toBe(DisconnectReason.Other);
  });

  it("test_disconnect_encode_decode: 2-byte msg_type + reason", () => {
    const d: Disconnect = { reason: DisconnectReason.Restart };
    const encoded = encodeDisconnect(d);
    expect(encoded.length).toBe(2);
    expect(encoded[0]).toBe(LinkMessageType.Disconnect);
    expect(encoded[1]).toBe(DisconnectReason.Restart);
    // Rust's Disconnect::decode operates on the payload AFTER the msg_type byte.
    const back = decodeDisconnect(encoded.subarray(1));
    expect(back.reason).toBe(DisconnectReason.Restart);
  });

  it("test_disconnect_all_reasons: every known reason round-trips through encode/decode", () => {
    for (const r of [
      DisconnectReason.Shutdown,
      DisconnectReason.Restart,
      DisconnectReason.ProtocolError,
      DisconnectReason.TransportFailure,
      DisconnectReason.ResourceExhaustion,
      DisconnectReason.SecurityViolation,
      DisconnectReason.Other,
    ]) {
      const e = encodeDisconnect({ reason: r });
      const d = decodeDisconnect(e.subarray(1));
      expect(d.reason).toBe(r);
    }
  });
});

describe("SessionDatagram codec", () => {
  it("36-byte header layout: [type|ttl|mtu LE|src 16|dest 16]", () => {
    const src = new Uint8Array(16);
    src[0] = 0xaa;
    const dest = new Uint8Array(16);
    dest[15] = 0xbb;
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeSessionDatagram({
      ttl: 64,
      pathMtu: 1200,
      srcAddr: src,
      destAddr: dest,
      payload,
    });
    expect(encoded.length).toBe(SESSION_DATAGRAM_HEADER_SIZE + payload.length);
    expect(encoded[0]).toBe(LinkMessageType.SessionDatagram);
    expect(encoded[1]).toBe(64);
    // pathMtu 1200 = 0x04b0 little-endian: b0 04
    expect(encoded[2]).toBe(0xb0);
    expect(encoded[3]).toBe(0x04);
    expect(encoded[4]).toBe(0xaa);
    expect(encoded[4 + 16 + 15]).toBe(0xbb);

    const decoded = decodeSessionDatagram(encoded);
    expect(decoded.ttl).toBe(64);
    expect(decoded.pathMtu).toBe(1200);
    expect(bytesEqual(decoded.srcAddr, src)).toBe(true);
    expect(bytesEqual(decoded.destAddr, dest)).toBe(true);
    expect(bytesEqual(decoded.payload, payload)).toBe(true);
  });

  it("rejects bufs shorter than the fixed header", () => {
    expect(() => decodeSessionDatagram(new Uint8Array(10))).toThrow();
    expect(() => decodeSessionDatagram(new Uint8Array(35))).toThrow();
  });

  it("rejects buffers with the wrong msg_type", () => {
    const wrong = new Uint8Array(SESSION_DATAGRAM_HEADER_SIZE);
    wrong[0] = LinkMessageType.Heartbeat;
    expect(() => decodeSessionDatagram(wrong)).toThrow();
  });

  it("decrementTtl: 64 → 63; 1 → 0 returns false", () => {
    const d = {
      ttl: 64,
      pathMtu: 0,
      srcAddr: new Uint8Array(16),
      destAddr: new Uint8Array(16),
      payload: new Uint8Array(0),
    };
    expect(decrementTtl(d)).toBe(true);
    expect(d.ttl).toBe(63);

    d.ttl = 1;
    expect(decrementTtl(d)).toBe(false);
    expect(d.ttl).toBe(0);
  });
});

describe("FilterAnnounce codec (Rust protocol/filter.rs)", () => {
  it("test_filter_announce_size_class: v1 wraps a 1024-byte filter", () => {
    const filter = BloomFilter.withParams(DEFAULT_FILTER_SIZE_BITS, DEFAULT_HASH_COUNT);
    const fa = buildFilterAnnounce(filter, 42n);
    expect(fa.sizeClass).toBe(V1_SIZE_CLASS);
    expect(fa.hashCount).toBe(DEFAULT_HASH_COUNT);
    expect(fa.filter.numBytes).toBe(1024);
  });

  it("test_filter_announce_encode_decode_roundtrip", () => {
    const filter = BloomFilter.withParams(DEFAULT_FILTER_SIZE_BITS, DEFAULT_HASH_COUNT);
    filter.insertBytes(new TextEncoder().encode("alice"));
    filter.insertBytes(new TextEncoder().encode("bob"));
    const fa = buildFilterAnnounce(filter, 7n);
    const encoded = encodeFilterAnnounce(fa);
    expect(encoded[0]).toBe(LinkMessageType.FilterAnnounce);
    // After msg_type: 8-byte LE 7 then hashCount then size_class then 1024 bytes.
    expect(encoded.length).toBe(1 + 8 + 1 + 1 + 1024);
    const decoded = decodeFilterAnnounce(encoded);
    expect(decoded.sequence).toBe(7n);
    expect(decoded.hashCount).toBe(DEFAULT_HASH_COUNT);
    expect(decoded.sizeClass).toBe(V1_SIZE_CLASS);
    expect(decoded.filter.containsBytes(new TextEncoder().encode("alice"))).toBe(true);
    expect(decoded.filter.containsBytes(new TextEncoder().encode("bob"))).toBe(true);
    expect(decoded.filter.containsBytes(new TextEncoder().encode("carol"))).toBe(false);
  });

  it("test_filter_announce_decode_rejects_bad_size_class", () => {
    const buf = new Uint8Array(1 + 8 + 1 + 1 + 1024);
    buf[0] = LinkMessageType.FilterAnnounce;
    // sequence = 0; hash_count = 5; size_class = 2 (not v1)
    buf[1 + 8] = 5;
    buf[1 + 8 + 1] = 2;
    expect(() => decodeFilterAnnounce(buf)).toThrow(/size_class/);
  });

  it("test_filter_announce_decode_rejects_truncated", () => {
    // Header present but filter bytes truncated.
    const buf = new Uint8Array(1 + 8 + 1 + 1 + 512); // half-sized
    buf[0] = LinkMessageType.FilterAnnounce;
    buf[1 + 8] = 5;
    buf[1 + 8 + 1] = V1_SIZE_CLASS;
    expect(() => decodeFilterAnnounce(buf)).toThrow(/truncated/);
  });

  it("test_filter_announce_with_size_class: building from a 512-byte filter is rejected", () => {
    const small = BloomFilter.withParams(512 * 8, 5);
    expect(() => buildFilterAnnounce(small, 0n)).toThrow();
  });
});
