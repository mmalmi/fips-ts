import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink, type FmpHandshakeResult } from "../fmp/link.js";
import {
  DirectFspTransportReassembler,
  isDirectFspTransportFragment,
} from "../fsp/directTransport.js";
import { isDirectFspEstablished } from "../fsp/wire.js";
import type { FipsIdentity } from "../identity/index.js";
import { compareNodeAddr, deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import {
  decodeFmpEstablished,
  decodeFmpMsg2,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  peekFmpPhase,
} from "../fmp/wire.js";
import {
  transportAddressKey,
  type Logger,
  type ReceivedTransportPacket,
  type Transport,
  type TransportAddress,
} from "../transport/types.js";

import type { FipsRouting } from "./FipsRouting.js";
import type { FspSessionManager } from "./FspSessionManager.js";
import type { AdjacentPeer } from "./PeerState.js";
import type { PeerEvent } from "./types.js";

let sessionIdxCounter = 1;

export function nextSessionIdx(): number {
  const value = sessionIdxCounter++;
  return value >>> 0;
}

const FMP_REPLACED_LINK_DRAIN_MS = 10_000;

interface FmpTransportPacketProcessorConfig {
  identity: FipsIdentity;
  startupEpoch: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
  logger: Logger;
  peers: Map<string, AdjacentPeer>;
  peersByPubkey: Map<string, AdjacentPeer>;
  peersByNodeAddr: Map<string, AdjacentPeer>;
  routing: FipsRouting;
  sessionManager: FspSessionManager;
  emitError: (error: Error, where: string) => void;
  emitPeer: (event: PeerEvent) => void;
}

export class FmpTransportPacketProcessor {
  private readonly reassembler = new DirectFspTransportReassembler();

  constructor(private readonly cfg: FmpTransportPacketProcessorConfig) {}

  clear(): void {
    this.reassembler.clear();
  }

  process(transport: Transport, received: ReceivedTransportPacket): void {
    try {
      const key = transportAddressKey(received.remoteAddr);
      const peer = this.cfg.peers.get(key)
        ?? this.findXOnlyTransportPeer(transport, received.remoteAddr);
      let packet = received.data;
      if (isDirectFspTransportFragment(packet)) {
        if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
          throw new Error("direct FSP fragment before adjacent link handshake complete");
        }
        const reassembled = this.reassembler.ingest(key, packet, received.receivedAtMs);
        if (!reassembled) return;
        packet = reassembled;
      }
      if (isDirectFspEstablished(packet)) {
        if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
          throw new Error("direct FSP before adjacent link handshake complete");
        }
        void this.cfg.sessionManager
          .handleFromPeer(peer, deriveNodeAddr(peer.pubkey), packet)
          .catch((error) => this.cfg.emitError(error as Error, "direct-fsp"));
        return;
      }
      const phase = peekFmpPhase(packet);
      this.cfg.logger.debug(
        "fips packet received",
        received.remoteAddr.transport,
        received.remoteAddr.addr,
        packet.length,
        phase,
      );
      if (phase === FMP_PHASE_MSG1) {
        this.handleMsg1(transport, received.remoteAddr, key, peer, packet);
        return;
      }
      if (phase === FMP_PHASE_MSG2) {
        this.handleMsg2(received.remoteAddr, peer, packet);
        return;
      }
      if (phase === FMP_PHASE_ESTABLISHED) {
        this.handleEstablished(received.remoteAddr, peer, packet);
        return;
      }
      throw new Error(`unknown FMP phase ${phase}`);
    } catch (error) {
      this.cfg.emitError(error as Error, "onTransportPacket");
      this.cfg.logger.warn("transport packet error", error);
    }
  }

  private handleMsg1(
    transport: Transport,
    remoteAddr: TransportAddress,
    key: string,
    initialPeer: AdjacentPeer | undefined,
    packet: Uint8Array,
  ): void {
    const prepared = this.prepareMsg1Peer(transport, remoteAddr, key, initialPeer);
    if (!prepared) return;
    let { peer } = prepared;
    const {
      peerEpochBeforeMsg1,
      replacedEstablishedInitiator,
      replacedHandshake,
      stageEstablishedInitiator,
    } = prepared;
    let wasEstablished = replacedEstablishedInitiator || peer.link.state === "established";
    let result: FmpHandshakeResult;
    let handshakeLink: FmpLink;
    if (stageEstablishedInitiator) {
      result = this.stageResponderReplacement(peer, packet);
      handshakeLink = peer.pendingResponderLink!;
      this.cfg.logger.debug(
        "staged responder link for established initiator",
        remoteAddr.transport,
        remoteAddr.addr,
      );
    } else if (peer.link.state === "established") {
      try {
        result = peer.link.handleMsg1(packet, this.cfg.randomBytes);
        handshakeLink = peer.link;
      } catch (error) {
        if (!(error instanceof Error)
          || error.message !== "unexpected FMP Msg1 after establishment") {
          throw error;
        }
        result = this.stageResponderReplacement(peer, packet);
        handshakeLink = peer.pendingResponderLink!;
        this.cfg.logger.debug(
          "staged responder link after fresh authenticated Msg1",
          remoteAddr.transport,
          remoteAddr.addr,
        );
      }
    } else {
      result = peer.link.handleMsg1(packet, this.cfg.randomBytes);
      handshakeLink = peer.link;
    }
    const remotePubkeyHex = toHex(result.remotePubkey);
    const previousRemoteEpoch = peerEpochBeforeMsg1
      ?? this.establishedRemoteEpoch(remotePubkeyHex, handshakeLink);
    if (
      previousRemoteEpoch
      && handshakeLink.remoteEpoch
      && !bytesEqual(previousRemoteEpoch, handshakeLink.remoteEpoch)
    ) {
      this.removeRestartedPeerPaths(remotePubkeyHex, handshakeLink, replacedHandshake);
      peer = {
        pubkey: result.remotePubkey,
        pubkeyHex: remotePubkeyHex,
        remoteAddr,
        transport,
        link: handshakeLink,
      };
      this.cfg.peers.set(key, peer);
      wasEstablished = false;
      this.cfg.logger.info("FMP peer restart detected", remotePubkeyHex);
    }
    peer.pubkey = result.remotePubkey;
    peer.pubkeyHex = remotePubkeyHex;
    this.rememberPeer(peer);
    if (result.reply) {
      void transport.send(remoteAddr, result.reply).catch((error) => {
        this.cfg.emitError(error as Error, "send Msg2");
      });
      this.cfg.logger.debug(
        "fips msg2 sent",
        remoteAddr.transport,
        remoteAddr.addr,
        result.reply.length,
      );
    }
    if (replacedHandshake) {
      peer.outgoingHandshake = undefined;
      replacedHandshake.resolve();
    }
    if (!wasEstablished) {
      this.cfg.emitPeer({
        remotePubkey: peer.pubkeyHex,
        remoteAddr: peer.remoteAddr,
        state: "connected",
      });
    }
  }

  private prepareMsg1Peer(
    transport: Transport,
    remoteAddr: TransportAddress,
    key: string,
    initialPeer: AdjacentPeer | undefined,
  ): {
    peer: AdjacentPeer;
    peerEpochBeforeMsg1?: Uint8Array;
    replacedEstablishedInitiator: boolean;
    replacedHandshake?: AdjacentPeer["outgoingHandshake"];
    stageEstablishedInitiator: boolean;
  } | undefined {
    let peer = initialPeer;
    const peerEpochBeforeMsg1 = peer?.link.remoteEpoch?.slice();
    let replacedEstablishedInitiator = false;
    let replacedHandshake: AdjacentPeer["outgoingHandshake"];
    let stageEstablishedInitiator = false;
    if (peer?.link.role === "initiator" && peer.outgoingHandshake) {
      if (peer.pubkey.length === 0) {
        throw new Error("outbound FMP peer is missing its expected identity");
      }
      const order = compareNodeAddr(this.cfg.identity.nodeAddr, deriveNodeAddr(peer.pubkey));
      if (order < 0) {
        this.cfg.logger.debug(
          "simultaneous FMP handshake: local initiator wins",
          remoteAddr.transport,
          remoteAddr.addr,
        );
        return undefined;
      }
      if (order === 0) throw new Error("simultaneous FMP handshake with local identity");
      replacedEstablishedInitiator = peer.link.state === "established";
      peer.abandonedInitiatorSessionIdx = peer.link.localSessionIdx;
      replacedHandshake = peer.outgoingHandshake;
      peer.link.close();
      peer.link = this.newResponderLink();
      this.cfg.logger.debug(
        "simultaneous FMP handshake: remote initiator wins",
        remoteAddr.transport,
        remoteAddr.addr,
      );
    } else if (peer?.link.role === "initiator") {
      stageEstablishedInitiator = true;
    }
    if (!peer) {
      peer = {
        pubkey: new Uint8Array(0),
        pubkeyHex: "",
        remoteAddr,
        transport,
        link: this.newResponderLink(),
      };
      this.cfg.peers.set(key, peer);
    }
    return {
      peer,
      peerEpochBeforeMsg1,
      replacedEstablishedInitiator,
      replacedHandshake,
      stageEstablishedInitiator,
    };
  }

  private handleMsg2(
    remoteAddr: TransportAddress,
    peer: AdjacentPeer | undefined,
    packet: Uint8Array,
  ): void {
    if (!peer) throw new Error("FMP Msg2 with no peer state");
    if (peer.link.role === "responder" && peer.abandonedInitiatorSessionIdx !== undefined) {
      const msg2 = decodeFmpMsg2(packet);
      if (msg2.receiverIdx === peer.abandonedInitiatorSessionIdx) {
        peer.abandonedInitiatorSessionIdx = undefined;
        this.cfg.logger.debug(
          "ignored Msg2 for abandoned simultaneous FMP initiator",
          remoteAddr.transport,
          remoteAddr.addr,
        );
        return;
      }
    }
    const wasEstablished = peer.link.state === "established";
    const previousRemoteEpoch = this.establishedRemoteEpoch(peer.pubkeyHex, peer.link);
    const restartedHandshake = peer.outgoingHandshake;
    peer.link.handleMsg2(packet);
    peer.pubkey = peer.link.remotePubkey!;
    peer.pubkeyHex = toHex(peer.link.remotePubkey!);
    if (
      previousRemoteEpoch
      && peer.link.remoteEpoch
      && !bytesEqual(previousRemoteEpoch, peer.link.remoteEpoch)
    ) {
      this.removeRestartedPeerPaths(peer.pubkeyHex, peer.link, restartedHandshake);
      this.cfg.peers.set(transportAddressKey(peer.remoteAddr), peer);
      this.cfg.logger.info("FMP peer restart detected", peer.pubkeyHex);
    }
    this.rememberPeer(peer);
    if (!wasEstablished) {
      this.cfg.emitPeer({
        remotePubkey: peer.pubkeyHex,
        remoteAddr: peer.remoteAddr,
        state: "connected",
      });
      peer.outgoingHandshake?.resolve();
      peer.outgoingHandshake = undefined;
      this.cfg.routing.scheduleTreeAnnounce(peer);
    }
    this.cfg.logger.debug("fips msg2 handled", remoteAddr.transport, remoteAddr.addr);
  }

  private handleEstablished(
    remoteAddr: TransportAddress,
    peer: AdjacentPeer | undefined,
    packet: Uint8Array,
  ): void {
    if (!peer || peer.link.state !== "established") {
      throw new Error("FMP Established before handshake complete");
    }
    this.pruneDrainingResponderLinks(peer, Date.now());
    const receiverIdx = decodeFmpEstablished(packet).receiverIdx;
    let link = peer.link;
    let promotePending = false;
    if (receiverIdx !== link.localSessionIdx) {
      if (peer.pendingResponderLink?.localSessionIdx === receiverIdx) {
        link = peer.pendingResponderLink;
        promotePending = true;
      } else {
        const draining = peer.drainingResponderLinks?.get(receiverIdx);
        if (!draining) {
          const pendingIdx = peer.pendingResponderLink?.localSessionIdx;
          throw new Error(
            `FMP Established receiver_idx mismatch: received=${receiverIdx} active=${peer.link.localSessionIdx}`
            + (pendingIdx === undefined ? "" : ` pending=${pendingIdx}`),
          );
        }
        link = draining.link;
      }
    }
    const { msgType, payload } = link.decryptIncoming(packet);
    this.cfg.routing.scheduleTreeAnnounce(peer);
    if (promotePending) {
      const previous = peer.link;
      peer.link = link;
      peer.pendingResponderLink = undefined;
      const draining = peer.drainingResponderLinks ?? new Map();
      draining.set(previous.localSessionIdx, {
        link: previous,
        expiresAtMs: Date.now() + FMP_REPLACED_LINK_DRAIN_MS,
      });
      peer.drainingResponderLinks = draining;
      this.cfg.logger.debug(
        "promoted authenticated responder link",
        remoteAddr.transport,
        remoteAddr.addr,
        receiverIdx,
      );
    }
    this.cfg.routing.handleLinkMessage(peer, msgType, payload).catch((error) => {
      this.cfg.emitError(error as Error, "link-message");
    });
  }

  private newResponderLink(): FmpLink {
    return new FmpLink({
      identity: this.cfg.identity,
      role: "responder",
      sessionIdx: nextSessionIdx(),
      localEpoch: this.cfg.startupEpoch,
    });
  }

  private rememberPeer(peer: AdjacentPeer): void {
    if (peer.pubkey.length === 0 || !peer.pubkeyHex) return;
    this.cfg.peersByPubkey.set(peer.pubkeyHex, peer);
    this.cfg.peersByNodeAddr.set(nodeAddrToHex(deriveNodeAddr(peer.pubkey)), peer);
  }

  private findXOnlyTransportPeer(
    transport: Transport,
    remoteAddr: TransportAddress,
  ): AdjacentPeer | undefined {
    if (!/^[0-9a-fA-F]{64}$/.test(remoteAddr.addr)) return undefined;
    const xOnly = remoteAddr.addr.toLowerCase();
    for (const peer of this.cfg.peers.values()) {
      if (peer.transport !== transport || peer.pubkey.length !== 33) continue;
      if (peer.pubkeyHex.slice(2).toLowerCase() === xOnly) return peer;
    }
    return undefined;
  }

  private establishedRemoteEpoch(
    remotePubkeyHex: string,
    excludingLink: FmpLink,
  ): Uint8Array | undefined {
    if (!remotePubkeyHex) return undefined;
    for (const candidate of this.cfg.peers.values()) {
      if (
        candidate.pubkeyHex !== remotePubkeyHex
        || candidate.link === excludingLink
        || candidate.link.state !== "established"
        || !candidate.link.remoteEpoch
      ) {
        continue;
      }
      return candidate.link.remoteEpoch.slice();
    }
    return undefined;
  }

  private removeRestartedPeerPaths(
    remotePubkeyHex: string,
    preserveLink: FmpLink,
    preserveHandshake?: AdjacentPeer["outgoingHandshake"],
  ): void {
    let remotePubkey: Uint8Array | undefined;
    for (const [pathKey, candidate] of [...this.cfg.peers]) {
      if (candidate.pubkeyHex !== remotePubkeyHex) continue;
      remotePubkey = candidate.pubkey;
      this.cfg.peers.delete(pathKey);
      if (candidate.link !== preserveLink) candidate.link.close();
      if (candidate.pendingResponderLink !== preserveLink) {
        candidate.pendingResponderLink?.close();
      }
      for (const draining of candidate.drainingResponderLinks?.values() ?? []) {
        if (draining.link !== preserveLink) draining.link.close();
      }
      if (candidate.outgoingHandshake && candidate.outgoingHandshake !== preserveHandshake) {
        candidate.outgoingHandshake.reject(new Error("remote FIPS peer restarted"));
        candidate.outgoingHandshake = undefined;
      }
    }
    this.cfg.peersByPubkey.delete(remotePubkeyHex);
    if (remotePubkey) {
      const remoteNodeAddr = deriveNodeAddr(remotePubkey);
      this.cfg.peersByNodeAddr.delete(nodeAddrToHex(remoteNodeAddr));
      this.cfg.routing.removePeer(remoteNodeAddr);
    }
    this.cfg.sessionManager.closePeerSessions(remotePubkeyHex);
  }

  private stageResponderReplacement(
    peer: AdjacentPeer,
    packet: Uint8Array,
  ): FmpHandshakeResult {
    let replacement = peer.pendingResponderLink;
    if (replacement) {
      try {
        return replacement.handleMsg1(packet, this.cfg.randomBytes);
      } catch (error) {
        if (!(error instanceof Error)
          || error.message !== "unexpected FMP Msg1 after establishment") {
          throw error;
        }
        replacement.close();
        peer.pendingResponderLink = undefined;
      }
    }
    replacement = this.newResponderLink();
    const result = replacement.handleMsg1(packet, this.cfg.randomBytes);
    if (peer.pubkey.length > 0 && !bytesEqual(peer.pubkey, result.remotePubkey)) {
      replacement.close();
      throw new Error("fresh FMP Msg1 changed the authenticated peer identity");
    }
    peer.pendingResponderLink = replacement;
    return result;
  }

  private pruneDrainingResponderLinks(peer: AdjacentPeer, nowMs: number): void {
    if (!peer.drainingResponderLinks) return;
    for (const [receiverIdx, draining] of peer.drainingResponderLinks) {
      if (draining.expiresAtMs > nowMs) continue;
      draining.link.close();
      peer.drainingResponderLinks.delete(receiverIdx);
    }
    if (peer.drainingResponderLinks.size === 0) {
      peer.drainingResponderLinks = undefined;
    }
  }
}
