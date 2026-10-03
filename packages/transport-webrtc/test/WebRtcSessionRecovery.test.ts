import { expect, it, vi } from 'vitest'
import {
  FipsNode, identityFromSecretKey, nodeAddrToHex, toHex,
  type FspSession, type LinkNegotiationMessage,
} from '@fips/core'
import { WebRtcTransport } from '../src/WebRtcTransport.js'
import { BootstrapTransport, PairedPeerConnection } from './WebRtcSessionFixture.js'

interface ObservedSession { fsp: FspSession; currentKBit: boolean }
function session(node: FipsNode, address: Uint8Array): ObservedSession | undefined {
  return Reflect.get(Reflect.get(node, 'sessionManager'), 'sessions').get(nodeAddrToHex(address))
}
const counter = (value: ObservedSession) => Reflect.get(value.fsp, 'txCounter') as bigint
const flush = () => vi.advanceTimersByTimeAsync(0)

it('recovers a lost winning offer on the next authenticated retry while preserving FSP traffic', async () => {
  vi.useFakeTimers()
  PairedPeerConnection.instances = []
  const identities = await Promise.all([1, 2].map(async scalar => {
    const secret = new Uint8Array(32); secret[31] = scalar
    return identityFromSecretKey(secret)
  }))
  identities.sort((a, b) => toHex(a.xOnlyPubkey).localeCompare(toHex(b.xOnlyPubkey)))
  const keys = identities.map(identity => toHex(identity.publicKey))
  const bootstraps = [new BootstrapTransport(), new BootstrapTransport()]
  bootstraps[0]!.other = bootstraps[1]!
  bootstraps[1]!.other = bootstraps[0]!
  const transports = identities.map(() => new WebRtcTransport({
    rtcPeerConnection: PairedPeerConnection as unknown as typeof RTCPeerConnection,
    acceptConnections: true, stunServers: [],
  }))
  const nodes = identities.map((identity, i) => new FipsNode({
    identity, transports: [bootstraps[i]!, transports[i]!],
  }))
  const received: number[][] = [[], []]
  nodes.forEach((node, i) => node.registerService(4242, ({ payload }) => { received[i]!.push(payload[0]!) }))
  const send = async (from: number, value: number) => {
    await nodes[from]!.sendDatagram({ dst: keys[1 - from]!, dstPort: 4242, payload: new Uint8Array([value]) })
    await flush()
  }
  const originalHandler = transports[1]!.handleLinkNegotiation.bind(transports[1])
  let dropped = false
  const gate = vi.spyOn(transports[1]!, 'handleLinkNegotiation').mockImplementation(async (key, message) => {
    // The signaling write succeeds locally, but its peer never receives it.
    if (!dropped && message.kind === 'offer') { dropped = true; return }
    await originalHandler(key, message)
  })
  const operations: Promise<unknown>[] = []
  try {
    await Promise.all(nodes.map(node => node.start()))
    await nodes[0]!.connect({ transport: 'bootstrap', addr: keys[1]! })
    await send(0, 10)
    await send(1, 11)
    const original = nodes.map((node, i) => session(node, identities[1 - i]!.nodeAddr)!)
    const started = Date.now()
    const winningDial = nodes[0]!.connect({ transport: 'webrtc', addr: keys[1]! })
      .then(() => 'connected', error => (error as Error).message)
    operations.push(winningDial)
    await flush()
    expect(dropped).toBe(true)
    const firstRetry = nodes[1]!.connect({ transport: 'webrtc', addr: keys[0]! })
      .then(() => 'connected', error => (error as Error).message)
    operations.push(firstRetry)
    await flush()
    expect(await firstRetry).toBe('peer rejected')
    const nextRetry = nodes[1]!.connect({ transport: 'webrtc', addr: keys[0]! })
      .then(() => 'connected', error => (error as Error).message)
    operations.push(nextRetry)
    await flush()
    expect(PairedPeerConnection.instances).toHaveLength(4)
    expect(await winningDial).toBe('incoming WebRTC offer won simultaneous dial')
    PairedPeerConnection.instances[2]!.openPair()
    await flush()
    expect(await nextRetry).toBe('connected')
    expect(Date.now() - started).toBeLessThan(1_000)
    bootstraps.forEach(bootstrap => bootstrap.disconnect())
    await send(0, 20)
    await send(1, 21)
    expect(received).toEqual([[11, 21], [10, 20]])
    nodes.forEach((node, i) => {
      expect(session(node, identities[1 - i]!.nodeAddr)).toBe(original[i])
      expect(original[i]!.fsp.state).toBe('established')
    })
  } finally {
    gate.mockRestore()
    await Promise.all(nodes.map(node => node.stop()))
    await vi.runOnlyPendingTimersAsync()
    await Promise.allSettled(operations)
    vi.useRealTimers()
  }
})

