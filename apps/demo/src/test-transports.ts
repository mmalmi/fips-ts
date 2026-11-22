import { type FipsNode, peerIdFromPubkey } from "@fips/core";
import { WebRtcTransport, type WebRtcTransportConfig } from "@fips/transport-webrtc";
import { WebSocketTransport } from "@fips/transport-websocket";

export function webSocketSeedTransport(): WebSocketTransport {
  const seedUrl = window.__fipsTestWebSocketSeedUrl
    ?? new URL(window.location.href).searchParams.get("fipsSeed");
  if (!seedUrl) throw new Error("fipsSeed WebSocket URL is required");
  return new WebSocketTransport({ seedUrls: [seedUrl] });
}

export function webRtcTransports(config: WebRtcTransportConfig): [WebSocketTransport, WebRtcTransport] {
  return [webSocketSeedTransport(), new WebRtcTransport(config)];
}


export function waitForPeerState(
  node: FipsNode,
  remotePubkey: string | undefined,
  state: "connected" | "disconnected",
  transport = "webrtc",
): Promise<void> {
  const expectedId = remotePubkey === undefined ? undefined : peerIdFromPubkey(remotePubkey);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`${transport} peer ${remotePubkey ?? "any"} did not become ${state}`));
    }, 20_000);
    const off = node.on("peer", (peer) => {
      if (
        (expectedId !== undefined && peer.peerId !== expectedId)
        || peer.remoteAddr.transport !== transport
        || peer.state !== state
      ) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}
