'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {DESKTOP_IMAGES, desktopImage} = require('./desktop-images.cjs');
const {acquireLocalArtifact} = require('./artifact-download.cjs');
const {privateDirectory} = require('./iron-ca.cjs');

// Optional image bytes live outside versioned runtime releases. Upgrading or
// rolling back a runtime must not delete an image or its independent VM disk.
class DesktopImageStore extends EventEmitter {
  constructor({stateRoot, artifactRoot}) {
    super();
    this.directory = path.join(stateRoot, 'desktop-images');
    this.localArchive = path.join(this.directory, 'wrapvm-local-arm64.tar');
    this.artifactRoot = artifactRoot;
    this.state = {busy:false, phase:'idle', received:0, total:0, error:null};
  }
  archive(id) {
    desktopImage(id);
    return id === 'local-arm64' ? this.localArchive : path.join(this.artifactRoot, 'v1/wrapvm-stock-amd64.tar');
  }
  available(id) {
    const profile = desktopImage(id);
    try {
      const stat = fs.lstatSync(this.archive(id));
      // Presence is not a trust decision: import verifies SHA-256 and the driver
      // independently verifies the archive before creating any new guest.
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === profile.bytes;
    } catch { return false; }
  }
  snapshot(selected) {
    desktopImage(selected);
    return {...this.state, selected, items:DESKTOP_IMAGES.map(({id,name,architecture,browser,provenance,environmentId}) =>
      ({id,name,architecture,browser,provenance,environmentId,available:this.available(id)}))};
  }
  update(patch) { Object.assign(this.state,patch); this.emit('change'); }
  cancel() { this.controller?.abort(); }
  async importLocal(source) {
    if(this.state.busy) throw Error('An image import is already in progress.');
    const profile=desktopImage('local-arm64');
    const controller=new AbortController(); this.controller=controller;
    this.update({busy:true,phase:'verifying',received:0,total:profile.bytes,error:null});
    try {
      privateDirectory(this.directory);
      // Retain a reserve for app state and the user's work; never clean other
      // images, releases or workspaces to make an import fit.
      if(!fs.existsSync(this.localArchive)) {
        const disk=await fs.promises.statfs(this.directory);
        if(disk.bavail*disk.bsize < profile.bytes + 512*1024*1024) throw Error('Insufficient space.');
      }
      await acquireLocalArtifact({source,destination:this.localArchive,sha256:profile.sha256,
        maxBytes:profile.bytes,signal:controller.signal,onProgress:({received,total})=>
          this.update({phase:'copying',received,total})});
      controller.signal.throwIfAborted();
      this.update({phase:'ready',received:profile.bytes});
    } catch {
      this.update({phase:controller.signal.aborted?'idle':'error',error:controller.signal.aborted?null:
        'Image import failed. Choose the pinned ARM64 archive and check free disk space. Existing files are preserved.'});
    } finally {
      if(this.controller===controller)this.controller=undefined;
      this.update({busy:false});
    }
    return this.available('local-arm64');
  }
}
module.exports={DesktopImageStore};
