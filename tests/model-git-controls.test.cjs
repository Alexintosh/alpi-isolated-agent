const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/v1/control.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/v1/control.js'), 'utf8');

// Run the shipped Models/Git renderer and real handlers against IDs parsed from
// the shipped HTML, exactly like the Secrets fixtures. Synthetic state only:
// this fake DOM is not Electron, and no browser, VM, Keychain or network is used.
function fixture() {
  const nodes = new Map(), calls = [];
  function node() {
    const attributes = {}, events = {}, classes = new Set(), queries = new Map();
    return {
      disabled: false, hidden: false, readOnly: false, checked: false, dataset: {}, textContent: '', value: '',
      elements: [], children: [],
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      setAttribute(name, value) { attributes[name] = value; }, getAttribute: name => attributes[name],
      removeAttribute(name) { delete attributes[name]; },
      addEventListener(name, handler) { (events[name] ??= []).push(handler); },
      fire(name = 'click') { return Promise.all((events[name] ?? []).map(handler => handler({ preventDefault() {} }))); },
      click() { return this.disabled ? Promise.resolve() : this.fire(); },
      append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
      prepend(child) { child.parentNode = this; this.children.unshift(child); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node()); return queries.get(selector); },
      querySelectorAll() { return []; }, contains() { return false; }, focus() {},
    };
  }
  for (const match of html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const item = node(); item.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    item.hidden = /\shidden(?:\s|>)/.test(match[0]);
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) item.setAttribute(attr[1], attr[2]);
    nodes.set(match[1], item);
  }
  const get = id => { assert(nodes.has(id), `Missing live DOM ID: ${id}`); return nodes.get(id); };
  let status, save = async () => null, remove = async () => null, gitSave = async () => null;
  const api = {
    onStatus(handler) { status = handler; }, status: () => new Promise(() => {}),
    async showPanel(panel) { calls.push(['panel', panel]); },
    async saveModelProvider(input) { calls.push(['model-save', input]); return save(input); },
    async removeModelProvider(id) { calls.push(['model-remove', id]); return remove(id); },
    async selectModel(selection) { calls.push(['model-select', selection]); },
    async importModels() { calls.push(['model-import']); },
    async probeModels() { calls.push(['model-probe']); },
    async saveGit(input) { calls.push(['git-save', input]); return gitSave(input); },
    async importGit(repository) { calls.push(['git-import', repository]); },
    async removeGit(id) { calls.push(['git-remove', id]); },
    async saveSecret() { calls.push(['secret-save']); },
    async removeSecret() { calls.push(['secret-remove']); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: get, createElement: node, createElementNS: node },
    window: { isolated: api }, setInterval() {},
  }, { filename: 'control.js' });
  return { get, calls, render: state => status(state),
    setSave(fn) { save = fn; }, setRemove(fn) { remove = fn; }, setGitSave(fn) { gitSave = fn; } };
}
function base(overrides = {}, models = {}, git = {}) {
  return {
    selectedId: 'lima', activeId: null, panel: 'models', label: 'Disconnected', busy: false,
    environmentVerification: 'verified', installation: { active: 'release', ready: true, busy: false },
    networkPolicy: { modes: {}, rules: [], events: [] },
    environments: [
      { id: 'lima', name: 'Lima · Ubuntu', kind: 'lima', phase: 'stopped' },
      { id: 'wrap', name: 'WrapVM', kind: 'smolvm', phase: 'stopped' },
    ],
    models: { selected: null, providers: [], fault: false, cleanupPending: false, ...models },
    git: { repositories: [], fault: false, cleanupPending: false, ...git },
    secrets: { entries: [], fault: false }, ...overrides,
  };
}
const model = (overrides = {}) => ({
  id: 'model-a', name: 'Model A', contextWindow: 10000, maxTokens: 1000, ...overrides,
});
const provider = (overrides = {}) => ({
  id: 'alpha', displayName: 'Alpha', api: 'openai-completions', baseURL: 'https://models.example.test/v1',
  authMode: 'bearer', credentialAvailable: true, availability: 'available',
  models: [model()], ...overrides,
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const rowsOf = f => [...f.get('model-rows').children].filter(row => row._modelRow);

test('Models panel lists providers and models, marks the current default and invites Add provider when empty', () => {
  const f = fixture();
  f.render(base({}, { selected: { provider: 'alpha', model: 'model-a' }, providers: [
    provider(),
    provider({ id: 'beta', displayName: 'Beta', authMode: 'none', credentialAvailable: false,
      models: [model({ id: 'model-b', name: 'Model B' })] }),
  ] }));
  const rows = [...f.get('model-list').children];
  assert.equal(rows.length, 2);
  const firstDetails = rows[0].children[0], secondDetails = rows[1].children[0];
  assert.equal(firstDetails.children[0].textContent, 'Alpha');
  assert.match(firstDetails.children[3].children[0].children[0].textContent, /Model A · model-a/);
  assert.equal(firstDetails.children[3].children[0].children[0].children[0].textContent, 'Default');
  assert.match(secondDetails.children[2].textContent, /No authentication · Model available/);
  // The editor opens on the default provider with the saved key locked away.
  assert.equal(f.get('model-id').value, 'alpha');
  assert.equal(f.get('model-id').readOnly, true);
  assert.equal(f.get('model-value').readOnly, true);
  assert.equal(f.get('model-value').placeholder, 'Saved key is kept');
  assert.equal(f.get('model-replace').hidden, false);
  assert.equal(f.get('welcome').hidden, true);
  assert.equal(f.get('models').getAttribute('aria-pressed'), 'true');
  f.render(base({}, { selected: null, providers: [] }));
  assert.match(f.get('model-list').children[0].textContent, /No model providers saved/);
  assert.equal(f.get('model-editor-title').textContent, 'Add a provider');
});

test('new bearer provider save dispatches the exact payload, clearing the password before the IPC await', async () => {
  const f = fixture(); f.render(base());
  await f.get('model-add').click();
  f.get('model-id').value = 'my-provider';
  await f.get('model-id').fire('input');
  f.get('model-display-name').value = 'My Provider';
  await f.get('model-display-name').fire('input');
  f.get('model-baseurl').value = 'https://api.example.test/openai/v1/';
  await f.get('model-baseurl').fire('input');
  const [row] = rowsOf(f);
  row._idInput.value = 'my-model';
  await row._idInput.fire('input');
  row._nameInput.value = 'My Model';
  await row._nameInput.fire('input');
  row._contextInput.value = '16000';
  await row._contextInput.fire('input');
  row._tokensInput.value = '2000';
  await row._tokensInput.fire('input');
  row._imageInput.checked = true;
  await row._imageInput.fire('change');
  f.get('model-value').value = 'key-not-loggable';
  await f.get('model-form').fire('submit');
  // Cleared synchronously before the deferred IPC, even while the result is pending.
  assert.equal(f.get('model-value').value, '');
  assert.equal(f.get('model-save').disabled, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['model-save', {
    id: 'my-provider', displayName: 'My Provider', api: 'openai-completions',
    baseURL: 'https://api.example.test/openai/v1/', authMode: 'bearer',
    models: [{ id: 'my-model', name: 'My Model', contextWindow: 16000, maxTokens: 2000, input: ['text', 'image'] }],
    value: 'key-not-loggable',
  }]);
  await settle();
  assert.equal(f.get('model-save').disabled, false);
});

test('none-mode saves omit value and reject a typed key; new bearer without a key is rejected', async () => {
  const f = fixture(); f.render(base());
  await f.get('model-add').click();
  f.get('model-id').value = 'open';
  await f.get('model-id').fire('input');
  f.get('model-display-name').value = 'Open Endpoint';
  await f.get('model-display-name').fire('input');
  f.get('model-baseurl').value = 'https://open.example.test/models';
  await f.get('model-baseurl').fire('input');
  f.get('model-auth').value = 'none';
  await f.get('model-auth').fire('change');
  assert.equal(f.get('model-value').disabled, true);
  assert.match(f.get('model-value-label').textContent, /not used/);
  const [row] = rowsOf(f);
  row._idInput.value = 'model-a';
  await row._idInput.fire('input');
  row._nameInput.value = 'Model A';
  await row._nameInput.fire('input');
  row._contextInput.value = '10000';
  await row._contextInput.fire('input');
  row._tokensInput.value = '1000';
  await row._tokensInput.fire('input');
  // A none-mode endpoint never accepts a typed key; metadata survives the failure.
  f.get('model-value').value = 'must-not-send';
  await f.get('model-form').fire('submit'); await settle();
  assert.deepEqual(f.calls, []);
  assert.match(f.get('detail').textContent, /does not use an API key/);
  assert.equal(f.get('model-id').value, 'open');
  await f.get('model-form').fire('submit'); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['model-save', {
    id: 'open', displayName: 'Open Endpoint', api: 'openai-completions',
    baseURL: 'https://open.example.test/models', authMode: 'none',
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 10000, maxTokens: 1000, input: ['text'] }],
  }]);
  assert(!('value' in f.calls[0][1]));
  // A fresh bearer provider requires a key at save time.
  const g = fixture(); g.render(base());
  g.get('model-id').value = 'keyed';
  await g.get('model-id').fire('input');
  g.get('model-display-name').value = 'Keyed';
  await g.get('model-display-name').fire('input');
  g.get('model-baseurl').value = 'https://keyed.example.test/v1';
  await g.get('model-baseurl').fire('input');
  const [keyedRow] = rowsOf(g);
  keyedRow._idInput.value = 'model-a';
  await keyedRow._idInput.fire('input');
  keyedRow._nameInput.value = 'Model A';
  await keyedRow._nameInput.fire('input');
  keyedRow._contextInput.value = '10000';
  await keyedRow._contextInput.fire('input');
  keyedRow._tokensInput.value = '1000';
  await keyedRow._tokensInput.fire('input');
  await g.get('model-form').fire('submit'); await settle();
  assert.deepEqual(g.calls, []);
  assert.match(g.get('detail').textContent, /Enter an API key for this endpoint/);
});

