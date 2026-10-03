import { bytesEqual, fromHex } from "../codec/hex.js";
import { compressedPubkeyFromXOnly, } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex, } from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
export function peerNodeKey(peer) {
    return nodeAddrToHex(deriveNodeAddr(peer.pubkey));
}
export function frameCapacity(peer) {
    return Math.min(0xffff, peer.transport.maxFrameBytes ?? peer.transport.mtu);
}
/** Keep a newer narrow link from hiding a usable carrier to the same identity. */
export function selectCarrier(preferred, peers, excludedPeer, minMtu) {
    if (!preferred)
        return undefined;
    const usable = (peer) => peer.link.state === "established"
        && peer.pubkeyHex !== excludedPeer?.pubkeyHex && frameCapacity(peer) >= minMtu;
    if (usable(preferred))
        return preferred;
    const nodeHex = peerNodeKey(preferred);
    for (const peer of peers) {
        if (usable(peer) && peerNodeKey(peer) === nodeHex)
            return peer;
    }
    return undefined;
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
/** Resolve signed transport discovery without opening its physical carrier. */
export async function resolveTransportIdentity(transports, destNodeAddr, abort, isStarted) {
    const destNodeHex = nodeAddrToHex(destNodeAddr);
    if (abort.signal.aborted || !isStarted())
        throw new Error("FIPS node stopped");
    const resolvers = transports.filter((transport) => transport.resolve !== undefined);
    if (resolvers.length === 0)
        throw new Error(`no route to ${destNodeHex}`);
    const resolutionTasks = resolvers.map(async (transport) => {
        const discovered = await transport.resolve(destNodeAddr, abort.signal);
        if (!discovered)
            throw new Error("transport did not resolve destination");
        if (discovered.remoteAddr.transport !== transport.type) {
            throw new Error("resolved address transport mismatch");
        }
        const remotePubkey = discoveryPublicKey(discovered);
        if (!bytesEqual(deriveNodeAddr(remotePubkey), destNodeAddr)) {
            throw new Error("resolved identity does not match destination NodeAddr");
        }
        return { transport, remoteAddr: discovered.remoteAddr, remotePubkey };
    });
    const noRoute = () => new Error(`no route to ${destNodeHex}`);
    const candidate = Promise.any(resolutionTasks).catch(() => {
        throw noRoute();
    });
    let timeout;
    let onAbort;
    const boundary = new Promise((_resolve, reject) => {
        onAbort = () => reject(isStarted() ? noRoute() : new Error("FIPS node stopped"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => abort.abort(), 5_000);
    });
    let resolved;
    try {
        resolved = await Promise.race([candidate, boundary]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        if (onAbort)
            abort.signal.removeEventListener("abort", onAbort);
        if (!abort.signal.aborted)
            abort.abort();
    }
    return resolved;
}
//# sourceMappingURL=routingHelpers.js.map