const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { FileTransfers, guestPath, folderName } = require('../src/runtime/file-transfers.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-transfers-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const stateRoot = path.join(home, 'app-private'); fs.mkdirSync(stateRoot);
  const manager = new FileTransfers({ home, stateRoot, runtimeRoot: path.join(home, 'vm-private'), coordinator: {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { manager, root, home, stateRoot };
}
// Only the VM driver and byte channels are synthetic: prepare/plan/contentRoot
// stay the production implementation, and import previews use the real helper.
function syntheticChannel(chunks) {
  const input = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const output = (async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })();
  return { input, output, done: Promise.resolve(), stop() {} };
}
function fakeDriver({ exec = async () => 'no', scan } = {}) {
  return {
    launch: 'synthetic-launch',
    async exec() { return exec(); },
    async putFile() {},
    async requireOwned() {},
    async fileChannel() {
      if (!scan) throw new Error('unexpected file channel');
      return syntheticChannel([JSON.stringify(scan)]);
    },
  };
}
function fakeCoordinator(driver) {
  return {
    async withRunning(environmentId, operation, { signal } = {}) {
      return operation(driver, { ownershipToken: 'synthetic-token', signal: signal ?? new AbortController().signal });
    },
  };
}
test('host selection excludes managed credentials, parent trees, symlink aliases and Keychain', t => {
  const {manager,root,home,stateRoot}=fixture(t);
  fs.writeFileSync(path.join(stateRoot,'vault'),'canary');
  fs.mkdirSync(path.join(home,'.dsh'));fs.writeFileSync(path.join(home,'.dsh/credentials'),'canary');
  const legacy=path.join(home,'Library/Application Support/Harness Native VM PoC/electron');
  fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'Cookies'),'synthetic-cookie-canary');
  fs.symlinkSync(stateRoot,path.join(root,'alias'));
  fs.symlinkSync(legacy,path.join(root,'legacy-alias'));
  for (const source of [stateRoot,path.join(stateRoot,'vault'),home,path.join(home,'.dsh'),path.join(root,'alias'),
    legacy,path.join(legacy,'Cookies'),path.join(home,'Library/Application Support'),path.join(root,'legacy-alias')])
    assert.throws(()=>manager.hostPath(source,{importing:true}));
  const project=path.join(home,'project');fs.mkdirSync(project);assert.equal(manager.hostPath(project,{importing:true}),project);
  assert.equal(manager.hostPath(home),home); // export into a new sibling is permitted
  if(process.platform==='darwin')assert.throws(()=>manager.hostPath(path.join(home,'.DSH/credentials'),{importing:true}));
});
test('workspace paths and destination names never accept traversal or shell-style separators',()=>{
  assert.equal(guestPath('/home/user/workspace/project'),'/home/user/workspace/project');
  for(const value of ['/etc/passwd','/home/user/workspace-foreign','/home/user/workspace/../secret','/home/user/workspace/a\n']) assert.throws(()=>guestPath(value));
  for(const value of ['..','a/b','a\\b','a\0',''])assert.throws(()=>folderName(value));
  assert.equal(folderName('my project'),'my project');
});
test('host Python stays isolated and never writes imported-module bytecode',async t=>{
  const {manager,root}=fixture(t);
  const moduleFile=path.join(root,'sample.py'),helper=path.join(root,'probe.py');
  fs.writeFileSync(moduleFile,'value = 17\n');
  fs.writeFileSync(helper,`import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sample', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({'value': module.value, 'isolated': sys.flags.isolated, 'noBytecode': sys.dont_write_bytecode}))
`);
  manager.helper=helper;
  const channel=manager.local('scan',moduleFile);
  channel.input.end();let output='';for await(const chunk of channel.output)output+=chunk;
  await channel.done;
  assert.deepEqual(JSON.parse(output),{value:17,isolated:1,noBytecode:true});
  assert.equal(fs.existsSync(path.join(root,'__pycache__')),false);
});
test('preview is single-use and cancellation invalidates it without host path arguments to execute',async t=>{
  const {manager}=fixture(t);
  const first=manager.plan({environmentId:'a',direction:'import',source:'/tmp/source',destination:'/guest',bytes:1,entries:1,collision:false});
  const second=manager.plan({...first,id:undefined});
  await assert.rejects(manager.execute(first.id));
  // An invalid attempt consumes any pending plan too, so it cannot be replayed.
  await assert.rejects(manager.execute(second.id));
  const last=manager.plan({...first,id:undefined});manager.cancel();await assert.rejects(manager.execute(last.id));
  assert.equal(manager.snapshot().state,'cancelled');
});
test('progress is bounded, monotonic and needs an exact final summary',async t=>{
  const {manager}=fixture(t);const plan={entries:2,bytes:2};
  const records=values=>Readable.from(values.map(value=>JSON.stringify(value)+'\n'));
  await manager.progress(records([{type:'progress',entries:1,bytes:1},{type:'complete',entries:2,bytes:2}]),plan);
  for(const values of [
    [{type:'complete',entries:2,bytes:3}],
    [{type:'progress',entries:1,bytes:1}],
    [{type:'progress',entries:2,bytes:2},{type:'complete',entries:1,bytes:1}],
    [{type:'complete',entries:2,bytes:2},{type:'complete',entries:2,bytes:2}],
  ]) await assert.rejects(manager.progress(records(values),plan));
  await assert.rejects(manager.progress(Readable.from(['x'.repeat(5000)]),plan));
});

