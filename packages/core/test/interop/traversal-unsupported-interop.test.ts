import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, createReadStream, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FipsNode, generateIdentity, npubFromHex, npubToHex, toHex } from "../../src/index.js";
import { LoopbackUdp } from "./loopbackUdp.js";

interface NativeFixture {
  path: string;
  sha256: string;
  sourceCommit: string;
  rustc: string;
}
// A separately admitted, prebuilt test executable is mandatory. Never invoke Cargo.
const fixture: NativeFixture | undefined = process.env.FIPS_TRAVERSAL_FIXTURE
  ? JSON.parse(process.env.FIPS_TRAVERSAL_FIXTURE) : undefined;
const enabled = fixture ? it : it.skip;
const nativeTest = "node::tests::session::mesh_traversal_interop::native_js_unsupported_process";
const marker = (phase: string) => new TextEncoder().encode(`traversal-interop-${phase}`);

enabled("rejects native traversal through a real routed encrypted session", async () => {
  expect(fixture!.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(fixture!.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(fixture!.rustc).toMatch(/^rustc \d+\.\d+\.\d+/);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(fixture!.path)) hash.update(chunk);
  expect(hash.digest("hex"), "native fixture bytes must match accepted provenance").toBe(fixture!.sha256);

  const directory = mkdtempSync(join(process.env.FIPS_TRAVERSAL_EVIDENCE_DIR ?? tmpdir(), "fips-traversal-"));
  const ready = join(directory, "ready.json"), result = join(directory, "result.json");
  const stop = join(directory, "stop"), config = join(directory, "config.json");
  const identity = await generateIdentity();
  writeFileSync(config, JSON.stringify({ schema: 1, targetNpub: npubFromHex(toHex(identity.xOnlyPubkey)),
    readyPath: ready, resultPath: result, stopPath: stop }), { mode: 0o600 });
  const log = openSync(join(directory, "native.log"), "wx", 0o600);
  const child = spawn(fixture!.path, ["--ignored", "--exact", nativeTest, "--nocapture", "--test-threads=1"], {
    cwd: directory, stdio: ["ignore", log, log],
    env: { ...process.env, FIPS_TRAVERSAL_INTEROP_CONFIG: config,
      RUST_MIN_STACK: "16777216", RUST_LOG: "off", RUST_BACKTRACE: "0" },
  });
  closeSync(log);
  const exited = once(child, "exit");
  // Install rejection handling immediately, even if executable startup fails.
  void exited.catch(() => {});
  let node: FipsNode | undefined;
  let watchdogExpired = false;
  const watchdog = setTimeout(() => { watchdogExpired = true; child.kill("SIGKILL"); }, 170_000);
  let exitCode: number | null = null;
  const live = () => {
    if (watchdogExpired) throw new Error("mixed fixture exceeded its deadline");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("native fixture exited before readiness/result");
  };
  try {
    await vi.waitFor(() => { live(); expect(existsSync(ready)).toBe(true); }, { timeout: 20_000, interval: 25 });
    const native = JSON.parse(readFileSync(ready, "utf8"));
    expect(native.schema).toBe(1);
    expect(native.relayAddress).toMatch(/^127\.0\.0\.1:[0-9]+$/);
    const port = Number(native.relayAddress.split(":")[1]);
    expect(port).toBeGreaterThan(0); expect(port).toBeLessThanOrEqual(65535);
    const sender = npubToHex(native.senderNpub);
    const transport = new LoopbackUdp(`02${npubToHex(native.relayNpub)}`, port);
    node = new FipsNode({ identity, transports: [transport], strictClient: true });
    const currentNode = node;
    let phase = "warm", deliveries = 0, failedReplies = 0;
    node.on("endpointData", event => {
      const incoming = event as { src: string; payload: Uint8Array };
      if (incoming.src.slice(-64).toLowerCase() !== sender) return;
      const value = new TextDecoder().decode(incoming.payload);
      if (phase === "warm" && value === "traversal-interop-warm-ack") {
        phase = "running"; deliveries++;
        void currentNode.sendEndpointData({ dst: `02${sender}`, payload: marker("go") }).catch(() => failedReplies++);
      } else if (phase === "running" && value === "traversal-interop-finished") {
        phase = "finished"; deliveries++;
        void currentNode.sendEndpointData({ dst: `02${sender}`, payload: marker("finished-ack") }).catch(() => failedReplies++);
      }
    });
    await node.start();
    await node.connect({ transport: transport.type, addr: transport.key });
    await node.sendEndpointData({ dst: `02${sender}`, payload: marker("warm") });
    await vi.waitFor(() => {
      if (!existsSync(result)) live();
      expect(existsSync(result)).toBe(true);
    }, { timeout: 140_000, interval: 100 });
    const counters = JSON.parse(readFileSync(result, "utf8")) as Record<string, number>;
    expect(Object.values(counters).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(counters).toMatchObject({ attempts: 5, offers: 5, retransmissions: 0,
      matchingRejections: 5, failures: 5, passed: 1, cleanupClosed: 1 });
    expect(counters.cooldownMsRemaining).toBeGreaterThan(0);
    expect(counters.applicationDeliveries).toBe(3);
    expect(counters.applicationRepliesSent).toBe(2);
    expect(deliveries).toBe(2);
    expect(failedReplies).toBe(0);
    expect(phase).toBe("finished");
    [exitCode] = await exited;
    expect(exitCode).toBe(0);
    writeFileSync(join(directory, "receipt.json"), JSON.stringify({
      schema: 1, nativeSha256: fixture!.sha256, nativeSourceCommit: fixture!.sourceCommit,
      rustc: fixture!.rustc, counters, jsApplicationDeliveries: deliveries,
      scope: "FSP destination interop over test loopback UDP; not browser transport or deployment proof",
    }, null, 2));
  } finally {
    writeFileSync(stop, "");
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { await node?.stop(); }
    finally {
      try { if (child.exitCode === null && child.signalCode === null) await exited; }
      finally { clearTimeout(force); clearTimeout(watchdog); }
    }
  }
}, 180_000);
