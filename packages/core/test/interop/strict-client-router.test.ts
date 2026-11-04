import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import { createReadStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FipsNode, identityFromSecretKey, npubToHex, toHex, type FipsIdentity, type Transport, type TransportAddress, type TransportContext } from "../../src/index.js";

// Explicit, prebuilt fixtures only: this test never invokes Cargo or downloads binaries.
// Each path must be paired with its independently verified SHA-256.
const fixtures: Array<{ version: string; path: string; sha256: string }> = JSON.parse(process.env.FIPS_COMPAT_ROUTERS ?? "[]");
const cases = fixtures.map(fixture => [fixture.version, fixture] as const);
const enabled = fixtures.length ? it : it.skip;

class LoopbackUdp implements Transport {
  readonly type = "udp-fixture";
  readonly mtu = 1400;
  readonly packets = { sent: 0, received: 0, ignored: 0 };
  private socket?: Socket;
  constructor(readonly key: string, readonly port: number) {}
  async start(context: TransportContext) {
    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (data, remote) => {
      if (this.socket !== socket || remote.address !== "127.0.0.1" || remote.port !== this.port) { this.packets.ignored++; return; }
      this.packets.received++;
      context.onPacket({ transportType: this.type, remoteAddr: { transport: this.type, addr: this.key },
        data: new Uint8Array(data), receivedAtMs: Date.now() });
    });
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
  }
  async stop() {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await new Promise<void>(resolve => socket.close(() => resolve()));
  }
  async connect(address: TransportAddress) {
    if (address.addr !== this.key || !this.socket) throw new Error("unknown fixture peer");
  }
  async send(address: TransportAddress, packet: Uint8Array) {
    await this.connect(address);
    this.packets.sent++;
    await new Promise<void>((resolve, reject) => this.socket!.send(packet, this.port, "127.0.0.1",
      error => error ? reject(error) : resolve()));
  }
}

async function startRouter(fixture: typeof fixtures[number], identity: FipsIdentity,
  peer?: { npub: string; port: number }) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(fixture.path)) hash.update(chunk);
  expect(hash.digest("hex")).toBe(fixture.sha256);
  const reserved = createSocket("udp4");
  reserved.bind(0, "127.0.0.1");
  await once(reserved, "listening");
  const port = reserved.address().port;
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), "fips-strict-router-"));
  const ready = join(dir, "ready"), stop = join(dir, "stop"), config = join(dir, "config.json");
  const control = join(dir, "control.sock");
  writeFileSync(config, JSON.stringify({
    node: { identity: { nsec: toHex(identity.secretKey) }, routing: { mode: "reply_learned" },
      system_files_enabled: false, control: { enabled: true, socket_path: control },
      discovery: { local: { enabled: false }, lan: { enabled: false }, nostr: { enabled: false } } },
    tun: { enabled: false }, dns: { enabled: false }, transports: { udp: { bind_addr: `127.0.0.1:${port}` } },
    peers: peer ? [{ npub: peer.npub, addresses: [{ transport: "udp", addr: `127.0.0.1:${peer.port}` }] }] : [],
  }));
  const process = spawn(fixture.path, ["--exact", "compat_router_process", "--nocapture"], {
    cwd: dir, env: { ...globalThis.process.env, RUST_MIN_STACK: "16777216",
      FIPS_COMPAT_ROUTER_CONFIG: config, FIPS_COMPAT_ROUTER_READY: ready, FIPS_COMPAT_ROUTER_STOP: stop },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [process.stdout, process.stderr]) stream?.on("data", data => { output = (output + data).slice(-8000); });
  const exit = once(process, "exit");
  const close = async () => {
    writeFileSync(stop, "");
    const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
    try { if (process.exitCode === null && process.signalCode === null) await exit; }
    finally { clearTimeout(timer); }
  };
  try {
    await vi.waitFor(() => {
      if (process.exitCode !== null || process.signalCode !== null) throw new Error(output);
      expect(existsSync(ready), output).toBe(true);
    }, { timeout: 10000, interval: 25 });
    expect(npubToHex(readFileSync(ready, "utf8").trim())).toBe(toHex(identity.xOnlyPubkey));
  } catch (error) { await close(); throw error; }
  const query = async (command: string) => {
    const socket = createConnection(control);
    socket.setTimeout(2000, () => socket.destroy(new Error("fixture control timeout")));
    try {
      await once(socket, "connect");
      socket.write(JSON.stringify({ command }) + "\n");
      let text = "";
      for await (const data of socket) {
        text += data;
        if (text.includes("\n")) {
          const reply = JSON.parse(text.slice(0, text.indexOf("\n")));
          expect(reply.status, JSON.stringify(reply)).toBe("ok");
          return reply.data;
        }
      }
      throw new Error("fixture control closed without a reply");
    } finally { socket.destroy(); }
  };
  const npub = readFileSync(ready, "utf8").trim();
  return { identity, npub, port, close, query, output: () => output };
}

