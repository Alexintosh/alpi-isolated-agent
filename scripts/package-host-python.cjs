const path=require('node:path');
const spec=require('../src/runtime/python-artifact.cjs');
const {installArchive}=require('../src/runtime/archive-install.cjs');
const root=path.resolve(__dirname,'../vendor/v1');
installArchive({archive:path.join(root,spec.name),destination:path.join(root,'host-python'),spec:{...spec,root:'python'}})
 .then(()=>console.log('Verified private Python runtime is ready.')).catch(e=>{console.error(e.message);process.exitCode=1});
