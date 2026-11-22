import type { FipsIdentity } from "../identity/index.js";
import type { Logger, Transport, TransportAddress } from "../transport/types.js";

export interface ServiceContext {
  /** Authenticated remote Nostr public key (64 lowercase hex digits). */
  peerId: string;
  src: string;       // remote pubkey hex
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
  reply: (data: Uint8Array, replyDstPort?: number) => Promise<void>;
}

export type FipsServiceHandler = (ctx: ServiceContext) => Promise<void> | void;

export interface ServiceRegistration {
  port: number;
  handler: FipsServiceHandler;
}

export interface RandomSource {
  bytes(n: number): Uint8Array;
}

export interface Clock {
  nowMs(): number;
}

export interface FipsNodeConfig {
  identity: FipsIdentity;
  transports: Transport[];
  forwarding?: boolean;
  /** Never publish topology or fall back to a router role. Incompatible with forwarding. */
  strictClient?: boolean;
  /** Block x-only or compressed hex identities on every carrier and end-to-end session. */
  blockedPeerPubkeys?: readonly string[];
  /** Matches Rust fips-core's `node.routing.mode`. Defaults to `tree`. */
  routingMode?: "tree" | "reply_learned";
  /** Explicit next-hop peer pubkey for destinations without a direct link. */
  defaultRoute?: string;
  services?: ServiceRegistration[];
  clock?: Clock;
  random?: RandomSource;
  logger?: Logger;
  /** Authenticated adjacent-link heartbeat cadence. Defaults to 5 seconds. */
  heartbeatIntervalMs?: number;
}

export interface FipsEventMap {
  peer: PeerEvent;
  route: unknown;
  session: SessionEvent;
  datagram: DatagramEvent;
  endpointData: EndpointDataEvent;
  error: ErrorEvent;
}

export type FipsEventName = keyof FipsEventMap;

export interface PeerEvent {
  /** Authenticated remote Nostr public key (64 lowercase hex digits). */
  peerId: string;
  remotePubkey: string;
  remoteAddr: TransportAddress;
  state: "connected" | "disconnected";
}

export interface DatagramEvent {
  /** Authenticated remote Nostr public key (64 lowercase hex digits). */
  peerId: string;
  src: string;       // remote pubkey hex
  dst: string;       // local pubkey hex
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export interface EndpointDataEvent {
  /** Authenticated remote Nostr public key (64 lowercase hex digits). */
  peerId: string;
  src: string;       // remote pubkey hex
  dst: string;       // local pubkey hex
  payload: Uint8Array;
}

export interface SessionEvent {
  /** Authenticated remote Nostr public key. Absent until the handshake proves the peer's identity. */
  peerId?: string;
  remotePubkey: string;
  state: "establishing" | "established" | "closed";
  /** A fresh authenticated process epoch replaced the previous endpoint keys. */
  restarted?: boolean;
}

export interface ErrorEvent {
  err: Error;
  where: string;
}
