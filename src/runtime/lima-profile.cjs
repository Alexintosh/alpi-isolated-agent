const path = require("node:path");

// Process confinement established by M0 on macOS 27.2.1. No guest firewall trust.
function limaProfile({ instanceDirectory, sshPort, proxyPort, credentialPort }) {
  if (typeof instanceDirectory !== "string" || !path.isAbsolute(instanceDirectory) ||
      /[\x00-\x1f\x7f]/.test(instanceDirectory) || path.resolve(instanceDirectory) !== instanceDirectory)
    throw new Error("Invalid instance directory.");
  const ports = [sshPort, proxyPort, ...(credentialPort === undefined ? [] : [credentialPort])];
  for (const port of ports)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid environment port.");
  if (new Set(ports).size !== ports.length) throw new Error("Environment ports must be distinct.");
  return `(version 1)
(allow default)
(deny network-outbound)
(deny mach-lookup (global-name "com.apple.mDNSResponder"))
(allow network-outbound
  (remote tcp "localhost:${sshPort}")
  (remote tcp "localhost:${proxyPort}")
${credentialPort === undefined ? "" : `  (remote tcp "localhost:${credentialPort}")\n`}
  (remote unix-socket (subpath ${JSON.stringify(instanceDirectory)})))
`;
}

module.exports = { limaProfile };
