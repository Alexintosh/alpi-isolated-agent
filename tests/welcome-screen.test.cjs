const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/v1/control.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/v1/control.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/v1/control.css'), 'utf8');

// Execute the shipped renderer, its status subscription and actual click handlers.
// Nodes come from the live HTML IDs, so missing markup fails instead of being invented.
function fixture() {
  const nodes = new Map(), calls = [], timers = [];
  function node() {
    const attributes = {}, events = {}, classes = new Set(), queries = new Map();
    return {
      disabled: false, hidden: false, dataset: {}, textContent: '', value: '', elements: [], children: [],
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { attributes[name] = value; }, getAttribute: name => attributes[name],
      removeAttribute(name) { delete attributes[name]; },
      addEventListener(name, handler) { events[name] = handler; },
      click() { if (!this.disabled) events.click?.(); },
      append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
      prepend(child) { child.parentNode = this; this.children.unshift(child); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node()); return queries.get(selector); },
      querySelectorAll() { return []; }, contains() { return false; }, focus() {},
    };
  }
  for (const match of html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const item = node(); item.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    item.hidden = /\shidden(?:\s|>)/.test(match[0]); nodes.set(match[1], item);
  }
  const get = id => { assert(nodes.has(id), `Missing live DOM ID: ${id}`); return nodes.get(id); };
  let status, connectError;
  const context = {
    document: { getElementById: get, createElement: node, createElementNS: node },
    window: { isolated: {
      onStatus(handler) { status = handler; }, status: () => new Promise(() => {}),
      async connect() { calls.push('connect'); if (connectError) throw Error(connectError); },
      async disconnect() { calls.push('disconnect'); },
      async stopEnvironment() { calls.push('stop'); },
      async showPanel(panel) { calls.push(`panel:${panel}`); },
    } },
    setInterval(handler) { timers.push(handler); },
  };
  vm.runInNewContext(source, context, { filename: 'control.js' });
  return { get, calls, render: state => status(state), tick: () => timers.forEach(fn => fn()),
    failConnect: message => { connectError = message; },
    value: name => get(`welcome-${name}-value`).textContent,
    tone: name => get(`welcome-${name}-dot`).dataset.state };
}
function state(overrides = {}, environment = {}) {
  return { selectedId: 'vm', activeId: null, panel: 'harness', label: 'Disconnected', busy: false,
    installation: { active: 'release', ready: true, busy: false },
    networkPolicy: { modes: {}, rules: [], events: [] },
    environments: [{ id: 'vm', name: 'Selected workspace', kind: 'smolvm', phase: 'stopped', network: 'offline', ...environment }],
    ...overrides };
}

test('installed stopped welcome renders live state and dispatches Connect', async () => {
  const f = fixture(); f.render(state());
  assert.equal(f.value('runtime'), 'Installed and verified');
  assert.equal(f.value('vm'), 'Stopped'); assert.equal(f.tone('vm'), 'idle');
  assert.equal(f.value('harness'), 'Disconnected');
  assert.equal(f.get('welcome-environment').textContent, 'Selected workspace');
  assert.equal(f.get('welcome-action').textContent, 'Connect');
  assert.equal(f.get('welcome-action').disabled, f.get('connect').disabled);
  f.get('welcome-action').click(); await Promise.resolve();
  assert.deepEqual(f.calls, ['connect']);
});

test('missing runtime opens existing Settings without installing or connecting', async () => {
  const f = fixture(); f.render(state({ installation: { ready: false, active: null } }));
  assert.equal(f.value('runtime'), 'Not installed'); assert.notEqual(f.tone('runtime'), 'ready');
  assert.equal(f.get('welcome-action').textContent, 'Set up runtime');
  assert.equal(f.get('welcome-action').disabled, false); assert.equal(f.get('connect').disabled, true);
  f.get('welcome-action').click(); await Promise.resolve(); assert.deepEqual(f.calls, ['panel:resources']);
});