test('editing metadata preserves imported input modes and reasoning efforts verbatim', async () => {
  const imported = provider({ models: [model({
    id: 'deep-model', name: 'Deep Model', input: ['image', 'text'],
    reasoningEfforts: { off: null, high: 'high', max: 'max-effort' },
  })] });
  const f = fixture(); f.render(base({}, { selected: { provider: 'alpha', model: 'deep-model' }, providers: [imported] }));
  // Editing unrelated metadata only: change the display name.
  f.get('model-display-name').value = 'Renamed Provider';
  await f.get('model-display-name').fire('input');
  const [row] = rowsOf(f);
  assert.equal(row._textInput.checked, true);
  assert.equal(row._imageInput.checked, true);
  await f.get('model-form').fire('submit'); await settle();
  assert.equal(f.calls.length, 1);
  // Round-trip through JSON: the payload originates in the vm realm, like IPC.
  const payload = JSON.parse(JSON.stringify(f.calls[0][1]));
  assert.equal(payload.displayName, 'Renamed Provider');
  assert.deepEqual(payload.models[0].input, ['text', 'image']);
  assert.deepEqual(payload.models[0].reasoningEfforts, { off: null, high: 'high', max: 'max-effort' });
});

test('saved keys are kept by omission; a typed value rotates and a changed endpoint requires one', async () => {
  const f = fixture(); f.render(base({}, { selected: { provider: 'alpha', model: 'model-a' }, providers: [provider()] }));
  // Same endpoint, no typed key: the payload omits value entirely.
  await f.get('model-form').fire('submit'); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].id, 'alpha');
  assert(!('value' in f.calls[0][1]));
  // Replace unlocks the field; the typed replacement is sent once and cleared.
  await f.get('model-replace').click();
  assert.equal(f.get('model-value').readOnly, false);
  f.get('model-value').value = 'replacement-not-loggable';
  await f.get('model-form').fire('submit');
  assert.equal(f.get('model-value').value, '');
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][1].value, 'replacement-not-loggable');
  // Changing the endpoint without a fresh key fails without submitting.
  f.get('model-baseurl').value = 'https://other.example.test/v1';
  await f.get('model-baseurl').fire('input');
  await f.get('model-form').fire('submit'); await settle();
  assert.equal(f.calls.length, 2);
  assert.match(f.get('detail').textContent, /Enter an API key for this endpoint/);
});

