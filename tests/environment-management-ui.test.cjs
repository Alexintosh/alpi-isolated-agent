const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/v1/control.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/v1/control.js'), 'utf8');

// Run the shipped renderer and its real subscriptions/handlers against IDs from
// the shipped HTML, without Electron, a browser, a VM or any external services.
function fixture() {
  const nodes = new Map(), calls = [];
  function node() {
    const attributes = {}, events = {}, classes = new Set(), queries = new Map();
    let value = '';
    const item = {
      disabled: false, hidden: false, dataset: {}, textContent: '', elements: [], children: [],
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      setAttribute(name, value) { attributes[name] = value; }, getAttribute: name => attributes[name],
      removeAttribute(name) { delete attributes[name]; },
      addEventListener(name, handler) { (events[name] ??= []).push(handler); },
      listenerCount(name) { return events[name]?.length ?? 0; },
      fire(name = 'click') { return Promise.all((events[name] ?? []).map(handler => handler({ preventDefault() {} }))); },
      click() { return this.disabled ? Promise.resolve() : this.fire(); },
      append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
      prepend(child) { child.parentNode = this; this.children.unshift(child); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node()); return queries.get(selector); },
      querySelectorAll() { return []; }, contains() { return false; }, focus() {},
    };
    // Emulate the browser's range sanitization: a value assigned before max is
    // clamped to the default max of 100. Text inputs keep their literal value.
    Object.defineProperty(item, 'value', {
      get() { return value; },
      set(next) {
        if (item.type === 'range') {
          const numeric = Number(next), min = Number(item.min ?? 0), max = Number(item.max ?? 100);
          value = Number.isFinite(numeric) ? String(Math.min(Math.max(numeric, min), max)) : '';
        } else value = String(next);
      },
    });
    return item;
  }
  for (const match of html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const item = node(); item.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    item.hidden = /\shidden(?:\s|>)/.test(match[0]);
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) item.setAttribute(attr[1], attr[2]);
    item.type = item.getAttribute('type') || undefined;
    nodes.set(match[1], item);
  }
  const get = id => { assert(nodes.has(id), `Missing live DOM ID: ${id}`); return nodes.get(id); };
  let status, manage = async () => {};
  const api = {
    onStatus(handler) { status = handler; }, status: () => new Promise(() => {}),
    async manageEnvironment(...args) { calls.push(['manage', ...args]); return manage(...args); },
    async connect() { calls.push(['connect']); }, async disconnect() { calls.push(['disconnect']); },
    async stopEnvironment() { calls.push(['stop']); }, async showPanel(panel) { calls.push(['panel', panel]); },
    async setResources(value) { calls.push(['resources', value]); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: get, createElement: node, createElementNS: node },
    window: { isolated: api }, setInterval() {},
  }, { filename: 'control.js' });
  return { get, calls, api, render: state => status(state), setManage(fn) { manage = fn; } };
}
function state(overrides = {}, environment = {}) {
  return {
    selectedId: 'vm', activeId: null, panel: 'resources', label: 'Disconnected', busy: false,
    environmentVerification: 'verified', installation: { active: 'release', ready: true, busy: false },
    networkPolicy: { modes: {}, rules: [], events: [] },
    resources: { environments: [{ id: 'vm', cpus: 4, memoryMiB: 4096, diskGiB: 30, diskChange: 'grow-only' }],
      limits: { cpus: 8, memoryMiB: 16384, diskGiB: 100, hostMemoryMiB: 16384 } },
    images: { selected: 'other-image', items: [
      { id: 'other-image', environmentId: 'other', name: 'Other image', available: true },
      { id: 'vm-image', environmentId: 'vm', name: 'Exact selected image', available: true },
    ] },
    environments: [
      { id: 'other', name: 'Other environment', kind: 'smolvm', phase: 'running' },
      { id: 'vm', name: 'Selected <workspace> & data', kind: 'smolvm', phase: 'stopped', network: 'offline', prepared: true, ...environment },
    ], ...overrides,
  };
}
test('Settings identifies the exact selected environment and its own image, without using global image preference', () => {
  const f = fixture(); f.render(state());
  assert.equal(f.get('management-environment').textContent, 'Selected <workspace> & data');
  assert.equal(f.get('management-image').textContent, 'Image: Exact selected image');
  assert.equal(f.get('management-image').hidden, false);
  f.render(state({ selectedId: 'other', resources: { environments: [] } }));
  assert.equal(f.get('management-environment').textContent, 'Other environment');
  assert.equal(f.get('management-image').textContent, 'Image: Other image');
  f.render(state({}, { id: 'lima-v1', kind: 'lima' }));
  assert.equal(f.get('management-environment').textContent, 'No environment selected');
  f.render(state({ selectedId: 'lima-v1' }, { id: 'lima-v1', kind: 'lima', name: 'Lima · Ubuntu' }));
  assert.equal(f.get('management-environment').textContent, 'Lima · Ubuntu');
  assert.equal(f.get('management-image').hidden, true);
  assert.equal(f.get('management-image').textContent, '');
});

