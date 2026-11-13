const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { LimaDriver } = require('../src/runtime/lima-driver.cjs');
const { SmolDriver, WRAP_IMAGE } = require('../src/runtime/smol-driver.cjs');
const { environment } = require('../src/runtime/environments.cjs');

function fixture(t, kind, { absent = false, reserved = false } = {}) {
  // All filesystem mutations stay within this disposable synthetic runtime.
  const runtimeRoot = fs.mkdtempSync('/tmp/driver-remove-');
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const lima = kind === 'lima';
  const definition = environment(lima ? 'lima-v1' : 'wrapvm-v1');
  const token = randomUUID(), options = { ownershipToken: token };
  const driver = lima ? new LimaDriver({ definition, runtimeRoot, binary: '/fixture/never-execute-limactl' }) :
    new SmolDriver({ definition, runtimeRoot, binary: '/fixture/never-execute-smolvm' });
  // No test can execute stock binaries: both the verifier and command boundary
  // are replaced before any driver operation, including inventory inspection.
  driver.verifyRuntime = () => {};
  let record = lima ? { name: definition.machine, dir: driver.instanceDirectory, status: 'Stopped' } :
    { name: definition.machine, state: 'stopped', labels: { owner: definition.owner, identity: token },
      network: true, mounts: 0, ports: 0, image: WRAP_IMAGE, restart_policy: 'never',
      allowed_hosts: ['=host.smolvm.internal'], allowed_cidrs: ['192.0.2.1/32'] };
  if (lima && !absent) {
    fs.mkdirSync(driver.instanceDirectory);
    const config = JSON.stringify({ env: { HARNESS_ISOLATED_RESOURCE_ID: token }, disk: '20GiB', mounts: [] });
    fs.writeFileSync(driver.configFile, config);
    const configSha256 = createHash('sha256').update(config).digest('hex');
    const stat = fs.statSync(driver.instanceDirectory);
    if (!reserved) fs.writeFileSync(driver.ownerFile, JSON.stringify({ owner: definition.owner,
      ownershipToken: token, inode: stat.ino, device: stat.dev, configSha256 }));
    fs.writeFileSync(driver.reservationFile, JSON.stringify({ owner: definition.owner,
      ownershipToken: token, resourceNonce: token, instanceDirectory: driver.instanceDirectory, configSha256 }));
  }
  if (absent) record = undefined;
  const deletion = lima ? ['delete', '--tty=false', definition.machine] :
    ['machine', 'delete', '--name', definition.machine, '--force'];
  const inventory = lima ? ['list', '--json'] : ['machine', 'ls', '--json'];
  const calls = [];
  const f = { driver, options, token, runtimeRoot, calls, deletion,
    get record() { return record; }, set record(value) { record = value; },
    deleteResource() {
      if (lima) fs.rmSync(driver.instanceDirectory, { recursive: true });
      record = undefined;
    },
    onDelete: async () => { f.deleteResource(); },
    onInventory: undefined,
    setState(state) { if (lima) record.status = state[0].toUpperCase() + state.slice(1); else record.state = state; },
  };
  driver.command = async (args, commandOptions) => {
    calls.push({ args, options: commandOptions });
    if (JSON.stringify(args) === JSON.stringify(inventory)) {
      await f.onInventory?.();
      return { stdout: lima ? (record ? JSON.stringify(record) : '') : JSON.stringify(record ? [record] : []) };
    }
    assert.deepEqual(args, deletion, 'no command other than fixed inventory/removal is permitted');
    await f.onDelete(commandOptions);
    return { stdout: '' };
  };
  return f;
}

