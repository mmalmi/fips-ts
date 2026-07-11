/**
 * TypeScript port of Rust fips-core's reply-learned route table.
 *
 * Route reinforcement, expiry, truncation, and smooth weighted round-robin
 * intentionally follow `crates/fips-core/src/proto/routing.rs`.
 */
export declare class LearnedRouteTable {
    private readonly routes;
    learn(destination: string, nextHop: string, nowMs: number, ttlSeconds: number, maxRoutesPerDestination: number): void;
    recordFailure(destination: string, nextHop: string): void;
    selectNextHop(destination: string, nowMs: number, canSend: (nextHop: string) => boolean): string | undefined;
    has(destination: string, nowMs?: number): boolean;
    clear(): void;
    private retainLive;
    private sortAndTruncate;
}
//# sourceMappingURL=LearnedRouteTable.d.ts.map