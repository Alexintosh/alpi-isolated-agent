const {createRendererBoundary, allowedRequest}=require('./renderer-boundary.cjs');

// A dedicated, nonpersistent session. No token in navigation/history or renderer
// bootstrap data; every HTTP request and WebSocket upgrade is scoped separately.
async function createViewerBoundary(target, origin, password) {
  if (typeof password !== 'string' || !/^[a-fA-F0-9]{32,128}$/.test(password)) throw Error('Invalid viewer credential.');
  const boundary=await createRendererBoundary(target);
  let active=true;
  target.webRequest.onBeforeSendHeaders({urls:['<all_urls>']}, (request, done)=>{
    if (!active || !allowedRequest(request.url,origin)) return done({cancel:true});
    const headers={...request.requestHeaders};
    for (const key of Object.keys(headers)) if (key.toLowerCase()==='authorization') delete headers[key];
    headers.Authorization='Bearer '+password;
    done({requestHeaders:headers});
  });
  function revoke(){active=false;password='';boundary.revoke();}
  try{await boundary.setOrigin(origin)}catch(error){revoke();await boundary.close();throw error}
  return {revoke,async close(){revoke();await boundary.close();target.webRequest.onBeforeSendHeaders(null)}};
}
module.exports={createViewerBoundary};
