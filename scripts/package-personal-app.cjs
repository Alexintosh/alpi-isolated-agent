// Build-time only. Produces a standalone client app; no global install,
// VM start, runtime payload or notarization.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Alpi packaging currently requires macOS Apple Silicon.');
const metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const releaseVersion=metadata.version;
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(releaseVersion))throw Error('Invalid release version.');
const bundleVersion=releaseVersion.split('-')[0];
const args=process.argv.slice(2);
if(args.length>1||(args.length&&!args[0].startsWith('--output=')))throw Error('Use --output=/absolute/path/Alpi.app');
const output=args.length?args[0].slice('--output='.length):path.join(root,'dist/Alpi.app');
if(!path.isAbsolute(output)||!output.endsWith('.app')||fs.existsSync(output))throw Error('Choose a new absolute .app destination; existing applications are never replaced.');
const source=path.join(root,'node_modules/electron/dist/Electron.app');
const extraSources=execFileSync('/Library/Developer/CommandLineTools/usr/bin/git',['ls-files','--others','--','src','guest/v1'],{cwd:root,encoding:'utf8'}).trim();
if(extraSources)throw Error('Untracked application sources must be reviewed before packaging.');
const configHome=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-package-'));
const env={PATH:process.env.PATH,HOME:configHome,NPM_CONFIG_USERCONFIG:path.join(configHome,'user'),NPM_CONFIG_GLOBALCONFIG:path.join(configHome,'global'),NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'};
fs.writeFileSync(env.NPM_CONFIG_USERCONFIG,'');fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG,'');
let dependencies;
try{dependencies=execFileSync('npm',['ls','--omit=dev','--all','--parseable'],{cwd:root,env,encoding:'utf8'}).trim().split('\n').filter(p=>p!==root);}
finally{fs.rmSync(configHome,{recursive:true,force:true});}
const packages=new Set();
for(const directory of dependencies){
 const relative=path.relative(path.join(root,'node_modules'),directory);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Runtime dependency is outside the pinned installation.');
 const parts=relative.split(path.sep);packages.add(parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0]);
}
fs.mkdirSync(path.dirname(output),{recursive:true});
const staging=path.join(path.dirname(output),'.app-build-'+crypto.randomBytes(12).toString('hex')+'.app');
try{
 fs.cpSync(source,staging,{recursive:true,dereference:false,verbatimSymlinks:true});
 fs.renameSync(path.join(staging,'Contents/MacOS/Electron'),path.join(staging,'Contents/MacOS/Alpi'));
 const resources=path.join(staging,'Contents/Resources'),application=path.join(resources,'app');
 fs.copyFileSync(path.join(root,'assets/Alpi.icns'),path.join(resources,'Alpi.icns'));
 fs.mkdirSync(application);fs.rmSync(path.join(resources,'default_app.asar'),{force:true});
 for(const directory of ['src','guest/v1'])fs.cpSync(path.join(root,directory),path.join(application,directory),{recursive:true,dereference:false,verbatimSymlinks:true});
 fs.copyFileSync(path.join(root,'guest/package-lock.json'),path.join(application,'guest/package-lock.json'));
 fs.writeFileSync(path.join(application,'package.json'),JSON.stringify({name:'alpi-isolated-agent',productName:'Alpi',version:releaseVersion,license:'MIT',private:true,main:'src/launch.cjs',dependencies:metadata.dependencies},null,2)+'\n');
 for(const name of packages)fs.cpSync(path.join(root,'node_modules',name),path.join(application,'node_modules',name),{recursive:true,dereference:false,verbatimSymlinks:true});
 const licenseRoot=path.join(resources,'licenses');fs.mkdirSync(licenseRoot);
 for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md'])fs.copyFileSync(path.join(root,name),path.join(licenseRoot,name));
 fs.cpSync(path.join(root,'licenses'),path.join(licenseRoot,'upstream'),{recursive:true});
 fs.copyFileSync(path.join(root,'node_modules/electron/dist/LICENSE'),path.join(licenseRoot,'ELECTRON-LICENSE'));
 fs.copyFileSync(path.join(root,'node_modules/electron/dist/LICENSES.chromium.html'),path.join(licenseRoot,'LICENSES.chromium.html'));
 const plist=path.join(staging,'Contents/Info.plist');
 for(const [key,value] of Object.entries({CFBundleIdentifier:'com.alexintosh.harness-isolated',CFBundleIconFile:'Alpi.icns',CFBundleExecutable:'Alpi',CFBundleName:'Alpi',CFBundleDisplayName:'Alpi',CFBundleShortVersionString:bundleVersion,CFBundleVersion:'1'}))
  execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
 const commit=execFileSync('/Library/Developer/CommandLineTools/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const dirty=Boolean(execFileSync('/Library/Developer/CommandLineTools/usr/bin/git',['status','--porcelain','--','src','guest','package.json','package-lock.json'],{cwd:root,encoding:'utf8'}).trim());
 fs.writeFileSync(path.join(application,'build.json'),JSON.stringify({commit,sourceDirty:dirty,builtAt:new Date().toISOString(),electron:metadata.devDependencies.electron,artifactRelease:require('../src/runtime/artifact-manifest.cjs').id,distribution:'Alpi developer preview; ad-hoc signed, not notarized. Third-party VM runtime payload excluded.'},null,2)+'\n');
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements,flags,runtime',staging],{stdio:'pipe'});
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',staging],{stdio:'pipe'});
 fs.renameSync(staging,output);console.log(output);
}finally{fs.rmSync(staging,{recursive:true,force:true});}
