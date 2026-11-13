// Generate exact installed production dependency notices; never synthesize copyright lines.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),lock=require('../package-lock.json');
const sections=['Alpi production npm dependency notices\nGenerated from package-lock.json and installed package notices.\nThird-party code retains its own license.\n'];
for(const [relative,item] of Object.entries(lock.packages).sort(([a],[b])=>a<b?-1:a>b?1:0)){
 if(!relative||item.dev)continue;
 if(!relative.startsWith('node_modules/')||relative.includes('..'))throw Error('Unexpected package path.');
 const dir=path.join(root,relative),pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
 if(pkg.version!==item.version)throw Error('Installed package differs from lockfile.');
 const names=fs.readdirSync(dir).filter(name=>/^(license|licence|copying|notice)([.\-_]|$)/i.test(name));
 if(!names.length)throw Error(`Missing license text for ${pkg.name}`);
 sections.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${item.license??pkg.license}\nRegistry: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`);
 for(const name of names.sort()){
  const file=path.join(dir,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size>1024*1024)throw Error('Unexpected notice file.');
  sections.push(`\n--- ${name} ---\n${fs.readFileSync(file,'utf8')}\n`);
 }
}
fs.mkdirSync(path.join(root,'licenses'),{recursive:true});
fs.writeFileSync(path.join(root,'licenses/production-notices.txt'),sections.join('\n').replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,'').trimEnd()+'\n');
console.log('Production notices collected from the locked installation.');
