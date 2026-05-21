/**
 * Sliding replay window (WireGuard-style, 2048 packets) over a u64 counter.
 * Returns true if `counter` is acceptable (and updates state); false if it's a
 * duplicate or too old.
 */
export declare class ReplayWindow {
    static readonly WINDOW = 2048n;
    private high;
    private readonly seen;
    accept(counter: bigint): boolean;
    /**
     * Non-destructive check: would `accept(counter)` succeed right now?
     * Mirrors Rust ReplayWindow::check.
     */
    check(counter: bigint): boolean;
    /** Highest counter ever accepted, or 0 if none (Rust returns 0 too). */
    get highest(): bigint;
    /** Forget all state. */
    reset(): void;
}
//# sourceMappingURL=replay.d.ts.map