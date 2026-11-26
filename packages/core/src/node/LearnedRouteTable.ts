const MIN_ROUTE_SCORE = 0.05;
const MAX_ROUTE_SCORE = 64;
const MAX_ROUTE_WEIGHT = 512;
const MAX_LEARNED_DESTINATIONS = 4_096;
const PRUNE_INTERVAL_MS = 60_000;

interface LearnedRoute {
  nextHop: string;
  lastSeenMs: number;
  expiresAtMs: number;
  successes: number;
  failures: number;
  score: number;
  currentWeight: number;
  selected: number;
  pathMtu?: number;
  pathMtuExpiresAtMs?: number;
}

/**
 * TypeScript port of Rust fips-core's reply-learned route table.
 *
 * Route reinforcement, expiry, truncation, and smooth weighted round-robin
 * intentionally follow `crates/fips-core/src/proto/routing.rs`.
 */
export class LearnedRouteTable {
  private readonly routes = new Map<string, LearnedRoute[]>();
  private lastPruneMs = -Infinity;

  learn(
    destination: string,
    nextHop: string,
    nowMs: number,
    ttlSeconds: number,
    maxRoutesPerDestination: number,
    pathMtu?: number,
  ): void {
    if (destination === nextHop || maxRoutesPerDestination === 0) return;
    if (this.routes.size > 0 && (nowMs - this.lastPruneMs >= PRUNE_INTERVAL_MS || nowMs < this.lastPruneMs)) {
      this.pruneExpired(nowMs);
    }
    const expiresAtMs = nowMs + ttlSeconds * 1_000;
    const routes = this.routes.get(destination) ?? [];
    const existing = routes.find((route) => route.nextHop === nextHop);
    if (existing) {
      existing.successes += 1;
      existing.lastSeenMs = nowMs;
      existing.expiresAtMs = expiresAtMs;
      existing.score = clamp(existing.score + 1, MIN_ROUTE_SCORE, MAX_ROUTE_SCORE);
      if (pathMtu !== undefined) {
        existing.pathMtu = pathMtu;
        existing.pathMtuExpiresAtMs = expiresAtMs;
      }
    } else {
      routes.push({
        nextHop,
        lastSeenMs: nowMs,
        expiresAtMs,
        successes: 1,
        failures: 0,
        score: 1,
        currentWeight: 0,
        selected: 0,
        pathMtu,
        pathMtuExpiresAtMs: pathMtu === undefined ? undefined : expiresAtMs,
      });
    }
    this.sortAndTruncate(routes, maxRoutesPerDestination);
    this.routes.delete(destination);
    if (this.routes.size >= MAX_LEARNED_DESTINATIONS) {
      this.pruneExpired(nowMs);
      if (this.routes.size >= MAX_LEARNED_DESTINATIONS) {
        const oldest = this.routes.keys().next().value as string | undefined;
        if (oldest !== undefined) this.routes.delete(oldest);
      }
    }
    this.routes.set(destination, routes);
  }

  pathMtu(destination: string, nextHop: string, nowMs: number): number | undefined {
    const route = this.routes.get(destination)?.find((candidate) => candidate.nextHop === nextHop);
    return route && (route.pathMtuExpiresAtMs ?? 0) > nowMs ? route.pathMtu : undefined;
  }

  recordFailure(destination: string, nextHop: string): void {
    const route = this.routes.get(destination)?.find((candidate) => candidate.nextHop === nextHop);
    if (!route) return;
    route.failures += 1;
    route.score = Math.max(route.score * 0.5, MIN_ROUTE_SCORE);
    route.currentWeight = Math.min(route.currentWeight, 0);
  }

  selectNextHop(
    destination: string,
    nowMs: number,
    canSend: (nextHop: string) => boolean,
  ): string | undefined {
    const routes = this.routes.get(destination);
    if (!routes) return undefined;
    this.retainLive(routes, nowMs);
    if (routes.length === 0) {
      this.routes.delete(destination);
      return undefined;
    }
    if (routes.length === 1) {
      const only = routes[0]!;
      if (!canSend(only.nextHop)) return undefined;
      only.selected += 1;
      return only.nextHop;
    }

    let totalWeight = 0;
    let selected: LearnedRoute | undefined;
    for (const route of routes) {
      if (!canSend(route.nextHop)) continue;
      const weight = routeWeight(route);
      totalWeight += weight;
      route.currentWeight += weight;
      if (
        !selected
        || route.currentWeight > selected.currentWeight
        || (route.currentWeight === selected.currentWeight && compareRoutes(route, selected) < 0)
      ) {
        selected = route;
      }
    }
    if (!selected) return undefined;

    selected.currentWeight -= totalWeight;
    selected.selected += 1;
    const nextHop = selected.nextHop;
    routes.sort(compareRoutes);
    return nextHop;
  }

  has(destination: string, nowMs = Date.now()): boolean {
    const routes = this.routes.get(destination);
    if (!routes) return false;
    this.retainLive(routes, nowMs);
    if (routes.length > 0) return true;
    this.routes.delete(destination);
    return false;
  }

  clear(): void {
    this.routes.clear();
    this.lastPruneMs = -Infinity;
  }

  private pruneExpired(nowMs: number): void {
    this.lastPruneMs = nowMs;
    for (const [destination, routes] of this.routes) {
      this.retainLive(routes, nowMs);
      if (routes.length === 0) this.routes.delete(destination);
    }
  }

  private retainLive(routes: LearnedRoute[], nowMs: number): void {
    let write = 0;
    for (const route of routes) {
      if (route.expiresAtMs > nowMs) routes[write++] = route;
    }
    routes.length = write;
  }

  private sortAndTruncate(routes: LearnedRoute[], maximum: number): void {
    if (routes.length > 1) routes.sort(compareRoutes);
    if (routes.length > maximum) routes.length = maximum;
  }
}

function routeWeight(route: LearnedRoute): number {
  return clamp(
    Math.pow(clamp(route.score, MIN_ROUTE_SCORE, MAX_ROUTE_SCORE), 1.5),
    MIN_ROUTE_SCORE,
    MAX_ROUTE_WEIGHT,
  );
}

function compareRoutes(left: LearnedRoute, right: LearnedRoute): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.lastSeenMs !== right.lastSeenMs) return right.lastSeenMs - left.lastSeenMs;
  return left.nextHop.localeCompare(right.nextHop);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
