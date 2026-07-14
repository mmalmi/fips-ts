/**
 * Minimal in-process Nostr relay for Playwright tests. Implements the bits
 * the FIPS Nostr peerfinding and relay transport paths need:
 *   - EVENT: store and rebroadcast to matching subscribers
 *   - REQ filter (kinds, authors, #p, #d, since/until/limit)
 *   - CLOSED
 *   - EOSE after a single replay pass
 */

import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket as WsType } from "ws";

interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Subscription {
  ws: WsType;
  subId: string;
  filter: RelayFilter;
}

interface RelayFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#p"?: string[];
  "#d"?: string[];
}

export interface LocalNostrRelay {
  url: string;
  close(): Promise<void>;
}

export async function startLocalNostrRelay(
  port = 0,
): Promise<LocalNostrRelay> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise<void>((resolve) => {
    wss.once("listening", () => resolve());
  });
  const events: RelayEvent[] = [];
  const subs = new Set<Subscription>();

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg.length < 2) return;
      const tag = msg[0];
      if (tag === "EVENT") {
        const ev = msg[1] as RelayEvent;
        if (!isReplaceable(ev.kind) && events.some((e) => e.id === ev.id)) {
          ws.send(JSON.stringify(["OK", ev.id, true, "duplicate"]));
          return;
        }
        // Parameterized replaceable (30000-39999): replace prior with same (pubkey, kind, d-tag).
        if (isReplaceable(ev.kind)) {
          const d = getDTag(ev);
          const idx = events.findIndex(
            (e) =>
              e.pubkey === ev.pubkey &&
              e.kind === ev.kind &&
              (d === undefined ? true : getDTag(e) === d),
          );
          if (idx >= 0) events.splice(idx, 1);
        }
        events.push(ev);
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        for (const sub of subs) {
          if (sub.ws.readyState === sub.ws.OPEN && matchFilter(sub.filter, ev)) {
            sub.ws.send(JSON.stringify(["EVENT", sub.subId, ev]));
          }
        }
        return;
      }
      if (tag === "REQ") {
        const subId = msg[1] as string;
        const filter = (msg[2] as RelayFilter) ?? {};
        const sub: Subscription = { ws, subId, filter };
        subs.add(sub);
        for (const ev of events) {
          if (matchFilter(filter, ev)) {
            ws.send(JSON.stringify(["EVENT", subId, ev]));
          }
        }
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }
      if (tag === "CLOSE") {
        const subId = msg[1] as string;
        for (const sub of [...subs]) {
          if (sub.subId === subId && sub.ws === ws) subs.delete(sub);
        }
        ws.send(JSON.stringify(["CLOSED", subId, ""]));
        return;
      }
    });
    ws.on("close", () => {
      for (const sub of [...subs]) {
        if (sub.ws === ws) subs.delete(sub);
      }
    });
  });

  const { port: boundPort } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${boundPort}`,
    async close() {
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000) || (kind >= 30_000 && kind < 40_000);
}

function getDTag(ev: RelayEvent): string | undefined {
  for (const t of ev.tags) if (t[0] === "d") return t[1];
  return undefined;
}

function matchFilter(f: RelayFilter, ev: RelayEvent): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  if (f["#p"]) {
    const want = new Set(f["#p"]);
    if (!ev.tags.some((t) => t[0] === "p" && want.has(t[1]))) return false;
  }
  if (f["#d"]) {
    const want = new Set(f["#d"]);
    if (!ev.tags.some((t) => t[0] === "d" && want.has(t[1]))) return false;
  }
  return true;
}
