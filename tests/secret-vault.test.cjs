const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {SecretVault}=require('../src/runtime/secret-vault.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vault-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const key=crypto.randomBytes(32);let available=true,rotate=false;
 const storage={isAsyncEncryptionAvailable:async()=>available,encryptStringAsync:async value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()])},decryptStringAsync:async value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return {result:Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString(),shouldReEncrypt:rotate}}};
 return {root,storage,vault:new SecretVault({stateRoot:root,safeStorage:storage,platform:'darwin'}),lock:()=>available=false,rotate:()=>rotate=true};
}
test('ciphertext-only persistence and concurrent updates survive restart (mock crypto, not Keychain proof)',async t=>{
 const f=fixture(t);await Promise.all([f.vault.put('models/a','canary-a'),f.vault.put('models/b','canary-b')]);
 const raw=fs.readFileSync(f.vault.file,'utf8');assert(!raw.includes('canary'));assert.equal(fs.statSync(f.vault.file).mode&0o777,0o600);
 const restarted=new SecretVault({stateRoot:f.root,safeStorage:f.storage,platform:'darwin'});assert.equal(await restarted.get('models/a'),'canary-a');assert.equal(await restarted.get('models/b'),'canary-b');
 await restarted.remove('models/a');assert.equal(await restarted.get('models/a'),undefined);assert.equal(await restarted.get('models/b'),'canary-b');
});
test('locked vault never falls back to plaintext or overwrites existing data',async t=>{
 const f=fixture(t);await f.vault.put('models/a','existing-secret');const before=fs.readFileSync(f.vault.file);f.lock();
 await assert.rejects(f.vault.get('models/a'),{code:'VAULT_UNAVAILABLE'});await assert.rejects(f.vault.put('models/a','new-secret'),{code:'VAULT_UNAVAILABLE'});
 assert.deepEqual(fs.readFileSync(f.vault.file),before);
});
test('rotation persists new ciphertext, corrupt encrypted files are not reset and errors conceal secrets',async t=>{
 const f=fixture(t);await f.vault.put('models/a','secret-canary');const before=fs.readFileSync(f.vault.file);f.rotate();assert.equal(await f.vault.get('models/a'),'secret-canary');assert.notDeepEqual(fs.readFileSync(f.vault.file),before);
 f.storage.decryptStringAsync=async()=>{throw new Error('secret-canary')};await assert.rejects(f.vault.get('models/a'),error=>error.code==='VAULT_UNAVAILABLE'&&!error.message.includes('secret-canary'));
 fs.writeFileSync(f.vault.file,'{"version":1,"entries":{"models/a":"not base64"}}');assert.throws(()=>new SecretVault({stateRoot:f.root,safeStorage:f.storage,platform:'darwin'}));
});

test('batch encryption failure preserves every previous credential and ciphertext file',async t=>{
 const f=fixture(t);await f.vault.putMany({'models/a':'old-a','models/b':'old-b'});const before=fs.readFileSync(f.vault.file);
 const encrypt=f.storage.encryptStringAsync;let calls=0;f.storage.encryptStringAsync=async value=>{if(++calls===2)throw new Error('new-secret');return encrypt(value)};
 await assert.rejects(f.vault.putMany({'models/a':'new-a','models/b':'new-b'}),{code:'VAULT_UNAVAILABLE'});
 assert.deepEqual(fs.readFileSync(f.vault.file),before);assert.equal(await f.vault.get('models/a'),'old-a');assert.equal(await f.vault.get('models/b'),'old-b');
});
