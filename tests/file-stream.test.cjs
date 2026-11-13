const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const script = path.resolve(__dirname, '../src/runtime/file-stream.py');
const python = process.platform === 'darwin' ? '/opt/homebrew/bin/python3' : 'python3';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-stream-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const run = (mode, target, input) => spawnSync(python, [script, mode, target], { input, maxBuffer: 5 * 1024 * 1024 });
const encode = records => records.map(x => JSON.stringify(x) + '\n').join('');
const begin = {type:'begin',version:1};
const file = (p, size=1) => ({type:'file',path:p,size,executable:false});
const data = text => ({type:'data',value:Buffer.from(text).toString('base64')});
const end = text => ({type:'end-file',sha256:createHash('sha256').update(text).digest('hex')});
const finish = (entries, bytes) => ({type:'finish',entries,bytes});

test('round-trip directories, empty files, opaque archives and executable bits with verified bytes', t => {
  const root=fixture(t), source=path.join(root,'project');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'nested'));
  const bytes=Buffer.alloc(140000,137);fs.writeFileSync(path.join(source,'nested','binary'),bytes);
  fs.writeFileSync(path.join(source,'empty'),'');fs.writeFileSync(path.join(source,'run.sh'),'echo ok\n',{mode:0o755});
  // A file named .zip is opaque; no extraction or traversal interpretation.
  fs.writeFileSync(path.join(source,'unsafe.zip'),'../../outside');
  const scan=run('scan',source);assert.equal(scan.status,0);assert.equal(JSON.parse(scan.stdout).entries,6);
  const sent=run('send',source);assert.equal(sent.status,0,String(sent.stderr));
  const target=path.join(root,'export');const received=run('receive',target,sent.stdout);
  assert.equal(received.status,0,String(received.stderr));
  assert.deepEqual(fs.readFileSync(path.join(target,'project/nested/binary')),bytes);
  assert.equal(fs.statSync(path.join(target,'project/run.sh')).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(target,'project/empty')).size,0);
  assert.equal(fs.readFileSync(path.join(target,'project/unsafe.zip'),'utf8'),'../../outside');
  assert.equal(fs.statSync(target).mode&0o777,0o700);
  assert.equal(JSON.parse(String(received.stdout).trim().split('\n').at(-1)).type,'complete');
});

test('sender rejects symlinks, hardlinks and special files rather than following them', t => {
  const root=fixture(t);fs.writeFileSync(path.join(root,'outside'),'canary');fs.mkdirSync(path.join(root,'source'));
  const child=path.join(root,'source/link');fs.symlinkSync('../outside',child);
  assert.equal(run('scan',path.join(root,'source')).status,1);
  assert.equal(run('send',child).status,1);fs.unlinkSync(child);fs.linkSync(path.join(root,'outside'),child);
  assert.equal(run('send',child).status,1);fs.unlinkSync(child);
  spawnSync('mkfifo',[child]);assert.equal(run('send',child).status,1);
  fs.symlinkSync('source',path.join(root,'parent-link'));
  assert.equal(run('scan',path.join(root,'parent-link/link')).status,1);
});

test('untrusted paths, duplicate entries, corrupt hashes, oversized data and truncation leave no output', t => {
  const root=fixture(t);fs.writeFileSync(path.join(root,'outside'),'untouched');
  const cases = [
    [begin,file(['..','outside']),data('x'),end('x'),finish(1,1)],
    [begin,file(['/outside']),data('x'),end('x'),finish(1,1)],
    [begin,file(['nested','file']),data('x'),end('x'),finish(1,1)],
    [begin,{type:'symlink',path:['x'],target:'../outside'},finish(1,0)],
    [begin,file(['x']),data('x'),end('x'),file(['x']),data('y'),end('y'),finish(2,2)],
    [begin,file(['x']),data('x'),end('wrong'),finish(1,1)],
    [begin,file(['x']),data('too big'),end('too big'),finish(1,1)],
    [begin,file(['x'],2),data('x')],
    [begin,file(['x'],1024*1024*1024+1)],
    [begin,file(['x']),{type:'data',value:'%%%'}],
    [begin,{type:'directory',path:['x']},finish(1,0),{type:'extra'}],
  ];
  for (const records of cases) {
    const dest=path.join(root,'export');const result=run('receive',dest,encode(records));
    assert.equal(result.status,1);assert(!fs.existsSync(dest));
    assert.equal(result.stderr.toString(),'File transfer rejected or interrupted.\n');
  }
  assert.equal(fs.readFileSync(path.join(root,'outside'),'utf8'),'untouched');
});

