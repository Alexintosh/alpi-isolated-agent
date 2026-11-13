const os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {readJson,writeJson}=require('./atomic-json.cjs');
class ResourceSettings extends EventEmitter {
  constructor({stateRoot,definitions,coordinator,cpus=os.cpus().length,memory=os.totalmem()}) {
    super();this.file=path.join(stateRoot,'resources.json');this.coordinator=coordinator;this.definitions=definitions;
    this.limits={cpus:Math.max(1,cpus),memoryMiB:Math.max(2048,Math.floor(memory*0.75/1024/1024/512)*512),hostMemoryMiB:Math.floor(memory/1024/1024),diskGiB:256,overlayGiB:128};
    try {
      this.data=readJson(this.file,{version:1,environments:{}});
      if(this.data?.version!==1 || !this.data.environments || typeof this.data.environments!=='object' || Array.isArray(this.data.environments))
        throw new Error('Resource settings are invalid.');
      for(const [id,value] of Object.entries(this.data.environments))this.validate(id,value);
    }catch {this.fault=true;}
  }
  validate(id,value) {
    const definition=this.definitions.find(item=>item.id===id);
    if(!definition || !value || Object.keys(value).some(key=>!['cpus','memoryMiB','diskGiB','overlayGiB'].includes(key)) ||
      !Number.isInteger(value.cpus)||value.cpus<1||value.cpus>this.limits.cpus ||
      !Number.isInteger(value.memoryMiB)||value.memoryMiB<2048||value.memoryMiB>this.limits.memoryMiB||value.memoryMiB%512 ||
      (value.diskGiB!==undefined&&(!Number.isInteger(value.diskGiB)||value.diskGiB<20||value.diskGiB>this.limits.diskGiB)) ||
      (value.overlayGiB!==undefined&&(definition.kind!=='smolvm'||!Number.isInteger(value.overlayGiB)||value.overlayGiB<10||value.overlayGiB>this.limits.overlayGiB)))
      throw new Error('Choose CPU and memory values within the displayed limits.');
  }
  forEnvironment(id) {
    if(this.fault)throw new Error('Resource settings are invalid. VM stop remains available.');
    const definition=this.definitions.find(item=>item.id===id);if(!definition)throw new Error('Unknown environment.');
    return {cpus:Math.min(2,this.limits.cpus),memoryMiB:Math.min(4096,this.limits.memoryMiB),diskGiB:20,...(definition.kind==='smolvm'?{overlayGiB:10}:{}),...this.data.environments[id]};
  }
  snapshot() {
    if(this.fault)return {fault:true,limits:{...this.limits},environments:[]};
    return {limits:{...this.limits},environments:this.definitions.map(item=>({id:item.id,...this.forEnvironment(item.id),
      diskChange:item.kind==='smolvm'?'grow-only':'before-create',diskResizable:item.kind==='smolvm'}))};
  }
  async set(id,value) {
    if(this.fault)throw new Error('Resource settings are invalid and were preserved.');
    this.validate(id,value);const selected={...this.forEnvironment(id),...value};
    await this.coordinator.withStopped(id,async(driver,options)=>{
      const current=this.forEnvironment(id),kind=this.definitions.find(item=>item.id===id).kind;
      const observed=await driver.inspect(options);
      if(observed.state!=='missing'&&!observed.owned)throw new Error('Environment ownership could not be verified.');
      if(kind==='lima'&&observed.state!=='missing'&&selected.diskGiB!==observed.resources?.diskGiB)
        throw new Error('Lima disk capacity can only be selected before the environment is created.');
      if(kind==='smolvm'&&(selected.diskGiB<Math.max(current.diskGiB,observed.resources?.diskGiB??20)||selected.overlayGiB<Math.max(current.overlayGiB,observed.resources?.overlayGiB??10)))
        throw new Error('Disk capacity can only increase. Existing workspace data is preserved.');
      const data={version:1,environments:{...this.data.environments,[id]:selected}};
      writeJson(this.file,data);this.data=data;this.emit('change',this.snapshot());
    });
  }
}
module.exports={ResourceSettings};
