import { afterEach, expect, it, vi } from 'vitest';
import { encodeFspEstablished, identityFromSecretKey, noopLogger } from '../src/index.js';
import { FspSessionManager } from '../src/node/FspSessionManager.js';

// A valid public envelope whose old ciphertext cannot be authenticated here.
// Recovery may request a handshake, but must never deliver this payload.
const staleRecord = encodeFspEstablished({
  flags: 0, counter: 1n, payloadLen: 6, ciphertext: new Uint8Array(22),
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x61));
  const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
  const resolveIdentity = vi.fn(async (_node: Uint8Array, _abort: AbortController): Promise<Uint8Array> => {
    throw new Error('unknown identity');
  });
  const sendFspToward = vi.fn();
  const delivered = vi.fn();
  const manager = new FspSessionManager({
    identity, localEpoch: new Uint8Array(8), random: { bytes: length => new Uint8Array(length) },
    logger: noopLogger,
    routing: { resolveIdentity, sendFspToward, hasUsableRoute: () => true, coordinatesFor: () => [remote.nodeAddr] } as never,
    getPeerByNodeAddr: () => undefined, emitDatagram: delivered, emitEndpointData: delivered,
    handleLinkNegotiation: delivered, emitSession: vi.fn(),
  });
  const receive = (node = remote.nodeAddr, frame = staleRecord) => manager.handleFromPeer({} as never, node, frame);
  return { manager, remote, receive, resolveIdentity, sendFspToward, delivered };
}

it('coalesces missing-session bursts and backs off failed identity lookups', async () => {
  vi.useFakeTimers();
  const { manager, receive, resolveIdentity, delivered } = await fixture();
  try {
    await Promise.all(Array.from({ length: 20 }, () => receive()));
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    await receive();
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await receive();
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    expect(delivered).not.toHaveBeenCalled();
  } finally { manager.stop(); }
});

it('rejects malformed established envelopes before attempting identity resolution', async () => {
  const { manager, receive, resolveIdentity } = await fixture();
  try {
    await expect(receive(undefined, staleRecord.slice(0, 12))).rejects.toThrow('too short');
    expect(resolveIdentity).not.toHaveBeenCalled();
  } finally { manager.stop(); }
});

it('bounds untrusted missing-session lookups and aborts all of them on stop', async () => {
  const { manager, receive, resolveIdentity, delivered } = await fixture();
  const signals: AbortSignal[] = [];
  resolveIdentity.mockImplementation((_node, abort) => new Promise((_resolve, reject) => {
    signals.push(abort.signal);
    abort.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }));
  const operations = Array.from({ length: 100 }, (_, index) => {
    const node = new Uint8Array(16); node[15] = index;
    return receive(node);
  });
  expect(resolveIdentity).toHaveBeenCalledTimes(64);
  manager.stop();
  await Promise.all(operations);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(delivered).not.toHaveBeenCalled();
});

it('does not create a session when a resolver completes after stop', async () => {
  const { manager, remote, receive, resolveIdentity, sendFspToward, delivered } = await fixture();
  let finish!: (key: Uint8Array) => void;
  resolveIdentity.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const operation = receive();
  manager.stop();
  finish(remote.publicKey);
  await operation;
  expect(sendFspToward).not.toHaveBeenCalled();
  expect(delivered).not.toHaveBeenCalled();
});


it('keeps a new recovery marker when the previous generation finishes its handshake', async () => {
  const { manager, remote, receive, resolveIdentity } = await fixture();
  let finishSession!: () => void;
  const ensure = vi.spyOn(manager as unknown as { ensureSession(key: string): Promise<unknown> }, 'ensureSession')
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishSession = resolve; }));
  resolveIdentity.mockResolvedValueOnce(remote.publicKey);
  const first = receive();
  await Promise.resolve();
  expect(ensure).toHaveBeenCalledTimes(1);
  finishSession();
  manager.stop();
  const lookups: AbortController[] = [];
  resolveIdentity.mockImplementation((_node, abort) => new Promise((_resolve, reject) => {
    lookups.push(abort);
    abort.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }));
  const second = receive();
  const operations = [first, second];
  try {
    await first;
    operations.push(receive());
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  } finally {
    manager.stop();
    for (const lookup of lookups) lookup.abort();
    await Promise.all(operations);
    ensure.mockRestore();
  }
});
