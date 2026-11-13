// Host-only, stock packages. Never executes npm lifecycle scripts or guest code.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "vendor/v1");
const PLATFORMS = {
  arm64: {
    nodeName: "node-v24.13.0-linux-arm64.tar.xz",
    nodeSha: "aa881151bd0f9f154a0424dd60a72e9ce10672619121658c278a24327ef46831",
    cpu: "arm64",
    subdir: null,
    platform: "linux-arm64-glibc",
    natives: ["node-pty/prebuilds/linux-arm64/pty.node", "@koromix/koffi-linux-arm64/linux_arm64/koffi.node"],
  },
  x64: {
    nodeName: "node-v24.13.0-linux-x64.tar.xz",
    nodeSha: "e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e",
    cpu: "x64",
    subdir: "x64",
    platform: "linux-x64-glibc",
    natives: ["node-pty/prebuilds/linux-x64/pty.node", "@koromix/koffi-linux-x64/linux_x64/koffi.node"],
  },
};
function selectArch(args) {
  let arch = "arm64", seen = false;
  for (const arg of args) {
    if (arg === "--arch=x64" || arg === "--arch=arm64") {
      if (seen) throw new Error("Duplicate --arch argument.");
      seen = true;
      arch = arg.slice("--arch=".length);
    } else {
      throw new Error('Unknown build argument.');
    }
  }
  return arch;
}
async function sha(file) {
  const digest = createHash("sha256");
  for await (const data of fs.createReadStream(file)) digest.update(data);
  return digest.digest("hex");
}

async function main() {
  const cfg = PLATFORMS[selectArch(process.argv.slice(2))];
  const outDir = cfg.subdir ? path.join(artifacts, cfg.subdir) : artifacts;
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const scratchRoot = path.join(root, ".state"); fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const build = fs.mkdtempSync(path.join(scratchRoot, "guest-build-"));
  const nodeArchive = path.join(outDir, cfg.nodeName);
  const output = path.join(outDir, "guest-runtime.tar.gz");
  const partial = output + ".partial";
  const env = { PATH: process.env.PATH, HOME: path.join(build, "home"), LANG: "C.UTF-8", COPYFILE_DISABLE: "1" };
  fs.mkdirSync(env.HOME, { mode: 0o700 });
  const globalConfig = path.join(build, "global.npmrc"); fs.writeFileSync(globalConfig, "", { mode: 0o600 });
  const run = (binary, args, cwd = build) => exec(binary, args, { cwd, env, timeout: 600000, maxBuffer: 1024 * 1024 });
  try {
    if (!fs.existsSync(nodeArchive)) {
      await run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "2",
        `https://nodejs.org/dist/v24.13.0/${cfg.nodeName}`, "-o", nodeArchive + ".partial"]);
      if (await sha(nodeArchive + ".partial") !== cfg.nodeSha) throw new Error("Node archive digest mismatch.");
      fs.renameSync(nodeArchive + ".partial", nodeArchive);
    }
    if (await sha(nodeArchive) !== cfg.nodeSha) throw new Error("Node archive digest mismatch.");
    const stage = path.join(build, "stage"), runtime = path.join(stage, "runtime"), node = path.join(stage, "node");
    fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(node);
    const lockFile = path.join(root, "guest/package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    fs.copyFileSync(lockFile, path.join(runtime, "package-lock.json"));
    fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: lock.name, private: true,
      dependencies: lock.packages[""].dependencies }, null, 2) + "\n");
    console.log(`Preparing stock linux-${cfg.cpu} npm packages (lifecycle scripts disabled).`);
    await run("npm", ["ci", "--ignore-scripts", "--os=linux", `--cpu=${cfg.cpu}`, "--libc=glibc",
      "--no-audit", "--no-fund", "--userconfig=/dev/null", `--globalconfig=${globalConfig}`,
      "--registry=https://registry.npmjs.org/", "--strict-ssl=true"], runtime);
    for (const native of cfg.natives)
      if (!fs.existsSync(path.join(runtime, "node_modules", native))) throw new Error(`Missing Linux ${cfg.cpu} native prebuild.`);
    await run("/usr/bin/tar", ["-xf", nodeArchive, "--strip-components=1", "-C", node]);
    console.log("Packing offline guest runtime.");
    await run("/usr/bin/tar", ["--no-xattrs", "--no-acls", "--no-fflags", "--no-mac-metadata",
      "-czf", partial, "-C", stage, "node", "runtime"]);
    const manifest = { version: 1, platform: cfg.platform, node: "24.13.0", harness: "0.2.2-rc.2",
      nodeArchiveSha256: cfg.nodeSha, lockSha256: await sha(lockFile),
      bundleSha256: await sha(partial), bundleBytes: fs.statSync(partial).size,
      npmLifecycleScripts: false, createdAt: new Date().toISOString() };
    fs.renameSync(partial, output);
    fs.writeFileSync(path.join(outDir, "guest-runtime.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(partial, { force: true }); fs.rmSync(nodeArchive + ".partial", { force: true });
  }
}
main().catch(() => { console.error("Guest bundle build failed; no guest or personal profile was changed."); process.exitCode = 1; });
