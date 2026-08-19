export interface PendingOriginLookup {
  requestId: bigint;
  targetHex: string;
  targetPubkey?: Uint8Array;
  promise: Promise<void>;
}

interface PendingOriginLookupState extends PendingOriginLookup {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class OriginLookupRegistry {
  private readonly byTarget = new Map<string, PendingOriginLookupState>();
  private readonly byRequest = new Map<bigint, PendingOriginLookupState>();

  constructor(private readonly maximum: number) {}

  get(targetHex: string): PendingOriginLookup | undefined {
    return this.byTarget.get(targetHex);
  }

  findRequest(requestId: bigint): PendingOriginLookup | undefined {
    return this.byRequest.get(requestId);
  }

  create(args: {
    targetHex: string;
    targetPubkey?: Uint8Array;
    randomBytes: () => Uint8Array;
    timeoutMs: number;
  }): PendingOriginLookup {
    if (this.byTarget.size >= this.maximum) {
      throw new Error(`lookup capacity exceeded for ${args.targetHex}`);
    }
    const requestId = this.nextRequestId(args.randomBytes);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingOriginLookupState = {
      requestId,
      targetHex: args.targetHex,
      targetPubkey: args.targetPubkey
        ? new Uint8Array(args.targetPubkey)
        : undefined,
      promise,
      resolve,
      reject,
    };
    pending.timer = setTimeout(() => {
      this.fail(pending, new Error(`no route to ${args.targetHex}`));
    }, args.timeoutMs);
    this.byTarget.set(args.targetHex, pending);
    this.byRequest.set(requestId, pending);
    return pending;
  }

  complete(pending: PendingOriginLookup): void {
    const state = this.remove(pending);
    state?.resolve();
  }

  fail(pending: PendingOriginLookup, error: Error): void {
    const state = this.remove(pending);
    state?.reject(error);
  }

  stop(): void {
    for (const pending of [...this.byTarget.values()]) {
      this.fail(pending, new Error("FIPS node stopped"));
    }
  }

  private nextRequestId(randomBytes: () => Uint8Array): bigint {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = randomBytes();
      if (bytes.length !== 8) throw new Error("random source returned invalid lookup request id");
      const id = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getBigUint64(0, true);
      if (!this.byRequest.has(id)) return id;
    }
    throw new Error("failed to allocate unique lookup request id");
  }

  private remove(pending: PendingOriginLookup): PendingOriginLookupState | undefined {
    const state = this.byTarget.get(pending.targetHex);
    if (state !== pending) return undefined;
    if (state.timer) clearTimeout(state.timer);
    this.byTarget.delete(state.targetHex);
    this.byRequest.delete(state.requestId);
    return state;
  }
}
