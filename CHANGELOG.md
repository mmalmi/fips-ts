# Changelog

## @fips/core 0.0.21 - 2026-07-12

- Resolve simultaneous FSP session initiation deterministically by NodeAddr so
  both peers converge on one authenticated session without dropping the first
  endpoint messages.
- Complete the losing initiator's pending send only after the replacement
  responder session authenticates.

## Runtime packages - 2026-07-12

- `@fips/transport-webrtc` 0.0.28, `@fips/transport-ethernet` 0.0.20, and
  `@fips/browser` 0.0.3 pin `@fips/core` 0.0.21 in packed manifests.
