const test=require('node:test'),assert=require('node:assert/strict');
const {SecretRedactor}=require('../src/runtime/secret-redactor.cjs');
async function filter(parts,secrets,options){const transform=new SecretRedactor(secrets,options);const result=(async()=>{const chunks=[];for await(const chunk of transform)chunks.push(chunk);return Buffer.concat(chunks).toString()})();for(const part of parts)transform.write(Buffer.from(part));transform.end();return result}
test('literal secret is removed across every possible network chunk boundary',async()=>{
 const secret='canary-api-key-12345';const source='before '+secret+' after';
 for(let split=0;split<=source.length;split++) assert.equal(await filter([source.slice(0,split),source.slice(split)],[secret]),'before [redacted] after');
});
test('JSON escapes, adjacent secrets and prefix ambiguity do not disclose keys',async()=>{
 assert.equal(await filter(['{"error":"prefix '+JSON.stringify('a"b\\c').slice(1,-1)+' suffix"}'],['a"b\\c']),' {"error":"prefix [redacted] suffix"}'.trim());
 assert.equal(await filter(['abc','def','abc'],['abc','abcdef']),'[redacted][redacted]');
 assert.equal(await filter(['abc','X'],['abc','abcdef']),'[redacted]X');
});
test('ordinary SSE chunks arrive before stream end and partial prefixes stay bounded',async()=>{
 const transform=new SecretRedactor(['secret-value']);let output='';transform.on('data',chunk=>output+=chunk);
 transform.write('data: first\n\n');assert.equal(output,'data: first\n\n');
 transform.write('data: sec');assert.equal(output,'data: first\n\ndata: ');assert.equal(transform.pending.length,3);
 transform.end('ret-value\n\n');assert.equal(output,'data: first\n\ndata: [redacted]\n\n');
});
test('response size limit fails explicitly rather than completing a truncated stream',async()=>{
 await assert.rejects(filter(['1234','5678'],['secret'],{maxBytes:6}),/size limit/);
});
