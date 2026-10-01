import type { Transport, TransportAddress, TransportContext } from '@fips/core'

/** Only the physical carriers are simulated; nodes own FMP/FSP and signaling. */
export class BootstrapTransport implements Transport {
  readonly type = 'bootstrap'
  readonly mtu = 1200
  other!: BootstrapTransport
  private ctx?: TransportContext
  private address = ''
  private connected = true

  async start(ctx: TransportContext) {
    this.ctx = ctx
    this.address = Array.from(ctx.localIdentity.publicKey, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  async stop() { this.ctx = undefined }
  async connect() {}
  async send(_address: TransportAddress, data: Uint8Array) {
    if (!this.connected || !this.other.connected || !this.other.ctx) throw new Error('bootstrap disconnected')
    this.other.ctx.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.address },
      data: new Uint8Array(data), receivedAtMs: Date.now(),
    })
  }
  disconnect() {
    this.connected = false
    this.ctx?.onConnectionState?.({
      remoteAddr: { transport: this.type, addr: this.other.address }, state: 'disconnected',
    })
  }
}

class PairedDataChannel extends EventTarget {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  other?: PairedDataChannel
  sentPackets = 0

  send(data: Uint8Array) {
    if (this.readyState !== 'open') throw new Error('test data channel not open')
    const bytes = new Uint8Array(data)
    this.sentPackets++
    queueMicrotask(() => {
      if (this.other?.readyState === 'open') {
        this.other.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }))
      }
    })
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
    // The paired carrier closes too, just as a real canceled RTC pair does.
    this.other?.close()
  }
}

export class PairedPeerConnection extends EventTarget {
  static instances: PairedPeerConnection[] = []
  readonly id = PairedPeerConnection.instances.length
  readonly channel = new PairedDataChannel()
  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'complete'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ondatachannel?: (event: { channel: PairedDataChannel }) => void
  private other?: PairedPeerConnection

  constructor() { super(); PairedPeerConnection.instances.push(this) }
  createDataChannel() { return this.channel }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: String(this.id) } }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: String(this.id) } }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
    const other = PairedPeerConnection.instances[Number(description.sdp)]
    if (!other) throw new Error('unknown test SDP peer')
    this.other = other
    // A delayed offer for an already-canceled PC can create an inbound
    // candidate, but cannot reopen the canceled remote carrier.
    if (other.connectionState !== 'closed') {
      other.other = this
      this.channel.other = other.channel
      other.channel.other = this.channel
    }
    if (description.type === 'offer') this.ondatachannel?.({ channel: this.channel })
  }
  openPair() {
    const other = this.other
    if (!other || this.remoteDescription?.type !== 'answer'
      || other.remoteDescription?.type !== 'offer'
      || this.connectionState === 'closed' || other.connectionState === 'closed') {
      throw new Error('test RTC pair is not negotiated')
    }
    for (const pc of [this, other]) {
      pc.connectionState = 'connected'
      pc.iceConnectionState = 'connected'
      pc.channel.readyState = 'open'
    }
    // Both real WebRtcConnection message listeners are installed before open.
    // Their actual READY frames travel through the paired data channels.
    for (const pc of [this, other]) {
      pc.channel.dispatchEvent(new Event('open'))
      pc.dispatchEvent(new Event('connectionstatechange'))
    }
  }
  close() {
    if (this.connectionState === 'closed') return
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.channel.close()
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}
