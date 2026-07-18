import { beforeEach, describe, expect, it } from "vitest";

import { NostrRelayClient, type NostrEvent } from "../src/NostrRelayClient.js";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static accepted = true;
  static message = "";
  static failNextConnect = false;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.failNextConnect) {
        FakeWebSocket.failNextConnect = false;
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", {});
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as [string, NostrEvent];
    if (parsed[0] !== "EVENT") return;
    const event = parsed[1];
    queueMicrotask(() => {
      this.emit("message", {
        data: JSON.stringify(["OK", event.id, FakeWebSocket.accepted, FakeWebSocket.message]),
      });
    });
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  serverClose(): void {
    this.close();
  }

  serverMessage(message: unknown[]): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

beforeEach(() => {
  FakeWebSocket.accepted = true;
  FakeWebSocket.message = "";
  FakeWebSocket.failNextConnect = false;
  FakeWebSocket.instances = [];
});

function event(id: string): NostrEvent {
  return {
    id,
    pubkey: "aa".repeat(32),
    created_at: 1,
    kind: 37195,
    tags: [["p", "bb".repeat(32)]],
    content: "content",
    sig: "cc".repeat(64),
  };
}

describe("NostrRelayClient publish acknowledgements", () => {
  it("resolves after relay OK true", async () => {
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    await relay.publish(event("ok"));

    expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
  });

  it("can reconnect after a relay closes before opening", async () => {
    FakeWebSocket.failNextConnect = true;
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    await expect(relay.connect()).rejects.toThrow("relay closed before open");
    await relay.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("rejects relay OK false", async () => {
    FakeWebSocket.accepted = false;
    FakeWebSocket.message = "blocked: created_at too old";
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    await expect(relay.publish(event("reject"))).rejects.toThrow("created_at too old");
  });
});

describe("NostrRelayClient subscription lifecycle", () => {
  it("replays a subscription registered before an initial connection failure", async () => {
    FakeWebSocket.failNextConnect = true;
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const filter = { kinds: [37195], "#d": ["fips-overlay-v1"] };

    await expect(relay.subscribe(filter, {
      onEvent: () => undefined,
    })).rejects.toThrow("relay closed before open");
    await relay.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.sent.map((message) => JSON.parse(message))).toEqual([
      ["REQ", "s1", filter],
    ]);
  });

  it("replays active subscriptions once in insertion order after reconnect", async () => {
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const firstFilter = { kinds: [37195], "#p": ["aa"] };
    const secondFilter = { authors: ["bb"], since: 10 };
    const onEose = (): void => undefined;

    await relay.subscribe(firstFilter, { onEvent: () => undefined, onEose });
    await relay.subscribe(secondFilter, { onEvent: () => undefined });
    const firstSocket = FakeWebSocket.instances[0]!;

    expect(firstSocket.sent.map((message) => JSON.parse(message))).toEqual([
      ["REQ", "s1", firstFilter],
      ["REQ", "s2", secondFilter],
    ]);

    firstFilter.kinds = [1];
    firstSocket.serverMessage(["EOSE", "s1"]);
    firstSocket.serverClose();
    await relay.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.sent).toEqual(firstSocket.sent);
  });

  it("does not replay a subscription retired by relay CLOSED", async () => {
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const unsubscribe = await relay.subscribe(
      { kinds: [37195] },
      { onEvent: () => undefined },
    );
    const firstSocket = FakeWebSocket.instances[0]!;

    firstSocket.serverMessage(["CLOSED", "s1", "rate-limited"]);
    unsubscribe();
    firstSocket.serverClose();
    await relay.connect();

    expect(firstSocket.sent.map((message) => JSON.parse(message))).toEqual([
      ["REQ", "s1", { kinds: [37195] }],
    ]);
    expect(FakeWebSocket.instances[1]!.sent).toEqual([]);
  });

  it("does not replay subscriptions after explicit client close", async () => {
    const relay = new NostrRelayClient({
      url: "ws://relay.test",
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const unsubscribe = await relay.subscribe(
      { kinds: [37195] },
      { onEvent: () => undefined },
    );
    const firstSocket = FakeWebSocket.instances[0]!;

    relay.close();
    await relay.connect();
    unsubscribe();

    expect(firstSocket.sent.map((message) => JSON.parse(message))).toEqual([
      ["REQ", "s1", { kinds: [37195] }],
    ]);
    expect(FakeWebSocket.instances[1]!.sent).toEqual([]);
  });
});
