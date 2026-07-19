/**
 * FSP end-to-end session — same Rust-compatible wire envelope as before,
 * with the inner handshake now using the real Noise_XK_secp256k1_ChaChaPoly_SHA256
 * pattern. 8-byte epoch payloads at handshake steps 2 and 3 (XK msg1 has no
 * payload).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { noiseNonce } from "../crypto/aead.js";
import { ReplayWindow } from "../crypto/replay.js";
import { bytesEqual } from "../codec/hex.js";
import { NoiseHandshake } from "../noise/index.js";
import { decodeSessionAck, decodeSessionMsg3, decodeSessionSetup, encodeSessionAck, encodeSessionMsg3, encodeSessionSetup, SESSION_FLAG_DIRECT_FSP_TRANSPORT, } from "../protocol/session.js";
import { decodeDataPacket, decodeFspEstablished, decodeFspHandshake, decodeFspInner, encodeDataPacket, encodeFspEstablished, encodeFspEstablishedHeader, encodeFspHandshake, encodeFspInner, FSP_MSG_DATA, FSP_MSG_ENDPOINT_DATA, FSP_MSG_KEEPALIVE, FSP_FLAG_DIRECT_TRANSPORT, FSP_FLAG_K, NOISE_XK_MSG1_LEN, NOISE_XK_MSG2_LEN, NOISE_XK_MSG3_LEN, } from "./wire.js";
const EPOCH_LEN = 8;
export class FspSession {
    identity;
    role;
    remotePubkey;
    remoteEpoch;
    localEpoch;
    hs;
    tx;
    rx;
    receivedSessionSetup;
    sentSessionAck;
    receivedSessionAck;
    sentSessionMsg3;
    establishedMsg3;
    remoteDirectFspTransport = false;
    txCounter = 0n;
    replay = new ReplayWindow();
    state = "init";
    constructor(init) {
        this.identity = init.identity;
        this.role = init.role;
        this.localEpoch = init.localEpoch
            ? new Uint8Array(init.localEpoch)
            : new Uint8Array(EPOCH_LEN);
        if (this.localEpoch.length !== EPOCH_LEN) {
            throw new Error(`FSP local epoch must be ${EPOCH_LEN} bytes`);
        }
        if (init.remotePubkey)
            this.remotePubkey = init.remotePubkey;
        this.hs = new NoiseHandshake({
            pattern: "XK",
            role: init.role,
            identity: init.identity,
            remoteStatic: init.remotePubkey,
            ephemeralOverride: init.ephemeralOverride,
        });
    }
    get remoteSupportsDirectFspTransport() {
        return this.remoteDirectFspTransport;
    }
    buildMsg1(_rand) {
        if (this.role !== "initiator")
            throw new Error("only initiator builds XK msg1");
        if (!this.remotePubkey)
            throw new Error("initiator needs remote pubkey");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        this.state = "handshaking";
        // XK msg1 carries no payload — `e` only (33 bytes).
        const noiseMsg = this.hs.writeMessage(new Uint8Array(0));
        if (noiseMsg.length !== NOISE_XK_MSG1_LEN) {
            throw new Error(`XK msg1 size ${noiseMsg.length} != ${NOISE_XK_MSG1_LEN}`);
        }
        return encodeFspHandshake({ phase: 1, noiseMsg });
    }
    buildSessionSetup(_rand, srcCoords, destCoords) {
        if (this.role !== "initiator")
            throw new Error("only initiator builds SessionSetup");
        if (!this.remotePubkey)
            throw new Error("initiator needs remote pubkey");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        this.state = "handshaking";
        const noiseMsg = this.hs.writeMessage(new Uint8Array(0));
        if (noiseMsg.length !== NOISE_XK_MSG1_LEN) {
            throw new Error(`XK msg1 size ${noiseMsg.length} != ${NOISE_XK_MSG1_LEN}`);
        }
        return encodeSessionSetup({
            srcCoords: normalizeCoords(srcCoords),
            destCoords: normalizeCoords(destCoords),
            flags: SESSION_FLAG_DIRECT_FSP_TRANSPORT,
            handshakePayload: noiseMsg,
        });
    }
    handleMsg1(packet, _rand) {
        if (this.role !== "responder")
            throw new Error("only responder handles XK msg1");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const frame = decodeFspHandshake(packet);
        if (frame.phase !== 1)
            throw new Error("expected XK msg1");
        const payload = this.hs.readMessage(frame.noiseMsg);
        if (payload.length !== 0)
            throw new Error("XK msg1 inner payload must be empty");
        const noiseMsg = this.hs.writeMessage(this.localEpoch);
        if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
            throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
        }
        return encodeFspHandshake({ phase: 2, noiseMsg });
    }
    handleSessionSetup(packet, _rand, localCoords) {
        if (this.role !== "responder")
            throw new Error("only responder handles SessionSetup");
        if (this.receivedSessionSetup) {
            if (bytesEqual(packet, this.receivedSessionSetup) && this.sentSessionAck) {
                return new Uint8Array(this.sentSessionAck);
            }
            throw new Error("unexpected FSP SessionSetup after handshake start");
        }
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const setup = decodeSessionSetup(packet);
        if (setup.handshakePayload.length !== NOISE_XK_MSG1_LEN) {
            throw new Error("bad XK msg1 length");
        }
        const payload = this.hs.readMessage(setup.handshakePayload);
        if (payload.length !== 0)
            throw new Error("XK msg1 inner payload must be empty");
        this.remoteDirectFspTransport =
            (setup.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
        const noiseMsg = this.hs.writeMessage(this.localEpoch);
        if (noiseMsg.length !== NOISE_XK_MSG2_LEN) {
            throw new Error(`XK msg2 size ${noiseMsg.length} != ${NOISE_XK_MSG2_LEN}`);
        }
        const reply = encodeSessionAck({
            srcCoords: normalizeCoords(localCoords),
            destCoords: setup.srcCoords,
            flags: SESSION_FLAG_DIRECT_FSP_TRANSPORT,
            handshakePayload: noiseMsg,
        });
        this.state = "handshaking";
        this.receivedSessionSetup = new Uint8Array(packet);
        this.sentSessionAck = new Uint8Array(reply);
        return reply;
    }
    matchesSessionSetup(packet) {
        return this.receivedSessionSetup !== undefined
            && bytesEqual(packet, this.receivedSessionSetup);
    }
    handleMsg2(packet, _rand) {
        if (this.role !== "initiator")
            throw new Error("only initiator handles XK msg2");
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const frame = decodeFspHandshake(packet);
        if (frame.phase !== 2)
            throw new Error("expected XK msg2");
        if (frame.noiseMsg.length !== NOISE_XK_MSG2_LEN)
            throw new Error("bad XK msg2 length");
        const payload = this.hs.readMessage(frame.noiseMsg);
        if (payload.length !== EPOCH_LEN)
            throw new Error("XK msg2 inner payload must be 8 bytes");
        this.remoteEpoch = new Uint8Array(payload);
        const noiseMsg = this.hs.writeMessage(this.localEpoch);
        if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
            throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
        }
        this.finalize();
        return encodeFspHandshake({ phase: 3, noiseMsg });
    }
    handleSessionAck(packet, _rand) {
        if (this.role !== "initiator")
            throw new Error("only initiator handles SessionAck");
        if (this.receivedSessionAck) {
            if (bytesEqual(packet, this.receivedSessionAck) && this.sentSessionMsg3) {
                return new Uint8Array(this.sentSessionMsg3);
            }
            throw new Error("unexpected FSP SessionAck after establishment");
        }
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const ack = decodeSessionAck(packet);
        if (ack.handshakePayload.length !== NOISE_XK_MSG2_LEN)
            throw new Error("bad XK msg2 length");
        const payload = this.hs.readMessage(ack.handshakePayload);
        if (payload.length !== EPOCH_LEN)
            throw new Error("XK msg2 inner payload must be 8 bytes");
        this.remoteDirectFspTransport =
            (ack.flags & SESSION_FLAG_DIRECT_FSP_TRANSPORT) !== 0;
        this.remoteEpoch = new Uint8Array(payload);
        const noiseMsg = this.hs.writeMessage(this.localEpoch);
        if (noiseMsg.length !== NOISE_XK_MSG3_LEN) {
            throw new Error(`XK msg3 size ${noiseMsg.length} != ${NOISE_XK_MSG3_LEN}`);
        }
        const reply = encodeSessionMsg3({ flags: 0, handshakePayload: noiseMsg });
        this.receivedSessionAck = new Uint8Array(packet);
        this.sentSessionMsg3 = new Uint8Array(reply);
        this.finalize();
        return reply;
    }
    handleMsg3(packet) {
        if (this.role !== "responder")
            throw new Error("only responder handles XK msg3");
        if (this.state === "established") {
            if (this.establishedMsg3 && bytesEqual(packet, this.establishedMsg3))
                return;
            throw new Error("unexpected FSP Msg3 after establishment");
        }
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const frame = decodeFspHandshake(packet);
        if (frame.phase !== 3)
            throw new Error("expected XK msg3");
        if (frame.noiseMsg.length !== NOISE_XK_MSG3_LEN)
            throw new Error("bad XK msg3 length");
        const payload = this.hs.readMessage(frame.noiseMsg);
        if (payload.length !== EPOCH_LEN)
            throw new Error("XK msg3 inner payload must be 8 bytes");
        this.remoteEpoch = new Uint8Array(payload);
        const rs = this.hs.getRemoteStatic();
        if (!rs)
            throw new Error("XK responder did not capture remote static");
        this.remotePubkey = rs;
        this.establishedMsg3 = new Uint8Array(packet);
        this.finalize();
    }
    handleSessionMsg3(packet) {
        if (this.role !== "responder")
            throw new Error("only responder handles SessionMsg3");
        if (this.state === "established") {
            if (this.establishedMsg3 && bytesEqual(packet, this.establishedMsg3))
                return;
            throw new Error("unexpected FSP Msg3 after establishment");
        }
        if (!this.hs)
            throw new Error("noise handshake state missing");
        const msg3 = decodeSessionMsg3(packet);
        if (msg3.handshakePayload.length !== NOISE_XK_MSG3_LEN)
            throw new Error("bad XK msg3 length");
        const payload = this.hs.readMessage(msg3.handshakePayload);
        if (payload.length !== EPOCH_LEN)
            throw new Error("XK msg3 inner payload must be 8 bytes");
        this.remoteEpoch = new Uint8Array(payload);
        const rs = this.hs.getRemoteStatic();
        if (!rs)
            throw new Error("XK responder did not capture remote static");
        this.remotePubkey = rs;
        this.establishedMsg3 = new Uint8Array(packet);
        this.finalize();
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
    encryptDatagram(data, flags = 0) {
        if (this.state !== "established" || !this.tx)
            throw new Error("FSP not established");
        const counter = this.txCounter++;
        const inner = encodeFspInner({
            timestamp: Math.floor(Date.now() / 1000),
            msgType: FSP_MSG_DATA,
            innerFlags: 0,
            payload: encodeDataPacket(data),
        });
        validateEstablishedFlags(flags);
        const aad = encodeFspEstablishedHeader({ flags, counter }, inner.length);
        const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
        return encodeFspEstablished({ flags, counter, payloadLen: inner.length, ciphertext });
    }
    encryptEndpointData(payload, flags = 0) {
        return this.encryptMessage(FSP_MSG_ENDPOINT_DATA, payload, flags);
    }
    encryptMessage(msgType, payload, flags = 0) {
        if (this.state !== "established" || !this.tx)
            throw new Error("FSP not established");
        if (!Number.isInteger(msgType) || msgType < 0 || msgType > 0xff) {
            throw new Error("FSP message type must be one byte");
        }
        const counter = this.txCounter++;
        const inner = encodeFspInner({
            timestamp: Math.floor(Date.now() / 1000),
            msgType,
            innerFlags: 0,
            payload,
        });
        validateEstablishedFlags(flags);
        const aad = encodeFspEstablishedHeader({ flags, counter }, inner.length);
        const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
        return encodeFspEstablished({ flags, counter, payloadLen: inner.length, ciphertext });
    }
    encryptKeepalive(flags = 0) {
        if (this.state !== "established" || !this.tx)
            throw new Error("FSP not established");
        const counter = this.txCounter++;
        const inner = encodeFspInner({
            timestamp: Math.floor(Date.now() / 1000),
            msgType: FSP_MSG_KEEPALIVE,
            innerFlags: 0,
            payload: new Uint8Array(0),
        });
        validateEstablishedFlags(flags);
        const aad = encodeFspEstablishedHeader({ flags, counter }, inner.length);
        const ciphertext = chacha20poly1305(this.tx.getKey(), noiseNonce(counter), aad).encrypt(inner);
        return encodeFspEstablished({ flags, counter, payloadLen: inner.length, ciphertext });
    }
    decryptIncoming(packet) {
        if (this.state !== "established" || !this.rx)
            throw new Error("FSP not established");
        const est = decodeFspEstablished(packet);
        if (!this.replay.check(est.counter)) {
            throw new Error("FSP replay/duplicate counter");
        }
        const aad = encodeFspEstablishedHeader({ flags: est.flags, counter: est.counter }, est.payloadLen);
        const plaintext = chacha20poly1305(this.rx.getKey(), noiseNonce(est.counter), aad).decrypt(est.ciphertext);
        this.replay.accept(est.counter);
        const inner = decodeFspInner(plaintext);
        if (inner.msgType === FSP_MSG_DATA) {
            return { msgType: inner.msgType, data: decodeDataPacket(inner.payload) };
        }
        if (inner.msgType === FSP_MSG_ENDPOINT_DATA) {
            return { msgType: inner.msgType, endpointData: inner.payload, payload: inner.payload };
        }
        return { msgType: inner.msgType, payload: inner.payload };
    }
    close() {
        this.state = "closed";
        this.hs = undefined;
        this.tx = undefined;
        this.rx = undefined;
    }
}
function validateEstablishedFlags(flags) {
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
        throw new Error("FSP flags must be one byte");
    }
    if ((flags & ~(FSP_FLAG_DIRECT_TRANSPORT | FSP_FLAG_K)) !== 0) {
        throw new Error("unsupported FSP established flags");
    }
}
function normalizeCoords(coords) {
    return coords instanceof Uint8Array ? [coords] : coords;
}
//# sourceMappingURL=session.js.map