test('Set default dispatches selectModel; removing the selected default surfaces the actionable rejection', async () => {
  const f = fixture();
  const second = provider({ id: 'beta', displayName: 'Beta', models: [model({ id: 'model-b' })] });
  f.render(base({}, { selected: { provider: 'alpha', model: 'model-a' }, providers: [provider(), second] }));
  const betaDetails = [...f.get('model-list').children][1].children[0];
  const modelsBox = betaDetails.children[3];
  const setDefault = [...modelsBox.children[0].children].find(node => node.textContent.includes('Set default') ||
    node.children?.some(child => child.textContent === 'Set default'));
  await setDefault.fire();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['model-select', { provider: 'beta', model: 'model-b' }]);
  await settle();
  // Removing the selected default is rejected with the fixed actionable message.
  f.setRemove(async () => { throw Error('Choose another model first, then remove this provider.'); });
  const firstRow = [...f.get('model-list').children][0];
  const removeButton = [...firstRow.children[1].children].find(node => node.textContent.includes('Remove provider') ||
    node.children?.some(child => child.textContent.includes('Remove provider')));
  await removeButton.fire(); await settle();
  assert.equal(f.get('detail').textContent, 'Choose another model first, then remove this provider.');
  assert.equal(f.get('local-message').hidden, false);
  assert.equal(f.get('model-remove').disabled, false);
  // A non-default provider removal dispatches removeModelProvider with the id.
  f.setRemove(async () => null);
  const secondRow = [...f.get('model-list').children][1];
  const removeSecond = [...secondRow.children[1].children].find(node => node.textContent.includes('Remove provider') ||
    node.children?.some(child => child.textContent.includes('Remove provider')));
  await removeSecond.fire(); await settle();
  assert.deepEqual(f.calls.at(-1), ['model-remove', 'beta']);
});

