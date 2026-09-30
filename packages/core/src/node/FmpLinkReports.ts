import type { FmpLink } from "../fmp/link.js";
import { LinkMessageType } from "../protocol/link.js";
import type { AdjacentPeer } from "./PeerState.js";

const pendingReports = new WeakSet<FmpLink>();

export function receiveFmpLinkPacket(
  peer: AdjacentPeer,
  link: FmpLink,
  packet: Uint8Array,
  emitError: (error: Error, where: string) => void,
): { msgType: number; payload: Uint8Array } {
  const received = link.decryptIncoming(packet);
  if (received.msgType === LinkMessageType.SenderReport && !pendingReports.has(link)) {
    const report = link.receiverReportFor(received.payload);
    if (report) {
      // Reply using the same authenticated key/counter epoch, including
      // while a replacement link is pending or a previous link is draining.
      const frame = link.encryptOutgoing(report, LinkMessageType.ReceiverReport);
      pendingReports.add(link);
      void peer.transport.send(peer.remoteAddr, frame).catch((error) => {
        emitError(error as Error, "send link ReceiverReport");
      }).finally(() => pendingReports.delete(link));
    }
  }
  return received;
}