test('management dispatches only the operation for main to resolve the selected environment, once per click', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.render(state());
  for (const operation of ['restart', 'recreate']) {
    const button = f.get('environment-' + operation);
    assert.equal(button.disabled, false); assert.equal(button.listenerCount('click'), 1);
    await button.click();
  }
  assert.deepEqual(f.calls, [['manage', 'restart'], ['manage', 'recreate']]);
  assert.equal(f.get('environment-export').listenerCount('click'), 1);
});

test('busy, missing selection and unavailable runtime/resource guards survive synthetic clicks on enabled DOM', async () => {
  const guards = [
    { busy: true }, { filesBusy: true }, { modelBusy: true }, { quitting: true }, { viewer: { opening: true } },
    { installation: { ready: true, busy: true } }, { images: { busy: true } },
    { busy: true, label: 'Preparing runtime change', installation: { ready: true, busy: false } },
    { resources: undefined }, { resources: { fault: true } }, { resources: { environments: [] } },
    { resources: { environments: [{ id: 'other' }] } }, { environments: [] }, { selectedId: 'missing' },
  ];
  for (const guard of guards) {
    const f = fixture(); f.render(state(guard));
    for (const operation of ['restart', 'recreate']) {
      const button = f.get('environment-' + operation);
      assert.equal(button.disabled, true, JSON.stringify(guard));
      button.disabled = false; await button.fire();
    }
    assert.deepEqual(f.calls, [], JSON.stringify(guard));
  }
  for (const environment of [{ busy: true }, { phase: 'new', prepared: false }, { phase: 'new', prepared: true }]) {
    const f = fixture(); f.render(state({}, environment));
    for (const id of ['environment-restart', 'environment-recreate']) {
      assert.equal(f.get(id).disabled, true); await f.get(id).fire();
    }
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); delete f.api.manageEnvironment; f.render(state());
  assert.equal(f.get('environment-restart').disabled, true);
  assert.equal(f.get('environment-recreate').disabled, true);
});

