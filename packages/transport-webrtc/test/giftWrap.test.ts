import { describe, expect, it } from "vitest";

import { identityFromSecretKey, toHex } from "@fips/core";

import {
  buildGiftWrap,
  FIPS_SIGNAL_RUMOR_KIND,
  FIPS_SIGNAL_WRAP_KIND,
  LEGACY_FIPS_SIGNAL_RUMOR_KIND,
  NIP59_SEAL_KIND,
  unwrapGiftWrap,
} from "../src/giftWrap.js";
import { verifyEvent } from "../src/nostrEvent.js";

describe("NIP-59 gift wrap (FIPS-flavored, outer kind 21059)", () => {
  it("wrap -> unwrap recovers content and identifies real sender", async () => {
    const sender = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const recipient = await identityFromSecretKey(new Uint8Array(32).fill(0x22));

    const wrap = buildGiftWrap(
      sender,
      toHex(recipient.xOnlyPubkey),
      JSON.stringify({ hello: "peer" }),
    );

    // The outer event:
    //   - kind 21059
    //   - p tag = recipient
    //   - pubkey is a random ephemeral key (NOT the real sender)
    expect(wrap.kind).toBe(FIPS_SIGNAL_WRAP_KIND);
    expect(wrap.tags).toEqual([["p", toHex(recipient.xOnlyPubkey)]]);
    expect(wrap.pubkey).not.toBe(toHex(sender.xOnlyPubkey));
    expect(verifyEvent(wrap)).toBe(true);

    const r = unwrapGiftWrap(recipient, wrap);
    expect(r.senderXOnlyHex).toBe(toHex(sender.xOnlyPubkey));
    expect(r.kind).toBe(FIPS_SIGNAL_RUMOR_KIND);
    expect(JSON.parse(r.content)).toEqual({ hello: "peer" });
  });

  it("a different recipient cannot unwrap", async () => {
    const sender = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const recipient = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const stranger = await identityFromSecretKey(new Uint8Array(32).fill(0x33));
    const wrap = buildGiftWrap(
      sender,
      toHex(recipient.xOnlyPubkey),
      "secret",
    );
    expect(() => unwrapGiftWrap(stranger, wrap)).toThrow();
  });

  it("uses Rust FIPS signal kinds", () => {
    expect(NIP59_SEAL_KIND).toBe(13);
    expect(FIPS_SIGNAL_RUMOR_KIND).toBe(14);
    expect(FIPS_SIGNAL_WRAP_KIND).toBe(21059);
    expect(LEGACY_FIPS_SIGNAL_RUMOR_KIND).toBe(21059);
  });
});
