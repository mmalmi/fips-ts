/**
 * Sliding replay window (WireGuard-style, 2048 packets) over a u64 counter.
 * Returns true if `counter` is acceptable (and updates state); false if it's a
 * duplicate or too old.
 */
export class ReplayWindow {
    static WINDOW = 2048n;
    high = -1n;
    // Counters inside a window occupy distinct slots. Keeping the full counter
    // distinguishes stale slots after wraparound without pruning on every packet.
    seen = new Array(Number(ReplayWindow.WINDOW));
    accept(counter) {
        if (!this.check(counter))
            return false;
        if (counter > this.high)
            this.high = counter;
        this.seen[Number(counter % ReplayWindow.WINDOW)] = counter;
        return true;
    }
    /**
     * Non-destructive check: would `accept(counter)` succeed right now?
     * Mirrors Rust ReplayWindow::check.
     */
    check(counter) {
        // Rust reserves u64::MAX for nonce exhaustion.
        return counter >= 0n && counter < 0xffffffffffffffffn
            && this.high - counter < ReplayWindow.WINDOW
            && this.seen[Number(counter % ReplayWindow.WINDOW)] !== counter;
    }
    /** Highest counter ever accepted, or 0 if none (Rust returns 0 too). */
    get highest() {
        return this.high < 0n ? 0n : this.high;
    }
    /** Forget all state. */
    reset() {
        this.high = -1n;
        this.seen.fill(undefined);
    }
}
//# sourceMappingURL=replay.js.map