import { describe, expect, it } from "vitest";

import {
  FMP_MSG1_TOTAL_LEN,
  FMP_MSG2_TOTAL_LEN,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  FSP_FLAG_CP,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_PHASE_ESTABLISHED,
  NOISE_IK_MSG1_LEN,
  NOISE_IK_MSG2_LEN,
  NOISE_XK_MSG1_LEN,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  decodeDataPacket,
  decodeFmpEstablished,
  decodeFmpMsg1,
  decodeFmpMsg2,
  decodeFspEstablished,
  decodeFspHandshake,
  encodeDataPacket,
  encodeFmpEstablished,
  encodeFmpMsg1,
  encodeFmpMsg2,
  encodeFspEstablished,
  encodeFspHandshake,
  isDirectFspEstablished,
  peekFmpPhase,
  peekFspPhase,
} from "../src/index.js";

const randBytes = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
};

describe("FMP wire codec", () => {
  it("Msg1 round-trip is 114 bytes with phase=1 and payload_len=110", () => {
    const msg1 = encodeFmpMsg1({
      senderIdx: 0x11223344,
      noiseMsg1: randBytes(NOISE_IK_MSG1_LEN),
    });
    expect(msg1.length).toBe(FMP_MSG1_TOTAL_LEN);
    expect(peekFmpPhase(msg1)).toBe(FMP_PHASE_MSG1);
    // payload_len is u16 LE at offset 2-3 == sender_idx + noise_msg1 (110).
    expect(msg1[2]).toBe(110);
    expect(msg1[3]).toBe(0);
    const round = decodeFmpMsg1(msg1);
    expect(round.senderIdx).toBe(0x11223344);
    expect(round.noiseMsg1.length).toBe(NOISE_IK_MSG1_LEN);
  });

  it("Msg2 round-trip is 69 bytes with phase=2 and payload_len=65", () => {
    const msg2 = encodeFmpMsg2({
      senderIdx: 0xaabbccdd,
      receiverIdx: 0x12345678,
      noiseMsg2: randBytes(NOISE_IK_MSG2_LEN),
    });
    expect(msg2.length).toBe(FMP_MSG2_TOTAL_LEN);
    expect(peekFmpPhase(msg2)).toBe(FMP_PHASE_MSG2);
    const round = decodeFmpMsg2(msg2);
    expect(round.senderIdx).toBe(0xaabbccdd);
    expect(round.receiverIdx).toBe(0x12345678);
  });

  it("Established round-trip preserves counter and receiver_idx", () => {
    const ct = randBytes(32);
    const packet = encodeFmpEstablished({
      flags: 0,
      receiverIdx: 0x01020304,
      counter: 0x0102030405060708n,
      payloadLen: ct.length - 16,
      ciphertext: ct,
    });
    expect(peekFmpPhase(packet)).toBe(FMP_PHASE_ESTABLISHED);
    const r = decodeFmpEstablished(packet);
    expect(r.receiverIdx).toBe(0x01020304);
    expect(r.counter).toBe(0x0102030405060708n);
    expect(r.payloadLen).toBe(16);
    expect(r.ciphertext.length).toBe(32);
  });

  it("rejects malformed Msg1 length", () => {
    expect(() => decodeFmpMsg1(new Uint8Array(113))).toThrow();
  });
});

