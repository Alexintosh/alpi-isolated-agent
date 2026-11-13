const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { gitEntries, gitRoute, gitCredential, guestGitConfig } = require('../src/runtime/git-bridge.cjs');
const { createCredentialBridge } = require('../src/runtime/credential-bridge.cjs');
const { Network } = require('../src/runtime/network.cjs');
const { run } = require('../src/runtime/driver-common.cjs');
const address = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal && /^192\.168\./.test(item.address))?.address;
const binary = path.resolve(__dirname, '../vendor/m0/iron-bin/iron-proxy');
const git = '/Library/Developer/CommandLineTools/usr/bin/git';
const available = process.platform === 'darwin' && fs.existsSync(binary) && fs.existsSync(git) && address;
const repository = { id: 'fixture', baseURL: 'https://github.com/fixture/project.git', credentialRef: 'git/fixture' };

test('Git routes are exact per repository, method, query and protocol; no APIs, LFS or arbitrary suffix', () => {
  const entries = gitEntries([repository]);
  const req = (url, method = 'GET', headers = {}) => ({ url, method, headers });
  assert(gitRoute(req('/git/fixture/repo.git/info/refs?service=git-upload-pack'), entries));
  assert(gitRoute(req('/git/fixture/repo.git/git-receive-pack', 'POST', { 'content-type': 'application/x-git-receive-pack-request' }), entries));
  for (const url of ['/git/foreign/repo.git/info/refs?service=git-upload-pack', '/git/fixture/repo.git/HEAD',
    '/git/fixture/repo.git/info/lfs/objects/batch', '/git/fixture/repo.git/../other.git/git-upload-pack',
    '/git/fixture/repo.git/info/refs?service=git-upload-pack&url=https://evil.test', '/git/fixture/repo.git/info/refs',
    '/git/fixture/repo.git/info/refs?service=git-receive-pack#x']) assert.equal(gitRoute(req(url), entries), undefined);
  assert.equal(gitRoute(req('/git/fixture/repo.git/git-upload-pack', 'GET'), entries), undefined);
  assert.equal(gitRoute(req('/git/fixture/repo.git/info/refs?service=git-upload-pack', 'GET', {'git-protocol':'version=2\nevil'}), entries), undefined);
  assert.throws(() => gitEntries([{...repository,baseURL:'http://github.com/fixture/project.git'}]));
  const credential = gitCredential(JSON.stringify({ username: 'test', password: 'synthetic-secret' }));
  assert.equal(credential.authorization, 'Basic ' + Buffer.from('test:synthetic-secret').toString('base64'));
  const config = guestGitConfig(entries, 'http://127.0.0.1:43987');
  assert(config.includes('insteadOf = https://github.com/fixture/project.git'));
  assert(!config.includes('synthetic-secret')); assert(config.includes('followRedirects = false'));
});