test('busy, fault, quitting and catalog flags disable mutations and show the cleanup warning', async () => {
  for (const overrides of [
    { busy: true }, { filesBusy: true }, { modelBusy: true }, { quitting: true },
    { installation: { active: 'release', ready: true, busy: true } }, { images: { busy: true } },
    { models: { fault: true, providers: [], selected: null } },
  ]) {
    const f = fixture(); f.render(base(overrides, { selected: null, providers: [provider()] }));
    assert.equal(f.get('model-save').disabled, true, JSON.stringify(overrides));
    assert.equal(f.get('models-import').disabled, true);
    assert.equal(f.get('models-probe').disabled, true);
    assert.equal(f.get('model-add').disabled, true);
    assert.equal(f.get('model-row-add').disabled, true);
    if (overrides.models?.fault) assert.equal(f.get('model-fault').hidden, false);
  }
  const f = fixture();
  f.render(base({}, { selected: null, providers: [provider()], cleanupPending: true }));
  assert.equal(f.get('model-cleanup-pending').hidden, false);
  assert.match(html, /An unused encrypted record could not be removed/);
});

test('metadata drafts survive unrelated status ticks and switching back restores them', async () => {
  const f = fixture(); f.render(base({}, { selected: null, providers: [provider()] }));
  await f.get('model-add').click();
  f.get('model-id').value = 'draft-id';
  await f.get('model-id').fire('input');
  f.get('model-display-name').value = 'Draft Name';
  await f.get('model-display-name').fire('input');
  f.get('model-baseurl').value = 'https://draft.example.test/v1';
  await f.get('model-baseurl').fire('input');
  rowsOf(f)[0]._nameInput.value = 'Draft Model';
  await rowsOf(f)[0]._nameInput.fire('input');
  f.render(base({ detail: 'Unrelated lifecycle tick' }, { selected: null, providers: [provider()] }));
  assert.equal(f.get('model-id').value, 'draft-id');
  assert.equal(f.get('model-display-name').value, 'Draft Name');
  assert.equal(rowsOf(f)[0]._nameInput.value, 'Draft Model');
  // Switching to a saved provider and back restores the draft. The stub
  // showPanel does not republish, so re-render to mirror main's snapshot.
  const editButton = f.get('model-list').children[0].children[1].children[0];
  await editButton.fire();
  f.render(base({}, { selected: null, providers: [provider()] }));
  assert.equal(f.get('model-id').value, 'alpha');
  // Add provider returns to the untouched 'new' draft.
  await f.get('model-add').fire();
  f.render(base({}, { selected: null, providers: [provider()] }));
  assert.equal(f.get('model-id').value, 'draft-id');
  assert.equal(f.get('model-display-name').value, 'Draft Name');
});

