const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate, createPrivateKey } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid host directory.");
  fs.chmodSync(directory, 0o700);
}

function validate(directory) {
  for (const name of ["ca.crt", "ca.key"]) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid host certificate authority.");
    fs.chmodSync(file, 0o600);
  }
  const cert = new X509Certificate(fs.readFileSync(path.join(directory, "ca.crt")));
  const key = createPrivateKey(fs.readFileSync(path.join(directory, "ca.key")));
  if (!cert.ca || !cert.checkPrivateKey(key) || Date.parse(cert.validTo) < Date.now() + 86400000)
    throw new Error("The host certificate authority is invalid or needs renewal.");
}

// A whole directory is installed atomically, so an interrupted generation never
// leaves a mismatched certificate/key pair. Only caFile may be sent to the guest.
async function ensureCA(directory, { signal } = {}) {
  privateDirectory(path.dirname(directory));
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Invalid host certificate authority.");
    privateDirectory(directory); validate(directory);
  } else {
    const temporary = fs.mkdtempSync(path.join(path.dirname(directory), ".ca-"));
    fs.chmodSync(temporary, 0o700);
    try {
      const config = path.join(temporary, "openssl.cnf");
      fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Harness Isolated local CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n", { mode: 0o600 });
      await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(temporary, "ca.key"), "-out", path.join(temporary, "ca.crt"),
        "-days", "3650", "-config", config], { signal, timeout: 30000, maxBuffer: 16384 });
      validate(temporary); fs.unlinkSync(config); fs.renameSync(temporary, directory);
    } catch { throw new Error("Host certificate authority setup failed."); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return { caFile: path.join(directory, "ca.crt"), keyFile: path.join(directory, "ca.key") };
}

module.exports = { ensureCA, privateDirectory };