test('import contentRoot is the verified canonical source basename inside the container', async t => {
  const { manager, home } = fixture(t);
  manager.coordinator = fakeCoordinator(fakeDriver());
  const directory = path.join(home, 'café project');
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'notes.txt'), 'hello');
  const file = path.join(home, 'café notes.txt'); fs.writeFileSync(file, 'hello');
  fs.symlinkSync(directory, path.join(home, 'alias dir'));

  const fromDirectory = await manager.prepareImport('env', directory, '/home/user/workspace', 'upload');
  assert.equal(fromDirectory.destination, '/home/user/workspace/upload');
  assert.equal(fromDirectory.contentRoot, '/home/user/workspace/upload/café project');

  const fromFile = await manager.prepareImport('env', file, '/home/user/workspace', 'file-upload');
  assert.equal(fromFile.contentRoot, '/home/user/workspace/file-upload/café notes.txt');

  // A trailing separator and a symlink alias never leak the raw caller string:
  // the canonical source is what file-stream.py actually nests.
  const trailing = await manager.prepareImport('env', directory + path.sep, '/home/user/workspace', 'trailing');
  assert.equal(trailing.contentRoot, '/home/user/workspace/trailing/café project');
  const alias = await manager.prepareImport('env', path.join(home, 'alias dir') + path.sep, '/home/user/workspace', 'alias');
  assert.equal(alias.contentRoot, '/home/user/workspace/alias/café project');
  assert.equal(manager.plans.size, 1);
});

test('export contentRoot is the verified guest source basename inside the host container', async t => {
  const { manager, root } = fixture(t);
  const hostParent = path.join(root, 'exports'); fs.mkdirSync(hostParent);
  manager.coordinator = fakeCoordinator(fakeDriver({ scan: { type: 'summary', entries: 2, bytes: 9 } }));

  const directory = await manager.prepareExport('env', '/home/user/workspace/my project', hostParent, 'result');
  assert.equal(directory.destination, path.join(hostParent, 'result'));
  assert.equal(directory.contentRoot, path.join(hostParent, 'result', 'my project'));

  const file = await manager.prepareExport('env', '/home/user/workspace/report.csv', hostParent, 'file-result');
  assert.equal(file.contentRoot, path.join(hostParent, 'file-result', 'report.csv'));
});

test('confirmed preview collisions keep the contentRoot and are reported, not thrown', async t => {
  const { manager, root } = fixture(t);
  const hostParent = path.join(root, 'exports'); fs.mkdirSync(hostParent);
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.mkdirSync(path.join(hostParent, 'result'));
  manager.coordinator = fakeCoordinator(fakeDriver({
    exec: async () => 'yes',
    scan: { type: 'summary', entries: 1, bytes: 5 },
  }));
  const imported = await manager.prepareImport('env', source, '/home/user/workspace', 'copy');
  assert.equal(imported.collision, true);
  assert.equal(imported.contentRoot, '/home/user/workspace/copy/source');
  const exported = await manager.prepareExport('env', '/home/user/workspace/copy', hostParent, 'result');
  assert.equal(exported.collision, true);
  assert.equal(exported.contentRoot, path.join(hostParent, 'result', 'copy'));
});

