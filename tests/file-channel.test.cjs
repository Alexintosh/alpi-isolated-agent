const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { streamCommand, cleanEnvironment } = require('../src/runtime/driver-common.cjs');

test('cancelling a streaming CLI also terminates a child retaining its output pipe', async () => {
  const grandchild = `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);`;
  const script = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const channel = streamCommand(process.execPath, ['-e', script], { env: cleanEnvironment('/tmp'), timeout:10000 });
  await once(channel.output,'data'); channel.input.end();
  channel.stop();
  let timer;
  try {
    await assert.rejects(Promise.race([channel.done, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('orphaned child')),6000)})]), /file transfer was interrupted/);
  } finally { clearTimeout(timer); channel.stop(); }
});
