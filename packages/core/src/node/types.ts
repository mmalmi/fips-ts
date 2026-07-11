import type { FipsIdentity } from "../identity/index.js";
import type { Logger, Transport, TransportAddress } from "../transport/types.js";

export interface ServiceContext {
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

export type FipsEventName = "peer" | "route" | "session" | "datagram" | "endpointData" | "error";

export interface PeerEvent {
  remotePubkey: string;
  remoteAddr: TransportAddress;
  state: "connected" | "disconnected";
}

export interface DatagramEvent {
  src: string;       // remote pubkey hex
  dst: string;       // local pubkey hex
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export interface EndpointDataEvent {
  src: string;       // remote pubkey hex
  dst: string;       // local pubkey hex
  payload: Uint8Array;
}

export interface SessionEvent {
  remotePubkey: string;
  state: "establishing" | "established" | "closed";
}

export interface ErrorEvent {
  err: Error;
  where: string;
}
