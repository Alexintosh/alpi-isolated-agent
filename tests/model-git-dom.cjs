// Synthetic Electron acceptance: real markup, renderer, preload and DOM;
// no production main, Keychain, VM, provider or external network access.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-model-git-dom-'));
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.setPath('logs', path.join(temporary, 'logs'));
const timeout = setTimeout(() => { console.error('DOM acceptance timed out'); app.exit(1); }, 30000);
let window;
const model = { id: 'model-a', name: 'Model A', contextWindow: 10000, maxTokens: 1000, input: ['text'] };
const alpha = { id: 'alpha', displayName: 'Alpha', api: 'openai-completions', baseURL: 'https://example.test/v1',
  authMode: 'bearer', credentialAvailable: true, models: [model] };
let state = {
  selectedId: 'synthetic', activeId: null, panel: 'models', label: 'Disconnected', busy: false,
  environmentVerification: 'verified', installation: { ready: true, busy: false },
  networkPolicy: { modes: {}, rules: [], events: [] },
  environments: [{ id: 'synthetic', name: 'Synthetic', kind: 'lima', phase: 'stopped' }],
  models: { providers: [alpha], selected: { provider: 'alpha', model: model.id }, fault: false },
  git: { repositories: [], fault: false }, secrets: { entries: [], fault: false },
};
const calls = [];
let pending, received;
ipcMain.handle('isolated:status', () => state);
ipcMain.handle('isolated:panel', (_event, panel) => { state = { ...state, panel }; return state; });
for (const action of ['model-save', 'git-save', 'git-import']) {
  ipcMain.handle(`isolated:${action}`, (_event, input) => new Promise((resolve, reject) => {
    calls.push({ action, input }); pending = { resolve, reject }; received?.();
  }));
}
const evaluate = source => window.webContents.executeJavaScript(`(() => { ${source} })()`);
const flush = () => window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function publish(next) {
  state = next;
  window.webContents.send('isolated:status', state);
  await flush();
}
function nextCall() { return new Promise(resolve => { received = resolve; }); }

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { preload: path.join(__dirname, '../src/v1/preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') });
  });
  const errors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  window.webContents.on('preload-error', () => errors.push('preload error'));
  await window.loadFile(path.join(__dirname, '../src/v1/control.html'));
  await flush();
  assert.equal(await evaluate('return document.getElementById("model-id").value'), 'alpha');

  // Browser constraint validation must not swallow submit before password clearing.
  assert.equal(await evaluate(`
    document.getElementById('model-add').click();
    document.getElementById('model-value').value = 'synthetic-model-canary';
    document.getElementById('model-form').requestSubmit();
    return document.getElementById('model-value').value;
  `), '');
  await flush(); assert.equal(calls.length, 0);
  assert.equal(await evaluate(`
    const field = document.getElementById('model-value');
    const auth = document.getElementById('model-auth');
    auth.value = 'none'; auth.dispatchEvent(new Event('change'));
    auth.value = 'bearer'; auth.dispatchEvent(new Event('change'));
    return field.isConnected && field === document.getElementById('model-value') && field.type === 'password';
  `), true);

  const modelCall = nextCall();
  const clearedModelValue = await evaluate(`
    for (const [id, value] of Object.entries({ 'model-id': 'new', 'model-display-name': 'New provider',
      'model-baseurl': 'https://example.test/custom', 'model-value': 'synthetic-model-canary' })) {
      const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input'));
    }
    const row = document.getElementById('model-rows').firstElementChild;
    row._idInput.value = 'new-model'; row._nameInput.value = 'New model';
    row._contextInput.value = '10000'; row._tokensInput.value = '1000';
    document.getElementById('model-form').requestSubmit();
    return document.getElementById('model-value').value;
  `);
  await flush();
  assert.deepEqual(errors, []);
  assert.equal(clearedModelValue, '');
  await modelCall;
  await evaluate(`document.getElementById('model-form').requestSubmit();`); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].input.id, 'new');
  const { value, ...saved } = calls[0].input;
  assert.equal(value, 'synthetic-model-canary');
  state = { ...state, models: { ...state.models, providers: [alpha, { ...saved, credentialAvailable: true }] } };
  pending.resolve(state); await flush();
  assert.equal(await evaluate('return document.getElementById("model-id").value'), 'new');
  assert.equal(await evaluate('return document.getElementById("model-add").disabled'), false);
  assert.equal(await evaluate(`document.getElementById('model-add').click(); return document.getElementById('model-id').value;`), '');

  // Editing a maximum-sized provider may remove a row and then add a replacement.
  const large = { ...alpha, id: 'large', models: Array.from({ length: 64 }, (_, index) => ({ ...model, id: `model-${index}` })) };
  await publish({ ...state, models: { ...state.models, providers: [large], selected: { provider: 'large', model: 'model-0' } } });
  await evaluate(`document.querySelector('#model-list .actions button').click();`); await flush();
  assert.equal(await evaluate('return document.getElementById("model-rows").children.length'), 64);
  await evaluate(`document.getElementById('model-rows').firstElementChild._removeButton.click();`);
  await publish({ ...state, detail: 'Synthetic unrelated status tick' });
  assert.equal(await evaluate('return document.getElementById("model-row-add").disabled'), false);

  await publish({ ...state, panel: 'secrets' });
  assert.equal(await evaluate(`return document.getElementById('git-form').closest('#secrets-panel') !== null
    && document.getElementById('git-value').form.id === 'git-form'
    && document.getElementById('git-form').parentElement.closest('form') === null;`), true);
  assert.equal(await evaluate(`
    document.getElementById('git-value').value = 'synthetic-git-canary';
    document.getElementById('git-form').requestSubmit();
    return document.getElementById('git-value').value;
  `), '');
  await flush(); assert.equal(calls.length, 1);
  const gitCall = nextCall();
  assert.equal(await evaluate(`
    document.getElementById('git-repository').value = 'synthetic/private';
    document.getElementById('git-username').value = 'synthetic';
    document.getElementById('git-value').value = 'synthetic-git-canary';
    document.getElementById('git-form').requestSubmit();
    return document.getElementById('git-value').value;
  `), '');
  await gitCall; assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input, { repository: 'synthetic/private', username: 'synthetic', value: 'synthetic-git-canary' });
  pending.reject(new Error('Synthetic save rejection')); await flush();
  assert.equal(await evaluate('return document.getElementById("git-repository").value'), 'synthetic/private');
  assert.equal(await evaluate('return document.getElementById("git-value").value'), '');
  const importCall = nextCall();
  await evaluate(`document.getElementById('git-username').value = ''; document.getElementById('git-import').click();`);
  await importCall; assert.equal(calls[2].input, 'synthetic/private'); pending.resolve(state); await flush();
  await evaluate(`document.getElementById('git-value').value = 'synthetic-git-canary';`);
  await publish({ ...state, panel: 'models' });
  assert.equal(await evaluate('return document.getElementById("git-value").value'), '');
  assert.deepEqual(errors, []);
  console.log('PASS: real DOM forms, password clearing, deferred IPC, provider IDs, 64-row editing, Git import and rejection. Synthetic only.');
}).then(() => finish(0), error => { console.error(error); finish(1); });

function finish(code) {
  clearTimeout(timeout);
  window?.destroy();
  app.quit();
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code;
  if (code) app.exit(code);
}
