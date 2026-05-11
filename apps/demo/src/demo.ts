import {
  FipsNode,
  generateIdentity,
  toHex,
} from "@fips/core";
import { MemoryTransport, MemoryHub } from "@fips/transport-memory";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function log(line: string) {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
}

export async function runDemo(): Promise<void> {
  const startBtn = $<HTMLButtonElement>("start");
  const stopBtn = $<HTMLButtonElement>("stop");
  const echoBtn = $<HTMLButtonElement>("echo-self");
  const statusEl = $("status");
  const pubkeyEl = $("pubkey");
  const nodeaddrEl = $("nodeaddr");
  const peersEl = $("peers");

  let node: FipsNode | null = null;
  let peerNode: FipsNode | null = null;

  startBtn.addEventListener("click", async () => {
    const identity = await generateIdentity();
    const peerIdentity = await generateIdentity();
    const hub = new MemoryHub();
    node = new FipsNode({
      identity,
      transports: [new MemoryTransport({ hub })],
    });
    peerNode = new FipsNode({
      identity: peerIdentity,
      transports: [new MemoryTransport({ hub })],
    });

    peerNode.registerService(9000, async ({ payload, reply }) => {
      await reply(payload);
    });

    await node.start();
    await peerNode.start();

    pubkeyEl.textContent = toHex(identity.publicKey);
    nodeaddrEl.textContent = toHex(identity.nodeAddr);
    statusEl.textContent = "started";
    statusEl.className = "pill ok";
    peersEl.textContent = `local: ${toHex(identity.publicKey).slice(0, 16)}…\npeer:  ${toHex(peerIdentity.publicKey).slice(0, 16)}…`;
    log("[demo] node started");
    startBtn.disabled = true;
    stopBtn.disabled = false;
    echoBtn.disabled = false;

    await node.connect({
      transport: "memory",
      addr: toHex(peerIdentity.publicKey),
    });
    log("[demo] connected to peer over memory transport");
    (window as unknown as { __fips: unknown }).__fips = { node, peerNode };
  });

  stopBtn.addEventListener("click", async () => {
    await node?.stop();
    await peerNode?.stop();
    node = null;
    peerNode = null;
    statusEl.textContent = "stopped";
    statusEl.className = "pill err";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    echoBtn.disabled = true;
    log("[demo] node stopped");
  });

  echoBtn.addEventListener("click", async () => {
    if (!node || !peerNode) return;
    const reply = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("echo timeout")), 5000);
      const off = node!.on("datagram", (evt: unknown) => {
        const dg = evt as { dstPort: number; payload: Uint8Array };
        if (dg.dstPort === 9000) {
          clearTimeout(timer);
          off();
          resolve(dg.payload);
        }
      });
      void node!.sendDatagram({
        dst: toHex(peerNode!.identity.publicKey),
        srcPort: 9000,
        dstPort: 9000,
        payload: new TextEncoder().encode("hello"),
      });
    });
    log(`[demo] echo reply: ${new TextDecoder().decode(reply)}`);
  });
}