for (const kind of ['lima', 'smolvm']) {
  const removedCalls = f => f.calls.filter(call => call.args.includes('delete'));

  test(`${kind}: verified absence is idempotent and invokes no deletion`, async t => {
    const f = fixture(t, kind, { absent: true });
    assert.deepEqual(await f.driver.remove(f.options), { state: 'missing', removed: false });
    assert.equal(f.calls.length, 1);
    assert.equal(removedCalls(f).length, 0);
  });

  test(`${kind}: removes only the fixed owned stopped resource and verifies absence`, async t => {
    const f = fixture(t, kind), controller = new AbortController();
    const sentinel = path.join(f.runtimeRoot, 'shared-folder-and-image-cache');
    fs.mkdirSync(sentinel); fs.writeFileSync(path.join(sentinel, 'keep'), 'shared');
    assert.deepEqual(await f.driver.remove({ ...f.options, signal: controller.signal }), { state: 'missing', removed: true });
    assert.equal(removedCalls(f).length, 1);
    assert.equal(f.calls.length, 3, 'inventory before and after the stock delete');
    assert.deepEqual(removedCalls(f)[0].args, f.deletion);
    assert.equal(removedCalls(f)[0].options.signal, controller.signal);
    assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'shared');
    assert.equal((await f.driver.inspect(f.options)).state, 'missing');
    assert.deepEqual(await f.driver.remove(f.options), { state: 'missing', removed: false });
  });

  test(`${kind}: running and unrecognized states are rejected without stop or delete`, async t => {
    const f = fixture(t, kind);
    for (const state of ['running', 'unknown', 'unreachable', 'frozen']) {
      f.setState(state);
      await assert.rejects(f.driver.remove(f.options), /Stop .* before removing/);
    }
    assert.equal(removedCalls(f).length, 0);
  });

  test(`${kind}: foreign ownership and configuration drift are rejected`, async t => {
    const f = fixture(t, kind);
    await assert.rejects(f.driver.remove({ ownershipToken: randomUUID() }), /not owned/);
    await assert.rejects(f.driver.remove(), /not owned/);
    if (kind === 'lima') fs.appendFileSync(f.driver.configFile, '\n');
    else f.record.allowed_hosts = ['host.smolvm.internal'];
    await assert.rejects(f.driver.remove(f.options), /configuration/);
    assert.equal(removedCalls(f).length, 0);
  });

  test(`${kind}: failed inventory never authorizes deletion or claims absence`, async t => {
    const f = fixture(t, kind, { absent: true }), failure = new Error('inventory failed');
    f.onInventory = async () => { throw failure; };
    await assert.rejects(f.driver.remove(f.options), error => error === failure);
    assert.equal(removedCalls(f).length, 0);
  });

  test(`${kind}: delete failure propagates and retains launch and reservation`, async t => {
    const f = fixture(t, kind), failure = new Error('delete failed');
    const launch = { network: { mediator: { revoke() { assert.fail('must not revoke'); } } } };
    f.driver.launch = launch;
    f.onDelete = async () => { throw failure; };
    await assert.rejects(f.driver.remove(f.options), error => error === failure);
    assert.equal(f.driver.launch, launch);
    assert.equal(f.calls.length, 2);
    if (kind === 'lima') assert(fs.existsSync(f.driver.reservationFile));
  });

  test(`${kind}: success exit with retained or foreign replacement cannot claim removed`, async t => {
    const f = fixture(t, kind);
    f.onDelete = async () => {}; // A successful CLI exit is not proof.
    await assert.rejects(f.driver.remove(f.options), /removal could not be confirmed/);
    f.onDelete = async () => {
      if (kind === 'lima') {
        const record = f.record, config = fs.readFileSync(f.driver.configFile);
        const owner = JSON.parse(fs.readFileSync(f.driver.ownerFile));
        f.deleteResource();
        fs.mkdirSync(f.driver.instanceDirectory); fs.writeFileSync(f.driver.configFile, config);
        const stat = fs.statSync(f.driver.instanceDirectory);
        fs.writeFileSync(f.driver.ownerFile, JSON.stringify({ ...owner, inode: stat.ino, device: stat.dev,
          ownershipToken: randomUUID() }));
        f.record = record;
      } else {
        const record = structuredClone(f.record); f.deleteResource();
        record.labels.identity = randomUUID(); f.record = record;
      }
    };
    await assert.rejects(f.driver.remove(f.options), /removal could not be confirmed/);
    assert(f.record, 'replacement is not deleted a second time');
    assert.equal(removedCalls(f).length, 2);
    if (kind === 'lima') assert(fs.existsSync(f.driver.reservationFile));
  });

  test(`${kind}: failed post-delete inventory propagates even when deletion happened`, async t => {
    const f = fixture(t, kind), failure = new Error('verification failed');
    f.onDelete = async () => {
      f.deleteResource();
      f.onInventory = async () => { throw failure; };
    };
    await assert.rejects(f.driver.remove(f.options), error => error === failure);
    if (kind === 'lima') assert(fs.existsSync(f.driver.reservationFile));
  });

  test(`${kind}: cancellation before, during, and after deletion always propagates`, async t => {
    const f = fixture(t, kind);
    const before = new AbortController(); before.abort(new Error('before removal'));
    await assert.rejects(f.driver.remove({ ...f.options, signal: before.signal }), /before removal/);
    assert.equal(f.calls.length, 0);
    const during = new AbortController();
    f.onDelete = async () => { during.abort(new Error('during removal')); };
    await assert.rejects(f.driver.remove({ ...f.options, signal: during.signal }), /during removal/);
    assert.equal(f.calls.length, 2, 'does not continue after cancellation');
    const after = new AbortController();
    f.onDelete = async () => {
      f.deleteResource();
      f.onInventory = async () => { after.abort(new Error('during verification')); };
    };
    await assert.rejects(f.driver.remove({ ...f.options, signal: after.signal }), /during verification/);
    if (kind === 'lima') assert(fs.existsSync(f.driver.reservationFile));
  });
}

