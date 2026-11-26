/**
 * FMP link state machine — adjacent-peer encrypted channel.
 *
 * Wire frames match Rust FIPS byte layout (FMP Msg1/Msg2/Established with
 * 4-byte common prefix and fixed Noise IK payload sizes 106/57). The inner
 * handshake is the real Noise_IK_secp256k1_ChaChaPoly_SHA256 pattern with an
 * 8-byte startup epoch payload used for restart detection.
 *
 * The link's job:
 *   - Noise IK handshake (msg1/msg2)
 *   - frame keep-alive and data packets with the split CipherStates
 *   - enforce replay window on the receive side
 */
import { aeadOpen, aeadSealInto } from "../crypto/aead.js";
import { ReplayWindow } from "../crypto/replay.js";
import { readU32le, writeU32le } from "../codec/binary.js";
import { bytesEqual } from "../codec/hex.js";
import { NoiseHandshake } from "../noise/index.js";
import { FmpReceiverReports } from "./receiverReports.js";
import { decodeFmpMsg1, decodeFmpMsg2, encodeFmpMsg1, encodeFmpMsg2, FMP_AEAD_TAG_LEN, FMP_ESTABLISHED_HEADER_LEN, FMP_INNER_DATA, FMP_INNER_KEEPALIVE, FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2, NOISE_IK_MSG1_LEN, NOISE_IK_MSG2_LEN, parseFmpEstablished, writeFmpEstablishedHeader, } from "./wire.js";
/** 8-byte epoch payload carried inside each FMP handshake step. */
const EPOCH_PAYLOAD_LEN = 8;
export class FmpLink {
    role;
    localSessionIdx;
    identity;
    localEpoch;
    remotePubkey;
    remoteSessionIdx;
    remoteEpoch;
    hs;
    tx;
    rx;
    establishedMsg1;
    establishedMsg2;
    txCounter = 0n;
    sessionStartMs = 0;
    rxReplay = new ReplayWindow();
    receiverReports = new FmpReceiverReports();
    state = "init";
    constructor(init) {
        this.identity = init.identity;
        this.role = init.role;
        this.localSessionIdx = init.sessionIdx;
        if (init.localEpoch.length !== EPOCH_PAYLOAD_LEN) {
            throw new Error("FMP local epoch must be 8 bytes");
        }
        this.localEpoch = new Uint8Array(init.localEpoch);
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
        const noiseMsg1 = this.hs.writeMessage(this.localEpoch);
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
        if (this.state === "established") {
            if (this.establishedMsg1
                && this.establishedMsg2
                && bytesEqual(packet, this.establishedMsg1)
                && this.remotePubkey) {
                return {
                    reply: new Uint8Array(this.establishedMsg2),
                    established: true,
                    remotePubkey: this.remotePubkey,
                };
            }
            throw new Error("unexpected FMP Msg1 after establishment");
        }
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const msg1 = decodeFmpMsg1(packet);
        const payload = this.hs.readMessage(msg1.noiseMsg1);
        if (payload.length !== EPOCH_PAYLOAD_LEN) {
            throw new Error("noise IK msg1 inner payload must be 8 bytes");
        }
        this.remoteEpoch = new Uint8Array(payload);
        this.remoteSessionIdx = msg1.senderIdx;
        const rs = this.hs.getRemoteStatic();
        if (!rs)
            throw new Error("noise IK responder did not capture remote static");
        this.remotePubkey = rs;
        const noiseMsg2 = this.hs.writeMessage(this.localEpoch);
        if (noiseMsg2.length !== NOISE_IK_MSG2_LEN) {
            throw new Error(`noise IK msg2 size ${noiseMsg2.length} != ${NOISE_IK_MSG2_LEN}`);
        }
        const reply = encodeFmpMsg2({
            senderIdx: this.localSessionIdx,
            receiverIdx: msg1.senderIdx,
            noiseMsg2,
        });
        this.establishedMsg1 = new Uint8Array(packet);
        this.establishedMsg2 = new Uint8Array(reply);
        this.finalize();
        return { reply, established: true, remotePubkey: rs };
    }
    handleMsg2(packet) {
        if (this.role !== "initiator")
            throw new Error("only initiator handles Msg2");
        if (this.state === "established") {
            if (this.establishedMsg2 && bytesEqual(packet, this.establishedMsg2)) {
                return { established: true, remotePubkey: this.remotePubkey };
            }
            throw new Error("unexpected FMP Msg2 after establishment");
        }
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
        this.remoteEpoch = new Uint8Array(payload);
        this.remoteSessionIdx = msg2.senderIdx;
        this.establishedMsg2 = new Uint8Array(packet);
        this.finalize();
        return { established: true, remotePubkey: this.remotePubkey };
    }
    finalize() {
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const { tx, rx } = this.hs.splitTxRx();
        this.tx = tx;
        this.rx = rx;
        this.sessionStartMs = performance.now();
        this.state = "established";
        this.hs = undefined;
    }
    encryptOutgoing(payload, msgType = FMP_INNER_DATA) {
        if (this.state !== "established" || !this.tx || this.remoteSessionIdx === undefined) {
            throw new Error("FMP link not established");
        }
        if (this.txCounter >= 0xffffffffffffffffn)
            throw new Error("FMP nonce exhausted");
        const counter = this.txCounter++;
        const innerLen = 5 + payload.length;
        const out = new Uint8Array(FMP_ESTABLISHED_HEADER_LEN + innerLen + FMP_AEAD_TAG_LEN);
        writeFmpEstablishedHeader(out, { flags: 0, receiverIdx: this.remoteSessionIdx, counter }, innerLen);
        writeU32le(out, FMP_ESTABLISHED_HEADER_LEN, Math.floor(performance.now() - this.sessionStartMs) >>> 0);
        out[FMP_ESTABLISHED_HEADER_LEN + 4] = msgType & 0xff;
        out.set(payload, FMP_ESTABLISHED_HEADER_LEN + 5);
        // Use the explicit u64 frame counter as the AEAD nonce, encrypting in-place.
        aeadSealInto(this.tx.getKey(), counter, out.subarray(FMP_ESTABLISHED_HEADER_LEN, FMP_ESTABLISHED_HEADER_LEN + innerLen), out.subarray(0, FMP_ESTABLISHED_HEADER_LEN), out.subarray(FMP_ESTABLISHED_HEADER_LEN));
        return out;
    }
    encryptKeepalive() {
        return this.encryptOutgoing(new Uint8Array(0), FMP_INNER_KEEPALIVE);
    }
    decryptIncoming(packet) {
        if (this.state !== "established" || !this.rx) {
            throw new Error("FMP link not established");
        }
        const est = parseFmpEstablished(packet);
        if (est.receiverIdx !== this.localSessionIdx) {
            throw new Error("FMP Established receiver_idx mismatch");
        }
        if (!this.rxReplay.check(est.counter)) {
            throw new Error("FMP replay/duplicate counter");
        }
        const plaintext = aeadOpen(this.rx.getKey(), est.counter, est.ciphertext, est.aad);
        this.rxReplay.accept(est.counter);
        if (plaintext.length < 5)
            throw new Error("FMP inner packet too short");
        const timestamp = readU32le(plaintext, 0);
        const msgType = plaintext[4];
        this.receiverReports.record({
            counter: est.counter, timestamp, bytes: packet.length,
            ceFlag: (est.flags & 0x02) !== 0,
        }, performance.now());
        return { msgType, payload: plaintext.subarray(5) };
    }
    /** Report on this authenticated key/counter epoch; no timer or RR replies. */
    receiverReportFor(senderReport) {
        if (this.state !== "established")
            return undefined;
        return this.receiverReports.forSenderReport(senderReport, performance.now());
    }
    close() {
        this.state = "closed";
    }
}
export { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2 };
export function isEqualPubkey(a, b) {
    return bytesEqual(a, b);
}
//# sourceMappingURL=link.js.map