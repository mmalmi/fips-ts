/**
 * Sliding replay window (WireGuard-style, 2048 packets) over a u64 counter.
 * Returns true if `counter` is acceptable (and updates state); false if it's a
 * duplicate or too old.
 */
export class ReplayWindow {
  static readonly WINDOW = 2048n;
  private high = -1n;
  private readonly seen = new Set<bigint>();

  accept(counter: bigint): boolean {
    if (counter < 0n) return false;
    if (this.high < 0n) {
      this.high = counter;
      this.seen.add(counter);
      return true;
    }
    if (counter > this.high) {
      // advance window; drop entries below new low
      const newLow = counter > ReplayWindow.WINDOW - 1n ? counter - (ReplayWindow.WINDOW - 1n) : 0n;
      for (const c of this.seen) {
        if (c < newLow) this.seen.delete(c);
      }
      this.high = counter;
      this.seen.add(counter);
      return true;
    }
    const low = this.high > ReplayWindow.WINDOW - 1n ? this.high - (ReplayWindow.WINDOW - 1n) : 0n;
    if (counter < low) return false;
    if (this.seen.has(counter)) return false;
    this.seen.add(counter);
    return true;
  }
}
