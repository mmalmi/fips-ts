import type { FmpLink } from "../fmp/link.js";
import type { AdjacentPeer } from "./PeerState.js";
export declare function receiveFmpLinkPacket(peer: AdjacentPeer, link: FmpLink, packet: Uint8Array, emitError: (error: Error, where: string) => void): {
    msgType: number;
    payload: Uint8Array;
};
//# sourceMappingURL=FmpLinkReports.d.ts.map