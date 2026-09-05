/** Receiver-side FSP MMP counters and the existing 66-byte report body. */
export class FspReceiverReports {
  private packets = 0n;
  private bytes = 0n;
  private highest = 0n;
  private expected?: bigint;
  private intervalPackets = 0;
  private intervalBytes = 0;
  private reordered = 0;
  private timestamp = 0;
  private receivedAt?: number;
  private jitterUs = 0;
  private burst = 0;
  private bursts = 0;
  private maxBurst = 0;
  private totalBurst = 0;
  private transitSamples: Array<{ time: number; transit: number }> = [];

  resetEpoch(): void {
    this.highest = 0n;
    this.expected = undefined;
    this.intervalPackets = this.intervalBytes = this.reordered = 0;
    this.timestamp = this.jitterUs = 0;
    this.receivedAt = undefined;
    this.burst = this.bursts = this.maxBurst = this.totalBurst = 0;
    this.transitSamples = [];
  }

  record(
    received: { counter: bigint; timestamp: number; bytes: number },
    nowMs: number,
    currentEpoch = true,
  ): void {
    this.packets++;
    this.bytes += BigInt(received.bytes);
    // Delayed old keys remain readable, but their counters and timestamps
    // cannot describe the new epoch. Keep only lifetime totals for them.
    if (!currentEpoch) return;
    this.intervalPackets = Math.min(this.intervalPackets + 1, 0xffff_ffff);
    this.intervalBytes = Math.min(this.intervalBytes + received.bytes, 0xffff_ffff);
    if (received.counter < this.highest) this.reordered = (this.reordered + 1) >>> 0;
    else this.highest = received.counter;
    if (this.expected !== undefined && received.counter > this.expected) {
      if (this.burst === 0) this.bursts++;
      this.burst = Math.min(this.burst + Number(received.counter - this.expected), 0xffff);
    } else {
      this.finishBurst();
    }
    if (this.expected === undefined || received.counter >= this.expected) {
      this.expected = received.counter + 1n;
    }
    let transit = 0;
    if (this.receivedAt !== undefined) {
      const sentDeltaMs = (received.timestamp - this.timestamp) | 0;
      const transitDeltaUs = ((nowMs - this.receivedAt) - sentDeltaMs) * 1_000;
      this.jitterUs += (Math.abs(transitDeltaUs) - this.jitterUs) / 16;
      transit = this.transitSamples.at(-1)!.transit + transitDeltaUs / 1_000;
    }
    this.transitSamples.push({ time: nowMs, transit });
    if (this.transitSamples.length > 32) this.transitSamples.shift();
    this.timestamp = received.timestamp;
    this.receivedAt = nowMs;
  }

  build(nowMs: number): Uint8Array | undefined {
    if (this.intervalPackets === 0 || this.receivedAt === undefined) return undefined;
    this.finishBurst();
    const body = new Uint8Array(66);
    const view = new DataView(body.buffer);
    const dwell = Math.max(0, Math.floor(nowMs - this.receivedAt));
    view.setBigUint64(2, this.highest, true);
    view.setBigUint64(10, this.packets, true);
    view.setBigUint64(18, this.bytes, true);
    view.setUint32(26, dwell > 0xffff ? 0 : this.timestamp, true);
    view.setUint16(30, Math.min(dwell, 0xffff), true);
    view.setUint16(32, this.maxBurst, true);
    view.setUint16(34, this.bursts ? Math.min(0xffff, this.totalBurst * 256 / this.bursts) : 0, true);
    view.setUint32(38, Math.min(0xffff_ffff, Math.floor(this.jitterUs)), true);
    // Direct FSP has no CE indication; reserved bytes and ECN remain zero.
    view.setInt32(46, this.transitTrend(), true);
    view.setUint32(50, this.bursts, true);
    view.setUint32(54, this.reordered, true);
    view.setUint32(58, this.intervalPackets, true);
    view.setUint32(62, this.intervalBytes, true);
    this.intervalPackets = this.intervalBytes = 0;
    this.bursts = this.maxBurst = this.totalBurst = 0;
    return body;
  }

  private finishBurst(): void {
    this.maxBurst = Math.max(this.maxBurst, this.burst);
    this.totalBurst += this.burst;
    this.burst = 0;
  }

  private transitTrend(): number {
    const samples = this.transitSamples;
    if (samples.length < 2) return 0;
    const meanTime = samples.reduce((sum, sample) => sum + sample.time, 0) / samples.length;
    const meanTransit = samples.reduce((sum, sample) => sum + sample.transit, 0) / samples.length;
    let covariance = 0;
    let variance = 0;
    for (const sample of samples) {
      const time = sample.time - meanTime;
      covariance += time * (sample.transit - meanTransit);
      variance += time * time;
    }
    const slope = variance > 0 ? covariance / variance * 1_000_000 : 0;
    return Math.trunc(Math.max(-0x8000_0000, Math.min(0x7fff_ffff, slope)));
  }
}