test('startup verification and development mode never invent an installed runtime', () => {
  const f = fixture();
  f.render(state({ busy: true, installation: { active: 'release', ready: false }, label: 'Starting' }));
  assert.equal(f.value('runtime'), 'Checking runtime'); assert.equal(f.tone('runtime'), 'busy');
  assert.notEqual(f.value('harness'), 'Connected'); assert.notEqual(f.tone('harness'), 'ready');
  assert.equal(f.get('welcome-action').textContent, 'Review runtime');
  f.render(state({ installation: undefined }));
  assert.equal(f.value('runtime'), 'Development mode'); assert.notEqual(f.tone('runtime'), 'ready');
  assert.equal(f.get('welcome-action').textContent, 'Connect');
  f.render(state({ installation: undefined, busy: true, label: 'Starting' }));
  assert.equal(f.value('runtime'), 'Checking runtime');
});

test('verification faults and failed runtime changes offer review and never show ready', async () => {
  for (const overrides of [
    { installation: { active: 'release', ready: false } },
    { installation: { active: 'release', ready: true, fault: true } },
    { installation: { active: 'release', ready: true, phase: 'error' } },
    { label: 'Runtime change not completed' },
    { installation: { active: 'release', ready: false }, label: 'Recovery required' },
    { installation: undefined, label: 'Recovery required' },
  ]) {
    const f = fixture(); f.render(state(overrides));
    assert.equal(f.tone('runtime'), 'error'); assert.equal(f.get('welcome-action').textContent, 'Review runtime');
    f.get('welcome-action').click(); await Promise.resolve(); assert.deepEqual(f.calls, ['panel:resources']);
  }
});

test('preparing and starting preserve Cancel dispatch and elapsed announcements', async () => {
  for (const phase of ['preparing', 'starting']) {
    const f = fixture(); f.render(state({ busy: true, label: 'Connecting', detail: 'Preparing selected environment',
      progress: { phase, startedAt: Date.now() - 65000 } }, { phase }));
    assert.equal(f.value('vm'), phase === 'preparing' ? 'Preparing' : 'Starting');
    assert.equal(f.tone('vm'), 'busy'); assert.notEqual(f.tone('harness'), 'ready');
    assert.equal(f.get('welcome-action').textContent, 'Cancel');
    assert.equal(f.get('slow-start').hidden, false);
    f.tick(); assert.match(f.get('welcome-state').textContent, /1:0[5-9]/);
    assert.match(f.get('operation-text').textContent, /1:0[5-9]/);
    assert.match(f.get('status-announcement').textContent, /Preparing environment|Starting VM/);
    assert.equal(f.get('welcome-state').dataset.state, 'busy');
    f.get('welcome-action').click(); await Promise.resolve(); assert.deepEqual(f.calls, ['disconnect']);
  }
});

test('a disconnected client does not turn a running VM into a stopped one', async () => {
  const f = fixture(); f.render(state({}, { phase: 'running', network: 'ready' }));
  assert.equal(f.value('vm'), 'Running'); assert.equal(f.value('harness'), 'Disconnected');
  assert.equal(f.get('welcome-action').textContent, 'Retry');
  f.get('welcome-action').click(); await Promise.resolve(); assert.deepEqual(f.calls, ['connect']);
  f.render(state({}, { phase: 'error', issue: 'operation-failed' }));
  assert.match(f.value('vm'), /unconfirmed/); assert.equal(f.tone('vm'), 'error');
  f.render(state({}, { phase: 'unrecognized' }));
  assert.equal(f.value('vm'), 'Unknown'); assert.notEqual(f.tone('vm'), 'ready');
  f.render(state({}, { phase: 'ready' })); assert.equal(f.value('vm'), 'Prepared · not running');
});

test('network readiness distinguishes offline, block all, approvals, allow all and invalid policy', () => {
  const f = fixture();
  for (const mode of ['ask', 'block-all', 'allow-all']) {
    f.render(state({ networkPolicy: { modes: { vm: mode } } }));
    assert.match(f.value('network'), /^Offline · Iron/); assert.notEqual(f.tone('network'), 'ready');
  }
  for (const [mode, text, tone] of [
    ['ask', 'rules & approvals', 'ready'], ['block-all', 'all traffic blocked', 'idle'],
    ['allow-all', 'all destinations allowed', 'ready'], ['future-mode', 'mode unknown', 'unknown'],
  ]) {
    f.render(state({ networkPolicy: { modes: { vm: mode } } }, { phase: 'running', network: 'ready' }));
    assert.equal(f.value('network'), `Through Iron · ${text}`); assert.equal(f.tone('network'), tone);
  }
  for (const policy of [null, { fault: true }, { closed: true }]) {
    f.render(state({ networkPolicy: policy }, { phase: 'running', network: 'ready' }));
    assert.match(f.value('network'), /Offline/); assert.notEqual(f.tone('network'), 'ready');
  }
  assert.match(f.get('welcome-network-value').title, /No direct egress/);
  assert.match(f.get('welcome-network-value').title, /Imported model endpoints do not grant network permission/);
});