test('smolvm: an owned created machine can be removed without starting it', async t => {
  const f = fixture(t, 'smolvm'); f.setState('created');
  assert.equal((await f.driver.remove(f.options)).removed, true);
});

test('Lima: a matching interrupted creation can be removed and its reservation retired', async t => {
  const f = fixture(t, 'lima', { reserved: true });
  assert.equal((await f.driver.inspect(f.options)).reserved, true);
  await f.driver.remove(f.options);
  assert.equal(fs.existsSync(f.driver.reservationFile), false);
});

test('Lima: verified missing retry retires only a matching stale reservation', async t => {
  const f = fixture(t, 'lima'); f.deleteResource();
  const reservation = fs.readFileSync(f.driver.reservationFile, 'utf8');
  await f.driver.remove({ ownershipToken: randomUUID() });
  assert.equal(fs.readFileSync(f.driver.reservationFile, 'utf8'), reservation);
  await f.driver.remove(f.options);
  assert.equal(fs.existsSync(f.driver.reservationFile), false);
  // A fresh generation can reserve the same fixed filename without stale data.
  const next = { ...JSON.parse(reservation), ownershipToken: randomUUID(), resourceNonce: randomUUID() };
  fs.writeFileSync(f.driver.reservationFile, JSON.stringify(next), { flag: 'wx' });
  await f.driver.remove(f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.driver.reservationFile)), next);
});

test('Lima: reservation cleanup never follows a symlink or a recorded arbitrary path', async t => {
  const f = fixture(t, 'lima'); f.deleteResource();
  const target = path.join(f.runtimeRoot, 'keep');
  const reservation = { ...JSON.parse(fs.readFileSync(f.driver.reservationFile)), instanceDirectory: target };
  fs.writeFileSync(target, 'shared'); fs.writeFileSync(f.driver.reservationFile, JSON.stringify(reservation));
  await f.driver.remove(f.options);
  assert.equal(fs.readFileSync(target, 'utf8'), 'shared');
  assert(fs.existsSync(f.driver.reservationFile));
  fs.unlinkSync(f.driver.reservationFile); fs.symlinkSync(target, f.driver.reservationFile);
  await assert.rejects(f.driver.remove(f.options), { code: 'ELOOP' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'shared');
  assert(fs.lstatSync(f.driver.reservationFile).isSymbolicLink());
});

test('Lima: missing inventory cannot hide an unrecognized directory or dangling symlink', async t => {
  const f = fixture(t, 'lima'); f.record = undefined;
  await assert.rejects(f.driver.remove(f.options), /not recognized/);
  fs.rmSync(f.driver.instanceDirectory, { recursive: true });
  fs.symlinkSync(path.join(f.runtimeRoot, 'does-not-exist'), f.driver.instanceDirectory);
  await assert.rejects(f.driver.remove(f.options), /not recognized/);
  assert.equal(f.calls.filter(call => call.args[0] === 'delete').length, 0);
});

test('Lima: post-delete inventory absence with a leftover directory is a verification failure', async t => {
  const f = fixture(t, 'lima');
  f.onDelete = async () => { f.record = undefined; };
  await assert.rejects(f.driver.remove(f.options), /not recognized/);
  assert(fs.existsSync(f.driver.reservationFile));
});
