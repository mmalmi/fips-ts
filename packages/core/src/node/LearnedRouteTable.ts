const MIN_ROUTE_SCORE = 0.05;
const MAX_ROUTE_SCORE = 64;
const MAX_ROUTE_WEIGHT = 512;

interface LearnedRoute {
  nextHop: string;
  lastSeenMs: number;
  expiresAtMs: number;
  successes: number;
  failures: number;
  score: number;
  currentWeight: number;
  selected: number;
}

/**
 * TypeScript port of Rust fips-core's reply-learned route table.
 *
 * Route reinforcement, expiry, truncation, and smooth weighted round-robin
 * intentionally follow `crates/fips-core/src/proto/routing.rs`.
 */
export class LearnedRouteTable {
  private readonly routes = new Map<string, LearnedRoute[]>();

  learn(
    destination: string,
    nextHop: string,
    nowMs: number,
    ttlSeconds: number,
    maxRoutesPerDestination: number,
  ): void {
    if (destination === nextHop || maxRoutesPerDestination === 0) return;
    const expiresAtMs = nowMs + ttlSeconds * 1_000;
    const routes = this.routes.get(destination) ?? [];
    const existing = routes.find((route) => route.nextHop === nextHop);
    if (existing) {
      existing.successes += 1;
      existing.lastSeenMs = nowMs;
      existing.expiresAtMs = expiresAtMs;
      existing.score = clamp(existing.score + 1, MIN_ROUTE_SCORE, MAX_ROUTE_SCORE);
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
      });
    }
    this.sortAndTruncate(routes, maxRoutesPerDestination);
    this.routes.set(destination, routes);
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

    const sendable = routes
      .map((route, index) => ({ index, weight: routeWeight(route) }))
      .filter(({ index }) => canSend(routes[index]!.nextHop));
    if (sendable.length === 0) return undefined;

    const totalWeight = sendable.reduce((sum, candidate) => sum + candidate.weight, 0);
    let selected = sendable[0]!.index;
    for (const candidate of sendable) {
      routes[candidate.index]!.currentWeight += candidate.weight;
      const selectedRoute = routes[selected]!;
      const candidateRoute = routes[candidate.index]!;
      if (
        candidateRoute.currentWeight > selectedRoute.currentWeight
        || (
          candidateRoute.currentWeight === selectedRoute.currentWeight
          && compareRoutes(candidateRoute, selectedRoute) < 0
        )
      ) {
        selected = candidate.index;
      }
    }

    routes[selected]!.currentWeight -= totalWeight;
    routes[selected]!.selected += 1;
    const nextHop = routes[selected]!.nextHop;
    this.sortAndTruncate(routes, routes.length);
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
  }

  private retainLive(routes: LearnedRoute[], nowMs: number): void {
    let write = 0;
    for (const route of routes) {
      if (route.expiresAtMs > nowMs) routes[write++] = route;
    }
    routes.length = write;
  }

  private sortAndTruncate(routes: LearnedRoute[], maximum: number): void {
    routes.sort(compareRoutes);
    routes.length = Math.min(routes.length, maximum);
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
