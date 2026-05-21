/**
 * FMP link state machine — adjacent-peer encrypted channel.
 *
 * Wire frames match Rust FIPS byte layout (FMP Msg1/Msg2/Established with
 * 4-byte common prefix and fixed Noise IK payload sizes 106/57). The inner
 * handshake is the real Noise_IK_secp256k1_ChaChaPoly_SHA256 pattern with an
 * 8-byte epoch payload (currently zero; in Rust this is a u64 LE epoch).
 *
 * The link's job:
 *   - Noise IK handshake (msg1/msg2)
 *   - frame keep-alive and data packets with the split CipherStates
 *   - enforce replay window on the receive side
 */
import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual } from "../codec/hex.js";
import { NoiseHandshake } from "../noise/index.js";
import { decodeFmpEstablished, decodeFmpInner, decodeFmpMsg1, decodeFmpMsg2, encodeFmpEstablished, encodeFmpEstablishedHeader, encodeFmpInner, encodeFmpMsg1, encodeFmpMsg2, FMP_INNER_DATA, FMP_INNER_KEEPALIVE, FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2, NOISE_IK_MSG1_LEN, NOISE_IK_MSG2_LEN, } from "./wire.js";
/** 8-byte epoch payload carried inside each FMP handshake step. */
const EPOCH_PAYLOAD_LEN = 8;
function epochPayload() {
    // The Rust implementation carries a u64-LE epoch here; for now we emit
    // zeros to match the byte length. Wire layout is preserved.
    return new Uint8Array(EPOCH_PAYLOAD_LEN);
}
export class FmpLink {
    role;
    localSessionIdx;
    identity;
    remotePubkey;
    remoteSessionIdx;
    hs;
    tx;
    rx;
    txCounter = 0n;
    rxReplay = new ReplayWindow();
    state = "init";
    constructor(init) {
        this.identity = init.identity;
        this.role = init.role;
        this.localSessionIdx = init.sessionIdx;
        if (init.remotePubkey)
            this.remotePubkey = init.remotePubkey;
        this.hs = new NoiseHandshake({
            pattern: "IK",
            role: init.role,
            identity: init.identity,
            remoteStatic: init.remotePubkey,
            ephemeralOverride: init.ephemeralOverride,
        });
    }
    buildMsg1(_rand) {
        if (this.role !== "initiator")
            throw new Error("only initiator builds Msg1");
        if (!this.remotePubkey)
            throw new Error("initiator needs remote pubkey");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        this.state = "handshaking";
        const noiseMsg1 = this.hs.writeMessage(epochPayload());
        if (noiseMsg1.length !== NOISE_IK_MSG1_LEN) {
            throw new Error(`noise IK msg1 size ${noiseMsg1.length} != ${NOISE_IK_MSG1_LEN}`);
        }
        const packet = encodeFmpMsg1({
            senderIdx: this.localSessionIdx,
            noiseMsg1,
        });
        return { packet };
    }
    handleMsg1(packet, _rand) {
        if (this.role !== "responder")
            throw new Error("only responder handles Msg1");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const msg1 = decodeFmpMsg1(packet);
        const payload = this.hs.readMessage(msg1.noiseMsg1);
        if (payload.length !== EPOCH_PAYLOAD_LEN) {
            throw new Error("noise IK msg1 inner payload must be 8 bytes");
        }
        this.remoteSessionIdx = msg1.senderIdx;
        const rs = this.hs.getRemoteStatic();
        if (!rs)
            throw new Error("noise IK responder did not capture remote static");
        this.remotePubkey = rs;
        const noiseMsg2 = this.hs.writeMessage(epochPayload());
        if (noiseMsg2.length !== NOISE_IK_MSG2_LEN) {
            throw new Error(`noise IK msg2 size ${noiseMsg2.length} != ${NOISE_IK_MSG2_LEN}`);
        }
        const reply = encodeFmpMsg2({
            senderIdx: this.localSessionIdx,
            receiverIdx: msg1.senderIdx,
            noiseMsg2,
        });
        this.finalize();
        return { reply, established: true, remotePubkey: rs };
    }
    handleMsg2(packet) {
        if (this.role !== "initiator")
            throw new Error("only initiator handles Msg2");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const msg2 = decodeFmpMsg2(packet);
        if (msg2.receiverIdx !== this.localSessionIdx) {
            throw new Error("FMP Msg2 receiver_idx mismatch");
        }
        const payload = this.hs.readMessage(msg2.noiseMsg2);
        if (payload.length !== EPOCH_PAYLOAD_LEN) {
            throw new Error("noise IK msg2 inner payload must be 8 bytes");
        }
        this.remoteSessionIdx = msg2.senderIdx;
        this.finalize();
        return { established: true, remotePubkey: this.remotePubkey };
    }
    finalize() {
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const { tx, rx } = this.hs.splitTxRx();
        this.tx = tx;
        this.rx = rx;
        this.state = "established";
        this.hs = undefined;
    }
    encryptOutgoing(payload, msgType = FMP_INNER_DATA) {
        if (this.state !== "established" || !this.tx || this.remoteSessionIdx === undefined) {
            throw new Error("FMP link not established");
        }
        const counter = this.txCounter++;
        const inner = encodeFmpInner({
            timestamp: Math.floor(Date.now() / 1000),
            msgType,
            payload,
        });
        const ciphertextLen = inner.length + 16;
        const aad = encodeFmpEstablishedHeader({ flags: 0, receiverIdx: this.remoteSessionIdx, counter }, ciphertextLen);
        // CipherState manages its own monotonic nonce, but FIPS Established uses
        // the explicit u64 counter from the frame header. We bypass CipherState's
        // internal counter and use the AEAD primitive with the frame counter so
        // both endpoints derive the same 12-byte nonce.
        const ciphertext = aeadWithCounter(this.tx, counter, aad, inner);
        return encodeFmpEstablished({
            flags: 0,
            receiverIdx: this.remoteSessionIdx,
            counter,
            ciphertext,
        });
    }
    encryptKeepalive() {
        return this.encryptOutgoing(new Uint8Array(0), FMP_INNER_KEEPALIVE);
    }
    decryptIncoming(packet) {
        if (this.state !== "established" || !this.rx) {
            throw new Error("FMP link not established");
        }
        const est = decodeFmpEstablished(packet);
        if (est.receiverIdx !== this.localSessionIdx) {
            throw new Error("FMP Established receiver_idx mismatch");
        }
        if (!this.rxReplay.accept(est.counter)) {
            throw new Error("FMP replay/duplicate counter");
        }
        const aad = encodeFmpEstablishedHeader({ flags: est.flags, receiverIdx: est.receiverIdx, counter: est.counter }, est.ciphertext.length);
        const plaintext = openWithCounter(this.rx, est.counter, aad, est.ciphertext);
        const inner = decodeFmpInner(plaintext);
        return { msgType: inner.msgType, payload: inner.payload };
    }
    close() {
        this.state = "closed";
    }
}
export { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2 };
export function isEqualPubkey(a, b) {
    return bytesEqual(a, b);
}
// --- AEAD helpers that use an explicit u64 counter for the FIPS Established
// header counter, bypassing CipherState's internal monotonic counter ---
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { noiseNonce } from "../crypto/aead.js";
function aeadWithCounter(cs, counter, aad, pt) {
    return chacha20poly1305(cs.getKey(), noiseNonce(counter), aad).encrypt(pt);
}
function openWithCounter(cs, counter, aad, ct) {
    return chacha20poly1305(cs.getKey(), noiseNonce(counter), aad).decrypt(ct);
}
//# sourceMappingURL=link.js.map