test('existing workspace and protected-path checks keep their text and carry transfer_path_refused', async t => {
  const { manager, root, home, stateRoot } = fixture(t);
  fs.mkdirSync(path.join(home, '.ssh'));
  manager.coordinator = fakeCoordinator(fakeDriver());
  const refused = (promise, message) => assert.rejects(promise, error => {
    assert.equal(error.code, 'transfer_path_refused');
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    return true;
  });
  await refused(manager.prepareImport('env', stateRoot, '/home/user/workspace', 'copy'),
    'This path contains private data managed by the host.');
  await refused(manager.prepareImport('env', path.join(home, '.ssh'), '/home/user/workspace', 'copy'),
    'This path contains private data managed by the host.');
  await refused(manager.prepareExport('env', '/etc/passwd', path.join(root, 'exports'), 'copy'),
    'Choose a path inside the guest workspace.');
  await refused(manager.prepareExport('env', '/home/user/workspace-foreign', root, 'copy'),
    'Choose a path inside the guest workspace.');
  // guestPath keeps its existing rule for a trailing separator; file-stream.py
  // rejects the empty final component at scan, so the preview fails safely and
  // never exposes a contentRoot for an impossible layout.
  await assert.rejects(manager.prepareExport('env', '/home/user/workspace/project/', root, 'copy'),
    error => error.code === 'transfer_preview_failed');
  await refused(manager.prepareExport('env', '/home/user/workspace/copy', home, '.ssh'),
    'Reserved destination.');
  assert.equal(manager.active, undefined);
  assert.equal(manager.plans.size, 0);
});

test('unknown preview failures become one fixed transfer_preview_failed without canary leakage', async t => {
  const { manager, home } = fixture(t);
  manager.coordinator = fakeCoordinator(fakeDriver());
  const canary = path.join(home, 'canary-missing-source');
  await assert.rejects(manager.prepareImport('env', canary, '/home/user/workspace', 'copy'), error => {
    assert.equal(error.code, 'transfer_preview_failed');
    assert.equal(error.message, 'Preview unavailable. Check paths, permissions and file types.');
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes('canary'), false);
    return true;
  });

  // A dependency error that merely claims the refusal code is not allowlisted.
  const source = path.join(home, 'spoof-source'); fs.mkdirSync(source);
  const spoofed = Object.assign(new Error('canary dependency text'), { code: 'transfer_path_refused' });
  manager.coordinator = fakeCoordinator(fakeDriver({ exec: async () => { throw spoofed; } }));
  await assert.rejects(manager.prepareImport('env', source, '/home/user/workspace', 'copy'), error => {
    assert.equal(error.code, 'transfer_preview_failed');
    assert.equal(error.message.includes('canary'), false);
    return true;
  });

  // A hostile thrown object whose property access throws is still contained.
  const hostile = new Proxy({}, { get() { throw new Error('canary getter'); } });
  manager.coordinator = fakeCoordinator(fakeDriver({ exec: async () => { throw hostile; } }));
  await assert.rejects(manager.prepareImport('env', source, '/home/user/workspace', 'copy'), error => {
    assert.equal(error.code, 'transfer_preview_failed');
    assert.equal(error.message.includes('canary'), false);
    return true;
  });

  // Malformed driver metadata is an unknown validation failure, not a collision.
  manager.coordinator = fakeCoordinator(fakeDriver({ exec: async () => 'maybe' }));
  await assert.rejects(manager.prepareImport('env', source, '/home/user/workspace', 'copy'), error => {
    assert.equal(error.code, 'transfer_preview_failed');
    return true;
  });
  assert.equal(manager.plans.size, 0);
  assert.equal(manager.snapshot().state, 'error');
});
