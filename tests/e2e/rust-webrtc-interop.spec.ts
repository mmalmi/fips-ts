import { expect, test } from "@playwright/test";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import path from "node:path";

const RUST_SECRET_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

interface RustFixture {
  process: ChildProcessWithoutNullStreams;
  npub: string;
  pubkeyHex: string;
  websocketUrl: string;
  stderr: () => string;
  close(): Promise<void>;
}

test.setTimeout(180_000);

test("Rust WebRTC stays responsive after a browser peer disconnects", async ({ page, context }) => {
  const manifest = rustManifestPath();
  test.skip(
    !fs.existsSync(manifest),
    `Rust FIPS checkout not found at ${manifest}; set FIPS_RS_ROOT to run this interop test`,
  );

  const rust = await startRustFixture(manifest);
  try {
    await page.addInitScript((url) => {
      window.__fipsTestWebSocketSeedUrl = url;
    }, rust.websocketUrl);
    page.on("console", (msg) => {
      if (msg.type() === "log" || msg.type() === "warning" || msg.type() === "error") {
        console.log(`browser ${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => console.log("pageerror:", err.message));

    await page.goto("/");
    await page.waitForFunction(() => !!window.__fipsHarness);

    const reply = await page.evaluate(async ({ pubkeyHex }) => {
      return window.__fipsHarness.echoWithRustWebRtcPeer(
        pubkeyHex,
        "hello-rust-fips",
      );
    }, { pubkeyHex: rust.pubkeyHex });

    expect(reply).toBe("hello-rust-fips");

    await page.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    });

    const replacementPage = await context.newPage();
    await replacementPage.addInitScript((url) => {
      window.__fipsTestWebSocketSeedUrl = url;
    }, rust.websocketUrl);
    await replacementPage.goto("/");
    await replacementPage.waitForFunction(() => !!window.__fipsHarness);
    const replacementReply = await replacementPage.evaluate(
      async ({ pubkeyHex }) => window.__fipsHarness.echoWithRustWebRtcPeer(
        pubkeyHex,
        "hello-after-disconnect",
      ),
      { pubkeyHex: rust.pubkeyHex },
    );
    expect(replacementReply).toBe("hello-after-disconnect");
    await replacementPage.close();
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
  manifestPath: string,
): Promise<RustFixture> {
  const cwd = path.dirname(manifestPath);
  const port = await availableLoopbackPort();
  const websocketUrl = `ws://127.0.0.1:${port}/fips`;
  const fixtureBin = process.env.FIPS_RS_FIXTURE_BIN
    ? path.resolve(process.env.FIPS_RS_FIXTURE_BIN)
    : undefined;
  if (fixtureBin) fs.accessSync(fixtureBin, fs.constants.X_OK);
  const proc = spawn(
    fixtureBin ?? "cargo",
    [
      ...(fixtureBin ? [] : [
        "run", "--quiet", "--manifest-path", manifestPath,
        "--bin", "fips-webrtc-echo-fixture", "--",
      ]),
      "--websocket-bind",
      `127.0.0.1:${port}`,
      "--secret",
      RUST_SECRET_HEX,
    ],
    {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        RUSTC_WRAPPER: "",
        RUST_LOG:
          process.env.FIPS_RUST_LOG ??
          "fips_core::transport::websocket=debug,fips_core::transport::webrtc=debug,info",
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
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
  }).catch(async (error) => {
    lines.close();
    await stopProcess(proc);
    throw error;
  });

  return {
    process: proc,
    ...ready,
    websocketUrl,
    stderr: () => stderr,
    close: () => stopProcess(proc),
  };
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
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
