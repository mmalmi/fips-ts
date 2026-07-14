import type { FipsIdentity, Logger } from "@fips/core";

import { NostrRelayClient, type NostrEvent } from "./NostrRelayClient.js";
import { signEvent, verifyEvent } from "./nostrEvent.js";

export const FIPS_ADVERT_KIND = 37_195;
export const FIPS_ADVERT_IDENTIFIER = "fips-overlay-v1";
export const FIPS_ADVERT_D_TAG = FIPS_ADVERT_IDENTIFIER;
export const FIPS_DEFAULT_DISCOVERY_APP = "fips-overlay-v1";
export const FIPS_PROTOCOL_VERSION = "1";
export const DEFAULT_FIPS_ADVERT_TTL_MS = 60 * 60 * 1_000;
const RELAY_OPERATION_WARMUP_MS = 1_500;

export interface FipsAdvertContent {
  identifier: typeof FIPS_ADVERT_IDENTIFIER;
  version: 1;
  endpoints: Array<{ transport: string; addr: string }>;
  stunServers: string[];
}

export interface NostrPeerDiscoveryOptions {
  identity: FipsIdentity;
  relays: NostrRelayClient[];
  discoveryApp?: string;
  advertTtlMs?: number;
  logger?: Logger;
}

/** Public Nostr peer adverts. Private transport negotiation happens over FSP. */
export class NostrPeerDiscovery {
  private readonly identity: FipsIdentity;
  private readonly relays: NostrRelayClient[];
  private readonly discoveryApp: string;
  private readonly advertTtlMs: number;
  private readonly logger?: Logger;
  private readonly cleanups: Array<() => void> = [];

  constructor(opts: NostrPeerDiscoveryOptions) {
    this.identity = opts.identity;
    this.relays = opts.relays;
    this.discoveryApp = normalizeDiscoveryApp(opts.discoveryApp);
    this.advertTtlMs = opts.advertTtlMs ?? DEFAULT_FIPS_ADVERT_TTL_MS;
    this.logger = opts.logger;
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  async publishAdvert(advert: FipsAdvertContent): Promise<void> {
    const expiresAt = Math.floor((Date.now() + this.advertTtlMs) / 1_000);
    const event = signEvent(this.identity, {
      created_at: Math.floor(Date.now() / 1_000),
      kind: FIPS_ADVERT_KIND,
      tags: [
        ["d", this.discoveryApp],
        ["protocol", this.discoveryApp],
        ["version", FIPS_PROTOCOL_VERSION],
        ["expiration", String(expiresAt)],
      ],
      content: JSON.stringify(advert),
    });
    const results = await Promise.all(this.relays.map(async (relay) => {
      try {
        await relay.publish(event);
        return true;
      } catch (error) {
        this.logger?.warn("advert publish failed", relay.url, error);
        return false;
      }
    }));
    if (!results.some(Boolean)) throw new Error("no Nostr relay accepted peer advert");
  }

  async subscribeAdverts(
    cb: (event: NostrEvent, advert: FipsAdvertContent, sourceRelayUrl: string) => void,
    extraFilter: { authors?: string[] } = {},
  ): Promise<() => void> {
    const localCleanups: Array<() => void> = [];
    const operations = this.relays.map(async (relay) => {
      try {
        const cleanup = await relay.subscribe(
          {
            kinds: [FIPS_ADVERT_KIND],
            "#d": [this.discoveryApp],
            ...extraFilter,
          },
          {
            onEvent: (event) => {
              if (!verifyEvent(event)) return;
              if (tagValue(event, "protocol") !== this.discoveryApp) return;
              const version = tagValue(event, "version");
              if (version && version !== FIPS_PROTOCOL_VERSION) return;
              try {
                const advert = JSON.parse(event.content) as FipsAdvertContent;
                if (advert.identifier !== FIPS_ADVERT_IDENTIFIER) return;
                if (advert.version !== 1 || !Array.isArray(advert.endpoints)) return;
                cb(event, advert, normalizeRelayUrl(relay.url));
              } catch {
                // Malformed public advert; ignore it.
              }
            },
          },
        );
        localCleanups.push(cleanup);
        this.cleanups.push(cleanup);
        return true;
      } catch (error) {
        this.logger?.warn("advert subscription failed", relay.url, error);
        return false;
      }
    });
    await waitForRelayWarmup(operations);
    return () => {
      for (const cleanup of localCleanups) {
        cleanup();
        const index = this.cleanups.indexOf(cleanup);
        if (index >= 0) this.cleanups.splice(index, 1);
      }
    };
  }
}

async function waitForRelayWarmup(operations: Array<Promise<boolean>>): Promise<void> {
  if (operations.length === 0) return;
  await Promise.race([
    Promise.any(operations.map((operation) => operation.then((ok) => {
      if (!ok) throw new Error("relay operation failed");
      return true;
    }))).catch(() => false),
    Promise.all(operations).catch(() => []),
    new Promise((resolve) => {
      setTimeout(resolve, RELAY_OPERATION_WARMUP_MS);
    }),
  ]);
}

function normalizeRelayUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`unsupported Nostr relay protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function normalizeDiscoveryApp(app: string | undefined): string {
  const normalized = app?.trim();
  return normalized || FIPS_DEFAULT_DISCOVERY_APP;
}

function tagValue(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find((tag) => tag[0] === tagName)?.[1];
}
