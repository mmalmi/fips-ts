export {
  BinaryReader,
  BinaryWriter,
  bytesEqual,
  concatBytes,
  fromHex,
  toHex,
} from "./codec/index.js";

export {
  COMPRESSED_PUBKEY_LENGTH,
  NODE_ADDR_LENGTH,
  X_ONLY_PUBKEY_LENGTH,
  compareNodeAddr,
  deriveNodeAddr,
  nodeAddrFromHex,
  nodeAddrFromSlice,
  nodeAddrToHex,
  type NodeAddr,
} from "./nodeaddr/index.js";

export {
  compressedPubkeyFromXOnly,
  ecdh,
  exportIdentity,
  generateIdentity,
  identityFromSecretKey,
  importIdentity,
  signSchnorr,
  verifySchnorr,
  type FipsIdentity,
  type SerializedIdentity,
} from "./identity/index.js";

export {
  encodeNpub,
  decodeNpub,
  encodeNsec,
  decodeNsec,
  npubFromHex,
  npubToHex,
  NpubError,
} from "./identity/nip19.js";

export {
  authChallengeDigest,
  generateAuthChallenge,
  signChallenge,
  verifyChallenge,
  type AuthResponse,
} from "./identity/auth.js";

export { PeerIdentity } from "./identity/peer.js";

export {
  aeadOpen,
  aeadSeal,
  deriveSessionKeys,
  hkdfDerive,
  noiseNonce,
  ReplayWindow,
} from "./crypto/index.js";

export {
  BloomError,
  BloomFilter,
  DEFAULT_FILTER_SIZE_BITS,
  DEFAULT_HASH_COUNT,
  SIZE_CLASS_BYTES,
} from "./bloom/index.js";

export {
  DisconnectReason,
  FILTER_ANNOUNCE_MIN_PAYLOAD_SIZE,
  HandshakeMessageType,
  LinkMessageType,
  SESSION_DATAGRAM_HEADER_SIZE,
  V1_SIZE_CLASS,
  buildFilterAnnounce,
  decodeDisconnect,
  decodeFilterAnnounce,
  decodeLookupRequest,
  decodeLookupResponse,
  decodeSessionDatagram,
  decodeSessionDatagramPayload,
  decodeSessionAck,
  decodeSessionMsg3,
  decodeSessionSetup,
  decrementTtl,
  disconnectReasonFromByte,
  encodeDisconnect,
  encodeFilterAnnounce,
  encodeLookupRequestPayload,
  encodeLookupResponsePayload,
  encodeSessionAck,
  encodeSessionDatagram,
  encodeSessionMsg3,
  encodeSessionSetup,
  handshakeMessageTypeFromByte,
  isHandshakeMessageType,
  linkMessageTypeFromByte,
  type Disconnect,
  type FilterAnnounce,
  type LookupRequest,
  type LookupResponse,
  type SessionAck,
  type SessionDatagram,
  type SessionMsg3,
  type SessionSetup,
} from "./protocol/index.js";

export {
  CipherState,
  NoiseHandshake,
  SymmetricState,
  noiseHkdf2,
  noiseHkdf3,
  type NoiseHandshakeInit,
  type NoisePattern,
  type NoiseRole,
} from "./noise/index.js";

export {
  FMP_ESTABLISHED_HEADER_LEN,
  FMP_INNER_DATA,
  FMP_INNER_KEEPALIVE,
  FMP_MSG1_TOTAL_LEN,
  FMP_MSG2_TOTAL_LEN,
  FMP_PHASE_ESTABLISHED,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  NOISE_IK_MSG1_LEN,
  NOISE_IK_MSG2_LEN,
  decodeCommonPrefix,
  decodeFmpEstablished,
  decodeFmpInner,
  decodeFmpMsg1,
  decodeFmpMsg2,
  encodeCommonPrefix,
  encodeFmpEstablished,
  encodeFmpEstablishedHeader,
  encodeFmpInner,
  encodeFmpMsg1,
  encodeFmpMsg2,
  peekFmpPhase,
} from "./fmp/wire.js";

export { FmpLink } from "./fmp/link.js";

export {
  FSP_ESTABLISHED_HEADER_LEN,
  FSP_FLAG_CP,
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_K,
  FSP_FLAG_U,
  FSP_INNER_HEADER_LEN,
  FSP_MSG_DATA,
  FSP_MSG_ENDPOINT_DATA,
  FSP_MSG_KEEPALIVE,
  FSP_PHASE_ESTABLISHED,
  FSP_PHASE_MSG1,
  FSP_PHASE_MSG2,
  FSP_PHASE_MSG3,
  NOISE_XK_MSG1_LEN,
  NOISE_XK_MSG2_LEN,
  NOISE_XK_MSG3_LEN,
  decodeDataPacket,
  decodeFspEstablished,
  decodeFspHandshake,
  decodeFspInner,
  encodeDataPacket,
  encodeFspEstablished,
  encodeFspEstablishedHeader,
  encodeFspHandshake,
  encodeFspInner,
  isDirectFspEstablished,
  peekFspPhase,
  type DataPacket,
} from "./fsp/wire.js";

export { FspSession } from "./fsp/session.js";
export {
  DIRECT_FSP_TRANSPORT_FRAGMENT_HEADER_LEN,
  DIRECT_FSP_TRANSPORT_MAX_FRAGMENTS,
  DIRECT_FSP_TRANSPORT_MAX_REASSEMBLED_LEN,
  DirectFspTransportReassembler,
  isDirectFspTransportFragment,
  segmentDirectFspTransportRecord,
} from "./fsp/directTransport.js";

export {
  FORWARD_VERSION,
  decodeForwardEnvelope,
  encodeForwardEnvelope,
  type ForwardEnvelope,
} from "./node/forward.js";

export { FipsNode } from "./node/FipsNode.js";
export type {
  Clock,
  DatagramEvent,
  EndpointDataEvent,
  ErrorEvent,
  FipsEventName,
  FipsNodeConfig,
  FipsServiceHandler,
  PeerEvent,
  RandomSource,
  ServiceContext,
  ServiceRegistration,
  SessionEvent,
} from "./node/types.js";

export {
  noopLogger,
  transportAddressKey,
} from "./transport/types.js";

export type {
  DiscoveredPeer,
  Logger,
  ReceivedTransportPacket,
  Transport,
  TransportAddress,
  TransportConnectionStateEvent,
  TransportContext,
} from "./transport/types.js";
