import type { TransportAddress } from "@fips/core";

export interface WebRtcConnectionConfig {
  remotePubkeyHex: string;        // 33-byte compressed hex
  remoteAddr: TransportAddress;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  onPacket: (data: Uint8Array) => void;
  onState: (state: "connecting" | "connected" | "disconnected" | "failed") => void;
}

/**
 * A single WebRTC datachannel link to one remote pubkey.
 *
 * Reports `connected` only when both pc.connectionState === "connected" AND
 * dataChannel.readyState === "open".
 */
export class WebRtcConnection {
  readonly remotePubkeyHex: string;
  readonly remoteAddr: TransportAddress;
  readonly pc: RTCPeerConnection;
  readonly dataChannel: RTCDataChannel;
  private state: "connecting" | "connected" | "disconnected" | "failed" = "connecting";
  private readonly onPacket: (data: Uint8Array) => void;
  private readonly onState: (state: WebRtcConnection["state"]) => void;

  constructor(cfg: WebRtcConnectionConfig) {
    this.remotePubkeyHex = cfg.remotePubkeyHex;
    this.remoteAddr = cfg.remoteAddr;
    this.pc = cfg.pc;
    this.dataChannel = cfg.dataChannel;
    this.onPacket = cfg.onPacket;
    this.onState = cfg.onState;

    this.dataChannel.binaryType = "arraybuffer";
    this.dataChannel.addEventListener("message", (ev) => {
      let buf: Uint8Array;
      if (ev.data instanceof ArrayBuffer) buf = new Uint8Array(ev.data);
      else if (ev.data instanceof Uint8Array) buf = ev.data;
      else if (typeof ev.data === "string") buf = new TextEncoder().encode(ev.data);
      else return;
      this.onPacket(buf);
    });
    this.dataChannel.addEventListener("open", () => this.evaluateState());
    this.dataChannel.addEventListener("close", () => {
      this.state = "disconnected";
      this.onState(this.state);
    });
    this.pc.addEventListener("connectionstatechange", () => this.evaluateState());
    this.pc.addEventListener("iceconnectionstatechange", () => this.evaluateState());
    // Initial check in case listeners are wired after states have already
    // transitioned (e.g. responder's pc is already connected by the time we
    // construct this object).
    queueMicrotask(() => this.evaluateState());
  }

  private evaluateState(): void {
    const pcState = this.pc.connectionState;
    const dcState = this.dataChannel.readyState;
    let next: WebRtcConnection["state"];
    if (pcState === "connected" && dcState === "open") next = "connected";
    else if (pcState === "failed" || pcState === "closed") next = "failed";
    else if (pcState === "disconnected") next = "disconnected";
    else next = "connecting";
    if (next !== this.state) {
      this.state = next;
      this.onState(next);
    }
  }

  send(data: Uint8Array): void {
    if (this.dataChannel.readyState !== "open") {
      throw new Error(`datachannel not open (state=${this.dataChannel.readyState})`);
    }
    // The DOM type only accepts Uint8Array<ArrayBuffer> — copy the bytes
    // into a fresh, non-shared buffer to be safe.
    const copy = new Uint8Array(new ArrayBuffer(data.length));
    copy.set(data);
    this.dataChannel.send(copy);
  }

  close(): void {
    try { this.dataChannel.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }
}
