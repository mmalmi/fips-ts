import { expect, it, vi } from 'vitest'
import {
  FipsNode, FSP_MSG_KEEPALIVE, FSP_PHASE_ESTABLISHED, identityFromSecretKey, nodeAddrToHex, toHex,
  type FipsIdentity, type FspSession, type LinkNegotiationMessage, type SessionDatagram,
  type Transport, type TransportAddress, type TransportContext,
} from '@fips/core'
import { WebRtcTransport, type NostrEvent, type NostrFilter, type NostrRelayClient } from '../src/index.js'
import { PairedPeerConnection } from './WebRtcSessionFixture.js'

// Physical carriers and the public advert relay are simulated. FMP, FSP,
// signed discovery, initiator selection, reconnect timers and offers are real.
class SeedCarrier implements Transport {
  readonly type = 'websocket'
  readonly mtu = 1400
  private ctx?: TransportContext
  constructor(private network: Map<string, SeedCarrier>) {}
  async start(ctx: TransportContext) {
    this.ctx = ctx
    this.network.set(toHex(ctx.localIdentity.publicKey), this)
  }
  async stop() {
    if (!this.ctx) return
    const addr = toHex(this.ctx.localIdentity.publicKey)
    this.network.delete(addr)
    this.ctx = undefined
    for (const carrier of this.network.values()) {
      carrier.ctx?.onConnectionState?.({ remoteAddr: { transport: this.type, addr }, state: 'disconnected' })
    }
  }
  async connect() {}
  async send(address: TransportAddress, data: Uint8Array) {
    const remote = this.network.get(address.addr)
    if (!this.ctx || !remote?.ctx) throw new Error('seed carrier unavailable')
    remote.ctx.onPacket({ transportType: this.type,
      remoteAddr: { transport: this.type, addr: toHex(this.ctx.localIdentity.publicKey) },
      data: data.slice(), receivedAtMs: Date.now() })
  }
}

class AdvertRelay {
  readonly url = 'ws://reload.test/'
  private events = new Map<string, NostrEvent>()
  private handlers = new Set<(event: NostrEvent) => void>()
  async publish(event: NostrEvent) {
    this.events.set(event.pubkey, event)
    for (const handler of this.handlers) handler(event)
  }
  async subscribe(_filter: NostrFilter, callbacks: { onEvent: (event: NostrEvent) => void }) {
    this.handlers.add(callbacks.onEvent)
    for (const event of this.events.values()) callbacks.onEvent(event)
    return () => { this.handlers.delete(callbacks.onEvent) }
  }
}

interface ObservedSession { fsp: FspSession; currentKBit: boolean }
const session = (node: FipsNode, identity: FipsIdentity): ObservedSession | undefined =>
  Reflect.get(Reflect.get(node, 'sessionManager'), 'sessions').get(nodeAddrToHex(identity.nodeAddr))
const flush = () => vi.advanceTimersByTimeAsync(0)
const openNegotiatedPairs = () => {
  for (const pc of PairedPeerConnection.instances) {
    if (pc.connectionState === 'new' && pc.remoteDescription?.type === 'answer') pc.openPair()
  }
}
const hasRtc = (node: FipsNode) => [...Reflect.get(node, 'peers').values()]
  .some(peer => peer.remoteAddr.transport === 'webrtc' && peer.link.state === 'established')

