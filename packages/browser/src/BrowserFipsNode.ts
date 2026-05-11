import {
  FipsNode,
  type FipsServiceHandler,
  type ServiceRegistration,
  type Transport,
} from "@fips/core";

import { IndexedDbIdentityStore } from "./IndexedDbIdentityStore.js";

export interface CreateBrowserFipsNodeConfig {
  identityStoreName?: string;
  forwarding?: boolean;
  transports: Transport[];
  services?: ServiceRegistration[];
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
    services: cfg.services,
  });
}

export type { FipsServiceHandler };
