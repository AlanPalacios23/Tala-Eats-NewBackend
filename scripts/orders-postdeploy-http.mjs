/**
 * Safe, GET-only Orders deployment smoke. Never creates, cancels, pays,
 * confirms or fulfills an order. Logs only non-sensitive release metadata.
 * Usage: CORE_V2_POSTDEPLOY_BASE_URL=https://... node scripts/orders-postdeploy-http.mjs
 * Exit 0 only if commercial readiness has explicitly been approved.
 */
const text=process.env.CORE_V2_POSTDEPLOY_BASE_URL;
if(!text)throw Error('ORDERS_POSTDEPLOY_BASE_URL_REQUIRED');
const url=new URL(text);
if(url.username||url.password||url.search||url.hash||
  !(url.protocol==='https:'||
    (url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))
  throw Error('ORDERS_POSTDEPLOY_URL_NOT_ALLOWED');
const base=url.toString().replace(/\/$/,'');
async function check(path){
  const response=await fetch(base+path,{
    method:'GET',
    redirect:'error',
    signal:AbortSignal.timeout(5000),
    headers:{accept:'application/json'}
  });
  let payload;
  try{payload=await response.json();}catch{payload=null;}
  return {status:response.status,payload};
}
const health=await check('/health');
const readiness=await check('/ready');
const api=await check('/api/v2/health');
const version=typeof health.payload?.version==='string'?health.payload.version:null;
const schemaReady=readiness.status===200&&readiness.payload?.ready===true;
const apiOk=api.status===200&&api.payload?.mode==='isolated-lab';
const commercialReady=health.payload?.commercialReady===true&&
  readiness.payload?.commercialReady===true&&
  api.payload?.commercialReady===true;
const decision=commercialReady&&schemaReady&&apiOk?'GO':'NO_GO';
console.log(JSON.stringify({
  module:'orders',mode:'HTTP_GET_ONLY',version,
  healthHttp:health.status,readyHttp:readiness.status,ordersApiHttp:api.status,
  schemaReady,apiOk,commercialReady,decision
}));
if(decision!=='GO')process.exitCode=2;