test('click-time guards use the latest snapshot and pending confirmation blocks duplicate operations', async () => {
  const f = fixture(), current = state(); f.render(current);
  current.filesBusy = true; // A queued click cannot trust the previous enabled DOM.
  await f.get('environment-recreate').fire(); assert.deepEqual(f.calls, []);
  current.filesBusy = false;
  let finish; f.setManage(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.get('environment-recreate').click();
  assert.equal(f.get('environment-restart').disabled, true);
  assert.equal(f.get('environment-recreate').disabled, true);
  f.render(state()); await f.get('environment-recreate').fire(); await f.get('environment-restart').fire();
  assert.deepEqual(f.calls, [['manage', 'recreate']]);
  finish(); await pending;
  assert.equal(f.get('environment-restart').disabled, false);
  assert.equal(f.get('environment-recreate').disabled, false);
});

test('restart prerequisites do not hide native-confirmed recreation when a runtime still exists', async () => {
  for (const guard of [
    { installation: { ready: false } }, { installation: { ready: true, fault: true } },
    { installation: { ready: true, phase: 'error' } }, { networkPolicy: null },
    { networkPolicy: { fault: true } }, { networkPolicy: { closed: true } },
  ]) {
    const f = fixture(); f.render(state(guard));
    assert.equal(f.get('environment-restart').disabled, true);
    assert.equal(f.get('environment-recreate').disabled, false);
    await f.get('environment-restart').fire(); await f.get('environment-recreate').click();
    assert.deepEqual(f.calls, [['manage', 'recreate']]);
  }
});

test('incomplete recreation in new/error routes Connect and Retry to Settings and permits explicit recreate', async () => {
  for (const phase of ['new', 'error']) {
    const f = fixture(); f.render(state({ panel: 'harness', connection: { issue: 'renderer-stopped' } }, { phase, prepared: false, resetPending: true }));
    assert.equal(f.get('management-recovery').hidden, false);
    assert.equal(f.get('environment-restart').disabled, true);
    assert.equal(f.get('environment-recreate').disabled, false);
    assert.equal(f.get('welcome-action').textContent, 'Review environment');
    assert.equal(f.get('connect-label').textContent, 'Settings');
    assert.equal(f.get('welcome-vm-value').textContent, 'Recreation incomplete');
    for (const row of ['vm', 'network', 'harness']) assert.equal(f.get('welcome-' + row + '-dot').dataset.state, 'error');
    assert.equal(f.get('status').dataset.state, 'error');
    await f.get('welcome-action').click(); await f.get('connect').click();
    await f.get('environment-restart').fire(); await f.get('environment-recreate').click();
    assert.deepEqual(f.calls, [['panel', 'resources'], ['panel', 'resources'], ['manage', 'recreate']]);
  }
});

test('incomplete recreation retains Disconnect and current busy Cancel rather than attempting Connect', async () => {
  for (const guard of [{ activeId: 'vm', connection: { issue: 'renderer-stopped' } }, { busy: true },
    { busy: true, installation: { ready: false } }, { viewer: { opening: true } }]) {
    const f = fixture(); f.render(state({ panel: 'harness', ...guard }, { phase: 'error', resetPending: true }));
    const label = guard.busy || guard.viewer?.opening ? 'Cancel' : 'Disconnect';
    assert.equal(f.get('connect-label').textContent, label);
    assert.equal(f.get('welcome-action').textContent, label);
    assert.equal(f.get('connect').disabled, false);
    assert.equal(f.get('welcome-action').disabled, false);
    await f.get('connect').click(); await f.get('welcome-action').click();
    assert.deepEqual(f.calls, [['disconnect'], ['disconnect']]);
  }
});

test('Export files first opens Files on Export without starting a VM, transfer or destructive action', async () => {
  const f = fixture(); f.render(state()); await f.get('environment-export').click();
  assert.deepEqual(f.calls, [['panel', 'files']]);
  assert.equal(f.get('files-tab-export').getAttribute('aria-selected'), 'true');
  assert.equal(f.get('files-export').hidden, false); assert.equal(f.get('files-import').hidden, true);
  assert.equal(f.get('files-shared').hidden, true);
  f.render(state({ quitting: true })); await f.get('environment-export').fire();
  assert.equal(f.calls.length, 1);
});

test('main feedback uses existing action error/status surfaces and preserves actionable guidance', async () => {
  const f = fixture(); f.render(state());
  f.setManage(async () => { throw Error('Resolve interrupted transfers in Files before trying again.'); });
  await f.get('environment-recreate').click();
  assert.equal(f.get('detail').textContent, 'Resolve interrupted transfers in Files before trying again.');
  assert.equal(f.get('local-message').hidden, false);
  assert.equal(f.get('environment-recreate').disabled, false);
  f.setManage(async () => state({ label: 'Recreation unavailable', detail: 'Resolve interrupted transfers in Files and invalid sharing settings before trying again.' }));
  await f.get('environment-recreate').click();
  assert.match(f.get('detail').textContent, /Resolve interrupted transfers in Files and invalid sharing settings/);
  for (const label of ['Restarting VM…', 'Recreating environment…']) {
    f.render(state({ busy: true, label, detail: 'Selected environment · Selected image', progress: { phase: 'load-ui', startedAt: Date.now() } }));
    assert.match(f.get('operation-text').textContent, new RegExp('^' + label));
    assert.equal(f.get('management-availability').textContent, label + ' · Selected environment · Selected image');
  }
  // Main's successful result resets UI eligibility without an implicit Connect.
  f.render(state()); f.setManage(async () => state({ label: 'Environment reset' }, { phase: 'new', prepared: false }));
  await f.get('environment-recreate').click();
  assert.equal(f.get('environment-recreate').disabled, true);
  assert.equal(f.get('management-recovery').hidden, true);
  assert(f.calls.every(call => call[0] === 'manage'));
});

test('ordinary lifecycle, unverified startup and missing runtime guidance remain available', async () => {
  const f = fixture(); f.render(state({ panel: 'harness' })); await f.get('welcome-action').click();
  f.render(state({ panel: 'harness' }, { phase: 'error' })); await f.get('connect').click();
  f.render(state({ activeId: 'vm' }, { phase: 'running', network: 'ready' })); await f.get('connect').click();
  f.render(state({ busy: true })); await f.get('connect').click();
  assert.deepEqual(f.calls, [['connect'], ['connect'], ['disconnect'], ['disconnect']]);
  for (const status of ['pending', 'failed']) {
    f.render(state({ activeId: 'vm', environmentVerification: status }, { phase: 'running', network: 'ready' }));
    for (const row of ['vm', 'network', 'harness']) assert.notEqual(f.get('welcome-' + row + '-dot').dataset.state, 'ready');
    assert.notEqual(f.get('status').dataset.state, 'ready');
  }
  f.render(state({ panel: 'harness', installation: { ready: false } }));
  assert.equal(f.get('welcome-action').textContent, 'Set up runtime');
});

test('management keeps visible destructive scope, accessible controls and strict CSP', () => {
  const section = html.match(/<section id="environment-management"[\s\S]*?<\/section>/)[0];
  assert.match(section, /aria-labelledby="environment-management-heading"/);
  assert.match(section, /role="alert" hidden>Recreation incomplete/);
  assert.match(section, /Cannot be undone/); assert.match(section, /files on your Mac are never deleted/);
  assert.match(section, /host vault, saved network rules and network mode/);
  assert.match(section, /Other environments are unchanged/);
  assert.match(section, /next Connect; nothing starts automatically/);
  for (const id of ['environment-restart', 'environment-recreate'])
    assert.match(section, new RegExp('<button id="' + id + '" type="button"[^>]*aria-describedby='));
  assert.match(html, /content="default-src 'none'; style-src 'self'; script-src 'self'"/);
  const management = source.slice(source.indexOf('let environmentManagementPending'), source.indexOf('let resourceKey'));
  assert(!/window\.confirm\(|innerHTML\s*=/.test(management));
});

test('resource sliders expose live values and units, preserve drafts/reset and omit overlay for Lima', async () => {
  const f = fixture();
  const wrap = state({
    selectedId: 'vm',
    resources: {
      environments: [{ id: 'vm', cpus: 4, memoryMiB: 8192, diskGiB: 30, overlayGiB: 12, diskChange: 'grow-only' }],
      limits: { cpus: 8, memoryMiB: 16384, diskGiB: 100, overlayGiB: 128, hostMemoryMiB: 16384 },
    },
  }, { prepared: true });
  f.render(wrap);
  for (const id of ['resource-cpus', 'resource-memory', 'resource-disk-gib', 'resource-overlay-gib'])
    assert.equal(f.get(id).getAttribute('type'), 'range');
  assert.equal(f.get('resource-cpus').min, 1);
  assert.equal(f.get('resource-cpus').max, 8);
  assert.equal(f.get('resource-cpus').value, '4');
  assert.equal(f.get('resource-cpus-value').textContent, '4 CPUs');
  assert.equal(f.get('resource-cpus').getAttribute('aria-valuetext'), '4 CPUs');
  // These values are above the browser's default range max of 100. They must not
  // be clamped while the slider bounds are being populated.
  assert.equal(f.get('resource-memory').min, 2048);
  assert.equal(f.get('resource-memory').max, 16384);
  assert.equal(f.get('resource-memory').value, '8192');
  assert.equal(f.get('resource-memory-value').textContent, '8192 MiB');
  assert.equal(f.get('resource-memory').getAttribute('aria-valuetext'), '8192 MiB');
  assert.equal(f.get('resource-disk-gib').min, 30);
  assert.equal(f.get('resource-disk-gib').max, 100);
  assert.equal(f.get('resource-disk-gib').value, '30');
  assert.equal(f.get('resource-disk-gib-value').textContent, '30 GiB');
  assert.equal(f.get('resource-overlay-row').hidden, false);
  assert.equal(f.get('resource-overlay-gib').min, 12);
  assert.equal(f.get('resource-overlay-gib').max, 128);
  assert.equal(f.get('resource-overlay-gib').value, '12');
  assert.equal(f.get('resource-overlay-gib-value').textContent, '12 GiB');

  f.get('resource-memory').value = '12288';
  await f.get('resource-memory').fire('input');
  assert.equal(f.get('resource-memory-value').textContent, '12288 MiB');
  assert.equal(f.get('resource-memory').getAttribute('aria-valuetext'), '12288 MiB');
  f.render({ ...wrap, detail: 'Unrelated lifecycle tick' });
  assert.equal(f.get('resource-memory').value, '12288');
  assert.equal(f.get('resource-memory-value').textContent, '12288 MiB');
  await f.get('resource-form').fire('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['resources', { cpus: 4, memoryMiB: 12288, diskGiB: 30, overlayGiB: 12 }]);
  await new Promise(resolve => setImmediate(resolve));
  f.render(wrap);
  assert.equal(f.get('resource-memory').value, '8192');
  assert.equal(f.get('resource-memory-value').textContent, '8192 MiB');

  const lima = state({
    selectedId: 'vm',
    resources: {
      environments: [{ id: 'vm', cpus: 4, memoryMiB: 4096, diskGiB: 30, diskChange: 'before-create' }],
      limits: { cpus: 8, memoryMiB: 16384, diskGiB: 100, hostMemoryMiB: 16384 },
    },
  }, { prepared: true, kind: 'lima' });
  f.render(lima);
  assert.equal(f.get('resource-overlay-row').hidden, true);
  assert.equal(f.get('resource-disk-gib').disabled, true);
  assert.match(f.get('resource-disk-gib').title, /fixed after its first creation/);
  await f.get('resource-form').fire('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['resources', { cpus: 4, memoryMiB: 4096, diskGiB: 30 }]);
});
