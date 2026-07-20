import { decodeNpub, encodeNpub } from "./identity/nip19.js";
export const RECENT_PEERS_VERSION = 1;
export const RECENT_PEERS_MAX_PEERS = 256;
export const RECENT_PEERS_MAX_ENDPOINTS = 4;
export function createRecentPeers(localNpub, scope) {
    requireCanonicalNpub(localNpub, "local_npub");
    requireString(scope, "scope");
    return {
        version: RECENT_PEERS_VERSION,
        local_npub: localNpub,
        scope,
        peers: {},
    };
}
export function parseRecentPeers(value, expectedLocalNpub, expectedScope) {
    requireCanonicalNpub(expectedLocalNpub, "expected local_npub");
    requireString(expectedScope, "expected scope");
    const root = requireRecord(value, "recent peers");
    requireExactKeys(root, ["version", "local_npub", "scope", "peers"], "recent peers");
    if (root.version !== RECENT_PEERS_VERSION) {
        throw new Error(`recent peers version must be ${RECENT_PEERS_VERSION}`);
    }
    const localNpub = requireCanonicalNpub(root.local_npub, "local_npub");
    if (localNpub !== expectedLocalNpub) {
        throw new Error("recent peers local_npub does not match the expected identity");
    }
    const scope = requireString(root.scope, "scope");
    if (scope !== expectedScope) {
        throw new Error("recent peers scope does not match the expected scope");
    }
    const peersRecord = requireRecord(root.peers, "peers");
    const entries = Object.entries(peersRecord);
    if (entries.length > RECENT_PEERS_MAX_PEERS) {
        throw new Error(`recent peers exceeds ${RECENT_PEERS_MAX_PEERS} peers`);
    }
    const peers = {};
    for (const [remoteNpub, peerValue] of entries) {
        requireCanonicalNpub(remoteNpub, "remote_npub");
        if (remoteNpub === localNpub) {
            throw new Error("recent peers must not contain the local identity");
        }
        peers[remoteNpub] = parseRecentPeer(peerValue);
    }
    return {
        version: RECENT_PEERS_VERSION,
        local_npub: localNpub,
        scope,
        peers,
    };
}
export function observeAuthenticatedPeer(recentPeers, remoteNpub, authenticatedAtMs, udpAddr) {
    const parsed = parseRecentPeers(recentPeers, recentPeers.local_npub, recentPeers.scope);
    requireCanonicalNpub(remoteNpub, "remote_npub");
    if (remoteNpub === parsed.local_npub) {
        throw new Error("cannot observe the local identity as a recent peer");
    }
    requireTimestamp(authenticatedAtMs, "last_authenticated_at_ms");
    const parsedUdpAddr = udpAddr === undefined
        ? undefined
        : requireReusableUdpSocketAddr(udpAddr, "UDP addr");
    const peers = clonePeers(parsed.peers);
    const existing = peers[remoteNpub];
    const lastAuthenticatedAtMs = Math.max(existing?.last_authenticated_at_ms ?? 0, authenticatedAtMs);
    let endpoints = existing?.endpoints ?? [];
    if (parsedUdpAddr !== undefined) {
        const previous = endpoints.find((endpoint) => (requireReusableUdpSocketAddr(endpoint.addr, "cached UDP addr").key === parsedUdpAddr.key));
        endpoints = endpoints.filter((endpoint) => (requireReusableUdpSocketAddr(endpoint.addr, "cached UDP addr").key !== parsedUdpAddr.key));
        endpoints.push({
            transport: "udp",
            addr: parsedUdpAddr.canonical,
            last_authenticated_at_ms: Math.max(previous?.last_authenticated_at_ms ?? 0, authenticatedAtMs),
        });
    }
    endpoints.sort(compareEndpoints);
    endpoints.length = Math.min(endpoints.length, RECENT_PEERS_MAX_ENDPOINTS);
    peers[remoteNpub] = {
        last_authenticated_at_ms: lastAuthenticatedAtMs,
        endpoints,
    };
    return {
        ...parsed,
        peers: capPeers(peers),
    };
}
export function pruneRecentPeers(recentPeers, nowMs, ttlMs) {
    const parsed = parseRecentPeers(recentPeers, recentPeers.local_npub, recentPeers.scope);
    requireTimestamp(nowMs, "nowMs");
    requireTimestamp(ttlMs, "ttlMs");
    const cutoff = nowMs - ttlMs;
    const peers = {};
    for (const [remoteNpub, peer] of Object.entries(parsed.peers)) {
        if (peer.last_authenticated_at_ms < cutoff)
            continue;
        peers[remoteNpub] = {
            last_authenticated_at_ms: peer.last_authenticated_at_ms,
            endpoints: peer.endpoints
                .filter((endpoint) => endpoint.last_authenticated_at_ms >= cutoff)
                .sort(compareEndpoints),
        };
    }
    return {
        ...parsed,
        peers: capPeers(peers),
    };
}
function parseRecentPeer(value) {
    const peer = requireRecord(value, "recent peer");
    requireExactKeys(peer, ["last_authenticated_at_ms", "endpoints"], "recent peer");
    const lastAuthenticatedAtMs = requireTimestamp(peer.last_authenticated_at_ms, "recent peer last_authenticated_at_ms");
    if (!Array.isArray(peer.endpoints))
        throw new Error("recent peer endpoints must be an array");
    if (peer.endpoints.length > RECENT_PEERS_MAX_ENDPOINTS) {
        throw new Error(`recent peer exceeds ${RECENT_PEERS_MAX_ENDPOINTS} endpoints`);
    }
    const endpoints = peer.endpoints.map((endpoint) => parseRecentPeerEndpoint(endpoint, lastAuthenticatedAtMs));
    const addresses = new Set(endpoints.map(({ addr }) => (requireReusableUdpSocketAddr(addr, "recent peer endpoint addr").key)));
    if (addresses.size !== endpoints.length) {
        throw new Error("recent peer endpoints must have unique UDP addresses");
    }
    return { last_authenticated_at_ms: lastAuthenticatedAtMs, endpoints };
}
function parseRecentPeerEndpoint(value, peerAuthenticatedAtMs) {
    const endpoint = requireRecord(value, "recent peer endpoint");
    requireExactKeys(endpoint, ["transport", "addr", "last_authenticated_at_ms"], "recent peer endpoint");
    if (endpoint.transport !== "udp") {
        throw new Error("recent peer endpoint transport must be udp");
    }
    const addr = requireReusableUdpSocketAddr(endpoint.addr, "recent peer endpoint addr").addr;
    const lastAuthenticatedAtMs = requireTimestamp(endpoint.last_authenticated_at_ms, "recent peer endpoint last_authenticated_at_ms");
    if (lastAuthenticatedAtMs > peerAuthenticatedAtMs) {
        throw new Error("recent peer endpoint is newer than its peer");
    }
    return {
        transport: "udp",
        addr,
        last_authenticated_at_ms: lastAuthenticatedAtMs,
    };
}
function capPeers(peers) {
    return Object.fromEntries(Object.entries(peers)
        .sort(([leftNpub, left], [rightNpub, right]) => (right.last_authenticated_at_ms - left.last_authenticated_at_ms
        || compareStrings(rightNpub, leftNpub)))
        .slice(0, RECENT_PEERS_MAX_PEERS));
}
function clonePeers(peers) {
    return Object.fromEntries(Object.entries(peers).map(([npub, peer]) => [npub, {
            last_authenticated_at_ms: peer.last_authenticated_at_ms,
            endpoints: peer.endpoints.map((endpoint) => ({ ...endpoint })),
        }]));
}
function compareEndpoints(left, right) {
    return right.last_authenticated_at_ms - left.last_authenticated_at_ms
        || compareStrings(left.addr, right.addr);
}
function compareStrings(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function requireReusableUdpSocketAddr(value, label) {
    const addr = requireNonEmptyString(value, label);
    const parsed = addr.startsWith("[")
        ? parseIpv6SocketAddr(addr)
        : parseIpv4SocketAddr(addr);
    if (parsed === undefined) {
        throw new Error(`${label} must be a reusable numeric UDP socket address`);
    }
    return { addr, ...parsed };
}
function parseIpv4SocketAddr(addr) {
    const separator = addr.lastIndexOf(":");
    if (separator <= 0 || addr.indexOf(":") !== separator)
        return undefined;
    const port = parseReusablePort(addr.slice(separator + 1));
    if (port === undefined)
        return undefined;
    const octetStrings = addr.slice(0, separator).split(".");
    if (octetStrings.length !== 4)
        return undefined;
    const octets = octetStrings.map((octet) => Number(octet));
    if (octetStrings.some((octet, index) => (!/^(0|[1-9][0-9]{0,2})$/.test(octet)
        || !Number.isInteger(octets[index])
        || octets[index] > 255)))
        return undefined;
    if (octets.every((octet) => octet === 0))
        return undefined;
    if (octets[0] >= 224 && octets[0] <= 239)
        return undefined;
    const canonical = `${octets.join(".")}:${port}`;
    return { canonical, key: canonical };
}
function parseIpv6SocketAddr(addr) {
    const closingBracket = addr.indexOf("]");
    if (closingBracket <= 1 || addr[closingBracket + 1] !== ":")
        return undefined;
    const port = parseReusablePort(addr.slice(closingBracket + 2));
    if (port === undefined)
        return undefined;
    const hostAndScope = addr.slice(1, closingBracket);
    const scopeSeparator = hostAndScope.indexOf("%");
    if (scopeSeparator !== hostAndScope.lastIndexOf("%"))
        return undefined;
    const host = scopeSeparator < 0 ? hostAndScope : hostAndScope.slice(0, scopeSeparator);
    const scope = scopeSeparator < 0
        ? 0
        : parseIpv6Scope(hostAndScope.slice(scopeSeparator + 1));
    if (scope === undefined)
        return undefined;
    let normalizedHost;
    try {
        const urlHost = new URL(`http://[${host}]/`).hostname;
        if (!urlHost.startsWith("[") || !urlHost.endsWith("]"))
            return undefined;
        normalizedHost = urlHost.slice(1, -1).toLowerCase();
    }
    catch {
        return undefined;
    }
    if (normalizedHost === "::" || normalizedHost.startsWith("ff"))
        return undefined;
    const normalizedScope = scope === 0 ? "" : `%${scope}`;
    const canonical = `[${normalizedHost}${normalizedScope}]:${port}`;
    return { canonical, key: canonical };
}
function parseReusablePort(value) {
    if (!/^[0-9]+$/.test(value))
        return undefined;
    const port = Number(value);
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535
        ? port
        : undefined;
}
function parseIpv6Scope(value) {
    if (!/^[0-9]+$/.test(value))
        return undefined;
    const scope = Number(value);
    return Number.isSafeInteger(scope) && scope >= 0 && scope <= 0xffff_ffff
        ? scope
        : undefined;
}
function requireRecord(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} must be a JSON object`);
    }
    return value;
}
function requireExactKeys(value, expectedKeys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${label} has unexpected keys`);
    }
}
function requireCanonicalNpub(value, label) {
    const npub = requireString(value, label);
    try {
        if (encodeNpub(decodeNpub(npub)) !== npub)
            throw new Error("non-canonical npub");
    }
    catch {
        throw new Error(`${label} must be a canonical npub`);
    }
    return npub;
}
function requireTimestamp(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}
function requireString(value, label) {
    if (typeof value !== "string")
        throw new Error(`${label} must be a string`);
    return value;
}
function requireNonEmptyString(value, label) {
    const stringValue = requireString(value, label);
    if (stringValue.length === 0)
        throw new Error(`${label} must not be empty`);
    return stringValue;
}
//# sourceMappingURL=recentPeers.js.map