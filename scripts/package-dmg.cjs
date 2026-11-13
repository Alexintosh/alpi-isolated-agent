// Build and verify a client-only disk image. Never installs or launches Alpi.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('DMG packaging requires macOS Apple Silicon.');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !args[0].startsWith('--output='))) throw Error('Use --output=/absolute/path/Alpi.dmg');
const output = args.length ? args[0].slice(9) : path.join(root, 'dist', `Alpi-${version}-macOS-arm64.dmg`);
if (!path.isAbsolute(output) || !output.endsWith('.dmg') || fs.existsSync(output)) throw Error('Choose a new absolute .dmg destination.');
fs.mkdirSync(path.dirname(output), { recursive: true });
const work = fs.mkdtempSync(path.join(path.dirname(output), '.dmg-build-'));
const contents = path.join(work, 'contents');
const image = path.join(work, 'Alpi.dmg');
const mount = path.join(work, 'mounted');
let mounted = false;
function run(command, argv) { return execFileSync(command, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
try {
  fs.mkdirSync(contents); fs.mkdirSync(mount);
  run(process.execPath, [path.join(__dirname, 'package-personal-app.cjs'), `--output=${path.join(contents, 'Alpi.app')}`]);
  fs.symlinkSync('/Applications', path.join(contents, 'Applications'));
  fs.writeFileSync(path.join(contents, 'START HERE.txt'), `Alpi ${version} — macOS Apple Silicon\n\nDrag Alpi.app to Applications. Open it when you are ready to manage your environments.\n\nThis alpha is ad-hoc signed, not Developer ID signed or notarized. macOS may block first launch. Follow Apple's per-app Open Anyway process in System Settings > Privacy & Security only after verifying the release and checksum. Do not disable Gatekeeper globally.\n\nCLIENT ONLY: VM images and the verified Runtime Package are not included. A fresh Mac cannot start an environment from this DMG alone. See the setup guide for runtime requirements. Existing compatible installations retain their data paths.\n\nSetup: https://github.com/Alexintosh/alpi-isolated-agent/blob/main/docs/setup.md\nSecurity: https://github.com/Alexintosh/alpi-isolated-agent/blob/main/SECURITY.md\nLicenses: Alpi.app/Contents/Resources/licenses\n\nQuit an existing Alpi instance before replacing the application. Quit stops its managed VMs and active jobs; it preserves workspace data. This disk image does not launch, stop or reset any environment.\n`);
  run('/usr/bin/hdiutil', ['create', '-fs', 'HFS+', '-format', 'UDZO', '-volname', 'Alpi', '-srcfolder', contents, image]);
  run('/usr/bin/hdiutil', ['verify', image]);
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image]);
  mounted = true;
  const app = path.join(mount, 'Alpi.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const plist = path.join(app, 'Contents/Info.plist');
  for (const [key, expected] of Object.entries({ CFBundleExecutable: 'Alpi', CFBundleDisplayName: 'Alpi', CFBundleIdentifier: 'com.alexintosh.harness-isolated' })) {
    if (run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim() !== expected) throw Error(`Incorrect bundle ${key}`);
  }
  const packaged = path.join(app, 'Contents/Resources/app');
  if (JSON.parse(fs.readFileSync(path.join(packaged, 'package.json'))).version !== version) throw Error('Incorrect app version');
  if (fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications') throw Error('Incorrect Applications link');
  for (const file of ['Alpi.icns', 'licenses/LICENSE', 'licenses/ELECTRON-LICENSE', 'licenses/LICENSES.chromium.html', 'licenses/upstream/production-notices.txt']) {
    if (!fs.statSync(path.join(app, 'Contents/Resources', file)).isFile()) throw Error(`Missing resource: ${file}`);
  }
  for (const forbidden of ['vendor', '.state', '.git', '.env', 'evidence']) {
    if (fs.existsSync(path.join(packaged, forbidden))) throw Error(`Unexpected private/runtime payload: ${forbidden}`);
  }
  run('/usr/bin/hdiutil', ['detach', mount]); mounted = false;
  // Publish without replacing a concurrently created destination.
  fs.linkSync(image, output);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(output, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  console.log(`${hash.digest('hex')}  ${path.basename(output)}`);
  console.log(output);
} finally {
  if (mounted) {
    // If detach fails, preserve the mount directory rather than traversing it.
    run('/usr/bin/hdiutil', ['detach', mount]);
  }
  fs.rmSync(work, { recursive: true, force: true });
}
