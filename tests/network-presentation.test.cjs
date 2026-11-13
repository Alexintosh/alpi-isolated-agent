const test=require('node:test'),assert=require('node:assert/strict');
const {pendingGroups}=require('../src/runtime/network-presentation.cjs');
test('groups pending requests without exposing request content or granting inference access',()=>{
 const event={id:'one',environmentId:'wrapvm-v1',scheme:'http',host:'inference.test',port:8888,method:'POST',status:'pending',expiresAt:100,pathname:'/secret',headers:{Authorization:'secret'}};
 const providers=[{id:'model',displayName:'Local model',baseURL:'http://inference.test:8888/v1',credentialRef:'secret'}];
 const policy={events:[event,{...event,id:'two',expiresAt:90},{...event,id:'three',environmentId:'lima-v1'},{...event,id:'four',status:'denied-rule'}]};
 const before=JSON.stringify(policy),groups=pendingGroups(policy,providers);
 assert.equal(groups.length,2);assert.deepEqual(groups[0].ids,['one','two']);assert.equal(groups[0].count,2);assert.equal(groups[0].expiresAt,90);
 assert.deepEqual(groups[0].inference,[{id:'model',name:'Local model'}]);assert(!JSON.stringify(groups).includes('secret'));assert.equal(JSON.stringify(policy),before);
 assert.deepEqual(pendingGroups({events:[{...event,host:'inference.test.evil'}]},providers)[0].inference,[]);
 assert.deepEqual(pendingGroups({events:[{...event,port:80}]},providers)[0].inference,[]);
 assert.deepEqual(pendingGroups({events:[{...event,scheme:'https'}]},providers)[0].inference,[]);
});
