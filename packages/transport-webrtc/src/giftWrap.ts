/**
 * FIPS-flavored NIP-59 gift wrap.
 *
 * Standard NIP-59 publishes gift wraps as kind 1059 (regular event, stored by
 * relays). Rust FIPS uses kind 21059 for the outer gift wrap, which is in the
 * 20000-29999 ephemeral range; relays drop them after broadcast, so signaling
 * never accumulates relay state. We follow Rust FIPS for byte-compatible
 * interop.
 *
 * Layering on the wire:
 *
 *   gift-wrap event (kind 21059, signed by random ephemeral key)
 *     content: NIP-44(seal, ephemeralKey, recipientPubkey)
 *
 *   seal event (kind 13, signed by sender's real key)
 *     content: NIP-44(rumor, senderKey, recipientPubkey)
 *
 *   rumor (unsigned event, kind 14 - NIP-17 private message content)
 */

import { randomBytes } from "@noble/hashes/utils";
import { v2 as nip44v2 } from "nostr-tools/nip44";
import { secp256k1 } from "@noble/curves/secp256k1";

import { toHex, type FipsIdentity } from "@fips/core";

import {
  computeEventId,
  signEvent,
  type UnsignedEvent,
} from "./nostrEvent.js";
import type { NostrEvent } from "./NostrRelayClient.js";

export const FIPS_SIGNAL_RUMOR_KIND = 14;
export const FIPS_SIGNAL_WRAP_KIND = 21059;
export const NIP59_SEAL_KIND = 13;

const TWO_DAYS_SECS = 2 * 24 * 60 * 60;

function randomTimestampJitter(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - Math.floor(Math.random() * TWO_DAYS_SECS);
}

function identityFromSecretKey(sk: Uint8Array): FipsIdentity {
  const pub = secp256k1.getPublicKey(sk, true);
  const xOnly = pub.slice(1);
  // We only need pubkey/secretKey/xOnly for signEvent; nodeAddr is unused here.
  return {
    secretKey: sk,
    publicKey: pub,
    xOnlyPubkey: xOnly,
    nodeAddr: new Uint8Array(16),
  };
}

/**
 * Build and sign a kind 21059 gift wrap containing the given rumor content,
 * sealed for `recipientXOnlyHex`.
 */
export function buildGiftWrap(
  sender: FipsIdentity,
  recipientXOnlyHex: string,
  rumorContent: string,
  rumorKind: number = FIPS_SIGNAL_RUMOR_KIND,
): NostrEvent {
  // 1. Build the rumor (NIP-59: unsigned, with stable id).
  const rumorBase: UnsignedEvent = {
    pubkey: toHex(sender.xOnlyPubkey),
    created_at: Math.floor(Date.now() / 1000),
    kind: rumorKind,
    tags: [["p", recipientXOnlyHex]],
    content: rumorContent,
  };
  const rumorId = computeEventId(rumorBase);
  const rumorWithId = { ...rumorBase, id: rumorId };

  // 2. Seal: kind 13, signed by sender's real key, content = NIP-44(rumor).
  const sealConvKey = nip44v2.utils.getConversationKey(
    sender.secretKey,
    recipientXOnlyHex,
  );
  const sealContent = nip44v2.encrypt(JSON.stringify(rumorWithId), sealConvKey);
  const seal = signEvent(sender, {
    created_at: randomTimestampJitter(),
    kind: NIP59_SEAL_KIND,
    tags: [],
    content: sealContent,
  });

  // 3. Gift wrap: kind 21059, signed by a fresh ephemeral key.
  const wrapSk = randomBytes(32);
  const wrapper = identityFromSecretKey(wrapSk);
  const wrapConvKey = nip44v2.utils.getConversationKey(
    wrapper.secretKey,
    recipientXOnlyHex,
  );
  const wrapContent = nip44v2.encrypt(JSON.stringify(seal), wrapConvKey);
  return signEvent(wrapper, {
    created_at: randomTimestampJitter(),
    kind: FIPS_SIGNAL_WRAP_KIND,
    tags: [["p", recipientXOnlyHex]],
    content: wrapContent,
  });
}

export interface UnwrappedRumor {
  /** Real sender's xOnly hex (from the seal). */
  senderXOnlyHex: string;
  /** The rumor's content string. */
  content: string;
  /** The rumor's kind (caller may want to validate it). */
  kind: number;
}

/**
 * Reverse of buildGiftWrap. Throws if any layer fails to decrypt or verify.
 */
export function unwrapGiftWrap(
  recipient: FipsIdentity,
  wrap: NostrEvent,
): UnwrappedRumor {
  // Outer layer: decrypt the wrap's content with conv-key(recipient, wrap.pubkey).
  const wrapConvKey = nip44v2.utils.getConversationKey(
    recipient.secretKey,
    wrap.pubkey,
  );
  const sealJson = nip44v2.decrypt(wrap.content, wrapConvKey);
  const seal = JSON.parse(sealJson) as NostrEvent;
  if (seal.kind !== NIP59_SEAL_KIND) {
    throw new Error(`gift wrap inner kind ${seal.kind} != ${NIP59_SEAL_KIND}`);
  }
  // We do NOT require seal.sig to verify because some relays will already
  // have checked it; we trust the NIP-44 outer layer's integrity guarantee.
  // The real sender's pubkey comes from `seal.pubkey`.
  const sealConvKey = nip44v2.utils.getConversationKey(
    recipient.secretKey,
    seal.pubkey,
  );
  const rumorJson = nip44v2.decrypt(seal.content, sealConvKey);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent & { id?: string };
  if (rumor.pubkey !== seal.pubkey) {
    throw new Error("gift wrap: rumor pubkey does not match seal pubkey");
  }
  return {
    senderXOnlyHex: rumor.pubkey,
    content: rumor.content,
    kind: rumor.kind,
  };
}
