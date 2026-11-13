const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const shell = fs.readFileSync(path.join(__dirname, '../guest/v1/configure-desktop.sh'), 'utf8');
const code = shell.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];

function run(mode) {
  // Execute the deployed shutdown program with a controlled CDP endpoint and
  // transport. A WebSocket reset alone is not proof the browser has stopped.
  const fixture = `
    const realTimeout=global.setTimeout;
    global.setTimeout=(fn,ms)=>realTimeout(fn,ms===10000?200:1);
    let calls=0;
    global.fetch=async()=>{
      if(calls++===0)return{json:async()=>({webSocketDebuggerUrl:'ws://fixture'})};
      if(${JSON.stringify(mode)}==='stopped')throw Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}});
      if(${JSON.stringify(mode)}==='timeout')throw new Error('request timed out');
      return{status:200};
    };
    global.WebSocket=class{
      constructor(){realTimeout(()=>${JSON.stringify(mode)}==='handshake'?this.onerror():this.onopen(),0)}
      send(){realTimeout(()=>this.onerror(),0)}
    };
  `;
  return spawnSync(process.execPath, ['-e', fixture + code], { timeout: 3000 }).status;
}

test('browser shutdown accepts a reset only after CDP refuses connections', () => {
  assert.equal(run('stopped'), 0);
});
test('browser shutdown rejects a reset while CDP remains available', () => {
  assert.equal(run('running'), 1);
});
test('browser shutdown does not confuse timeouts or failed handshakes with a stopped browser', () => {
  assert.equal(run('timeout'), 1);
  assert.equal(run('handshake'), 1);
});
