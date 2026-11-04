import {
  FipsNode,
  type FipsServiceHandler,
  type Logger,
  type ServiceRegistration,
  type Transport,
} from "@fips/core";

import { IndexedDbIdentityStore } from "./IndexedDbIdentityStore.js";

export interface CreateBrowserFipsNodeConfig {
  identityStoreName?: string;
  forwarding?: boolean;
  strictClient?: boolean;
  blockedPeerPubkeys?: readonly string[];
  routingMode?: "tree" | "reply_learned";
  defaultRoute?: string;
  transports: Transport[];
  services?: ServiceRegistration[];
  logger?: Logger;
}

export async function createBrowserFipsNode(
  cfg: CreateBrowserFipsNodeConfig,
): Promise<FipsNode> {
  const store = new IndexedDbIdentityStore(cfg.identityStoreName);
  const identity = await store.getOrCreateIdentity();
  return new FipsNode({
    identity,
    transports: cfg.transports,
    forwarding: cfg.forwarding ?? false,
    strictClient: cfg.strictClient,
    blockedPeerPubkeys: cfg.blockedPeerPubkeys,
    routingMode: cfg.routingMode,
    defaultRoute: cfg.defaultRoute,
    services: cfg.services,
    logger: cfg.logger,
  });
}

export type { FipsServiceHandler };
