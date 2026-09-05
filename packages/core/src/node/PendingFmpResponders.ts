import type { FmpLink } from "../fmp/link.js";
import { FMP_HANDSHAKE_TIMEOUT_MS, MAX_PENDING_FMP_RESPONDERS, type AdjacentPeer } from "./PeerState.js";

/** Owns the bounded lifetime of responder keys awaiting confirmation. */
export class PendingFmpResponders {
  private readonly pending = new Map<AdjacentPeer, {
    link: FmpLink;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly removePeerPath: (peer: AdjacentPeer) => void) {}

  clear(): void {
    for (const peer of this.pending.keys()) this.discard(peer);
  }

  discard(peer: AdjacentPeer): void {
    this.take(peer)?.close();
  }

  take(peer: AdjacentPeer): FmpLink | undefined {
    const pending = this.pending.get(peer);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(peer);
    const link = peer.pendingResponderLink;
    peer.pendingResponderLink = undefined;
    return link;
  }

  set(peer: AdjacentPeer, link: FmpLink): void {
    if (this.pending.get(peer)?.link === link) return;
    this.discard(peer);
    if (this.pending.size >= MAX_PENDING_FMP_RESPONDERS) {
      link.close();
      if (peer.link === link) this.removePeerPath(peer);
      throw new Error("too many pending FMP responders");
    }
    peer.pendingResponderLink = link;
    const timer = setTimeout(() => {
      if (this.pending.get(peer)?.link !== link) return;
      this.discard(peer);
      if (peer.link.state !== "established" && !peer.outgoingHandshake) {
        peer.link.close();
        this.removePeerPath(peer);
      }
    }, FMP_HANDSHAKE_TIMEOUT_MS);
    this.pending.set(peer, { link, timer });
  }
}
