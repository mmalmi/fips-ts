/**
 * Tiny harness around the `fips-rust-bridge` Cargo binary.
 *
 * The bridge runs a Noise responder (IK or XK) using the Rust FIPS
 * implementation and exchanges 4-byte-big-endian-length-prefixed frames over
 * stdin/stdout. This module spawns it and exposes a Promise-shaped frame
 * reader/writer.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BRIDGE_BIN = resolve(
  __dirname,
  "../../../../interop/rust-bridge/target/release/fips-rust-bridge",
);

export function bridgeAvailable(): boolean {
  return existsSync(BRIDGE_BIN);
}

export interface BridgeSession {
  readFrame(): Promise<Uint8Array>;
  writeFrame(data: Uint8Array): Promise<void>;
  close(): Promise<number>;
}

interface PendingRead {
  resolve: (b: Uint8Array) => void;
  reject: (err: Error) => void;
}

export function spawnBridge(mode: "ik" | "xk", responderSkHex: string): BridgeSession {
  if (!bridgeAvailable()) {
    throw new Error(
      `bridge binary not built at ${BRIDGE_BIN}; run \`cargo build --release --manifest-path interop/rust-bridge/Cargo.toml\``,
    );
  }
  const proc = spawn(BRIDGE_BIN, [mode, responderSkHex], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    if (process.env.INTEROP_DEBUG) {
      process.stderr.write(`[bridge] ${chunk}`);
    }
  });

  let buffer = new Uint8Array(0);
  const pending: PendingRead[] = [];
  let closed = false;
  let closeReason: Error | null = null;

  function appendChunk(chunk: Buffer): void {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.length);
    buffer = merged;
    drainFrames();
  }

  function drainFrames(): void {
    while (pending.length > 0 && buffer.length >= 4) {
      const len =
        (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
      if (buffer.length < 4 + len) break;
      const frame = buffer.slice(4, 4 + len);
      buffer = buffer.slice(4 + len);
      pending.shift()!.resolve(new Uint8Array(frame));
    }
  }

  proc.stdout.on("data", appendChunk);
  proc.on("close", (_code) => {
    closed = true;
    closeReason = new Error(
      `bridge closed; stderr: ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
    for (const p of pending.splice(0)) p.reject(closeReason);
  });

  function readFrame(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (closed) return reject(closeReason!);
      pending.push({ resolve, reject });
      drainFrames();
    });
  }

  function writeFrame(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (closed) return reject(new Error("bridge closed"));
      const len = new Uint8Array(4);
      len[0] = (data.length >>> 24) & 0xff;
      len[1] = (data.length >>> 16) & 0xff;
      len[2] = (data.length >>> 8) & 0xff;
      len[3] = data.length & 0xff;
      proc.stdin.write(len, (err) => {
        if (err) return reject(err);
        proc.stdin.write(data, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  function close(): Promise<number> {
    return new Promise<number>((resolve) => {
      if (closed) return resolve(proc.exitCode ?? -1);
      proc.on("close", (code) => resolve(code ?? -1));
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!closed) proc.kill();
      }, 2000);
    });
  }

  return { readFrame, writeFrame, close };
}
