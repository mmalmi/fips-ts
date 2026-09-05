import type { FipsNode } from "@fips/core";
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`${transport} peer ${remotePubkey ?? "any"} did not become ${state}`));
    }, 20_000);
    const off = node.on("peer", (event) => {
      const peer = event as {
        remotePubkey: string;
        remoteAddr: { transport: string };
        state: string;
      };
      if (
        (remotePubkey !== undefined && peer.remotePubkey !== remotePubkey)
        || peer.remoteAddr.transport !== transport
        || peer.state !== state
      ) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}
