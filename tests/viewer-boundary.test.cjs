const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createViewerBoundary}=require('../src/runtime/viewer-boundary.cjs');
test('viewer auth applies to exact HTTP/WS origin and is revoked before session cleanup',async()=>{
 const handlers={};const target=Object.assign(new EventEmitter(),{
  webRequest:{onBeforeRequest:(_filter,fn)=>handlers.request=fn,onBeforeSendHeaders:(filter,fn)=>handlers.headers=filter===null?null:fn},
  setPermissionRequestHandler:fn=>handlers.permission=fn,setPermissionCheckHandler:fn=>handlers.checkPermission=fn,
  closeAllConnections:async()=>{},setProxy:async()=>{},
 });
 const origin='http://127.0.0.1:42819',password='ab'.repeat(16);
 const boundary=await createViewerBoundary(target,origin,password);
 const inspect=url=>{let value;handlers.headers({url,requestHeaders:{authorization:'forged',X:'keep'}},result=>value=result);return value};
 for(const url of [origin+'/',origin+'/index.js','ws://127.0.0.1:42819/ws']){
  const result=inspect(url);assert.equal(result.requestHeaders.Authorization,'Bearer '+password);
  assert.equal(result.requestHeaders.authorization,undefined);assert.equal(result.requestHeaders.X,'keep');
 }
 for(const url of ['http://127.0.0.1:42820/','https://example.com/','file:///etc/passwd','http://user@127.0.0.1:42819/'])assert.deepEqual(inspect(url),{cancel:true});
 assert.equal(handlers.checkPermission(),false);let permission;handlers.permission(null,'clipboard-read',value=>permission=value);assert.equal(permission,false);
 boundary.revoke();assert.deepEqual(inspect(origin+'/'),{cancel:true});
 await boundary.close();assert.equal(handlers.headers,null);
});
