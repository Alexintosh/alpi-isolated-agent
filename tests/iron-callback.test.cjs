const test = require("node:test");
const assert = require("node:assert/strict");
const grpc = require("@grpc/grpc-js");
const { createIronCallback, proto } = require("../src/runtime/iron-callback.cjs");

async function fixture(t, options = {}) {
  const service = await createIronCallback({ environmentId: "host-env", ...options });
  const client = new proto.TransformService(service.address, grpc.credentials.createInsecure());
  t.after(async () => { client.close(); await service.close(); });
  const request = () => new Promise((resolve, reject) => client.transformRequest({ request: {
    method: "GET", url: "https://example.com/", headers: { "x-environment-id": { values: ["spoofed"] } },
  } }, (error, result) => error ? reject(error) : resolve(result)));
  return { service, client, request };
}

test("stock gRPC callback defaults to deny and attributes requests using the host closure", async t => {
  const denied = await fixture(t); assert.equal((await denied.request()).action, 2);
  let observed;
  const allowed = await fixture(t, { decide: async input => { observed = input; return true; } });
  assert.equal((await allowed.request()).action, 1); assert.equal(observed.environmentId, "host-env");
  assert(observed.signal.aborted); // Decision lifetime has ended.
});

test("errors, non-boolean approvals and expired decisions cannot forward a request", async t => {
  for (const decide of [async () => { throw new Error("private detail"); }, async () => "true"]) {
    const f = await fixture(t, { decide }); const response = await f.request();
    assert.equal(response.action, 2); assert(!JSON.stringify(response).includes("private detail"));
  }
  let signal;
  const f = await fixture(t, { timeoutMs: 30, decide: input => { signal = input.signal; return new Promise(() => {}); } });
  assert.equal((await f.request()).response.statusCode, 408); assert(signal.aborted);
});

test("pending limits and cancellation release the callback without replaying work", async t => {
  let entered, signal, resolveDecision, decisions = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { maxPending: 1, decide: input => {
    decisions++; signal = input.signal; entered(); return new Promise(resolve => { resolveDecision = resolve; });
  } });
  const first = new Promise(resolve => {
    const call = f.client.transformRequest({ request: { method: "POST", url: "https://example.com/" } }, error => resolve(error));
    ready.then(async () => {
      assert.equal((await f.request()).response.statusCode, 503);
      call.cancel();
    });
  });
  assert.equal((await first).code, grpc.status.CANCELLED);
  await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }));
  resolveDecision(true); assert.equal(decisions, 1);
});