test('panel exit, selection switch, auth change, Cancel and fault clear the typed API key', async () => {
  const f = fixture();
  f.render(base({}, { selected: null, providers: [provider()] }));
  f.get('model-value').value = 'typed-not-loggable';
  f.render(base({ panel: 'resources' }, { selected: null, providers: [provider()] }));
  assert.equal(f.get('model-value').value, '');
  f.render(base({}, { selected: null, providers: [provider()] }));
  assert.equal(f.get('model-value').value, '');
  f.get('model-value').value = 'typed-not-loggable';
  f.get('model-auth').value = 'none';
  await f.get('model-auth').fire('change');
  assert.equal(f.get('model-value').value, '');
  f.get('model-auth').value = 'bearer';
  await f.get('model-auth').fire('change');
  f.get('model-value').value = 'typed-not-loggable';
  await f.get('model-cancel').click();
  assert.equal(f.get('model-value').value, '');
  assert.equal(f.get('model-id').value, 'alpha');
  f.get('model-value').value = 'typed-not-loggable';
  f.render(base({ models: { fault: true, providers: [], selected: null } }));
  assert.equal(f.get('model-value').value, '');
});

test('pending saves block duplicates and stale completion never overwrites a newer selection', async () => {
  let finish;
  const f = fixture(); f.render(base({}, { selected: null, providers: [provider()] }));
  f.setSave(() => new Promise(resolve => { finish = resolve; }));
  await f.get('model-form').fire('submit');
  await f.get('model-form').fire('submit');
  await f.get('model-add').fire();
  assert.equal(f.calls.length, 1);
  assert.equal(f.get('model-save').disabled, true);
  assert.equal(f.get('model-add').disabled, true);
  await f.get('model-list').children[0].children[1].children[1].fire();
  assert.equal(f.calls.length, 1);
  finish(null);
  await settle();
  assert.equal(f.get('model-save').disabled, false);
  // A failed save is reported through feedback and never clears the metadata.
  f.setSave(async () => { throw Error('The API key could not be encrypted. Check Keychain availability.'); });
  f.get('model-display-name').value = 'Kept Name';
  await f.get('model-display-name').fire('input');
  await f.get('model-form').fire('submit'); await settle();
  assert.equal(f.get('detail').textContent, 'The API key could not be encrypted. Check Keychain availability.');
  assert.equal(f.get('local-message').hidden, false);
  assert.equal(f.get('model-display-name').value, 'Kept Name');
});

test('Git manual save requires username and token; helper import uses only the repository field', async () => {
  const f = fixture(); f.render(base({ panel: 'secrets' }));
  // Manual save with a missing token fails without dispatching.
  f.get('git-repository').value = 'acme/private';
  f.get('git-username').value = 'octocat';
  await f.get('git-form').fire('submit'); await settle();
  assert.deepEqual(f.calls, []);
  assert.match(f.get('detail').textContent, /Enter a GitHub token/);
  // Import never validates username or token: it uses the repository alone.
  await f.get('git-import').fire(); await settle();
  assert.deepEqual(f.calls, [['git-import', 'acme/private']]);
  assert.equal(f.get('git-value').value, '');
  // Successful helper import clears the repository; manual save re-enters it.
  f.get('git-repository').value = 'acme/private';
  f.get('git-username').value = 'octocat';
  // Manual save dispatches the exact scoped payload and clears the token first.
  f.get('git-value').value = 'token-not-loggable';
  await f.get('git-form').fire('submit');
  assert.equal(f.get('git-value').value, '');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), ['git-save',
    { repository: 'acme/private', username: 'octocat', value: 'token-not-loggable' }]);
  assert.equal(f.get('git-repository').value, '');
  assert.equal(f.get('git-username').value, '');
  // Import with an empty repository is rejected without touching the token path.
  await f.get('git-import').fire(); await settle();
  assert.equal(f.calls.length, 2);
  assert.match(f.get('detail').textContent, /Enter a GitHub owner\/repository/);
});

test('Git rows show credential status, Replace token fills repository only, and remove dispatches', async () => {
  const f = fixture(); f.render(base({ panel: 'secrets' }, {}, {
    repositories: [
      { id: 'repo-1', repository: 'acme/private', baseURL: 'https://github.com/acme/private.git', credentialAvailable: true },
      { id: 'repo-2', repository: 'org/tool', baseURL: 'https://github.com/org/tool.git', credentialAvailable: false },
    ],
  }));
  const rows = [...f.get('git-list').children];
  assert.equal(rows.length, 2);
  const firstDetails = rows[0].children[0], secondDetails = rows[1].children[0];
  assert.equal(firstDetails.children[0].textContent, 'acme/private');
  assert.match(firstDetails.children[2].textContent, /Credential kept on Mac/);
  assert.match(secondDetails.children[2].textContent, /Credential missing/);
  // Replace token fills the repository only; no stored username is restored.
  await rows[0].children[1].children[0].fire();
  assert.equal(f.get('git-repository').value, 'acme/private');
  assert.equal(f.get('git-username').value, '');
  assert.equal(f.get('git-value').value, '');
  await rows[1].children[1].children[1].fire(); await settle();
  assert.deepEqual(f.calls.at(-1), ['git-remove', 'repo-2']);
});

