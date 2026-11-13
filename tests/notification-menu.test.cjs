const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function fixture() {
  const elements = new Map(), listeners = {}, calls = [], intervals = []; let onChange, now = 100, response, fail, pending, statusOverride;
  const document = { activeElement: null, getElementById: id => elements.get(id), addEventListener: (name, fn) => listeners[name] = fn };
  for (const [, id] of fs.readFileSync(path.join(__dirname, '../src/v1/notification.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    const events = {}, attributes = {};
    elements.set(id, { id, hidden: true, disabled: false, textContent: '', classList: { toggle() {} },
      addEventListener(name, fn) { events[name] = fn; }, setAttribute(name, value) { attributes[name] = value; },
      getAttribute(name) { return attributes[name]; }, focus() { document.activeElement = this; listeners.focusin?.({ target: this }); },
      contains(target) { return target === this || (id.endsWith('-split') && [id.split('-')[0]+'-options', id.split('-')[0]+'-once', id.split('-')[0]+'-always'].includes(target.id)); },
      click() { if (!this.disabled) return this.onclick ? this.onclick() : events.click?.({ target: this }); },
      key(key) { let stopped=false; const event={key,target:this,preventDefault(){},stopPropagation(){stopped=true}}; events.keydown?.(event); if(!stopped)listeners.keydown?.(event); }
    });
  }
  const context = { document, Date: { now: () => now }, setInterval: fn => intervals.push(fn), window: { networkNotice: {
    onChange: fn => onChange = fn, status: () => statusOverride ? statusOverride() : Promise.resolve(response),
    decide: async (key, decision) => { calls.push([key, decision]); if (fail) throw Error(fail); if (pending) await pending; },
    dismiss: async key => { calls.push(['dismiss', key]); }, review: async () => { calls.push(['review']); }
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/v1/notification.js'), 'utf8'), context);
  const group = { key: 'a', ids: ['one'], expiresAt: 1000, host: 'model.test', port: 443, scheme: 'https', method: 'POST', count: 1, environmentId: 'vm', inference: [{name:'Local model'}] };
  return { get: id => elements.get(id), focused:()=>document.activeElement?.id, calls, publish(value = group) { response = value; onChange(value); }, group,
    flush: async () => { for(let i=0;i<8;i++) await Promise.resolve(); }, tick(time) { now = time; intervals.forEach(fn => fn()); },
    event(name, event) { listeners[name]?.({ preventDefault() {}, ...event }); }, fail(value) { fail = value; }, defer(value) { pending=value; }, status(value) { statusOverride=value; } };
}
test('split defaults and menu decisions use the four existing policy strings', async () => {
  for (const [id, kind, decision] of [['notice-allow', null, 'once'], ['notice-deny', null, 'deny'], ['allow-once','allow','once'], ['allow-always','allow','save'], ['deny-once','deny','deny'], ['deny-always','deny','deny-save']]) {
    const f=fixture();f.publish();await f.flush();if(kind)f.get(kind+'-options').click();f.get(id).click();await f.flush();
    assert.deepEqual(f.calls,[['a',decision]]);assert.match(f.get('notice-context').textContent,/Importing a model does not authorize traffic/);
  }
});
test('unchanged publishes preserve a usable menu; replaced batches and stale closures cannot decide', async () => {
  const f=fixture();f.publish();await f.flush();f.get('allow-options').click();const stale=f.get('allow-always').onclick;
  f.publish({...f.group, ids:['one']});assert.equal(f.get('allow-menu').hidden,false);
  f.publish({...f.group, ids:['two']});assert.equal(f.get('allow-menu').hidden,true);stale();assert.deepEqual(f.calls,[]);
  f.get('allow-options').click();const replaced=f.get('allow-always').onclick;f.publish({...f.group,key:'b'});replaced();assert.deepEqual(f.calls,[]);
  f.get('deny-options').click();const dismissed=f.get('deny-always').onclick;f.publish(null);dismissed();assert.deepEqual(f.calls,[]);
});
test('Escape closes menu first, keyboard navigation and outside interactions release focus', async () => {
  const f=fixture();f.publish();await f.flush();f.get('deny-options').key('ArrowDown');assert.equal(f.get('deny-menu').hidden,false);assert.equal(f.focused(),'deny-once');f.get('deny-once').click();await f.flush();assert.deepEqual(f.calls,[['a','deny']]);f.calls.length=0;f.get('deny-options').key('ArrowDown');
  f.event('keydown',{key:'End'});f.event('keydown',{key:'Escape'});assert.equal(f.get('deny-menu').hidden,true);assert.deepEqual(f.calls,[]);
  f.event('keydown',{key:'Escape'});assert.deepEqual(f.calls,[['dismiss','a']]);
  f.get('allow-options').click();f.event('pointerdown',{target:f.get('notice-review')});assert.equal(f.get('allow-menu').hidden,true);
  f.get('allow-options').click();f.get('notice-review').focus();assert.equal(f.get('allow-menu').hidden,true);
});
test('expiry invalidates menu decisions, pending decisions disable controls, failures remain visible across publishes', async () => {
  const f=fixture();f.publish();await f.flush();f.get('allow-options').click();const expired=f.get('allow-always').onclick;f.tick(1000);expired();
  assert.deepEqual(f.calls,[]);assert.equal(f.get('allow-options').disabled,true);assert.equal(f.get('allow-menu').hidden,true);assert.match(f.get('notice-result').textContent,/expired/);
  f.publish({...f.group,expiresAt:2000});let resolve;f.defer(new Promise(r=>resolve=r));f.get('notice-allow').click();
  for(const id of ['notice-allow','notice-deny','allow-options','deny-options','notice-review','notice-close'])assert.equal(f.get(id).disabled,true,id);
  f.get('notice-deny').click();assert.equal(f.calls.length,1);resolve();await f.flush();
  f.defer(null);f.fail('Policy offline');f.get('notice-deny').click();await f.flush();assert.equal(f.get('notice-result').hidden,false);
  f.publish({...f.group,expiresAt:2000});assert.equal(f.get('notice-result').hidden,false);assert.equal(f.get('notice-result').textContent,'Policy offline');
});
test('stale async errors and status results do not replace a newer notification', async () => {
  const f=fixture();f.publish();await f.flush();let reject;f.defer(new Promise((_,r)=>reject=r));f.get('notice-allow').click();
  f.publish({...f.group,key:'b',host:'new.test'});reject(Error('old decision failed'));await f.flush();
  assert.equal(f.get('notice-destination').textContent,'https://new.test:443');assert.equal(f.get('notice-result').hidden,true);
});

test('a late status response cannot overwrite a group published while it was pending', async () => {
  const f=fixture();f.publish();await f.flush();let resolve;f.status(()=>new Promise(r=>resolve=r));
  f.get('notice-deny').click();await f.flush();f.publish({...f.group,key:'new',host:'new.test'});resolve(f.group);await f.flush();
  assert.equal(f.get('notice-destination').textContent,'https://new.test:443');
});