test('existing destination and symlink parents are refused without changing their targets', t => {
  const root=fixture(t),records=encode([begin,file(['x']),data('x'),end('x'),finish(1,1)]);
  fs.mkdirSync(path.join(root,'existing'));fs.writeFileSync(path.join(root,'existing/canary'),'same');
  assert.equal(run('receive',path.join(root,'existing'),records).status,1);
  fs.symlinkSync('existing',path.join(root,'link'));
  assert.equal(run('receive',path.join(root,'link/new'),records).status,1);
  assert.equal(fs.readFileSync(path.join(root,'existing/canary'),'utf8'),'same');
  assert(!fs.existsSync(path.join(root,'existing/new')));
});

test('SIGTERM cancels an incomplete receive and removes its owned output', async t => {
  const root=fixture(t),dest=path.join(root,'export');
  const child=spawn(python,[script,'receive',dest],{stdio:['pipe','pipe','pipe']});
  child.stderr.resume();child.stdin.write(encode([begin,file(['x']),data('x'),end('x')]));
  await once(child.stdout,'data');const exit=once(child,'exit');child.kill('SIGTERM');
  assert.equal((await exit)[0],1);assert(!fs.existsSync(dest));
});

test('transaction cleanup recovers a killed receiver and refuses a foreign destination', async t => {
  const root=fixture(t),dest=path.join(root,'export'),token='a'.repeat(64);
  const child=spawn(python,[script,'receive',dest,'2','2',token],{stdio:['pipe','pipe','pipe']});
  child.stderr.resume();child.stdin.write(encode([begin,file(['x']),data('x'),end('x')]));
  await once(child.stdout,'data');const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  assert(fs.existsSync(dest));
  const wrong=spawnSync(python,[script,'discard',dest,'b'.repeat(64)]);assert.equal(wrong.status,1);assert(fs.existsSync(dest));
  const cleaned=spawnSync(python,[script,'discard',dest,token]);assert.equal(cleaned.status,0);assert(!fs.existsSync(dest));
  fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'keep'),'original');
  assert.equal(spawnSync(python,[script,'discard',dest,token]).status,1);
  assert.equal(fs.readFileSync(path.join(dest,'keep'),'utf8'),'original');
});

test('commit removes only the ownership marker; changed preview totals remove incomplete output', t => {
  const root=fixture(t),dest=path.join(root,'export'),token='a'.repeat(64);
  const input=encode([begin,file(['x']),data('x'),end('x'),finish(1,1)]);
  assert.equal(spawnSync(python,[script,'receive',dest,'1','2',token],{input}).status,1);assert(!fs.existsSync(dest));
  assert.equal(spawnSync(python,[script,'receive',dest,'1','1',token],{input}).status,0);
  assert.equal(spawnSync(python,[script,'commit',dest,token]).status,0);
  assert.deepEqual(fs.readdirSync(dest),['x']);assert.equal(fs.readFileSync(path.join(dest,'x'),'utf8'),'x');
});

test('a directory replaced by a symlink during receive cannot redirect later writes', async t => {
  const root=fixture(t),dest=path.join(root,'export'),outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'canary'),'untouched');
  const child=spawn(python,[script,'receive',dest],{stdio:['pipe','pipe','pipe']});child.stderr.resume();
  child.stdin.write(encode([begin,{type:'directory',path:['nested']},file(['nested','first']),data('x'),end('x')]));
  await once(child.stdout,'data');
  fs.renameSync(path.join(dest,'nested'),path.join(dest,'old'));fs.symlinkSync(outside,path.join(dest,'nested'));
  const exit=once(child,'exit');child.stdin.end(encode([file(['nested','canary']),data('y'),end('y'),finish(3,2)]));
  assert.equal((await exit)[0],1);assert(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(outside),['canary']);assert.equal(fs.readFileSync(path.join(outside,'canary'),'utf8'),'untouched');
});