it('keeps the end-to-end session and bidirectional traffic after a delayed crossed RTC offer', async () => {
  vi.useFakeTimers()
  PairedPeerConnection.instances = []
  const identities = await Promise.all([1, 2].map(async scalar => {
    const secret = new Uint8Array(32); secret[31] = scalar
    return identityFromSecretKey(secret)
  }))
  // Higher x-only identity yields its pending dial to the lower identity.
  identities.sort((a, b) => toHex(a.xOnlyPubkey).localeCompare(toHex(b.xOnlyPubkey)))
  const keys = identities.map(identity => toHex(identity.publicKey))
  const bootstraps = [new BootstrapTransport(), new BootstrapTransport()]
  bootstraps[0]!.other = bootstraps[1]!
  bootstraps[1]!.other = bootstraps[0]!
  const transports = identities.map(() => new WebRtcTransport({
    rtcPeerConnection: PairedPeerConnection as unknown as typeof RTCPeerConnection,
    acceptConnections: true, stunServers: [],
  }))
  const nodes = identities.map((identity, i) => new FipsNode({
    identity, transports: [bootstraps[i]!, transports[i]!],
  }))
  const received: number[][] = [[], []]
  const errors: Error[] = []
  const closed: unknown[] = []
  nodes.forEach((node, i) => {
    node.registerService(4242, ({ payload }) => { received[i]!.push(payload[0]!) })
    node.on('error', event => errors.push((event as { err: Error }).err))
    node.on('session', event => { if ((event as { state: string }).state === 'closed') closed.push(event) })
  })
  const send = async (from: number, value: number) => {
    await nodes[from]!.sendDatagram({ dst: keys[1 - from]!, dstPort: 4242, payload: new Uint8Array([value]) })
    await flush()
  }
  const deliverSignal = transports[0]!.handleLinkNegotiation.bind(transports[0])
  let held: { key: string; message: LinkNegotiationMessage } | undefined
  const gate = vi.spyOn(transports[0]!, 'handleLinkNegotiation').mockImplementation(async (key, message) => {
    if (!held && message.kind === 'offer') {
      held = { key, message: structuredClone(message) }
      return
    }
    await deliverSignal(key, message)
  })
  const operations: Promise<unknown>[] = []
  try {
    await Promise.all(nodes.map(node => node.start()))
    await nodes[0]!.connect({ transport: 'bootstrap', addr: keys[1]! })
    await send(0, 10)
    await send(1, 11)
    expect(received).toEqual([[11], [10]])
    const original = nodes.map((node, i) => session(node, identities[1 - i]!.nodeAddr)!)
    expect(original.every(value => value?.fsp.state === 'established')).toBe(true)

    // Hold B's real, authenticated offer after FSP has delivered it. Its send
    // completes, so A's later winning offer can cancel B's outgoing RTC PC.
    const losingDial = transports[1]!.connect({ transport: 'webrtc', addr: keys[0]! })
      .then(() => 'connected', error => (error as Error).message)
    operations.push(losingDial)
    await flush()
    expect(held?.message.kind).toBe('offer')
    expect(PairedPeerConnection.instances).toHaveLength(1)
    const winningDial = nodes[0]!.connect({ transport: 'webrtc', addr: keys[1]! })
      .then(() => 'connected', error => (error as Error).message)
    operations.push(winningDial)
    await flush()
    expect(await losingDial).toBe('incoming WebRTC offer won simultaneous dial')
    expect(PairedPeerConnection.instances).toHaveLength(3)
    expect(PairedPeerConnection.instances[0]!.connectionState).toBe('closed')
    PairedPeerConnection.instances[1]!.openPair()
    await flush()
    expect(await winningDial).toBe('connected')

    // Remove the bootstrap normally, only after real FMP establishes on RTC.
    // An alternate path to the same identity must not mask a spurious close.
    bootstraps.forEach(bootstrap => bootstrap.disconnect())
    for (const node of nodes) {
      const peers = [...Reflect.get(node, 'peers').values()] as { remoteAddr: { transport: string }; link: { state: string } }[]
      expect(peers.map(peer => [peer.remoteAddr.transport, peer.link.state])).toEqual([['webrtc', 'established']])
    }
    await send(0, 20)
    await send(1, 21)
    expect(received).toEqual([[11, 21], [10, 20]])
    const before = original.map(counter)
    expect(closed).toEqual([])
    expect(errors).toEqual([])

    gate.mockRestore()
    const delayedOffer = deliverSignal(held!.key, held!.message).catch(error => error)
    operations.push(delayedOffer)
    await flush()
    // This is the intended old-runtime failure, before a replacement timeout
    // or a new handshake can obscure the lost end-to-end session.
    nodes.forEach((node, i) => {
      expect(session(node, identities[1 - i]!.nodeAddr), 'delayed offer must preserve the established FSP session').toBe(original[i])
      expect(original[i]!.fsp.state).toBe('established')
      expect(original[i]!.currentKBit).toBe(false)
      expect(counter(original[i]!)).toBeGreaterThanOrEqual(before[i]!)
    })
    await send(0, 30)
    await send(1, 31)
    expect(received).toEqual([[11, 21, 31], [10, 20, 30]])
    original.forEach((value, i) => expect(counter(value)).toBeGreaterThan(before[i]!))
    expect(closed).toEqual([])
    expect(errors).toEqual([])
    expect(await delayedOffer).toBeUndefined()
  } finally {
    gate.mockRestore()
    await Promise.all(nodes.map(node => node.stop()))
    // Settle only owned cleanup/retry work after both real nodes have stopped.
    await vi.runOnlyPendingTimersAsync()
    await Promise.allSettled(operations)
    vi.useRealTimers()
  }
})
