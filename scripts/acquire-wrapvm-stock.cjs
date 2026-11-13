// Download stock OCI bytes on the host. No Docker, extraction or guest execution.
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { acquireArtifact } = require('../src/runtime/artifact-download.cjs');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const digest = 'sha256:30491fa51a779ffe3c0cc85fe6cb80319b86c64b1e0e7122e4fc8fe4fff175ea';
const configDigest = 'sha256:5b706299bf352dc84bcbfe4a96c249c02632197082a9a3c19d9a2dff7c51fc54';
const mediaType = 'application/vnd.oci.image.manifest.v1+json';
const directory = path.join(root, 'vendor/v1/wrapvm-stock-oci');
const controller = new AbortController();
for (const event of ['SIGINT','SIGTERM']) process.once(event, () => controller.abort());
async function sha(file) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function main() {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const auth = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository%3Atobi%2Fwrapvm%3Apull',
    {signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
  if (!auth.ok) throw Error('Anonymous registry authorization unavailable');
  const token = (await auth.json()).token;
  if (typeof token !== 'string') throw Error('Anonymous registry token unavailable');
  const registryFetch = (url, options) => fetch(url, {...options,
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10*60000)]),
    headers:new URL(url).origin === 'https://ghcr.io' ? {Authorization:'Bearer '+token,Accept:mediaType} : {}});
  const blobPath = value => {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw Error('Unexpected image digest');
    return path.join(directory,'blobs/sha256',value.slice(7));
  };
  const get = (value, size, manifest=false) => acquireArtifact({
    url:`https://ghcr.io/v2/tobi/wrapvm/${manifest?'manifests':'blobs'}/${value}`,
    destination:blobPath(value), sha256:value.slice(7), maxBytes:size, signal:controller.signal, fetch:registryFetch,
  });
  const manifestFile = await get(digest, 1024*1024, true);
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (manifest.mediaType !== mediaType || manifest.config.digest !== configDigest || !Array.isArray(manifest.layers) || manifest.layers.length > 100) throw Error('Unexpected stock manifest');
  const descriptors = [manifest.config,...manifest.layers];
  let total=0;
  for (const descriptor of descriptors) {
    blobPath(descriptor.digest);
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw Error('Invalid blob size');
    total += descriptor.size;
  }
  if (total > 3*1024**3) throw Error('Image exceeds the pinned acquisition budget');
  let completed=0,bytes=0;
  for (const descriptor of descriptors) {
    const file = await get(descriptor.digest,descriptor.size);
    if (fs.statSync(file).size !== descriptor.size) throw Error('Blob size mismatch');
    completed++; bytes+=descriptor.size;
    console.log(JSON.stringify({phase:'verified-blobs',completed,count:descriptors.length,bytes,total}));
  }
  const config=JSON.parse(fs.readFileSync(blobPath(configDigest)));
  if(config.architecture!=='amd64'||config.os!=='linux')throw Error('Unexpected image architecture');
  fs.writeFileSync(path.join(directory,'oci-layout'),JSON.stringify({imageLayoutVersion:'1.0.0'})+'\n',{mode:0o600});
  fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify({schemaVersion:2,manifests:[{
    mediaType,digest,size:fs.statSync(manifestFile).size,platform:{architecture:'amd64',os:'linux'},
    annotations:{'org.opencontainers.image.ref.name':'desktop-pinned'}
  }]})+'\n',{mode:0o600});
  const archive=path.join(root,'vendor/v1/wrapvm-stock-amd64.tar');
  const reportFile=path.join(root,'evidence/v1/wrapvm-stock-acquisition.json');
  if (fs.existsSync(archive)) {
    const previous=JSON.parse(fs.readFileSync(reportFile));
    if (previous.image!=='ghcr.io/tobi/wrapvm@'+digest || previous.archiveSha256!==await sha(archive))
      throw Error('Existing stock archive differs; retained without replacement');
    console.log(JSON.stringify({...previous,reused:true})); return;
  }
  const partial=archive+'.partial';
  try {
    // Explicit members only; no registry-provided filenames or archive extraction.
    const members=['oci-layout','index.json',path.relative(directory,manifestFile),...descriptors.map(d=>path.relative(directory,blobPath(d.digest)))];
    await run('/usr/bin/tar',['--no-xattrs','--no-acls','--no-fflags','--no-mac-metadata','-cf',partial,'-C',directory,...new Set(members)],
      {signal:controller.signal,timeout:600000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',COPYFILE_DISABLE:'1'}});
    if (fs.existsSync(archive)) {
      if(await sha(archive)!==await sha(partial))throw Error('Existing stock archive differs; retained without replacement');
    } else fs.renameSync(partial,archive);
    const report={date:new Date().toISOString(),image:'ghcr.io/tobi/wrapvm@'+digest,platform:'linux/amd64',
      configDigest,sourceRevision:config.config?.Labels?.['org.opencontainers.image.revision'],
      blobCount:descriptors.length,blobBytes:total,archiveSha256:await sha(archive),archiveBytes:fs.statSync(archive).size,
      stockBytesVerified:true,guestExecuted:false,dockerUsed:false,
      limitations:['Registry image identity verified by pinned SHA-256, not independently reproduced from source',
        'Rosetta compatibility, browser and protected runtime require a separate live test']};
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally {fs.rmSync(partial,{force:true});}
}
main().catch(error=>{console.error(controller.signal.aborted?'Stock image acquisition cancelled':error.message);process.exitCode=1;});
