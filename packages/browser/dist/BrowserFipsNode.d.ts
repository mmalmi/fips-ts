import { FipsNode, type FipsServiceHandler, type Logger, type ServiceRegistration, type Transport } from "@fips/core";
export interface CreateBrowserFipsNodeConfig {
    identityStoreName?: string;
    forwarding?: boolean;
    routingMode?: "tree" | "reply_learned";
    defaultRoute?: string;
    transports: Transport[];
    services?: ServiceRegistration[];
    logger?: Logger;
}
export declare function createBrowserFipsNode(cfg: CreateBrowserFipsNodeConfig): Promise<FipsNode>;
export type { FipsServiceHandler };
//# sourceMappingURL=BrowserFipsNode.d.ts.map