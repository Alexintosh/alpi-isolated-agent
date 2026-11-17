const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/v1/control.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/v1/control.js'), 'utf8');

// Run the shipped Secrets renderer and its real handlers against IDs parsed from
// the shipped HTML. Synthetic state only: no Electron, browser, VM or Keychain.
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
  let status, save = async () => null, remove = async () => null;
  const api = {
    onStatus(handler) { status = handler; }, status: () => new Promise(() => {}),
    async showPanel(panel) { calls.push(['panel', panel]); },
    async saveSecret(input) { calls.push(['save', input]); return save(input); },
    async removeSecret(id) { calls.push(['remove', id]); return remove(id); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: get, createElement: node, createElementNS: node },
    window: { isolated: api }, setInterval() {},
  }, { filename: 'control.js' });
  return { get, calls, render: state => status(state), setSave(fn) { save = fn; }, setRemove(fn) { remove = fn; } };
}
function base(overrides = {}, entries = []) {
  return {
    selectedId: 'lima', activeId: null, panel: 'secrets', label: 'Disconnected', busy: false,
    environmentVerification: 'verified', installation: { active: 'release', ready: true, busy: false },
    networkPolicy: { modes: {}, rules: [], events: [] },
    environments: [
      { id: 'lima', name: 'Lima · Ubuntu', kind: 'lima', phase: 'stopped' },
      { id: 'wrap', name: 'WrapVM', kind: 'smolvm', phase: 'stopped' },
    ],
    secrets: { entries }, ...overrides,
  };
}
const entry = (overrides = {}) => ({
  id: 'cred-1', name: 'GitHub API', environmentId: 'wrap', authType: 'bearer',
  origin: 'https://api.github.com', pathPrefix: '/repos/acme/project/', methods: ['GET', 'POST'],
  headerName: '', username: '', credentialAvailable: true, ...overrides,
});
const settle = () => new Promise(resolve => setImmediate(resolve));

test('missing or faulty secret state disables mutations; empty state invites Add secret', async () => {
  for (const secrets of [undefined, { fault: true }]) {
    const f = fixture(); f.render(base({ secrets }));
    assert.equal(f.get('secrets-fault').hidden, false);
    assert.equal(f.get('secret-save').disabled, true);
    assert.equal(f.get('secret-auth').disabled, true);
    assert.equal(f.get('secret-add').disabled, true);
    assert.equal(f.get('secret-remove').disabled, true);
    await f.get('secret-form').fire('submit'); await f.get('secret-remove').fire();
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.render(base());
  assert.equal(f.get('secrets-fault').hidden, true);
  assert.match(f.get('secret-list').children[0].textContent, /No credentials saved yet\. Add a secret/);
  // With no entries the editor already starts in the Add state, so the button is not duplicated.
  assert.equal(f.get('secret-add').disabled, true);
  assert.equal(f.get('secret-editor-title').textContent, 'New credential');
  assert.equal(f.get('secret-environment').value, 'lima');
  assert.equal(f.get('secret-method-GET').checked, true);
  assert.equal(f.get('secret-method-POST').checked, false);
  // The panel is a real page: the welcome surface yields and the toolbar shows pressed state.
  assert.equal(f.get('welcome').hidden, true);
  assert.equal(f.get('secrets').getAttribute('aria-pressed'), 'true');
  await f.get('secrets-back').click();
  assert.deepEqual(f.calls, [['panel', 'harness']]);
});

test('add dispatches the exact scoped payload and clears the password before awaiting IPC', async () => {
  const f = fixture(); f.render(base({}, [entry()]));
  await f.get('secret-add').click();
  f.get('secret-name').value = 'Registry token';
  await f.get('secret-name').fire('input');
  f.get('secret-origin').value = 'https://registry.example.com';
  await f.get('secret-origin').fire('input');
  f.get('secret-path').value = '/pulls/';
  await f.get('secret-path').fire('input');
  f.get('secret-method-POST').checked = true;
  await f.get('secret-method-POST').fire('change');
  f.get('secret-value').value = 'hunter2-not-loggable';
  await f.get('secret-form').fire('submit');
  // Cleared synchronously before the IPC await, even though the result is still pending.
  assert.equal(f.get('secret-value').value, '');
  assert.equal(f.get('secret-save').disabled, true);
  assert.equal(f.calls.length, 1);
  // The payload crosses the preload boundary: compare through serialization, like IPC would.
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['save', {
    name: 'Registry token', environmentId: 'lima', authType: 'bearer',
    origin: 'https://registry.example.com', pathPrefix: '/pulls/', methods: ['GET', 'POST'],
    headerName: '', username: '', value: 'hunter2-not-loggable',
  }]);
  assert(!('id' in f.calls[0][1]));
  await settle();
  assert.equal(f.get('secret-save').disabled, false);
});