enabled.each(cases.length ? cases : [["unconfigured", undefined!] as const])(
  "strict clients read and reconnect through two Rust %s ReplyLearned routers", async (_version, fixture) => {
    const identities = await Promise.all([1, 2, 3, 4, 5].map(value => identityFromSecretKey(new Uint8Array(32).fill(value))));
    const routers: Awaited<ReturnType<typeof startRouter>>[] = [];
    const nodes: FipsNode[] = [];
    const transports: LoopbackUdp[] = [];
    const diagnostics: string[] = [];
    try {
      routers.push(await startRouter(fixture, identities[0]));
      routers.push(await startRouter(fixture, identities[1], routers[0]));
      const [reader, provider] = [0, 1].map(index => {
        const router = routers[index];
        const transport = new LoopbackUdp(toHex(router.identity.publicKey), router.port);
        transports.push(transport);
        const node = new FipsNode({ identity: identities[index + 2], transports: [transport], strictClient: true });
        node.on("error", event => diagnostics.push(`${index}: ${String((event as { err: Error }).err)}`));
        nodes.push(node);
        return { node, transport, address: { transport: transport.type, addr: transport.key } };
      });
      const replies: number[] = [];
      reader.node.registerService(9010, ({ payload }) => { replies.push(payload[0]); });
      provider.node.registerService(9011, ({ payload, reply }) => reply(payload));
      await Promise.all(nodes.map(node => node.start()));
      await provider.node.connect(provider.address);
      for (const value of [1, 2]) {
        if (value === 2) await reader.node.setBlockedPeerPubkeys([toHex(identities[4].xOnlyPubkey)]);
        await reader.node.connect(reader.address);
        await vi.waitFor(async () => {
          for (const [index, router] of routers.entries()) {
            const peers = await router.query("show_peers");
            expect(peers.peers.filter((peer: { connectivity: string }) => peer.connectivity === "connected")).toHaveLength(2);
            const bloom = await router.query("show_bloom");
            expect(bloom.leaf_dependents).toContain(toHex(nodes[index].identity.nodeAddr));
          }
        }, { timeout: 3000, interval: 50 });
        const sent = reader.node.sendDatagram({ dst: toHex(provider.node.identity.publicKey), srcPort: 9010,
          dstPort: 9011, payload: new Uint8Array([value]) });
        void sent.catch(error => diagnostics.push(String(error)));
        await vi.waitFor(() => expect(replies, diagnostics.join("\n") + "\n" + routers.map(router => router.output()).join("\n")).toContain(value), { timeout: 10000 });
        await sent;
      }
      expect(replies).toEqual([1, 2]);
    } catch (error) {
      console.log(JSON.stringify({ packets: transports.map(transport => transport.packets), diagnostics }));
      for (const router of routers) for (const command of ["show_peers", "show_bloom", "show_tree"]) {
        console.log(JSON.stringify({ command, data: await router.query(command).catch(String) }));
      }
      throw error;
    } finally {
      await Promise.all(nodes.map(node => node.stop()));
      await Promise.all(routers.map(router => router.close()));
    }
  }, 30000,
);
