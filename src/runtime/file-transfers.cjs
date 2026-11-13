const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const { streamCommand, cleanEnvironment } = require('./driver-common.cjs');
const { TransferJournal } = require('./transfer-journal.cjs');

const MAX_BYTES = 1024 * 1024 * 1024, MAX_ENTRIES = 20000;
const guestHelper = '/home/user/.harness-isolated/file-stream.py';
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const inside = (target, root) => target === root || target.startsWith(root + path.sep);
const hostComparable = value => process.platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value;
const hostInside = (target, root) => inside(hostComparable(target), hostComparable(root));
function guestPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/home/user/workspace') ||
      !inside(value, '/home/user/workspace') || path.posix.normalize(value) !== value || /[\x00-\x1f\x7f\\]/.test(value))
    throw new Error('Choose a path inside the guest workspace.');
  return value;
}
function folderName(value) {
  if (typeof value !== 'string' || ['.', '..', ''].includes(value) || Buffer.byteLength(value) > 255 || /[\x00-\x1f\x7f/\\]/.test(value))
    throw new Error('Invalid folder name.');
  return value;
}
function validSummary(value, type) {
  return value?.type === type && Number.isSafeInteger(value.entries) && value.entries >= 1 && value.entries <= MAX_ENTRIES &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_BYTES;
}
async function smallOutput(channel) {
  const chunks = []; let bytes = 0;
  channel.input.end();
  try {
    for await (const chunk of channel.output) {
      bytes += chunk.length;
      if (bytes > 4096) throw new Error('Invalid file response.');
      chunks.push(chunk);
    }
    await channel.done;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { channel.stop(); await channel.done.catch(() => {}); throw new Error('The selected files could not be verified.'); }
}

class FileTransfers extends EventEmitter {
  constructor({ coordinator, stateRoot, runtimeRoot, home = os.homedir(),
    python = process.platform === 'darwin' ? '/opt/homebrew/bin/python3' : '/usr/bin/python3',
    helper = path.join(__dirname, 'file-stream.py'), protectedPaths = [] }) {
    super(); this.coordinator = coordinator; this.python = python; this.helper = helper; this.home = home;
    this.protectedPaths = [stateRoot, runtimeRoot, path.join(home, '.dsh'), path.join(home, '.ssh'),
      path.join(home, 'Library/Keychains'), path.join(home, 'Library/Application Support/Harness Native VM PoC'),
      path.join(home, 'Library/Application Support/Harness Isolated'),
      ...protectedPaths].filter(Boolean).flatMap(value => {
        const absolute = path.resolve(value);
        try { return [absolute, fs.realpathSync(absolute)]; } catch { return [absolute]; }
      });
    this.plans = new Map(); this.active = undefined; this.status = { state: 'idle' };
    try { this.journal = new TransferJournal(stateRoot); }
    catch { this.journalFault = true; }
  }
  snapshot() { return { ...this.status, fault:Boolean(this.journalFault), interrupted: this.journal?.snapshot().filter(item=>item.id!==this.activeTransferId)??[] }; }
  requireJournal() { if(this.journalFault)throw new Error('Transfer recovery is unavailable. The private journal was preserved; VM controls remain available.'); }
  publish(status) { this.status = { ...this.status, ...status }; this.emit('change', this.snapshot()); }
  hostPath(value, { importing = false } = {}) {
    const canonical = fs.realpathSync(value);
    const info = fs.lstatSync(canonical);
    const roots = this.protectedPaths.flatMap(root => {
      try { return [root, fs.realpathSync(root)]; } catch { return [root]; }
    });
    if (roots.some(root => hostInside(canonical, root) || (importing && info.isDirectory() && hostInside(root, canonical))))
      throw new Error('This path contains private data managed by the host.');
    return canonical;
  }
  local(mode, target, signal, plan) {
    const args = !plan ? [] : mode === 'receive' ? [String(plan.entries), String(plan.bytes), plan.transaction] : [plan.transaction];
    // The bundled interpreter is a verified immutable artifact. -I ignores
    // PYTHONDONTWRITEBYTECODE, so use -B explicitly to prevent cache rewrites.
    return streamCommand(this.python, ['-I', '-B', this.helper, mode, target, ...args],
      { signal, env: cleanEnvironment(this.home) });
  }
  async install(driver, options) { await driver.putFile(this.helper, guestHelper, options); }
  remote(driver, mode, target, options, plan) {
    const args = !plan ? '' : mode === 'receive' ? ` ${plan.entries} ${plan.bytes} ${plan.transaction}` : ` ${plan.transaction}`;
    return driver.fileChannel(`exec /usr/bin/python3 -I ${quote(guestHelper)} ${quote(mode)} ${quote(target)}${args}`, options);
  }
  prepareImport(...args) { return this.preview(signal => this.importPlan(...args, signal)); }
  prepareExport(...args) { return this.preview(signal => this.exportPlan(...args, signal)); }
  async preview(operation) {
    this.requireJournal();
    if (this.active) throw new Error('A transfer is already in progress.');
    const controller = new AbortController(); this.active = controller;
    this.plans.clear(); this.status = { state: 'preparing' }; this.emit('change', this.snapshot());
    try { return await operation(controller.signal); }
    catch { this.publish({ state: controller.signal.aborted ? 'cancelled' : 'error' }); throw new Error('Preview unavailable. Check paths, permissions and file types.'); }
    finally { this.active = undefined; }
  }
  async importPlan(environmentId, source, guestParent, name, signal) {
    source = this.hostPath(source, { importing: true });
    const destination = guestPath(guestPath(guestParent) + '/' + folderName(name));
    const summary = await smallOutput(this.local('scan', source, signal));
    if (!validSummary(summary, 'summary')) throw new Error('The source cannot be transferred.');
    const collision = await this.coordinator.withRunning(environmentId, async (driver, options) => {
      const script = `import os; print('yes' if os.path.lexists(${JSON.stringify(destination)}) else 'no')`;
      const result = await driver.exec(`/usr/bin/python3 -c ${quote(script)}`, options);
      if (!['yes', 'no'].includes(result.trim())) throw new Error('The destination could not be verified.');
      return result.trim() === 'yes';
    }, { signal });
    const info = fs.statSync(source);
    return this.plan({ direction: 'import', environmentId, source, destination, collision, entries: summary.entries,
      bytes: summary.bytes, sourceIdentity: `${info.dev}:${info.ino}` });
  }
  async exportPlan(environmentId, source, hostParent, name, signal) {
    source = guestPath(source); hostParent = this.hostPath(hostParent);
    if (!fs.statSync(hostParent).isDirectory()) throw new Error('Choose a destination folder.');
    const destination = path.join(hostParent, folderName(name));
    if (this.protectedPaths.some(root => hostInside(destination, root))) throw new Error('Reserved destination.');
    const summary = await this.coordinator.withRunning(environmentId, async (driver, options) => {
      await this.install(driver, options);
      return smallOutput(await this.remote(driver, 'scan', source, options));
    }, { signal });
    if (!validSummary(summary, 'summary')) throw new Error('The guest source cannot be transferred.');
    let collision = false;
    try { fs.lstatSync(destination); collision = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.plan({ direction: 'export', environmentId, source, destination, collision, entries: summary.entries, bytes: summary.bytes });
  }
  plan(value) {
    // A plan is a local picker capability; renderer cannot substitute host paths
    // in execute(). Only the most recently previewed operation remains usable.
    this.plans.clear();
    const plan = { ...value, id: randomUUID(), expiresAt: Date.now() + 10 * 60000 };
    this.plans.set(plan.id, plan);
    const { sourceIdentity, ...visible } = plan;
    this.publish({ state: 'preview', ...visible, transferredBytes: 0, transferredEntries: 0 });
    return visible;
  }
  cancel() {
    this.plans.clear(); this.active?.abort();
    if (!this.active) this.publish({ state: 'cancelled' });
  }
  async execute(id) {
    this.requireJournal();
    const prepared = this.plans.get(id); this.plans.clear();
    const plan = prepared && { ...prepared, transaction: randomBytes(32).toString('hex') };
    if (this.active || !plan || plan.collision || plan.expiresAt <= Date.now()) throw new Error('The preview expired or the destination already exists.');
    const controller = new AbortController(); this.active = controller;
    this.activeTransferId = plan.id;
    this.publish({ state: 'running', transferredBytes: 0, transferredEntries: 0, cleanupPending: false });
    try {
      await this.coordinator.withRunning(plan.environmentId, async (driver, options) => {
        if (plan.direction === 'import') {
          this.hostPath(plan.source, { importing: true });
          const info = fs.statSync(plan.source);
          if (`${info.dev}:${info.ino}` !== plan.sourceIdentity) throw new Error('The source changed. Generate a new preview.');
        } else this.hostPath(path.dirname(plan.destination));
        await this.install(driver, options);
        const parent = plan.direction === 'export' ? fs.statSync(this.hostPath(path.dirname(plan.destination))) : undefined;
        this.journal.begin({id:plan.id, environmentId:plan.environmentId, direction:plan.direction,
          destination:plan.destination, transaction:plan.transaction, ownershipToken:options.ownershipToken,
          parentIdentity:parent ? `${parent.dev}:${parent.ino}` : undefined, phase:'receiving', createdAt:Date.now()});
        let sender, receiver, monitor;
        const finishOutput = async mode => {
          const signal = AbortSignal.timeout(5000);
          const channel = plan.direction === 'import' ? await this.remote(driver, mode, plan.destination, { ...options, signal }, plan) :
            this.local(mode, plan.destination, signal, plan);
          const result = await smallOutput(channel);
          if (result.type !== (mode === 'commit' ? 'committed' : 'discarded')) throw new Error('Cleanup could not be confirmed.');
        };
        const expectedLaunch = driver.launch;
        try {
          if (plan.direction === 'import') {
            receiver = await this.remote(driver, 'receive', plan.destination, options, plan);
            sender = this.local('send', plan.source, options.signal);
          } else {
            receiver = this.local('receive', plan.destination, options.signal, plan);
            sender = await this.remote(driver, 'send', plan.source, options);
          }
          sender.input.end();
          let checking = false;
          monitor = setInterval(async () => {
            if (checking) return; checking = true;
            try {
              await driver.requireOwned(options, { protectedLaunch: true });
              if (driver.launch !== expectedLaunch) throw new Error('Launch replaced');
            } catch { controller.abort(); }
            finally { checking = false; }
          }, 2000); monitor.unref();
          const progress = this.progress(receiver.output, plan);
          await Promise.all([pipeline(sender.output, receiver.input, { signal: options.signal }),
            sender.done, receiver.done, progress]);
          // Do not accept completion from a replaced or unprotected launch.
          await driver.requireOwned(options, { protectedLaunch: true });
          if (driver.launch !== expectedLaunch) throw new Error('The launch was replaced.');
          options.signal.throwIfAborted();
          this.journal.committing(plan.id);
          await finishOutput('commit');
          this.journal.remove(plan.id);
        } catch (error) {
          sender?.stop(); receiver?.stop();
          await Promise.allSettled([sender?.done, receiver?.done]);
          if (receiver) {
            try { await finishOutput('discard'); this.journal.remove(plan.id); }
            catch { this.publish({ cleanupPending: true }); }
          }
          throw error;
        } finally { clearInterval(monitor); }
      }, { signal: controller.signal });
      this.publish({ state: 'complete' });
    } catch {
      this.publish({ state: controller.signal.aborted ? 'cancelled' : 'error' });
    } finally { this.active = undefined; this.activeTransferId = undefined; this.emit('change', this.snapshot()); }
    return this.snapshot();
  }
  async recover(id, action) {
    this.requireJournal();
    if (this.active || !['discard','forget'].includes(action)) throw new Error('Transfer recovery is unavailable.');
    const record = this.journal.get(id);
    if (!record) throw new Error('Interrupted transfer not found.');
    // Forgetting only clears host metadata; it never touches the selected files.
    if (action === 'forget') { this.journal.remove(id); this.emit('change',this.snapshot()); return; }
    const controller=new AbortController();this.active=controller;
    try {
      const discard=async channel=>{
        const result=await smallOutput(channel);
        if(result.type!=='discarded')throw new Error('Partial output cleanup was not confirmed.');
      };
      if(record.direction==='export'){
        const parent=this.hostPath(path.dirname(record.destination)),info=fs.statSync(parent);
        if(`${info.dev}:${info.ino}`!==record.parentIdentity || this.hostPath(parent)!==path.dirname(record.destination))
          throw new Error('Export parent changed. Files were preserved.');
        if(this.protectedPaths.some(root=>hostInside(record.destination,root)))throw new Error('Reserved export destination.');
        await discard(this.local('discard',record.destination,AbortSignal.timeout(5000),record));
      }else{
        guestPath(record.destination);
        await this.coordinator.withRunning(record.environmentId,async(driver,options)=>{
          if(options.ownershipToken!==record.ownershipToken)throw new Error('The original guest is unavailable.');
          await this.install(driver,options);
          await discard(await this.remote(driver,'discard',record.destination,options,record));
        },{signal:AbortSignal.timeout(10000)});
      }
      this.journal.remove(id);
    } finally {this.active=undefined;this.emit('change',this.snapshot());}
  }
  async progress(stream, plan) {
    let buffer = '', finished = false, previousBytes = 0, previousEntries = 0, records = 0, lastPublish = 0;
    for await (const chunk of stream) {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > 4096) throw new Error('The transfer response exceeds the size limit.');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (++records > MAX_ENTRIES * 2 + MAX_BYTES / (1024 * 1024) + 1) throw new Error('Too many progress updates.');
        const value = JSON.parse(line);
        if (finished || !['progress', 'complete'].includes(value.type) || !validSummary(value, value.type) ||
            value.bytes < previousBytes || value.entries < previousEntries || value.bytes > plan.bytes || value.entries > plan.entries)
          throw new Error('Invalid transfer response.');
        previousBytes = value.bytes; previousEntries = value.entries;
        if (value.type === 'complete') {
          if (value.bytes !== plan.bytes || value.entries !== plan.entries) throw new Error('The source changed. Its size differs from the preview.');
          finished = true;
        }
        if (finished || Date.now() - lastPublish >= 100) {
          this.publish({ transferredBytes: value.bytes, transferredEntries: value.entries }); lastPublish = Date.now();
        }
      }
      if (buffer.length > 4096) throw new Error('The transfer response exceeds the size limit.');
    }
    if (buffer || !finished) throw new Error('The transfer is incomplete.');
  }
}
module.exports = { FileTransfers, guestPath, folderName };
