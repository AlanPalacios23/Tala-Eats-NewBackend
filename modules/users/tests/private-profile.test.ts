import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {registerCredentialedPendingUser,loginLabUser,
  requestAuthenticatedDeletion} from '../src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge,
  transitionLabUser} from '../src/store.js';
import {listMyAddresses,saveMyAddress,updateMyAddress,
  setMyDefaultAddress,deleteMyAddress,readMyPreferences,
  updateMyPreferences,exportMyData} from '../src/private-profile.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const authSecret=randomBytes(32),emailSecret=randomBytes(32);
const password='UnaClaveMuyLarga#2026';
const key=()=> 'm4-private-'+randomUUID();
const address={label:'Casa',street:'Calle Principal',exterior:'45',
  neighborhood:'Centro',city:'Tala',state:'Jalisco',postalCode:'45300'};
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof UsersError&&e.code===code);
async function user(db:pg.Pool){
  const email='private.'+randomUUID()+'@example.com';
  const registered=await registerCredentialedPendingUser(db,{
    email,displayName:'Usuario Ejemplo',password,secret:authSecret,
    idempotencyKey:key()
  });
  const id=registered.user.id;
  const proof=await issueLabEmailChallenge(db,{userId:id,secret:emailSecret});
  await verifyLabEmailChallenge(db,{userId:id,actorId:id,
    token:proof.token,secret:emailSecret,expectedVersion:1,idempotencyKey:key()});
  const login=await loginLabUser(db,{email,password,secret:authSecret});
  return {id,sessionToken:login.sessionToken,secret:authSecret};
}
test('M4: customer-only signup, private addresses, preferences, export and deletion',
  {skip:!enabled,timeout:120000},async()=>{
  const db=new pg.Pool({connectionString:url,max:10});
  try{
    const a=await user(db),b=await user(db);
    const roles=await db.query('SELECT role FROM tala_users_v2.account_roles WHERE account_id=$1',
      [a.id]);
    assert.equal(roles.rows[0]?.role,'customer');
    assert.equal((await listMyAddresses(db,a)).addresses.length,0);
    const first=await saveMyAddress(db,{...a,address,idempotencyKey:key()});
    assert.equal(first.address.isDefault,true);
    assert.equal(first.address.version,1);
    const otherKey=key();
    const second=await saveMyAddress(db,{...a,
      address:{...address,label:'Trabajo',exterior:'55'},idempotencyKey:otherKey});
    assert.equal(second.address.isDefault,false);
    const again=await saveMyAddress(db,{...a,
      address:{...address,label:'Trabajo',exterior:'55'},idempotencyKey:otherKey});
    assert.equal(again.replayed,true);
    assert.equal(again.address.id,second.address.id);
    await fail(()=>saveMyAddress(db,{...a,
      address:{...address,label:'Otra'},idempotencyKey:otherKey}),
      'USERS_IDEMPOTENCY_CONFLICT');
    assert.equal((await listMyAddresses(db,a)).addresses.length,2);
    assert.equal((await listMyAddresses(db,b)).addresses.length,0);
    await fail(()=>setMyDefaultAddress(db,{...b,addressId:first.address.id}),
      'USERS_ADDRESS_NOT_FOUND');
    await fail(()=>updateMyAddress(db,{...b,addressId:first.address.id,
      address,expectedVersion:1}),'USERS_ADDRESS_NOT_FOUND');
    assert.equal((await deleteMyAddress(db,{...b,addressId:first.address.id})).deleted,false);
    const updated=await updateMyAddress(db,{...a,addressId:first.address.id,
      address:{...address,street:'Avenida Principal',isDefault:true},
      expectedVersion:1});
    assert.equal(updated.address.version,2);
    await fail(()=>updateMyAddress(db,{...a,addressId:first.address.id,
      address,expectedVersion:1}),'USERS_VERSION_CONFLICT');
    await setMyDefaultAddress(db,{...a,addressId:second.address.id});
    const selected=(await listMyAddresses(db,a)).addresses;
    assert.equal(selected.filter(x=>x.isDefault).length,1);
    assert.equal(selected.find(x=>x.isDefault)?.id,second.address.id);
    assert.deepEqual(await readMyPreferences(db,a),{
      locale:'es-MX',marketingOptIn:false
    });
    await updateMyPreferences(db,{...a,locale:'en-US',marketingOptIn:true});
    const personal=await exportMyData(db,a);
    assert.equal(personal.account.id,a.id);
    assert.equal(personal.preferences.locale,'en-US');
    assert.equal(personal.preferences.marketingOptIn,true);
    assert.equal(personal.role,'customer');
    assert.equal(personal.addresses.length,2);
    assert.equal(JSON.stringify(personal).includes(a.sessionToken),false);
    assert.equal(JSON.stringify(personal).includes(password),false);
    assert.equal((await deleteMyAddress(db,{...a,addressId:second.address.id})).deleted,true);
    assert.equal((await listMyAddresses(db,a)).addresses[0]?.isDefault,true);
    await fail(()=>saveMyAddress(db,{...a,address:{...address,postalCode:'bad'},
      idempotencyKey:key()}),'USERS_ADDRESS_INVALID');
    await fail(()=>updateMyPreferences(db,{...a,locale:'xx',marketingOptIn:false}),
      'USERS_PREFERENCES_INVALID');
    await requestAuthenticatedDeletion(db,{...a,
      expectedVersion:2,idempotencyKey:key()});
    await fail(()=>listMyAddresses(db,a),'USERS_SESSION_INVALID');
    await transitionLabUser(db,{userId:a.id,actorId:randomUUID(),
      expectedVersion:3,action:'finalize_deletion',idempotencyKey:key()});
    for(const table of ['saved_addresses','user_preferences','account_roles']){
      const r=await db.query('SELECT count(*)::int AS n FROM tala_users_v2.'+
        table+' WHERE account_id=$1',[a.id]);
      assert.equal(r.rows[0].n,0,table+' must be removed with tombstone');
    }
    assert.equal((await listMyAddresses(db,b)).addresses.length,0);
  }finally{await db.end();}
});

test('M4: concurrency creates one address and isolates other accounts',
  {skip:!enabled,timeout:120000},async()=>{
  const db=new pg.Pool({connectionString:url,max:14});
  try{
    const auth=await user(db),command=key();
    const requests=await Promise.all(Array.from({length:10},()=>
      saveMyAddress(db,{...auth,address,idempotencyKey:command})
    ));
    assert.equal(requests.filter(x=>!x.replayed).length,1);
    assert.equal(new Set(requests.map(x=>x.address.id)).size,1);
    assert.equal((await listMyAddresses(db,auth)).addresses.length,1);
    assert.equal((await listMyAddresses(db,auth)).addresses[0]?.isDefault,true);
  }finally{await db.end();}
});
