/** One-process import smoke of real code taken from all ten source trees.
 * No functions are invoked and absolutely no money/HTTP/DB side effects.
 */
const sources=[
 ['M1','../../../src/modules/orders/order-machine.ts'],
 ['M2','../../../src/modules/logistics/tala-dispatch-engine.ts'],
 ['M3','../../finance/src/ledger.mjs'],
 ['M4','../../users/src/auth.ts'],
 ['M5','../../notifications/src/operations.ts'],
 ['M6','../../restaurants/src/stores.ts'],
 ['M7','../../locations/src/zones.ts'],
 ['M8','../../payments/src/payments.ts'],
 ['M9','../../security/src/gate.ts'],
 ['M10','../../analytics/src/analytics.ts']
] as const;
for(const [name,path] of sources){
 const loaded=await import(path);
 if(Object.keys(loaded).length===0)
  throw new Error('M11_EXPORTS_MISSING:'+name);
 console.log('M11_REAL_SOURCE_IMPORT_PASS',name,
  Object.keys(loaded).length);
}
console.log('M11_TEN_SOURCES_LOAD_IN_ONE_NODE24_RUNTIME');
