const path=require('node:path');
const artifact=require('../src/runtime/browser-artifact.cjs');
const {acquireArtifact}=require('../src/runtime/artifact-download.cjs');
acquireArtifact({url:artifact.url,destination:path.resolve(__dirname,'../vendor/v1',artifact.name),
 sha256:artifact.sha256,maxBytes:artifact.bytes}).then(()=>console.log('Verified stock guest browser tool is ready.'))
 .catch(error=>{console.error(error.message);process.exitCode=1});
