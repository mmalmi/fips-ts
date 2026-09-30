import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRtcTransport } from '../src/WebRtcTransport.js'
import { identityFromSecretKey, toHex } from '@fips/core'
import type { WebRtcTransportConfig } from '../src/WebRtcTransportConfig.js'
import { validateWebRtcSignal, type WebRtcSignal } from '../src/WebRtcSignal.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class FakeDataChannel extends EventTarget {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  deferCloseEvents = false
  sent: Uint8Array[] = []
  send(data: Uint8Array) { this.sent.push(new Uint8Array(data)) }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    const notify = () => this.dispatchEvent(new Event('close'))
    if (this.deferCloseEvents) setTimeout(notify, 1)
    else notify()
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = []
  static offerGate: ReturnType<typeof deferred<RTCSessionDescriptionInit>> | undefined
  static localGate: ReturnType<typeof deferred<void>> | undefined
  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'gathering'
  signalingState = 'stable'
  deferCloseEvents = false
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ondatachannel?: (event: { channel: FakeDataChannel }) => void
  channel = new FakeDataChannel()
  setLocalCalls = 0
  private readonly initiator = FakePeerConnection.instances.length === 0

  constructor(readonly configuration?: RTCConfiguration) {
    super()
    FakePeerConnection.instances.push(this)
    if (!this.initiator) this.iceGatheringState = 'complete'
  }

  createDataChannel() { return this.channel }
  async createOffer() {
    return FakePeerConnection.offerGate?.promise ?? { type: 'offer', sdp: 'outgoing-sdp' }
  }
  async createAnswer() { return { type: 'answer', sdp: 'incoming-answer-sdp' } }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.setLocalCalls += 1
    if (this.initiator) await FakePeerConnection.localGate?.promise
    this.localDescription = description
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }
  close() {
    if (this.connectionState === 'closed') return
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.channel.close()
    const notify = () => this.dispatchEvent(new Event('connectionstatechange'))
    if (this.deferCloseEvents) setTimeout(notify, 1)
    else notify()
  }
  finishGathering() {
    this.iceGatheringState = 'complete'
    this.dispatchEvent(new Event('icegatheringstatechange'))
  }
  connectChannel() {
    this.connectionState = 'connected'
    this.iceConnectionState = 'connected'
    this.channel.readyState = 'open'
    this.channel.dispatchEvent(new Event('open'))
    this.channel.dispatchEvent(new MessageEvent('message', {
      data: new Uint8Array([0xff, 0x46, 0x57, 0x52, 0x31]).buffer,
    }))
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

const remote = { transport: 'webrtc', addr: '' }
const transports: WebRtcTransport[] = []
const flush = () => vi.advanceTimersByTimeAsync(0)

async function fixture(
  sendGate?: ReturnType<typeof deferred<void>>,
  localScalar = 2,
  remoteScalar = 1,
  config: Partial<WebRtcTransportConfig> = {},
  send?: (signal: WebRtcSignal) => Promise<void>,
) {
  const secret = (scalar: number) => {
    const bytes = new Uint8Array(32)
    bytes[31] = scalar
    return bytes
  }
  const identities = await Promise.all([remoteScalar, localScalar].map(value => identityFromSecretKey(secret(value))))
  remote.addr = `02${toHex(identities[0]!.xOnlyPubkey)}`
  const sent: WebRtcSignal[] = []
  const states: string[] = []
  const transport = new WebRtcTransport({
    rtcPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
    acceptConnections: true,
    ...config,
  })
  transports.push(transport)
  await transport.start({
    localIdentity: identities[1]!,
    onPacket: vi.fn(),
    onConnectionState: event => states.push(event.state),
    sendLinkNegotiation: async (_peer, signal) => {
      sent.push(signal as WebRtcSignal)
      await send?.(signal as WebRtcSignal)
      if (signal.kind === 'offer') await sendGate?.promise
    },
  })
  const result = transport.connect(remote).then(() => 'connected', error => error.message as string)
  await flush()
  return { transport, sent, states, result }
}

async function incomingWins(transport: WebRtcTransport, negotiationId = 'winning-incoming-offer') {
  await transport.handleLinkNegotiation(remote.addr, {
    version: 1,
    negotiationId,
    linkType: 'webrtc',
    kind: 'offer',
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    payload: { sdp: 'incoming-sdp' },
  })
  const replacement = FakePeerConnection.instances.at(-1)!
  replacement.ondatachannel?.({ channel: replacement.channel })
  await flush()
  replacement.connectChannel()
  await flush()
  return replacement
}

beforeEach(() => {
  vi.useFakeTimers()
  FakePeerConnection.instances = []
  FakePeerConnection.offerGate = undefined
  FakePeerConnection.localGate = undefined
})

describe('WebRTC failed answer route recovery', () => {
  const noRoute = () => new Error('no route to 0123456789abcdef0123456789abcdef')

  it('recovers failed answer writes without replaying a successfully delivered signal', async () => {
    const delivered = new Set<string>()
    let attempts = 0
    const { transport, sent, states } = await fixture(undefined, 2, 1, {}, async signal => {
      if (++attempts <= 2) throw noRoute()
      // Existing peers reject repeated negotiation IDs: only the successful
      // write may reach this unchanged receiver-side replay check.
      validateWebRtcSignal(signal, {
        knownNegotiationIds: new Set(['winning-incoming-offer']),
        seenNegotiationIds: delivered,
        nowMs: Date.now(),
      })
      delivered.add(`${signal.negotiationId}:${signal.kind}`)
    })
    const result = incomingWins(transport).then(() => 'connected', error => error.message)
    await flush()
    const incoming = FakePeerConnection.instances.at(-1)!
    expect(incoming.connectionState).toBe('new')
    await vi.advanceTimersByTimeAsync(999)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await result).toBe('connected')
    expect(states).toEqual(['connected'])
    expect(delivered.size).toBe(1)
    expect(sent).toHaveLength(3)
    expect(sent.every(signal => JSON.stringify(signal) === JSON.stringify(sent[0]))).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(3)
    expect(states).toEqual(['connected'])
  })

  it('bounds unreachable answer retries and keeps the original failure', async () => {
    const { transport, sent } = await fixture(undefined, 2, 1, {}, async () => { throw noRoute() })
    const result = incomingWins(transport).then(() => 'connected', error => error.message)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await result).toBe(noRoute().message)
    expect(sent).toHaveLength(4)
    expect(FakePeerConnection.instances.at(-1)!.connectionState).toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(4)
  })

  it.each(['deadline', 'stop'])('does not retry after the inbound negotiation loses ownership through %s', async reason => {
    const { transport, sent, states } = await fixture(undefined, 2, 1, { connectTimeoutMs: 500 }, async () => { throw noRoute() })
    const result = incomingWins(transport).then(() => 'settled', error => error.message)
    await flush()
    if (reason === 'stop') await transport.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(sent).toHaveLength(1)
    expect(states).not.toContain('connected')
  })

  it('does not retry unrelated answer errors', async () => {
    const { transport, sent } = await fixture(undefined, 2, 1, {}, async () => { throw new Error('invalid session') })
    const result = incomingWins(transport).then(() => 'connected', error => error.message)
    await flush()
    expect(await result).toBe('invalid session')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(1)
  })

  it('does not resend a failed offer to older native admission code', async () => {
    const { sent, result } = await fixture(undefined, 2, 1, {}, async () => { throw noRoute() })
    FakePeerConnection.instances[0].finishGathering()
    await flush()
    expect(await result).toBe(noRoute().message)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.map(signal => signal.kind)).toEqual(['offer'])
  })
})

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop()
  vi.useRealTimers()
})

