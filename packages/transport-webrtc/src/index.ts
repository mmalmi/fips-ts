export {
  WebRtcTransport,
} from "./WebRtcTransport.js";
export type { WebRtcTransportConfig } from "./WebRtcTransportConfig.js";

export { WebRtcConnection } from "./WebRtcConnection.js";

export {
  NostrPeerDiscovery,
  FIPS_ADVERT_KIND,
  FIPS_ADVERT_D_TAG,
  FIPS_DEFAULT_DISCOVERY_APP,
  FIPS_PROTOCOL_VERSION,
  DEFAULT_FIPS_ADVERT_TTL_MS,
  type FipsAdvertContent,
  type NostrPeerDiscoveryOptions,
} from "./NostrPeerDiscovery.js";

export {
  NostrRelayTransport,
  NOSTR_RELAY_DATAGRAM_KIND,
  type NostrRelayTransportConfig,
} from "./NostrRelayTransport.js";

export {
  NostrRelayClient,
  type NostrEvent,
  type NostrFilter,
  type NostrRelayClientOptions,
} from "./NostrRelayClient.js";

export {
  signEvent,
  verifyEvent,
  computeEventId,
  serializeForId,
  type UnsignedEvent,
} from "./nostrEvent.js";

export {
  validateWebRtcSignal,
  SignalValidationError,
  type WebRtcSignal,
  type WebRtcSignalPayload,
  type WebRtcSignalValidationContext,
  type IceCandidateJson,
} from "./WebRtcSignal.js";
