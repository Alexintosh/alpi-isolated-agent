const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { FileTransfers, guestPath, folderName } = require('../src/runtime/file-transfers.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-transfers-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const stateRoot = path.join(home, 'app-private'); fs.mkdirSync(stateRoot);
  const manager = new FileTransfers({ home, stateRoot, runtimeRoot: path.join(home, 'vm-private'), coordinator: {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { manager, root, home, stateRoot };
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