describe('WebRTC connection configuration', () => {
  const defaultServers = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
  it.each([
    { name: 'omitted settings', config: {}, servers: defaultServers, timeout: 2_000 },
    {
      name: 'undefined settings',
      config: { stunServers: undefined, iceGatherTimeoutMs: undefined },
      servers: defaultServers,
      timeout: 2_000,
    },
    {
      name: 'explicit local-only settings',
      config: { stunServers: [], iceGatherTimeoutMs: 75 },
      servers: [],
      timeout: 75,
    },
    {
      name: 'custom servers and timeout',
      config: { stunServers: ['stun:custom.example:3478'], iceGatherTimeoutMs: 125 },
      servers: ['stun:custom.example:3478'],
      timeout: 125,
    },
  ])('uses $name for outgoing and incoming connections', async ({ config, servers, timeout }) => {
    const { transport, sent } = await fixture(undefined, 2, 1, config)
    const expected = { iceServers: servers.map(urls => ({ urls })) }
    expect(FakePeerConnection.instances[0].configuration).toEqual(expected)
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.map(signal => signal.kind)).toEqual(['offer'])
    const incoming = await incomingWins(transport)
    expect(incoming.configuration).toEqual(expected)
  })
})

describe('WebRTC simultaneous negotiation ownership', () => {
  it.each(['outgoing', 'incoming'])(
    'reports an explicit %s close immediately and preserves its replacement after delayed close events',
    async direction => {
      const { transport, states, result } = await fixture()
      let current = FakePeerConnection.instances[0]
      if (direction === 'outgoing') {
        current.finishGathering()
        await flush()
        current.connectChannel()
        await flush()
        expect(await result).toBe('connected')
      } else {
        current = await incomingWins(transport)
      }
      expect(states).toEqual(['connected'])
      current.deferCloseEvents = true
      current.channel.deferCloseEvents = true

      await transport.close(remote)
      expect(states).toEqual(['connected', 'disconnected'])
      await transport.close(remote)
      expect(states).toEqual(['connected', 'disconnected'])

      const replacement = await incomingWins(transport, 'replacement-after-explicit-close')
      expect(states).toEqual(['connected', 'disconnected', 'connected'])
      await vi.advanceTimersByTimeAsync(1)
      expect(states).toEqual(['connected', 'disconnected', 'connected'])
      await transport.send(remote, new Uint8Array([45]))
      expect(replacement.channel.sent.at(-1)).toEqual(new Uint8Array([45]))
    },
  )

  it.each([[22, 1, false], [1, 22, true], [22, 22, false]] as const)(
    'uses full x-only ordering for local scalar%s versus remote scalar%s',
    async (localScalar: number, remoteScalar: number, accept: boolean) => {
      const { transport, sent } = await fixture(undefined, localScalar, remoteScalar)
      await transport.handleLinkNegotiation(remote.addr, {
        version: 1, negotiationId: 'parity-ordering-offer', linkType: 'webrtc', kind: 'offer',
        createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        payload: { sdp: 'incoming-sdp' },
      })
      expect(sent.map(signal => signal.kind)).toEqual([accept ? 'answer' : 'reject'])
      expect(FakePeerConnection.instances).toHaveLength(accept ? 2 : 1)
    },
  )

  it('does not send a canceled offer or remove the winning connection after slow ICE gathering', async () => {
    const { transport, sent, states, result } = await fixture()
    const replacement = await incomingWins(transport)
    expect(await result).toBe('incoming WebRTC offer won simultaneous dial')
    expect(states).toContain('connected')

    await vi.advanceTimersByTimeAsync(2_000)

    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
    expect(states).not.toContain('failed')
    expect(states).not.toContain('disconnected')
    await transport.send(remote, new Uint8Array([42]))
    expect(replacement.channel.sent.at(-1)).toEqual(new Uint8Array([42]))
  })

  it('stops a canceled createOffer continuation before setting its local description', async () => {
    const gate = deferred<RTCSessionDescriptionInit>()
    FakePeerConnection.offerGate = gate
    const { transport, sent } = await fixture()
    await incomingWins(transport)
    gate.resolve({ type: 'offer', sdp: 'canceled-sdp' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakePeerConnection.instances[0].setLocalCalls).toBe(0)
    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
  })

  it('stops a canceled setLocalDescription continuation', async () => {
    const gate = deferred<void>()
    FakePeerConnection.localGate = gate
    const { transport, sent } = await fixture()
    await incomingWins(transport)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
  })

  it('does not install stale connection callbacks after a pending offer send resolves', async () => {
    const gate = deferred<void>()
    const { transport, sent, states } = await fixture(gate)
    FakePeerConnection.instances[0].finishGathering()
    await flush()
    expect(sent.map(signal => signal.kind)).toEqual(['offer'])
    const replacement = await incomingWins(transport)
    gate.resolve()
    await flush()
    expect(states).not.toContain('failed')
    await transport.send(remote, new Uint8Array([43]))
    expect(replacement.channel.sent.at(-1)).toEqual(new Uint8Array([43]))
  })

  it('ignores close callbacks from an already wired dial when an incoming offer wins', async () => {
    const { transport, states } = await fixture()
    FakePeerConnection.instances[0].finishGathering()
    await flush()
    await incomingWins(transport)
    expect(states).toEqual(['connected'])
    await transport.send(remote, new Uint8Array([44]))
  })

  it('still reports a genuine failure for the current outgoing dial', async () => {
    const { states, result } = await fixture()
    const current = FakePeerConnection.instances[0]
    current.finishGathering()
    await flush()
    current.connectionState = 'failed'
    current.iceConnectionState = 'failed'
    current.dispatchEvent(new Event('connectionstatechange'))
    await flush()
    expect(await result).toBe('webrtc state failed')
    expect(states).toContain('failed')
    expect(current.connectionState).toBe('closed')
  })
})


describe('WebRTC negotiation resource cleanup', () => {
  it.each(['stop', 'reject'])('closes an unfinished outgoing connection on %s', async reason => {
    const { transport, sent, result } = await fixture()
    const pc = FakePeerConnection.instances[0]
    pc.finishGathering()
    await flush()
    if (reason === 'stop') {
      await transport.stop()
    } else {
      await transport.handleLinkNegotiation(remote.addr, {
        ...sent[0], kind: 'reject', payload: {},
      })
    }
    expect(await result).toBe(reason === 'stop' ? 'transport stopped' : 'peer rejected')
    expect(pc.connectionState).toBe('closed')
    expect(pc.channel.readyState).toBe('closed')
  })

  it.each(['stop', 'deadline', 'close'])('closes an incoming channel that never opens on %s', async reason => {
    const { transport, states } = await fixture(undefined, 2, 1, { connectTimeoutMs: 500 })
    await transport.handleLinkNegotiation(remote.addr, {
      version: 1, negotiationId: 'stalled-inbound', linkType: 'webrtc', kind: 'offer',
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      payload: { sdp: 'incoming-sdp' },
    })
    const pc = FakePeerConnection.instances.at(-1)!
    pc.ondatachannel?.({ channel: pc.channel })
    await flush()
    if (reason === 'stop') await transport.stop()
    else if (reason === 'close') await transport.close(remote)
    else await vi.advanceTimersByTimeAsync(500)
    expect(pc.connectionState).toBe('closed')
    expect(pc.channel.readyState).toBe('closed')
    expect(states).not.toContain('connected')
  })

  it('ignores a late incoming data channel after stop', async () => {
    const { transport, states } = await fixture()
    await transport.handleLinkNegotiation(remote.addr, {
      version: 1, negotiationId: 'late-inbound', linkType: 'webrtc', kind: 'offer',
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      payload: { sdp: 'incoming-sdp' },
    })
    const pc = FakePeerConnection.instances.at(-1)!
    await transport.stop()
    pc.ondatachannel?.({ channel: pc.channel })
    await flush()
    expect(pc.connectionState).toBe('closed')
    expect(pc.channel.readyState).toBe('closed')
    expect(states).not.toContain('connected')
  })
})