test('real Git clone/fetch/push crosses Iron with host-only Basic credentials and scoped token', { skip: !available }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const env = { HOME: root, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const execute = args => run(git, args, {env, timeout:30000});
  const repos = path.join(root, 'repos'); fs.mkdirSync(path.join(repos, 'fixture'), {recursive:true});
  const bare = path.join(repos, 'fixture/project.git'), seed = path.join(root, 'seed'), clone = path.join(root, 'clone');
  await execute(['init','--bare','--initial-branch=main',bare]);
  await execute(['--git-dir',bare,'config','http.receivepack','true']);
  await execute(['init','--initial-branch=main',seed]); fs.writeFileSync(path.join(seed,'file.txt'),'initial fixture\n');
  await execute(['-C',seed,'add','.']); await execute(['-C',seed,'commit','-m','Initial fixture']);
  await execute(['-C',seed,'push',bare,'main']);
  const password = 'synthetic-git-canary-91bd12', encoded = Buffer.from('fixture:' + password).toString('base64');
  let hits=0, authHits=0, privateHeaders=0, mode='git';
  const upstream = http.createServer((req,res) => {
    hits++; if(req.headers.authorization === 'Basic ' + encoded) authHits++;
    privateHeaders += Object.keys(req.headers).filter(name => name.startsWith('x-isolated-')).length;
    if(req.headers.authorization !== 'Basic ' + encoded) {req.resume();res.writeHead(401).end();return;}
    if(mode==='reflect'){req.resume();res.writeHead(401,{'x-secret':password,'set-cookie':encoded}).end(password+' '+encoded);return;}
    if(mode==='redirect'){req.resume();res.writeHead(307,{location:'https://example.invalid/'+password}).end();return;}
    const url=new URL(req.url,'http://fixture');
    const child=spawn(git,['http-backend'],{env:{...env,GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',REMOTE_USER:'fixture',
      REQUEST_METHOD:req.method,PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),
      CONTENT_TYPE:req.headers['content-type']??'',SERVER_PROTOCOL:'HTTP/1.1',
      ...(req.headers['git-protocol']?{HTTP_GIT_PROTOCOL:req.headers['git-protocol']}:{})},stdio:['pipe','pipe','pipe']});
    child.stderr.resume();child.stdin.on('error',()=>{});req.pipe(child.stdin);
    let pending=Buffer.alloc(0), headersDone=false;
    child.stdout.on('data',chunk=>{
      if(headersDone){res.write(chunk);return;}
      pending=Buffer.concat([pending,chunk]);const end=pending.indexOf('\r\n\r\n');
      if(end<0){if(pending.length>16384)child.kill();return;}
      const lines=pending.subarray(0,end).toString().split('\r\n'),headers={};let status=200;
      for(const line of lines){const colon=line.indexOf(':');if(colon<0)continue;const name=line.slice(0,colon),value=line.slice(colon+1).trim();
        if(name.toLowerCase()==='status')status=Number(value.split(' ')[0]);else headers[name]=value;}
      headersDone=true;res.writeHead(status,headers);res.write(pending.subarray(end+4));pending=undefined;
    });
    child.on('close',()=>res.end());child.on('error',()=>res.destroy());
    res.on('close',()=>{if(!res.writableFinished)child.kill();});
  });
  upstream.listen(0,address);await once(upstream,'listening');
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const proxyPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const repo={...repository,baseURL:`http://${address}:${upstream.address().port}/fixture/project.git`};
  let bridge;
  const network=new Network({stateRoot:root,ironBinary:binary,decide:async()=>true,credentialBridge:async({caFile})=>
    bridge=await createCredentialBridge({environmentId:'git-test',gitRepositories:[repo],allowGitFixtureHttp:true,
      vault:{get:async()=>JSON.stringify({username:'fixture',password})},proxyPort,caFile,decide:async()=>true})});
  const guard=await network.open({id:'git-test',kind:'smolvm',proxyPort});t.after(()=>guard.close());
  const endpoint=`http://127.0.0.1:${bridge.port}`;
  const config=bridge.guestGitConfig(endpoint);fs.writeFileSync(env.GIT_CONFIG_GLOBAL,config,{mode:0o600});
  assert(!config.includes(password));assert(!config.includes(encoded));
  await execute(['clone',repo.baseURL,clone]);assert.equal(fs.readFileSync(path.join(clone,'file.txt'),'utf8'),'initial fixture\n');
  fs.writeFileSync(path.join(seed,'file.txt'),'fetch fixture\n');await execute(['-C',seed,'commit','-am','Fetch fixture']);await execute(['-C',seed,'push',bare,'main']);
  await execute(['-C',clone,'fetch','origin']);
  assert.equal((await execute(['-C',clone,'rev-parse','origin/main'])).stdout,(await execute(['-C',seed,'rev-parse','HEAD'])).stdout);
  await execute(['-C',clone,'checkout','-b','test-push']);fs.writeFileSync(path.join(clone,'new.txt'),'push fixture\n');
  await execute(['-C',clone,'add','.']);await execute(['-C',clone,'commit','-m','Push fixture']);
  await execute(['-C',clone,'push','origin','HEAD:refs/heads/test-push']);
  assert.equal((await execute(['--git-dir',bare,'rev-parse','refs/heads/test-push'])).stdout,(await execute(['-C',clone,'rev-parse','HEAD'])).stdout);
  assert(hits>0);assert.equal(hits,authHits);assert.equal(privateHeaders,0);
  const auth=/extraHeader = Authorization: (.+)/.exec(config)[1], headers={authorization:auth};
  const before=hits;
  for(const suffix of ['/info/lfs/objects/batch','/HEAD','/git-upload-pack?repository=other'])
    assert.equal((await fetch(endpoint+'/git/fixture/repo.git'+suffix,{headers})).status,404);
  assert.equal((await fetch(endpoint+'/git/fixture/repo.git/info/refs?service=git-upload-pack',{headers:{authorization:'Basic foreign'}})).status,401);
  assert.equal(hits,before);
  mode='reflect';const reflected=await fetch(endpoint+'/git/fixture/repo.git/info/refs?service=git-upload-pack',{headers});
  const text=await reflected.text();assert.equal(reflected.status,401);assert(!text.includes(password));assert(!text.includes(encoded));
  assert(!reflected.headers.has('x-secret'));assert(!reflected.headers.has('set-cookie'));
  mode='redirect';assert.equal((await fetch(endpoint+'/git/fixture/repo.git/info/refs?service=git-upload-pack',{headers})).status,502);
  await guard.close();await assert.rejects(fetch(endpoint+'/git/fixture/repo.git/info/refs?service=git-upload-pack',{headers}));
});