test('Harness connection requires the matching active environment and no busy bootstrap or issue', () => {
  const f = fixture();
  for (const overrides of [{ activeId: 'other' }, { activeId: 'vm', busy: true, progress: { phase: 'bootstrap' } },
    { activeId: 'vm', connection: { issue: 'renderer-stopped' } },
    { activeId: 'vm', connection: { issue: 'control-channel-unavailable' } }]) {
    f.render(state(overrides, { phase: 'running', network: 'ready' }));
    assert.notEqual(f.tone('harness'), 'ready');
    assert.equal(f.value('vm'), 'Running');
  }
  f.render(state({ activeId: 'vm' }, { phase: 'running', network: 'ready' }));
  assert.equal(f.value('harness'), 'Connected');
});

test('architecture follows selected image metadata and is omitted when undeclared', () => {
  const f = fixture(), images = { selected: 'arm', items: [
    { id: 'arm', environmentId: 'arm-vm', architecture: 'arm64' },
    { id: 'official', environmentId: 'vm', architecture: 'x64' },
  ] };
  f.render(state({ images }));
  assert.equal(f.get('welcome-capabilities').textContent, 'AMD64 · Browser & desktop · Selected environment');
  f.render(state({ images, selectedId: 'arm-vm' }, { id: 'arm-vm', name: 'Local ARM64 Chromium' }));
  assert.match(f.get('welcome-capabilities').textContent, /^ARM64/);
  f.render(state({ images, selectedId: 'lima-v1' }, { id: 'lima-v1', kind: 'lima' }));
  assert.equal(f.get('welcome-capabilities').textContent, 'Shell & terminal · Selected environment');
  f.render(state({ images, selectedId: 'lima-v1' }, { id: 'lima-v1', kind: 'lima', architecture: 'aarch64' }));
  assert.match(f.get('welcome-capabilities').textContent, /^ARM64/);
});

test('central lifecycle action has toolbar guard parity including release during blocked prerequisites', () => {
  const guards = [{}, { filesBusy: true }, { quitting: true }, { modelBusy: true },
    { images: { busy: true } }, { networkPolicy: null }, { networkPolicy: { fault: true } },
    { networkPolicy: { closed: true } }, { environments: [] }];
  for (const guard of guards) for (const busy of [false, true]) {
    const f = fixture(); f.render(state({ ...guard, busy }));
    assert.equal(f.get('welcome-action').disabled, f.get('connect').disabled, JSON.stringify({ guard, busy }));
    assert.equal(f.get('welcome-action').textContent, f.get('connect-label').textContent);
    if (f.get('welcome-action').disabled) { f.get('welcome-action').click(); assert.deepEqual(f.calls, []); }
  }
});

test('runtime install and package picker cannot be cancelled through the welcome lifecycle path', () => {
  for (const overrides of [
    { busy: true, installation: { ready: true, active: 'release', busy: true, phase: 'copying' } },
    { busy: true, label: 'Preparing runtime change', installation: { ready: true, active: 'release', busy: false } },
    { busy: true, label: 'Runtime · stopping', installation: { ready: false, active: 'release', busy: false } },
  ]) {
    const f = fixture(); f.render(state(overrides));
    assert.equal(f.get('welcome-action').disabled, true); assert.equal(f.get('welcome-action').textContent, 'Review runtime');
    assert.equal(f.tone('runtime'), 'busy'); f.get('welcome-action').click(); assert.deepEqual(f.calls, []);
    f.get('welcome-settings').click(); assert.deepEqual(f.calls, ['panel:resources']);
  }
});

test('shortcuts use the reviewed panel names and obey quitting guards', () => {
  const f = fixture(); f.render(state());
  for (const id of ['welcome-files', 'welcome-network', 'welcome-settings']) f.get(id).click();
  assert.deepEqual(f.calls, ['panel:files', 'panel:network', 'panel:resources']);
  f.render(state({ quitting: true }));
  for (const id of ['welcome-files', 'welcome-network', 'welcome-settings', 'welcome-action']) {
    assert.equal(f.get(id).disabled, true); f.get(id).click();
  }
  assert.equal(f.calls.length, 3);
});

