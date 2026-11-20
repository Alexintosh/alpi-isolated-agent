'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const { runPairingWorkflow } = require('./helpers/alpi-server-workflow.cjs');
const repo = path.resolve(__dirname, '..');

test('control packages install offline and expose their commands outside the checkout', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-package-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const prefix = path.join(temp, 'install');
  const env = {
    ...process.env,
    PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    npm_config_cache: path.join(temp, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
  };
  const archives = [];
  for (const [name, bin] of [['alpi-server', 'alpi-server'], ['alpi-client', 'alpi']]) {
    const { stdout } = await execFile(process.execPath, [path.join(repo, 'scripts/pack-alpi-control.cjs'), name, temp], { cwd: temp, env });
    const [pkg] = JSON.parse(stdout);
    const files = pkg.files.map(entry => entry.path);
    assert.ok(files.includes('bin/' + bin + '.cjs'));
    assert.ok(files.includes('LICENSE'));
    assert.ok(files.includes('src/shared/file-stream.py'));
    if (name === 'alpi-server') assert.ok(files.includes('src/shared/artifact-download.cjs'));
    assert.ok(files.every(file => /^(?:bin\/|src\/|package\.json$|LICENSE$|README\.md$|deploy\/|api\/|manifests\/)/.test(file)), files.join('\n'));
    t.diagnostic(name + ' packed bytes: ' + pkg.size);
    archives.push(path.join(temp, pkg.filename));
  }
  await execFile('npm', ['install', '--prefix', prefix, '--no-save', ...archives], { cwd: temp, env });
  const fileStream = await fs.readFile(path.join(repo, 'src/runtime/file-stream.py'));
  for (const name of ['alpi-server', 'alpi-client']) {
    const installed = path.join(prefix, 'node_modules', name, 'src/shared/file-stream.py');
    assert.ok((await fs.lstat(installed)).isFile());
    assert.deepEqual(await fs.readFile(installed), fileStream);
  }
  for (const bin of ['alpi-server', 'alpi']) {
    const cmd = path.join(prefix, 'node_modules', '.bin', bin);
    const { stdout } = await execFile(cmd, ['--help'], { cwd: temp, env, timeout: 5000 });
    assert.match(stdout, /usage/i);
    if (bin === 'alpi-server') {
      const doctor = await execFile(cmd, ['doctor', '--host', '--state-dir', temp], { cwd: temp, env });
      const host = JSON.parse(doctor.stdout);
      assert.equal(host.platform, process.platform);
      assert.equal(host.architecture, process.arch);
      assert.ok(BigInt(host.availableDiskBytes) >= 0n);
      if (process.platform !== 'linux') assert.equal(host.kvm, 'unsupported-platform');
    }
  }
  const binDir = path.join(prefix, 'node_modules', '.bin');
  await t.test('installed MCP verifies identity and observes revocation', { timeout: 25000 }, sub =>
    runPairingWorkflow(sub, path.join(binDir, 'alpi-server'), path.join(binDir, 'alpi')));
});
