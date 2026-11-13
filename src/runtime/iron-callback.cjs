const path = require("node:path");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const proto = grpc.loadPackageDefinition(loader.loadSync(
  path.join(__dirname, "../protocol/iron-transform.proto"))).transform.v1;

const rejectResponse = statusCode => ({ action: 2, response: { statusCode } });

// One callback listener per environment. The environment comes from the host
// closure, never a request header. No request body or secret enters a UI event.
async function createIronCallback({ environmentId, decide = async () => false,
  transform, timeoutMs = 60000, maxPending = 128 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxPending) || maxPending < 1)
    throw new Error("Invalid callback limits.");
  const server = new grpc.Server({ "grpc.max_receive_message_length": 256 * 1024 });
  const pending = new Set();
  let closed = false, paused = false;
  server.addService(proto.TransformService.service, {
    transformRequest(call, done) {
      if (closed || paused || pending.size >= maxPending) return done(null, rejectResponse(503));
      const controller = new AbortController();
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(cancel);
        call.removeListener("cancelled", cancel); controller.abort();
        if (!call.cancelled) done(null, result);
      };
      const cancel = () => finish(rejectResponse(503));
      const timer = setTimeout(() => finish(rejectResponse(408)), timeoutMs);
      pending.add(cancel); call.once("cancelled", cancel);
      if (call.cancelled) return cancel();
      Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const input = { environmentId, request: call.request.request,
          context: call.request.context, signal: controller.signal };
        const transformed = await transform?.(input);
        if (transformed !== undefined) return transformed;
        return await decide(input) === true ? { action: 1 } : rejectResponse(403);
      }).then(result => finish(result),
        () => finish(rejectResponse(503)));
    },
    transformResponse(_call, done) { done(null, { action: 1 }); },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0",
    grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  return {
    address: `127.0.0.1:${port}`, healthy: () => !closed && !paused,
    pause() { paused = true; for (const cancel of [...pending]) cancel(); },
    resume() { if (closed) throw new Error('Policy listener is closed.'); paused = false; },
    async close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
      server.forceShutdown();
    },
  };
}

module.exports = { createIronCallback, proto };
