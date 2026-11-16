'use strict';

// Pilot CI glue. GitHub authenticates the job, not the truth of candidate code.
// This candidate-owned policy is advisory until a separately trusted control
// plane pins the policy/evaluator/fixtures. It never authorizes a merge.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runNodeTests } = require('./run-node-tests.cjs');
const { evaluateEvidence } = require('./evidence.cjs');
const cwd = path.resolve(__dirname, '..');
const output = path.join(cwd, '.factory-results');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const environmentId = { linux: 'portable-linux', darwin: 'portable-macos' }[process.platform];
  const policyBytes = fs.readFileSync(path.join(__dirname, 'ci-policy.json'));
  const policy = JSON.parse(policyBytes);
  const headSha = git('rev-parse', 'HEAD');
  const testedTreeSha = git('rev-parse', 'HEAD^{tree}');
  if (!environmentId || process.version !== 'v24.13.0'
    || headSha !== process.env.FACTORY_HEAD_SHA
    || git('status', '--porcelain', '--untracked-files=no')) throw new Error('preflight');
  const evaluatorFiles = ['ci-run.cjs', 'evidence.cjs', 'run-node-tests.cjs', 'node-test-reporter.cjs'];
  const expected = {
    repository: process.env.FACTORY_REPOSITORY,
    pullRequest: process.env.FACTORY_PR ? Number(process.env.FACTORY_PR) : null,
    baseSha: process.env.FACTORY_BASE_SHA,
    headSha,
    testedTreeSha,
    policyDigest: digest(policyBytes),
    evaluatorDigest: digest(JSON.stringify(evaluatorFiles.map(name =>
      [name, digest(fs.readFileSync(path.join(__dirname, name)))]))),
    fixtureDigest: digest(git('rev-parse', 'HEAD:tests')),
  };
  if (policy.schemaVersion !== 1 || policy.status !== 'pilot-advisory'
    || !Array.isArray(policy.checks) || policy.checks.length !== 2) throw new Error('policy');
  const requiredChecks = policy.checks.map(({ id, minimumTests }) => ({ id, minimumTests, environmentId }));
  const initial = evaluateEvidence({ expected, requiredChecks, records: [] });
  if (initial.reasons.length !== requiredChecks.length
    || initial.reasons.some(reason => reason.code !== 'missing-check')) throw new Error('identity');
  const records = [], results = [];
  for (const check of policy.checks) {
    const result = await runNodeTests({ cwd, files: check.files, minimumTests: check.minimumTests, timeoutMs: 120000 });
    results.push({ checkId: check.id, ...result });
    if (result.tests) records.push({
      schemaVersion: 1, checkId: check.id, environmentId, identity: expected,
      outcome: result.outcome, exitCode: result.exitCode, tests: result.tests,
    });
  }
  const checkoutUnchanged = git('rev-parse', 'HEAD') === headSha
    && git('rev-parse', 'HEAD^{tree}') === testedTreeSha
    && git('status', '--porcelain', '--untracked-files=no') === '';
  const evaluation = evaluateEvidence({ expected, requiredChecks, records });
  const passed = checkoutUnchanged && evaluation.eligible;
  const report = { schemaVersion: 1, status: passed ? 'pass' : 'fail', authority: 'pilot-advisory',
    expected, requiredChecks, records, results, checkoutUnchanged, evaluation,
    node: process.version, platform: process.platform, architecture: process.arch,
    githubRunId: process.env.GITHUB_RUN_ID || null };
  fs.writeFileSync(path.join(output, `${environmentId}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, headSha, environmentId,
    checks: results.map(({ checkId, outcome, tests }) => ({ checkId, outcome, tests })) }));
  process.exitCode = passed ? 0 : 1;
}

main().catch(() => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'blocked.json'), JSON.stringify({ status: 'blocked', reason: 'ci-preflight-or-execution-failed' }) + '\n');
  console.error('Factory checks blocked; no passing evidence produced.');
  process.exitCode = 1;
});