test('saved secrets are never revealed or prefilled; replacement sends a value only when supplied', async () => {
  const f = fixture(); f.render(base({}, [entry()]));
  assert.equal(f.get('secret-name').value, 'GitHub API');
  assert.equal(f.get('secret-value').value, '');
  assert.equal(f.get('secret-value').readOnly, true);
  assert.equal(f.get('secret-value').placeholder, 'Saved value is kept');
  assert.equal(f.get('secret-replace').hidden, false);
  assert.equal(f.get('secret-remove').hidden, false);
  // Keeping the stored secret omits the value field entirely.
  await f.get('secret-form').fire('submit'); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].id, 'cred-1');
  assert(!('value' in f.calls[0][1]));
  assert.equal(f.calls[0][1].methods.join(','), 'GET,POST');
  // Replace unlocks the field; the typed replacement is sent once and then cleared.
  await f.get('secret-replace').click();
  assert.equal(f.get('secret-value').readOnly, false);
  f.get('secret-value').value = 'replacement-not-loggable';
  await f.get('secret-form').fire('submit');
  assert.equal(f.get('secret-value').value, '');
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][1].value, 'replacement-not-loggable');
  // Changing the authentication type without a fresh value fails without submitting.
  f.get('secret-auth').value = 'basic';
  await f.get('secret-auth').fire('change');
  await f.get('secret-form').fire('submit'); await settle();
  assert.equal(f.calls.length, 2);
  assert.match(f.get('detail').textContent, /requires a new secret value/);
});

test('authentication type switches conditional fields, labels and clears the typed secret', async () => {
  const f = fixture(); f.render(base({}, [entry()]));
  assert.equal(f.get('secret-header-row').hidden, true);
  assert.equal(f.get('secret-username-row').hidden, true);
  assert.equal(f.get('secret-value-label').textContent, 'Secret value');
  f.get('secret-auth').value = 'api-key';
  await f.get('secret-auth').fire('change');
  assert.equal(f.get('secret-header-row').hidden, false);
  assert.equal(f.get('secret-username-row').hidden, true);
  assert.match(f.get('secret-preview').children[0].textContent, /^API key header: •+/);
  f.get('secret-header').value = 'x-api-key';
  await f.get('secret-header').fire('input');
  assert.match(f.get('secret-preview').children[0].textContent, /^x-api-key: •+/);
  f.get('secret-auth').value = 'basic';
  await f.get('secret-auth').fire('change');
  assert.equal(f.get('secret-username-row').hidden, false);
  assert.equal(f.get('secret-value-label').textContent, 'Password');
  assert.match(f.get('secret-preview').children[0].textContent, /^Authorization: Basic •+/);
  // The masked preview never contains a typed secret.
  f.get('secret-value').value = 'typed-not-loggable';
  await f.get('secret-auth').fire('change');
  assert.equal(f.get('secret-value').value, '');
  assert(!JSON.stringify(f.get('secret-preview').children.map(item => item.textContent)).includes('typed-not-loggable'));
});

test('environment scope is immutable on saved entries and helpers explain the alternative', () => {
  const f = fixture(); f.render(base({}, [entry()]));
  assert.equal(f.get('secret-environment').disabled, true);
  assert.equal(f.get('secret-environment').value, 'wrap');
  assert.match(f.get('secret-environment-help').textContent, /cannot change\. Add another secret for a different environment/);
  f.render(base({}, [entry({ credentialAvailable: false })]));
  assert.equal(f.get('secret-value').readOnly, false);
  assert.equal(f.get('secret-replace').hidden, true);
  assert.equal(f.get('secret-list').children[0].children[2].textContent, 'Needs setup');
  assert.equal(f.get('secret-list').children[0].children[2].dataset.state, 'missing');
});

test('metadata drafts survive unrelated status ticks and the list is keyed by real metadata', async () => {
  const f = fixture(); f.render(base({}, [entry()]));
  await f.get('secret-add').click();
  f.get('secret-name').value = 'Draft name';
  await f.get('secret-name').fire('input');
  f.get('secret-path').value = '/draft/prefix/';
  await f.get('secret-path').fire('input');
  const row = f.get('secret-list').children[0];
  f.render(base({ detail: 'Unrelated lifecycle tick' }, [entry()]));
  assert.equal(f.get('secret-name').value, 'Draft name');
  assert.equal(f.get('secret-path').value, '/draft/prefix/');
  // Same credential metadata, selection and eligibility: no list rebuild.
  assert.equal(f.get('secret-list').children[0], row);
  // An authoritative entry change does rebuild the list.
  f.render(base({}, [entry({ name: 'Renamed credential' })]));
  assert.notEqual(f.get('secret-list').children[0], row);
});

