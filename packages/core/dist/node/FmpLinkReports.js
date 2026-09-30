import { LinkMessageType } from "../protocol/link.js";
const pendingReports = new WeakSet();
export function receiveFmpLinkPacket(peer, link, packet, emitError) {
    const received = link.decryptIncoming(packet);
    if (received.msgType === LinkMessageType.SenderReport && !pendingReports.has(link)) {
        const report = link.receiverReportFor(received.payload);
        if (report) {
            // Reply using the same authenticated key/counter epoch, including
            // while a replacement link is pending or a previous link is draining.
            const frame = link.encryptOutgoing(report, LinkMessageType.ReceiverReport);
            pendingReports.add(link);
            void peer.transport.send(peer.remoteAddr, frame).catch((error) => {
                emitError(error, "send link ReceiverReport");
            }).finally(() => pendingReports.delete(link));
        }
    }
    return received;
}
//# sourceMappingURL=FmpLinkReports.js.map