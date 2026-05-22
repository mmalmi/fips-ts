const READY_FRAME = new Uint8Array([0xff, 0x46, 0x57, 0x52, 0x31]); // FWR1
const DEFAULT_READY_FALLBACK_MS = 250;
/**
 * A single WebRTC datachannel link to one remote pubkey.
 *
 * Reports `connected` after the peer connection or ICE transport is connected
 * and the data channel is open, then waits for the peer's small ready marker
 * or a short compatibility grace period. The grace keeps old peers working
 * while avoiding the common race where FMP Msg1 is sent before the responder's
 * onmessage handler is installed.
 */
export class WebRtcConnection {
    remotePubkeyHex;
    remoteAddr;
    pc;
    dataChannel;
    state = "connecting";
    onPacket;
    onState;
    readyFallbackMs;
    logger;
    localReadySent = false;
    remoteReady = false;
    fallbackTimer;
    constructor(cfg) {
        this.remotePubkeyHex = cfg.remotePubkeyHex;
        this.remoteAddr = cfg.remoteAddr;
        this.pc = cfg.pc;
        this.dataChannel = cfg.dataChannel;
        this.onPacket = cfg.onPacket;
        this.onState = cfg.onState;
        this.readyFallbackMs = cfg.readyFallbackMs ?? DEFAULT_READY_FALLBACK_MS;
        this.logger = cfg.logger;
        this.dataChannel.binaryType = "arraybuffer";
        this.dataChannel.addEventListener("message", (ev) => {
            let buf;
            if (ev.data instanceof ArrayBuffer)
                buf = new Uint8Array(ev.data);
            else if (ev.data instanceof Uint8Array)
                buf = ev.data;
            else if (typeof ev.data === "string")
                buf = new TextEncoder().encode(ev.data);
            else
                return;
            if (isReadyFrame(buf)) {
                this.remoteReady = true;
                this.logger?.debug("webrtc ready received", this.remotePubkeyHex);
                if (this.fallbackTimer) {
                    clearTimeout(this.fallbackTimer);
                    this.fallbackTimer = undefined;
                }
                this.evaluateState();
                return;
            }
            this.logger?.debug("webrtc packet received", this.remotePubkeyHex, buf.length, buf[0] ?? null);
            this.onPacket(buf);
        });
        this.dataChannel.addEventListener("open", () => {
            this.sendLocalReady();
            this.startReadyFallback();
            this.evaluateState();
        });
        this.dataChannel.addEventListener("close", () => {
            if (this.fallbackTimer)
                clearTimeout(this.fallbackTimer);
            this.state = "disconnected";
            this.logger?.debug("webrtc datachannel closed", this.remotePubkeyHex);
            this.onState(this.state);
        });
        this.pc.addEventListener("connectionstatechange", () => this.evaluateState());
        this.pc.addEventListener("iceconnectionstatechange", () => this.evaluateState());
        // Initial check in case listeners are wired after states have already
        // transitioned (e.g. responder's pc is already connected by the time we
        // construct this object).
        queueMicrotask(() => this.evaluateState());
    }
    evaluateState() {
        const pcState = this.pc.connectionState;
        const iceState = this.pc.iceConnectionState;
        const dcState = this.dataChannel.readyState;
        const pcConnected = pcState === "connected"
            || iceState === "connected"
            || iceState === "completed";
        const pcFailed = pcState === "failed"
            || pcState === "closed"
            || iceState === "failed"
            || iceState === "closed";
        const pcDisconnected = pcState === "disconnected"
            || iceState === "disconnected";
        let next;
        if (pcConnected && dcState === "open" && this.remoteReady)
            next = "connected";
        else if (pcFailed)
            next = "failed";
        else if (pcDisconnected)
            next = "disconnected";
        else
            next = "connecting";
        if (next !== this.state) {
            this.state = next;
            this.onState(next);
        }
    }
    sendLocalReady() {
        if (this.localReadySent || this.dataChannel.readyState !== "open")
            return;
        this.localReadySent = true;
        this.dataChannel.send(READY_FRAME);
        this.logger?.debug("webrtc ready sent", this.remotePubkeyHex);
    }
    startReadyFallback() {
        if (this.remoteReady || this.fallbackTimer || this.readyFallbackMs <= 0)
            return;
        this.fallbackTimer = setTimeout(() => {
            this.fallbackTimer = undefined;
            this.remoteReady = true;
            this.logger?.debug("webrtc ready fallback elapsed", this.remotePubkeyHex);
            this.evaluateState();
        }, this.readyFallbackMs);
    }
    send(data) {
        if (this.dataChannel.readyState !== "open") {
            throw new Error(`datachannel not open (state=${this.dataChannel.readyState})`);
        }
        // The DOM type only accepts Uint8Array<ArrayBuffer> — copy the bytes
        // into a fresh, non-shared buffer to be safe.
        const copy = new Uint8Array(new ArrayBuffer(data.length));
        copy.set(data);
        this.dataChannel.send(copy);
        this.logger?.debug("webrtc packet sent", this.remotePubkeyHex, copy.length, copy[0] ?? null);
    }
    close() {
        if (this.fallbackTimer)
            clearTimeout(this.fallbackTimer);
        try {
            this.dataChannel.close();
        }
        catch { /* ignore */ }
        try {
            this.pc.close();
        }
        catch { /* ignore */ }
    }
}
function isReadyFrame(data) {
    if (data.length !== READY_FRAME.length)
        return false;
    for (let i = 0; i < READY_FRAME.length; i++) {
        if (data[i] !== READY_FRAME[i])
            return false;
    }
    return true;
}
//# sourceMappingURL=WebRtcConnection.js.map