test('panel exit, credential selection, type change and Cancel clear the typed secret', async () => {
  const f = fixture();
  f.render(base({}, [entry(), entry({ id: 'cred-2', name: 'Anthropic', authType: 'api-key', credentialAvailable: false })]));
  await f.get('secret-list').children[1].click();
  assert.equal(f.get('secret-editor-title').textContent, 'Anthropic');
  f.get('secret-value').value = 'typed-not-loggable';
  f.render(base({ panel: 'resources' }, [entry(), entry({ id: 'cred-2', name: 'Anthropic', authType: 'api-key', credentialAvailable: false })]));
  assert.equal(f.get('secret-value').value, '');
  f.render(base({}, [entry(), entry({ id: 'cred-2', name: 'Anthropic', authType: 'api-key', credentialAvailable: false })]));
  assert.equal(f.get('secret-value').value, '');
  f.get('secret-value').value = 'typed-not-loggable';
  await f.get('secret-list').children[0].click();
  assert.equal(f.get('secret-value').value, '');
  f.get('secret-value').value = 'typed-not-loggable';
  f.get('secret-auth').value = 'bearer';
  await f.get('secret-auth').fire('change');
  assert.equal(f.get('secret-value').value, '');
  f.get('secret-name').value = 'Discarded draft';
  await f.get('secret-name').fire('input');
  f.get('secret-value').value = 'typed-not-loggable';
  await f.get('secret-cancel').click();
  assert.equal(f.get('secret-value').value, '');
  assert.equal(f.get('secret-name').value, 'GitHub API');
});

test('pending submissions block duplicates, selection changes survive stale completion, and failures stay failures', async () => {
  const entries = [entry(), entry({ id: 'cred-2', name: 'Anthropic', authType: 'api-key', credentialAvailable: false })];
  const f = fixture(); f.render(base({}, entries));
  let finish;
  f.setSave(() => new Promise(resolve => { finish = resolve; }));
  await f.get('secret-form').fire('submit');
  await f.get('secret-form').fire('submit');
  await f.get('secret-add').fire();
  assert.equal(f.calls.length, 1);
  assert.equal(f.get('secret-save').disabled, true);
  assert.equal(f.get('secret-add').disabled, true);
  // Selecting another credential while the save is in flight must survive its completion.
  await f.get('secret-list').children[1].click();
  assert.equal(f.get('secret-name').value, 'Anthropic');
  finish(base({}, entries));
  await settle();
  assert.equal(f.get('secret-name').value, 'Anthropic');
  assert.equal(f.get('secret-save').disabled, false);
  // A rejected removal is reported through the shared feedback surface, never as success.
  f.setRemove(async () => { throw Error('Keychain unavailable'); });
  await f.get('secret-remove').click(); await settle();
  assert.equal(f.calls.at(-1)[0], 'remove');
  assert.equal(f.get('detail').textContent, 'Keychain unavailable');
  assert.equal(f.get('local-message').hidden, false);
  assert.equal(f.get('secret-value').value, '');
  assert.equal(f.get('secret-remove').disabled, false);
});

test('unsafe credential display names reach the DOM only as text', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const f = fixture(); f.render(base({}, [entry({ name: hostile })]));
  const identity = f.get('secret-list').children[0].children[1];
  assert.equal(identity.children[0].textContent, hostile);
  assert.equal(identity.children[1].textContent, 'Bearer token · WrapVM');
  assert.equal(f.get('secret-editor-title').textContent, hostile);
  assert(!identity.children.some(child => 'innerHTML' in child));
});

test('secrets markup keeps the reviewed scope copy, accessible controls and strict CSP', () => {
  // syncSecretEditor replaces this node's text; it must not own the input.
  assert.match(html, /<label for="secret-value"><span id="secret-value-label">[^<]*<\/span>\s*<input id="secret-value"/);
  const panel = html.slice(html.indexOf('<section id="secrets-panel"'), html.indexOf('<section id="files-panel"'));
  assert.match(panel, /Keep credentials on your Mac\. Grant scoped access through Iron\./);
  assert.match(panel, /Keychain protected/);
  assert.match(panel, /Encrypt on your Mac/); assert.match(panel, /Choose where it can be used/);
  assert.match(panel, /Iron injects it upstream/); assert.match(panel, /Network approvals still apply\./);
  assert.match(panel, /~\/\.harness-isolated\/secrets\.json/);
  assert.match(panel, /Saving or removing stops this credential's environment and its running jobs/);
  assert.match(panel, /<input id="secret-value" type="password"/);
  assert.match(panel, /<button id="secret-save" type="submit"[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<span>Save and stop environment<\/span>/);
  const button = html.match(/<button id="secrets"[\s\S]*?<\/button>/)[0];
  assert(!button.includes('title='));
  assert.match(button, /aria-label="Secrets"/);
  assert.match(button, /aria-hidden="true">Secrets/);
  assert.match(html, /content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'"/);
  const secrets = source.slice(source.indexOf('const secretMethods'), source.indexOf('window.isolated.onStatus'));
  assert(!/window\.confirm\(|localStorage|sessionStorage|dataset\.value|innerHTML\s*=\s*[^I]/.test(secrets.replace('svg.innerHTML = ICON_PATHS.key', '')));
});
