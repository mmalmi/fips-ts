import { fromHex } from "../codec/hex.js";
import { compressedPubkeyFromXOnly, } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex, } from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
export function peerNodeKey(peer) {
    return nodeAddrToHex(deriveNodeAddr(peer.pubkey));
}
export function delay(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
export function discoveryPublicKey(discovered) {
    const hinted = discovered.publicKey;
    if (hinted?.length === 32)
        return compressedPubkeyFromXOnly(hinted);
    if (hinted?.length === 33) {
        if (hinted[0] !== 0x02 && hinted[0] !== 0x03) {
            throw new Error("discovered compressed pubkey has invalid prefix");
        }
        return new Uint8Array(hinted);
    }
    if (!hinted && discovered.remoteAddr.addr.length === 66) {
        return fromHex(discovered.remoteAddr.addr);
    }
    throw new Error("discovered peer did not include a FIPS public key");
}
export function lookupReverseKey(requestId, target) {
    return `${requestId.toString(16)}:${nodeAddrToHex(target)}`;
}
export function isKnownUnhandledLinkMessage(msgType) {
    return (msgType === LinkMessageType.Heartbeat
        || msgType === LinkMessageType.Disconnect
        || msgType === LinkMessageType.SenderReport
        || msgType === LinkMessageType.ReceiverReport
        || msgType === LinkMessageType.TreeAnnounce
        || msgType === LinkMessageType.FilterAnnounce);
}
//# sourceMappingURL=routingHelpers.js.map