import { expect, test } from "@playwright/test";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { startLocalNostrRelay, type LocalNostrRelay } from "./fixtures/localNostrRelay.js";

const RUST_SECRET_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

interface RustFixture {
  process: ChildProcessWithoutNullStreams;
  npub: string;
  pubkeyHex: string;
  stderr: () => string;
  close(): Promise<void>;
}

let relay: LocalNostrRelay;

test.setTimeout(180_000);

test.beforeAll(async () => {
  relay = await startLocalNostrRelay();
});

test.afterAll(async () => {
  await relay.close();
});

test("browser TypeScript FIPS dials Rust FIPS over WebRTC + local Nostr signaling", async ({ page }) => {
  const manifest = rustManifestPath();
  test.skip(
    !fs.existsSync(manifest),
    `Rust FIPS checkout not found at ${manifest}; set FIPS_RS_ROOT to run this interop test`,
  );

  const rust = await startRustFixture(relay.url, manifest);
  try {
    await page.addInitScript((url) => {
      window.__fipsTestRelayUrl = url;
    }, relay.url);
    page.on("console", (msg) => {
      if (msg.type() === "log" || msg.type() === "warning" || msg.type() === "error") {
        console.log(`browser ${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => console.log("pageerror:", err.message));

    await page.goto("/");
    await page.waitForFunction(() => !!window.__fipsHarness);

    const reply = await page.evaluate(async ({ relayUrl, pubkeyHex }) => {
      return window.__fipsHarness.echoWithRustWebRtcPeer(
        relayUrl,
        pubkeyHex,
        "hello-rust-fips",
      );
    }, { relayUrl: relay.url, pubkeyHex: rust.pubkeyHex });

    expect(reply).toBe("hello-rust-fips");
  } catch (err) {
    const stderr = rust.stderr();
    if (stderr) console.log(`rust fixture stderr:\n${stderr}`);
    throw err;
  } finally {
    await rust.close();
  }
});

function rustManifestPath(): string {
  const root = process.env.FIPS_RS_ROOT ?? path.resolve(process.cwd(), "../fips");
  return path.join(root, "Cargo.toml");
}

async function startRustFixture(
  relayUrl: string,
  manifestPath: string,
): Promise<RustFixture> {
  const cwd = path.dirname(manifestPath);
  const proc = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      manifestPath,
      "--bin",
      "fips-webrtc-echo-fixture",
      "--",
      "--relay",
      relayUrl,
      "--secret",
      RUST_SECRET_HEX,
    ],
    {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        RUST_LOG:
          process.env.FIPS_RUST_LOG ??
          "fips_core::transport::webrtc=debug,fips_core::discovery::nostr=debug,info",
      },
    },
  );

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr = trimLog(stderr + chunk.toString("utf8"));
  });

  const lines = createInterface({ input: proc.stdout });
  const ready = await new Promise<{ npub: string; pubkeyHex: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Rust fixture did not become ready\n${stderr}`));
    }, 90_000);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Rust fixture exited before ready code=${code} signal=${signal}\n${stderr}`));
    });
    lines.on("line", (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: string }).type === "ready" &&
        typeof (msg as { npub?: unknown }).npub === "string" &&
        typeof (msg as { pubkeyHex?: unknown }).pubkeyHex === "string"
      ) {
        clearTimeout(timer);
        resolve({
          npub: (msg as { npub: string }).npub,
          pubkeyHex: (msg as { pubkeyHex: string }).pubkeyHex,
        });
      }
    });
  });

  return {
    process: proc,
    ...ready,
    stderr: () => stderr,
    close: () => stopProcess(proc),
  };
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
  } else {
    proc.kill("SIGTERM");
  }
  const exited = once(proc, "exit").then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 5_000);
  });
  await Promise.race([exited, timeout]);
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

function trimLog(log: string): string {
  const max = 24_000;
  return log.length > max ? log.slice(log.length - max) : log;
}
