import { afterEach, expect, it, vi } from "vitest";
import {
  FipsNode, generateIdentity, toHex, LinkMessageType,
  decodeLookupRequest, decodeLookupResponse, decodeSessionDatagramPayload,
} from "../src/index.js";
import { decodeSessionSetup, decodeSessionAck } from "../src/protocol/session.js";
import { decodeFspEstablished, FSP_FLAG_CP } from "../src/fsp/wire.js";
import { MemoryHub, MemoryTransport } from "../../transport-memory/src/MemoryTransport.js";

const active: FipsNode[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(node => node.stop())); });

it.each(["reply_learned", "tree"] as const)("preserves strict privacy through %s routers", async routingMode => {
  const hub = new MemoryHub();
  const errors: string[] = [];
  const nodes = await Promise.all([0, 1, 2, 3].map(async index => {
    const identity = await generateIdentity();
    const strictClient = index === 0 || index === 3;
    const node = new FipsNode({ identity, transports: [new MemoryTransport({ hub })],
      strictClient, forwarding: !strictClient, routingMode });
    node.on("error", event => { errors.push(String((event as { err: Error }).err)); });
    active.push(node);
    await node.start();
    return node;
  }));
  const [reader, first, second, provider] = nodes;
  const observed: Array<{ sender: string; type: number; body: Uint8Array }> = [];
  for (const node of [first, second]) {
    const routing = (node as any).routing;
    const receive = routing.handleLinkMessage.bind(routing);
    vi.spyOn(routing, "handleLinkMessage").mockImplementation(async (...args: any[]) => {
      const [peer, type, body] = args;
      observed.push({ sender: peer.pubkeyHex, type, body: body.slice() });
      await receive(...args);
    });
  }
  const connect = (from: FipsNode, to: FipsNode) => from.connect({ transport: "memory", addr: toHex(to.identity.publicKey) });
  await connect(reader, first);
  await connect(second, first);
  await connect(provider, second);
  await vi.waitFor(() => {
    for (const [router, client] of [[first, reader], [second, provider]]) {
      expect((router as any).peersByPubkey.get(toHex(client.identity.publicKey))?.clientOnly).toBe(true);
    }
  });

  const responses: Uint8Array[] = [];
  reader.registerService(9010, ({ payload }) => { responses.push(payload); });
  provider.registerService(9011, ({ payload, reply }) => reply(payload));
  const payload = new Uint8Array([9, 8, 7]);
  const sent = reader.sendDatagram({ dst: toHex(provider.identity.publicKey), srcPort: 9010, dstPort: 9011, payload });
  void sent.catch(() => {});
  if (routingMode === "reply_learned") {
    await vi.waitFor(() => expect(responses).toEqual([payload]), { timeout: 2500 });
    await sent;
  } else {
    // Tree-only transit cannot route endpoint-only coordinates. It must fail
    // without persuading a strict endpoint to export its private ancestry.
    await vi.waitFor(() => expect(errors.some(error => error.includes("no route"))).toBe(true), { timeout: 2500 });
    await reader.stop();
    await expect(sent).rejects.toThrow();
    expect(responses).toEqual([]);
  }

  const endpoints = new Set([reader, provider].map(node => toHex(node.identity.publicKey)));
  const endpointFrames = observed.filter(frame => endpoints.has(frame.sender));
  expect(endpointFrames.some(frame => frame.type === LinkMessageType.LookupRequest)).toBe(true);
  expect(endpointFrames.some(frame => frame.type === LinkMessageType.LookupResponse)).toBe(true);
  const phases = new Set<number>();
  for (const { type, body } of endpointFrames) {
    expect([LinkMessageType.TreeAnnounce, LinkMessageType.FilterAnnounce]).not.toContain(type);
    if (type === LinkMessageType.LookupRequest) expect(decodeLookupRequest(body).originCoords).toHaveLength(1);
    if (type === LinkMessageType.LookupResponse) expect(decodeLookupResponse(body).targetCoords).toHaveLength(1);
    if (type !== LinkMessageType.SessionDatagram) continue;
    const frame = decodeSessionDatagramPayload(body).payload;
    const phase = frame[0] & 0x0f;
    phases.add(phase);
    const coords = phase === 1 ? decodeSessionSetup(frame)
      : phase === 2 ? decodeSessionAck(frame)
      : phase === 0 && (frame[1] & FSP_FLAG_CP) ? decodeFspEstablished(frame) : undefined;
    if (coords) {
      expect(coords.srcCoords).toHaveLength(1);
      expect(coords.destCoords).toHaveLength(1);
    }
  }
  expect(phases).toContain(1);
  if (routingMode === "reply_learned") {
    expect(phases).toContain(2);
    expect(phases).toContain(0);
  }
});
