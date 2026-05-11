/**
 * Deterministic Noise vectors. These are snapshot tests against fixed
 * static and ephemeral key material so any change to the handshake — even an
 * accidental byte reordering — produces a diff that's easy to inspect.
 *
 * To regenerate: set REGENERATE_VECTORS=1 and the test prints the new hex
 * values; copy them into the expected constants below.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  identityFromSecretKey,
  NoiseHandshake,
  toHex,
} from "../src/index.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../fixtures/rust-vectors/noise-handshakes.json",
);

const INITIATOR_SK = new Uint8Array(32).fill(0xa1);
const RESPONDER_SK = new Uint8Array(32).fill(0xb2);
const INITIATOR_E = new Uint8Array(32).fill(0xc3);
const RESPONDER_E = new Uint8Array(32).fill(0xd4);
const EPOCH_PAYLOAD = new Uint8Array(8); // all zeros

interface VectorFile {
  ik: { msg1: string; msg2: string; handshakeHash: string };
  xk: { msg1: string; msg2: string; msg3: string; handshakeHash: string };
  notes: string;
}

async function generate(): Promise<VectorFile> {
  const initiator = await identityFromSecretKey(INITIATOR_SK);
  const responder = await identityFromSecretKey(RESPONDER_SK);

  // --- IK ---
  const ikI = new NoiseHandshake({
    pattern: "IK",
    role: "initiator",
    identity: initiator,
    remoteStatic: responder.publicKey,
    ephemeralOverride: INITIATOR_E,
  });
  const ikR = new NoiseHandshake({
    pattern: "IK",
    role: "responder",
    identity: responder,
    ephemeralOverride: RESPONDER_E,
  });
  const ikMsg1 = ikI.writeMessage(EPOCH_PAYLOAD);
  ikR.readMessage(ikMsg1);
  const ikMsg2 = ikR.writeMessage(EPOCH_PAYLOAD);
  ikI.readMessage(ikMsg2);

  // --- XK ---
  const xkI = new NoiseHandshake({
    pattern: "XK",
    role: "initiator",
    identity: initiator,
    remoteStatic: responder.publicKey,
    ephemeralOverride: INITIATOR_E,
  });
  const xkR = new NoiseHandshake({
    pattern: "XK",
    role: "responder",
    identity: responder,
    ephemeralOverride: RESPONDER_E,
  });
  const xkMsg1 = xkI.writeMessage(new Uint8Array(0));
  xkR.readMessage(xkMsg1);
  const xkMsg2 = xkR.writeMessage(EPOCH_PAYLOAD);
  xkI.readMessage(xkMsg2);
  const xkMsg3 = xkI.writeMessage(EPOCH_PAYLOAD);
  xkR.readMessage(xkMsg3);

  return {
    ik: {
      msg1: toHex(ikMsg1),
      msg2: toHex(ikMsg2),
      handshakeHash: toHex(ikI.getHandshakeHash()),
    },
    xk: {
      msg1: toHex(xkMsg1),
      msg2: toHex(xkMsg2),
      msg3: toHex(xkMsg3),
      handshakeHash: toHex(xkI.getHandshakeHash()),
    },
    notes:
      "Inputs: initiator_sk=0xa1*32, responder_sk=0xb2*32, initiator_e=0xc3*32, responder_e=0xd4*32, epoch=8×0. " +
      "Produced by packages/core/test/noise-vectors.test.ts. Compare with Rust FIPS once vectors are exported there.",
  };
}

describe("Noise vector snapshots (initiator_sk=0xa1*32, responder_sk=0xb2*32, ephemerals fixed)", () => {
  it("IK and XK handshake bytes are byte-stable", async () => {
    const fresh = await generate();
    if (process.env.REGENERATE_VECTORS === "1") {
      writeFileSync(FIXTURE_PATH, JSON.stringify(fresh, null, 2) + "\n");
      console.log("wrote", FIXTURE_PATH);
    }
    const onDisk = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VectorFile;
    // Drop notes for compare — it's free-form.
    expect(fresh.ik).toEqual(onDisk.ik);
    expect(fresh.xk).toEqual(onDisk.xk);

    // Sanity: handshake hashes are 32-byte hex.
    expect(fresh.ik.handshakeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.xk.handshakeHash).toMatch(/^[0-9a-f]{64}$/);

    // Sanity: msg lengths match the Rust-spec wire sizes.
    expect(fresh.ik.msg1.length / 2).toBe(106);
    expect(fresh.ik.msg2.length / 2).toBe(57);
    expect(fresh.xk.msg1.length / 2).toBe(33);
    expect(fresh.xk.msg2.length / 2).toBe(57);
    expect(fresh.xk.msg3.length / 2).toBe(73);
  });
});
