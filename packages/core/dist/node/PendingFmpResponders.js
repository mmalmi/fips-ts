import { FMP_HANDSHAKE_TIMEOUT_MS, MAX_PENDING_FMP_RESPONDERS } from "./PeerState.js";
/** Owns the bounded lifetime of responder keys awaiting confirmation. */
export class PendingFmpResponders {
    removePeerPath;
    pending = new Map();
    constructor(removePeerPath) {
        this.removePeerPath = removePeerPath;
    }
    clear() {
        for (const peer of this.pending.keys())
            this.discard(peer);
    }
    discard(peer) {
        this.take(peer)?.close();
    }
    take(peer) {
        const pending = this.pending.get(peer);
        if (pending)
            clearTimeout(pending.timer);
        this.pending.delete(peer);
        const link = peer.pendingResponderLink;
        peer.pendingResponderLink = undefined;
        return link;
    }
    set(peer, link) {
        if (this.pending.get(peer)?.link === link)
            return;
        this.discard(peer);
        if (this.pending.size >= MAX_PENDING_FMP_RESPONDERS) {
            link.close();
            if (peer.link === link)
                this.removePeerPath(peer);
            throw new Error("too many pending FMP responders");
        }
        peer.pendingResponderLink = link;
        const timer = setTimeout(() => {
            if (this.pending.get(peer)?.link !== link)
                return;
            this.discard(peer);
            if (peer.link.state !== "established" && !peer.outgoingHandshake) {
                peer.link.close();
                this.removePeerPath(peer);
            }
        }, FMP_HANDSHAKE_TIMEOUT_MS);
        this.pending.set(peer, { link, timer });
    }
}
//# sourceMappingURL=PendingFmpResponders.js.map