test('welcome yields to existing panels and active guest views', () => {
  const f = fixture();
  for (const panel of ['resources', 'network', 'files', 'models', 'desktop', 'browser']) {
    f.render(state({ panel })); assert.equal(f.get('welcome').hidden, true);
  }
  f.render(state({ activeId: 'vm' }, { phase: 'running', network: 'ready' }));
  assert.equal(f.get('welcome').hidden, true); assert.equal(f.get('content').hidden, true);
  f.render(state()); assert.equal(f.get('welcome').hidden, false); assert.equal(f.get('content').hidden, false);
});

test('rejected actions retain errors and never confirm a VM stop', async () => {
  const f = fixture(); f.failConnect('Synthetic connection failure'); f.render(state());
  f.get('welcome-action').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.get('welcome-state').textContent, /Synthetic connection failure/);
  assert.equal(f.get('welcome-state').dataset.state, 'error');
  assert.match(f.value('vm'), /unconfirmed/); assert.equal(f.tone('vm'), 'error');
  assert.equal(f.value('harness'), 'Not connected · operation failed');
  assert.match(f.get('status-announcement').textContent, /Synthetic connection failure/);
});

test('a failed bootstrap returned as a snapshot keeps the VM running and marks Harness failure', () => {
  const f = fixture();
  f.render(state({ label: 'Operation not completed', detail: 'The environment remains isolated. Retry or stop it using the local controls.' },
    { phase: 'running', network: 'ready' }));
  assert.equal(f.value('vm'), 'Running'); assert.equal(f.value('harness'), 'Not connected · operation failed');
  assert.equal(f.tone('harness'), 'error'); assert.equal(f.get('welcome-state').dataset.state, 'error');
  assert.equal(f.get('welcome-action').textContent, 'Retry');
});

test('welcome uses native keyboard controls, textual statuses and strict CSP', () => {
  const welcome = html.match(/<main id="welcome"[\s\S]*?<\/main>/)[0];
  assert.match(welcome, /Your workspace, isolated\./);
  assert.match(welcome, /aria-labelledby="welcome-heading"/);
  for (const id of ['welcome-action', 'welcome-files', 'welcome-network', 'welcome-settings'])
    assert.match(welcome, new RegExp(`<button id="${id}" type="button"`));
  assert.match(welcome, /aria-label="Selected environment status"/);
  assert.match(welcome, /Disconnect keeps jobs running\. Stop VM stops jobs\./);
  assert.match(welcome, /Quit stops managed environments/);
  assert(!/scenario|Switching environments/.test(welcome));
  assert.match(html, /content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'"/);
});


test('welcome uses the local Alpi logo decoratively with self-only image CSP', () => {
  const welcome = html.match(/<main id="welcome"[\s\S]*?<\/main>/)[0];
  assert.match(welcome, /<img class="welcome-logo" src="alpi-logo\.png" alt="" aria-hidden="true" width="24" height="24">Alpi<\/p>/);
  assert(!welcome.includes('M3 3v10M13 3v10M3 8h10'));
  assert.match(html, /content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'"/);
  assert.doesNotMatch(html, /img-src[^;"]*(?:data:|blob:|\*|https?:)/);
  assert.match(css, /#welcome \.welcome-mark\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.welcome-logo\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*flex:\s*none;/);
  const shipped = fs.readFileSync(path.join(__dirname, '../src/v1/alpi-logo.png'));
  const original = fs.readFileSync(path.join(__dirname, '../assets/Alpi-1024.png'));
  assert.equal(shipped.equals(original), true);
});

test('persisted ready values cannot appear verified before reconciliation completes',()=>{
 const f=fixture();
 for(const status of ['pending','failed']){
  f.render(state({environmentVerification:status,busy:status==='pending',activeId:'vm'}, {phase:'running',network:'ready'}));
  for(const row of ['vm','network','harness'])assert.equal(f.tone(row),status==='pending'?'busy':'error');
  assert.match(f.value('vm'),status==='pending'?/Checking saved state/:/unverified/);
 }
 f.render(state({environmentVerification:'verified'}, {phase:'running',network:'ready'}));
 assert.equal(f.value('vm'),'Running');assert.equal(f.tone('vm'),'ready');
 assert.equal(f.value('harness'),'Disconnected');
});
