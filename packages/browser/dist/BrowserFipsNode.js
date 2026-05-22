import { FipsNode, } from "@fips/core";
import { IndexedDbIdentityStore } from "./IndexedDbIdentityStore.js";
export async function createBrowserFipsNode(cfg) {
    const store = new IndexedDbIdentityStore(cfg.identityStoreName);
    const identity = await store.getOrCreateIdentity();
    return new FipsNode({
        identity,
        transports: cfg.transports,
        forwarding: cfg.forwarding ?? false,
        services: cfg.services,
        logger: cfg.logger,
    });
}
//# sourceMappingURL=BrowserFipsNode.js.map