test('Git fault blocks all mutations and cleanup pending is shown', () => {
  const f = fixture(); f.render(base({ panel: 'secrets' }, {}, { fault: true, repositories: [] }));
  assert.equal(f.get('git-fault').hidden, false);
  for (const id of ['git-repository', 'git-username', 'git-value', 'git-save', 'git-import'])
    assert.equal(f.get(id).disabled, true);
  const g = fixture(); g.render(base({ panel: 'secrets' }, {}, { cleanupPending: true }));
  assert.equal(g.get('git-cleanup-pending').hidden, false);
});

test('provider credential status in Secrets labels auth-none and navigates Edit provider to Models', async () => {
  const f = fixture();
  f.render(base({ panel: 'secrets' }, { selected: null, providers: [
    provider(),
    provider({ id: 'open', displayName: 'Open', authMode: 'none', credentialAvailable: false }),
    provider({ id: 'setup', displayName: 'Setup', credentialAvailable: false }),
  ] }));
  const rows = [...f.get('provider-status-list').children];
  assert.equal(rows.length, 3);
  const configured = rows[0].children[0].children[2];
  assert.equal(configured.textContent, 'Configured');
  assert.equal(configured.dataset.state, 'ready');
  assert.equal(rows[1].children[0].children[2].textContent, 'No authentication');
  assert.equal(rows[2].children[0].children[2].textContent, 'Needs setup');
  await rows[2].children[1].children[0].fire();
  assert.deepEqual(f.calls, [['panel', 'models']]);
  // Navigation selects the correct Models editor.
  f.render(base({}, { selected: null, providers: [
    provider({ id: 'open', displayName: 'Open', authMode: 'none' }),
    provider({ id: 'setup', displayName: 'Setup', credentialAvailable: false }),
    provider() ] }));
  assert.equal(f.get('model-id').value, 'setup');
  assert.equal(f.get('model-id').readOnly, true);
});

test('Git lives in Secrets, not Models: shared scope copy, no nested forms, no label-destroys-input, strict CSP', () => {
  assert.match(html, /content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'"/);
  const models = html.slice(html.indexOf('<section id="models-panel"'), html.indexOf('<section id="secrets-panel"'));
  assert(!models.includes('model-authorizations.json'));
  assert(!models.includes('Local models'));
  assert(!models.includes('git-form'));
  assert.match(models, /Import from DSH/);
  const secrets = html.slice(html.indexOf('<section id="secrets-panel"'), html.indexOf('<section id="files-panel"'));
  assert(secrets.includes('<form id="git-form"'));
  const secretForm = secrets.slice(secrets.indexOf('<form id="secret-form"'), secrets.indexOf('</form>') + 7);
  assert(!secretForm.includes('git-form'));
  const gitForm = secrets.slice(secrets.indexOf('<form id="git-form"'), secrets.lastIndexOf('</form>') + 7);
  assert(!/<form/.test(gitForm.slice(13)));
  assert.match(html, /<label for="model-value"><span id="model-value-label">[^<]*<\/span>\s*<input id="model-value"/);
  assert.match(html, /<label for="git-value"><span id="git-value-label">[^<]*<\/span>\s*<input id="git-value"/);
  assert.match(secrets, /shared by every managed environment/);
  assert.match(secrets, /distinct.*GitHub REST API|separate from the GitHub REST API secrets/);
  const renderer = source.slice(source.indexOf('const modelStatuses'), source.indexOf('window.isolated.onStatus'));
  const cleaned = renderer.replaceAll('svg.innerHTML = ICON_PATHS.key', '')
    .replaceAll('svg.innerHTML = ICON_PATHS[icon] ?? ICON_PATHS.check', '');
  assert(!/window\.confirm\(|localStorage|sessionStorage|dataset\.value|innerHTML\s*=\s*[^I]/.test(cleaned));
});