it.each([
  { restarted: 0, resolutionDelay: 0, departingOrigin: false },
  { restarted: 1, resolutionDelay: 0, departingOrigin: false },
  { restarted: 0, resolutionDelay: 5, departingOrigin: false },
  { restarted: 1, resolutionDelay: 5, departingOrigin: false },
  { restarted: 0, resolutionDelay: 0, departingOrigin: true },
  { restarted: 1, resolutionDelay: 0, departingOrigin: true },
  { restarted: 0, resolutionDelay: 0, departingOrigin: false, seedReconnectDelay: 2_000 },
  { restarted: 1, resolutionDelay: 0, departingOrigin: false, seedReconnectDelay: 2_000 },
])('reconnects sorted identity $restarted after reload (identity lookup delay $resolutionDelay ms, departing origin $departingOrigin, seed gap $seedReconnectDelay)', async ({ restarted, resolutionDelay, departingOrigin, seedReconnectDelay = 0 }) => {
  vi.useFakeTimers()
  PairedPeerConnection.instances = []
  const identities = await Promise.all([1, 2, 3].map(async scalar => {
    const secret = new Uint8Array(32); secret[31] = scalar
    return identityFromSecretKey(secret)
  }))
  const seedIdentity = departingOrigin
    ? await identityFromSecretKey(new Uint8Array(32).fill(4)) : identities.pop()!
  const originIdentity = departingOrigin ? identities.shift() : undefined
  identities.sort((a, b) => toHex(a.xOnlyPubkey).localeCompare(toHex(b.xOnlyPubkey)))
  const network = new Map<string, SeedCarrier>()
  const relay = new AdvertRelay()
  const active: FipsNode[] = []
  const errors: unknown[] = []
  const recoveryPhases: string[] = []
  let gapArmed = false
  let gapUntil: number | undefined
  const offerWrites: { from: string; to: string; signal: LinkNegotiationMessage; at: number; succeeded: boolean }[] = []
  const offerReads: { from: string; to: string; signal: LinkNegotiationMessage; at: number }[] = []
  const seedDrops: { from: string; to: string; at: number }[] = []
  const makePeer = (identity: FipsIdentity) => {
    const transport = new WebRtcTransport({
      rtcPeerConnection: PairedPeerConnection as unknown as typeof RTCPeerConnection,
      relays: [relay.url], relayClients: [relay as unknown as NostrRelayClient],
      autoConnect: true, advertiseOnNostr: true, acceptConnections: true, stunServers: [],
    })
    if (seedReconnectDelay) {
      const start = transport.start.bind(transport)
      vi.spyOn(transport, 'start').mockImplementation(context => start({
        ...context,
        sendLinkNegotiation: async (to, signal) => {
          if (!gapArmed || signal.kind !== 'offer') {
            await context.sendLinkNegotiation!(to, signal)
            return
          }
          gapUntil ??= Date.now() + seedReconnectDelay
          const write = { from: toHex(identity.publicKey), to, signal, at: Date.now(), succeeded: false }
          offerWrites.push(write)
          await context.sendLinkNegotiation!(to, signal)
          write.succeeded = true
        },
      }))
      const receive = transport.handleLinkNegotiation.bind(transport)
      vi.spyOn(transport, 'handleLinkNegotiation').mockImplementation(async (from, signal) => {
        if (gapArmed && signal.kind === 'offer') {
          offerReads.push({ from, to: toHex(identity.publicKey), signal, at: Date.now() })
        }
        await receive(from, signal)
      })
    }
    const node = new FipsNode({ identity, transports: [new SeedCarrier(network), transport],
      forwarding: !departingOrigin, routingMode: 'reply_learned' })
    node.on('error', event => errors.push(event))
    const onSession = transport.handleSessionEstablished.bind(transport)
    vi.spyOn(transport, 'handleSessionEstablished').mockImplementation((key, restarted) => {
      if (restarted) {
        for (const dial of Reflect.get(transport, 'pendingDials').values()) recoveryPhases.push(dial.phase)
      }
      onSession(key, restarted)
    })
    const received: number[] = []
    node.registerService(4242, ({ payload }) => { received.push(payload[0]!) })
    active.push(node)
    return { node, transport, received }
  }
  const seed = new FipsNode({ identity: seedIdentity, transports: [new SeedCarrier(network)],
    forwarding: true, routingMode: 'reply_learned' })
  active.push(seed)
  const seedErrors: unknown[] = []
  seed.on('error', event => seedErrors.push(event))
  if (seedReconnectDelay) {
    const routing = Reflect.get(seed, 'routing')
    const forward = routing.sendSessionDatagram.bind(routing)
    const peerNodes = new Set(identities.map(identity => nodeAddrToHex(identity.nodeAddr)))
    // Inject a missing seed forwarding edge for two seconds in either reload
    // role. Handshake frames still pass, so an FSP write can succeed while its
    // encrypted offer is lost at the transit, independent of who restarted.
    routing.sendSessionDatagram = async (datagram: SessionDatagram, previousHop?: unknown) => {
      const from = nodeAddrToHex(datagram.srcAddr)
      const to = nodeAddrToHex(datagram.destAddr)
      if (previousHop && gapUntil !== undefined && Date.now() < gapUntil
        && peerNodes.has(from) && peerNodes.has(to)
        && (datagram.payload[0]! & 0x0f) === FSP_PHASE_ESTABLISHED) {
        seedDrops.push({ from, to, at: Date.now() })
        throw new Error(`no route to ${to}`)
      }
      await forward(datagram, previousHop)
    }
  }
  const origin = originIdentity ? makePeer(originIdentity) : undefined
  const peers = identities.map(makePeer)
  const connectSeed = (node: FipsNode) => node.connect({ transport: 'websocket', addr: toHex(seedIdentity.publicKey) })
  const send = async (from: number, value: number) => {
    await peers[from]!.node.sendDatagram({ dst: toHex(identities[1 - from]!.publicKey),
      dstPort: 4242, payload: new Uint8Array([value]) })
    await flush()
  }
  try {
    await seed.start()
    for (const peer of [...(origin ? [origin] : []), ...peers]) {
      await peer.node.start(); await connectSeed(peer.node)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    openNegotiatedPairs()
    await flush()
    expect(peers.every(peer => hasRtc(peer.node))).toBe(true)
    await send(0, 10)
    await send(1, 11)
    expect(peers.map(peer => peer.received)).toEqual([[11], [10]])
    const survivor = 1 - restarted
    const old = session(peers[survivor]!.node, identities[restarted]!)!
    const oldKeys = old.fsp
    if (origin) await origin.node.stop()
    await peers[restarted]!.node.stop()
    // Losing the direct carrier alone is not evidence of a process restart.
    expect(oldKeys.state).toBe('established')
    peers[restarted] = makePeer(identities[restarted]!)
    if (resolutionDelay) {
      const transport = peers[restarted]!.transport
      const resolve = transport.resolve.bind(transport)
      vi.spyOn(transport, 'resolve').mockImplementation(async (...args) => {
        const result = await resolve(...args)
        await new Promise(done => { setTimeout(done, resolutionDelay) })
        return result
      })
    }
    gapArmed = seedReconnectDelay > 0
    await peers[restarted]!.node.start()
    await connectSeed(peers[restarted]!.node)
    if (origin) {
      // A surviving process may send an old warmup before the reloaded peer
      // starts its offer. Its cached coordinates are not a usable reply route.
      const staleWarmup = oldKeys.encryptMessage(FSP_MSG_KEEPALIVE, new Uint8Array(), 0, {
        srcCoords: [identities[survivor]!.nodeAddr], destCoords: [identities[restarted]!.nodeAddr],
      })
      await Reflect.get(peers[survivor]!.node, 'routing')
        .sendFspToward(identities[restarted]!.nodeAddr, staleWarmup)
      await flush()
    }
    const start = Date.now()
    for (let elapsed = 0; elapsed < 10_000 && !peers.every(peer => hasRtc(peer.node)); elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250)
      openNegotiatedPairs()
      await flush()
    }
    expect(peers.every(peer => hasRtc(peer.node)), 'both peers must reconnect without application traffic').toBe(true)
    expect(Date.now() - start).toBeLessThan(10_000)
    if (seedReconnectDelay) {
      const first = offerWrites[0]!
      expect(first, 'a recovery offer must actually be written').toBeDefined()
      expect(first.succeeded).toBe(true)
      const sender = identities.find(identity => toHex(identity.publicKey).slice(2) === first.from.slice(2))!
      const target = identities.find(identity => toHex(identity.publicKey).slice(2) === first.to.slice(2))!
      expect(seedDrops.some(drop => drop.from === nodeAddrToHex(sender.nodeAddr)
        && drop.to === nodeAddrToHex(target.nodeAddr) && drop.at >= first.at)).toBe(true)
      expect(seedErrors.some(event => String((event as { err: Error }).err).includes('no route to'))).toBe(true)
      expect(offerReads.filter(read => read.signal.negotiationId === first.signal.negotiationId
        && read.at < gapUntil!)).toEqual([])
      expect(offerWrites.some(write => write !== first && write.succeeded && write.at >= gapUntil!
        && write.signal.negotiationId === first.signal.negotiationId
        && JSON.stringify(write.signal.payload) === JSON.stringify(first.signal.payload))).toBe(true)
      expect(offerReads.some(read => read.at >= gapUntil!
        && read.signal.negotiationId === first.signal.negotiationId
        && JSON.stringify(read.signal.payload) === JSON.stringify(first.signal.payload))).toBe(true)
    }
    expect(oldKeys.state).toBe('closed')
    if (restarted === 1 && !origin) {
      if (seedReconnectDelay) {
        expect(recoveryPhases.some(phase => ['sending-offer', 'awaiting-answer'].includes(phase))).toBe(true)
      } else {
        expect(recoveryPhases).toContain(resolutionDelay ? 'awaiting-answer' : 'sending-offer')
      }
    }
    expect(session(peers[survivor]!.node, identities[restarted]!)!.fsp).not.toBe(oldKeys)
    await send(0, 20)
    await send(1, 21)
    expect(peers[0]!.received.at(-1)).toBe(21)
    expect(peers[1]!.received.at(-1)).toBe(20)
    expect(errors).toEqual([])
  } finally {
    await Promise.all(active.map(node => node.stop()))
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  }
})
