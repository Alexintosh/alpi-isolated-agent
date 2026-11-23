'use strict';

// Deliberately synthetic, in-process execution for disposable acceptance
// workspaces. This is never installed by the production registry. All paths,
// the baseline and the finite timeout come from trusted local configuration;
// job payloads cannot choose a command, path, replacement or synchronization.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const run = promisify(execFile);
const PROFILE = 'scripted-counter-v1';

function durableJson(file, value, exclusive = false) {
  const destination = exclusive ? file : file + '.tmp';
  const fd = fs.openSync(destination, exclusive ? 'wx' : 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(destination, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function createScriptedFixtureJobs({ allowTestEngines, stateDir, workspaceDir,
  baselineCommit, gateTimeoutMs = 120000 } = {}) {
  if (allowTestEngines !== true) throw new Error('Scripted fixtures require explicit test opt-in.');
  if (!path.isAbsolute(stateDir || '') || !path.isAbsolute(workspaceDir || '') ||
      !/^[a-f0-9]{40}$/.test(baselineCommit || '') ||
      !Number.isSafeInteger(gateTimeoutMs) || gateTimeoutMs < 100 || gateTimeoutMs > 30 * 60 * 1000) {
    throw new Error('Invalid local scripted fixture configuration.');
  }
  const workspace = fs.realpathSync(workspaceDir);
  const root = path.join(stateDir, 'scripted-fixture');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tasks = new Map();

  return function testJob({ job, sandboxId, principal, store, attachPatch, signal }) {
    if (job.payload?.scriptedProfile !== PROFILE) return;
    if (tasks.has(job.jobId)) return tasks.get(job.jobId);
    const directory = path.join(root, job.jobId);
    // Exclusive directory is also a durable no-reexecution guard after a
    // daemon restart. Restart recovery is fail-closed, not automatic retry.
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    const parent = fs.openSync(root, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    const marker = (phase, detail = {}) => {
      const value = { jobId: job.jobId, phase, at: new Date().toISOString(), ...detail };
      durableJson(path.join(directory, phase + '.json'), value);
      store.appendEvent(principal, { jobId: job.jobId, type: 'job.log',
        data: { text: JSON.stringify(value) } });
      return value;
    };
    const command = (file, args) => run(file, args, { cwd: workspace,
      timeout: 10000, maxBuffer: 32768, env: { PATH: process.env.PATH, LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

    const work = (async () => {
      try {
        if (store.getSandbox(principal, sandboxId).profile !== PROFILE) {
          throw new Error('Scripted workspace profile required.');
        }
        marker('started', { baselineCommit, gateTimeoutMs });
        // One configured disposable workspace supports one logical job.
        durableJson(path.join(root, 'workspace-claim.json'), { jobId: job.jobId, workspace }, true);
        const head = await command('git', ['rev-parse', 'HEAD']);
        const status = await command('git', ['status', '--porcelain']);
        if (head.stdout.trim() !== baselineCommit || status.stdout !== '') {
          throw new Error('Scripted fixture baseline must be clean.');
        }
        for (const name of ['counter.js', 'check.cjs']) {
          if (!fs.lstatSync(path.join(workspace, name)).isFile()) throw new Error('Regular fixture files required.');
        }
        if (fs.readFileSync(path.join(workspace, 'counter.js'), 'utf8') !== 'module.exports = () => 1;\n') {
          throw new Error('Unexpected counter baseline.');
        }
        marker('partial', { preflight: 'clean-baseline', editCount: 0 });
        marker('parked', { releaseFile: 'release', editCount: 0 });
        const deadline = Date.now() + gateTimeoutMs;
        let heartbeatAt = 0;
        while (!fs.existsSync(path.join(directory, 'release'))) {
          if (signal.aborted) throw new Error('Fixture daemon is closing.');
          if (Date.now() >= deadline) throw new Error('Fixture release gate timed out.');
          if (Date.now() >= heartbeatAt) {
            marker('heartbeat', { editCount: 0 });
            heartbeatAt = Date.now() + 1000;
          }
          await delay(100, undefined, { signal });
        }
        if (signal.aborted || Date.now() >= deadline) throw new Error('Fixture gate expired or cancelled.');
        const disposition = store.getJob(principal, job.jobId).disposition;
        if (disposition !== 'acknowledged') throw new Error('Fixture job is no longer executable.');
        marker('released');
        // An exclusive intent precedes the only deterministic mutation. A
        // restart or replay cannot perform it again, even on a lost reply.
        durableJson(path.join(directory, 'edit-intent.json'), { jobId: job.jobId, at: new Date().toISOString() }, true);
        fs.writeFileSync(path.join(workspace, 'counter.js'), 'module.exports = () => 42;\n');
        marker('edited', { editCount: 1 });
        const assertion = await command(process.execPath, ['check.cjs']);
        marker('asserted', { exitCode: 0, stdout: assertion.stdout.trim() });
        const { stdout: patch } = await command('git', ['-c', 'core.hooksPath=/dev/null',
          'diff', '--no-ext-diff', '--no-textconv', '--', 'counter.js']);
        const bytes = Buffer.from(patch);
        if (bytes.length === 0 || bytes.length > 32768) throw new Error('Fixture patch bound exceeded.');
        const body = { requestId: job.jobId, label: 'scripted-counter.patch',
          totalLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          data: bytes.toString('base64') };
        // Same server path used by HTTPS registration: durable artifact
        // begin/chunk/finish, then the idempotent job reference. The job UUID
        // is the stable upload key; replay cannot allocate a second artifact.
        const receipt = await attachPatch(body);
        marker('attached', { artifactId: receipt.artifactId, sha256: receipt.sha256,
          totalLength: receipt.totalLength, artifactCount: 1 });
        store.markJob(principal, { jobId: job.jobId, disposition: 'completed' });
        marker('completed', { editCount: 1, artifactCount: 1 });
      } catch {
        marker('failed', { reason: 'Scripted fixture failed, expired or was cancelled.' });
        if (['acknowledged', 'uncertain', 'cancelRequested'].includes(store.getJob(principal, job.jobId).disposition)) {
          store.markJob(principal, { jobId: job.jobId, disposition: 'failed' });
        }
      }
    })();
    tasks.set(job.jobId, work);
    return work;
  };
}

module.exports = { createScriptedFixtureJobs, SCRIPTED_FIXTURE_PROFILE: PROFILE };
