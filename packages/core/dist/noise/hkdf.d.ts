/**
 * Noise-spec HKDF chain (RFC 5869 with chained HMAC outputs).
 *
 *   temp_key = HMAC-HASH(chaining_key, input_key_material)   // PRK
 *   output1  = HMAC-HASH(temp_key, 0x01)
 *   output2  = HMAC-HASH(temp_key, output1 || 0x02)
 *   output3  = HMAC-HASH(temp_key, output2 || 0x03)
 *
 * Returns 2 or 3 outputs depending on `numOutputs`.
 */
export declare function noiseHkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array];
export declare function noiseHkdf3(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array, Uint8Array];
//# sourceMappingURL=hkdf.d.ts.map