describe("FSP wire codec", () => {
  it("classifies Rust direct-transport established records before FMP", () => {
    const payloadLen = 21;
    const packet = encodeFspEstablished({
      flags: FSP_FLAG_DIRECT_TRANSPORT,
      counter: 7n,
      payloadLen,
      ciphertext: randBytes(payloadLen + 16),
    });

    expect(packet.length).toBe(12 + payloadLen + 16);
    expect([...packet.subarray(0, 12)]).toEqual([
      0x00, 0x08, 0x15, 0x00,
      0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(isDirectFspEstablished(packet)).toBe(true);
    expect(() => decodeFmpEstablished(packet)).toThrow("payload_len mismatch");
  });

  it("XK Msg1 round-trip is 4+33 bytes", () => {
    const p = encodeFspHandshake({ phase: 1, noiseMsg: randBytes(NOISE_XK_MSG1_LEN) });
    expect(p.length).toBe(4 + NOISE_XK_MSG1_LEN);
    const r = decodeFspHandshake(p);
    expect(r.phase).toBe(1);
    expect(r.noiseMsg.length).toBe(NOISE_XK_MSG1_LEN);
  });

  it("XK Msg2 round-trip is 4+57 bytes", () => {
    const p = encodeFspHandshake({ phase: 2, noiseMsg: randBytes(NOISE_XK_MSG2_LEN) });
    expect(p.length).toBe(4 + NOISE_XK_MSG2_LEN);
  });

  it("XK Msg3 round-trip is 4+73 bytes", () => {
    const p = encodeFspHandshake({ phase: 3, noiseMsg: randBytes(NOISE_XK_MSG3_LEN) });
    expect(p.length).toBe(4 + NOISE_XK_MSG3_LEN);
  });

  it("FSP Established has 12-byte header (no receiver_idx)", () => {
    const ct = randBytes(48);
    const p = encodeFspEstablished({ flags: 0, counter: 7n, payloadLen: ct.length - 16, ciphertext: ct });
    expect(peekFspPhase(p)).toBe(FSP_PHASE_ESTABLISHED);
    expect(p.length).toBe(4 + 8 + 48);
    const r = decodeFspEstablished(p);
    expect(r.counter).toBe(7n);
    expect(r.payloadLen).toBe(32);
    expect(r.ciphertext.length).toBe(48);
  });

  it("FSP Established skips cleartext coordinate warmup before ciphertext", () => {
    const payloadLen = 21;
    const ciphertext = randBytes(payloadLen + 16);
    const packet = new Uint8Array(12 + 36 + ciphertext.length);
    packet[0] = FSP_PHASE_ESTABLISHED;
    packet[1] = FSP_FLAG_CP;
    packet[2] = payloadLen;
    packet[3] = 0;
    packet[4] = 7;
    packet[12] = 1;
    packet[13] = 0;
    packet[30] = 1;
    packet[31] = 0;
    packet.set(ciphertext, 48);

    const r = decodeFspEstablished(packet);
    expect(r.counter).toBe(7n);
    expect(r.payloadLen).toBe(payloadLen);
    expect(r.srcCoords?.length).toBe(1);
    expect(r.destCoords?.length).toBe(1);
    expect([...r.ciphertext]).toEqual([...ciphertext]);
  });

  it("FSP Established emits cleartext coordinates when CP is set", () => {
    const payloadLen = 5;
    const ciphertext = randBytes(payloadLen + 16);
    const srcAddr = new Uint8Array(16).fill(0x11);
    const destAddr = new Uint8Array(16).fill(0x22);
    const packet = encodeFspEstablished({
      flags: FSP_FLAG_CP,
      counter: 8n,
      payloadLen,
      srcCoords: [srcAddr],
      destCoords: [destAddr],
      ciphertext,
    });

    const r = decodeFspEstablished(packet);
    expect(r.counter).toBe(8n);
    expect(r.srcCoords?.[0]).toEqual(srcAddr);
    expect(r.destCoords?.[0]).toEqual(destAddr);
    expect([...r.ciphertext]).toEqual([...ciphertext]);
  });

  it("DataPacket: src_port + dst_port + payload (u16 LE each)", () => {
    const dp = encodeDataPacket({
      srcPort: 9000,
      dstPort: 7001,
      payload: new Uint8Array([1, 2, 3]),
    });
    // 9000 == 0x2328 → little-endian: 28 23
    // 7001 == 0x1B59 → little-endian: 59 1b
    expect(dp[0]).toBe(0x28);
    expect(dp[1]).toBe(0x23);
    expect(dp[2]).toBe(0x59);
    expect(dp[3]).toBe(0x1b);
    const r = decodeDataPacket(dp);
    expect(r.srcPort).toBe(9000);
    expect(r.dstPort).toBe(7001);
    expect([...r.payload]).toEqual([1, 2, 3]);
  });
});
