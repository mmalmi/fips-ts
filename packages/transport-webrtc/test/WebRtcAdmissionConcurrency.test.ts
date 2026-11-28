import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityFromSecretKey, toHex } from "@fips/core";
import { WebRtcTransport } from "../src/WebRtcTransport.js";
import type { WebRtcSignal } from "../src/WebRtcSignal.js";

class AdmissionPeerConnection extends EventTarget {
  static instances: AdmissionPeerConnection[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ondatachannel?: (event: RTCDataChannelEvent) => void;

  constructor() {
    super();
    AdmissionPeerConnection.instances.push(this);
  }
  async setRemoteDescription() {}
  async createAnswer() { return { type: "answer" as const, sdp: "answer" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  close() { this.connectionState = "closed"; }
}

const transports: WebRtcTransport[] = [];
const identity = (scalar: number) => {
  const secret = new Uint8Array(32);
  secret[31] = scalar;
  return identityFromSecretKey(secret);
};
const offer = (negotiationId: string): WebRtcSignal => ({
  version: 1, linkType: "webrtc", kind: "offer", negotiationId,
  createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
  payload: { sdp: "offer" },
});

async function fixture() {
  const transport = new WebRtcTransport({
    rtcPeerConnection: AdmissionPeerConnection as unknown as typeof RTCPeerConnection,
    acceptConnections: true,
    maxConnections: 1,
  });
  transports.push(transport);
  await transport.start({
    localIdentity: await identity(1),
    onPacket() {},
    async sendLinkNegotiation() {},
  });
  return { transport, peers: await Promise.all([2, 3].map(async scalar => toHex((await identity(scalar)).publicKey))) };
}

beforeEach(() => { AdmissionPeerConnection.instances = []; });
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.stop()));
});

describe("inbound WebRTC admission", () => {
  it("reserves connection capacity before another offer can be admitted", async () => {
    const { transport, peers } = await fixture();
    await Promise.all(peers.map((peer, index) => transport.handleLinkNegotiation(peer, offer(`concurrent-${index}`))));
    expect(AdmissionPeerConnection.instances).toHaveLength(1);
  });

  it("does not create a peer connection after stopping during admission", async () => {
    const { transport, peers } = await fixture();
    const pending = transport.handleLinkNegotiation(peers[0]!, offer("stopped-during-admission"));
    const startedBeforeStop = AdmissionPeerConnection.instances.length;
    const stopped = transport.stop();
    await Promise.allSettled([pending, stopped]);
    expect(AdmissionPeerConnection.instances).toHaveLength(startedBeforeStop);
    expect(AdmissionPeerConnection.instances.every(peer => peer.connectionState === "closed")).toBe(true);
  });
});
