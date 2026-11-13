const net = require("node:net");

function allowedRequest(url, origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(url), expected = new URL(origin);
    return !parsed.username && !parsed.password && parsed.hostname === "127.0.0.1" &&
      parsed.hostname === expected.hostname && parsed.port === expected.port &&
      ["http:", "ws:"].includes(parsed.protocol);
  } catch { return false; }
}

// Defense in depth for guest-supplied renderer content. webRequest confines
// ordinary traffic; an owned rejecting proxy and disabled DNS/UDP cover channels
// such as speculative requests/WebRTC that aren't ordinary page fetches.
async function createRendererBoundary(target) {
  let origin;
  const sink = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", resolve); });
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, done) => done({ cancel: !allowedRequest(request.url, origin) }));
  target.on("will-download", event => event.preventDefault());
  async function setOrigin(next) {
    if (next) {
      const parsed = new URL(next);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.origin !== next)
        throw new Error("Invalid renderer origin.");
    }
    origin = undefined;
    await target.closeAllConnections();
    await target.setProxy({ mode: "fixed_servers", proxyRules: `http=127.0.0.1:${sink.address().port};https=127.0.0.1:${sink.address().port};socks=127.0.0.1:${sink.address().port}`,
      proxyBypassRules: next ? `<-loopback>;127.0.0.1:${new URL(next).port}` : "<-loopback>" });
    origin = next;
  }
  try { await setOrigin(undefined); }
  catch (error) { await new Promise(resolve => sink.close(resolve)); throw error; }
  return {
    setOrigin,
    revoke() { origin = undefined; },
    async close() { origin = undefined; await target.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); },
  };
}

module.exports = { allowedRequest, createRendererBoundary };
