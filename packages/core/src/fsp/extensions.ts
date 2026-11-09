import { LINK_NEGOTIATION_SERVICE_PORT } from "../linkNegotiation.js";
import {
  decodeExtensionCapabilities,
  encodeExtensionCapabilities,
  FSP_EXTENSION_DIRECT,
  hasExtensionMagic,
} from "../protocol/extensions.js";

type SendExtension = (payload: Uint8Array) => Promise<void>;

/** Capabilities belong to the authenticated process, not a single Noise key epoch. */
export class FspExtensions {
  private requested = false;
  private capabilities = 0;
  private responded = false;
  private responseRequired = false;

  get supportsDirect(): boolean {
    return !this.responseRequired && (this.capabilities & FSP_EXTENSION_DIRECT) !== 0;
  }

  rememberDirectSupport(): void {
    this.capabilities |= FSP_EXTENSION_DIRECT;
  }

  async request(send: SendExtension): Promise<void> {
    if (this.requested) return;
    // Mark before sending: a synchronous carrier can deliver its reply reentrantly.
    this.requested = true;
    await send(encodeExtensionCapabilities(1, FSP_EXTENSION_DIRECT));
  }

  async receive(
    data: { srcPort: number; dstPort: number; payload: Uint8Array },
    send: SendExtension,
  ): Promise<boolean> {
    if (data.dstPort !== LINK_NEGOTIATION_SERVICE_PORT) return false;
    if (!hasExtensionMagic(data.payload) && isJsonObject(data.payload)) return false;

    // Port 257 also carries JSON WebRTC signaling. Only object-shaped JSON goes
    // to that decoder; truncated/corrupted binary extensions must never do so.
    const message = data.srcPort === LINK_NEGOTIATION_SERVICE_PORT
      ? decodeExtensionCapabilities(data.payload) : undefined;
    if (!message) return true;
    if (message.kind === 1) {
      if (!this.responded) this.responseRequired = true;
      await send(encodeExtensionCapabilities(2, FSP_EXTENSION_DIRECT));
      this.responded = true;
      this.responseRequired = false;
    }
    // Respond using the baseline carrier before learning direct transport.
    // Unknown bits do not grant capabilities, and rekeys retain learned support.
    this.capabilities |= message.capabilities & FSP_EXTENSION_DIRECT;
    return true;
  }
}

function isJsonObject(payload: Uint8Array): boolean {
  let first: number | undefined;
  for (const byte of payload) {
    const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
    // JSON permits these whitespace bytes, but never raw binary controls.
    // Escaped controls and UTF-8 string bytes remain ordinary JSON input.
    if (byte < 0x20 && !whitespace) return false;
    if (first === undefined && !whitespace) first = byte;
  }
  return first === 0x7b;
}
