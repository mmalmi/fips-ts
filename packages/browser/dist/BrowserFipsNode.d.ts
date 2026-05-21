import { FipsNode, type FipsServiceHandler, type ServiceRegistration, type Transport } from "@fips/core";
export interface CreateBrowserFipsNodeConfig {
    identityStoreName?: string;
    forwarding?: boolean;
    transports: Transport[];
    services?: ServiceRegistration[];
}
export declare function createBrowserFipsNode(cfg: CreateBrowserFipsNodeConfig): Promise<FipsNode>;
export type { FipsServiceHandler };
//# sourceMappingURL=BrowserFipsNode.d.ts.map