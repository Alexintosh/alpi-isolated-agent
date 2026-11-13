const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedRequest } = require("../src/runtime/renderer-boundary.cjs");
test("renderer requests are confined to the exact active numeric loopback endpoint", () => {
  const origin = "http://127.0.0.1:43980";
  assert(allowedRequest(origin + "/api/file?name=x", origin));
  assert(allowedRequest("ws://127.0.0.1:43980/api/remote.mux", origin));
  for (const url of ["http://localhost:43980/", "http://127.0.0.1:43981/", "https://127.0.0.1:43980/",
    "http://127.0.0.1.evil.test:43980/", "http://user@127.0.0.1:43980/", "file:///etc/passwd", "https://example.com/", "invalid"])
    assert(!allowedRequest(url, origin), url);
  assert(!allowedRequest(origin, undefined));
});
