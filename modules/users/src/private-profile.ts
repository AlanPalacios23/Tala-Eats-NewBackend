/** M4 only: private account address book, preferences and portability. */
import type {Pool,PoolClient} from 'pg';
import {UsersError,requireUserId,eventFingerprint} from './domain.js';
import {withAuthenticatedIdentity} from './auth.js';

export type AddressInput={
  label:string;street:string;exterior:string;interior?:string|null;
  neighborhood:string;city:string;state:string;postalCode:string;
  isDefault?:boolean;
};
type AddressRow={id:string,label:string,street:string,exterior:string,
  interior:string|null,neighborhood:string,city:string,state:string,
  postal_code:string,is_default:boolean,version:number};
const columns='id,label,street,exterior,interior,neighborhood,city,state,postal_code,is_default,version';
function inputAddress(a:AddressInput){
  if(!a||typeof a!=='object'||Array.isArray(a)||
    Object.keys(a).some(k=>!['label','street','exterior','interior','neighborhood','city',
      'state','postalCode','isDefault'].includes(k)))
    throw new UsersError('USERS_ADDRESS_INVALID');
  const f=(v:unknown,min:number,max:number)=>{
    if(typeof v!=='string')throw new UsersError('USERS_ADDRESS_INVALID');
    const s=v.normalize('NFC').trim().replace(/ +/g,' ');
    if(s.length<min||s.length>max||/[\u0000-\u001f\u007f<>]/.test(s))
      throw new UsersError('USERS_ADDRESS_INVALID');
    return s;
  };
  if(typeof a.postalCode!=='string'||!/^[0-9]{5}$/.test(a.postalCode)||
    (a.isDefault!==undefined&&typeof a.isDefault!=='boolean'))
    throw new UsersError('USERS_ADDRESS_INVALID');
  return {label:f(a.label,2,40),street:f(a.street,4,140),
    exterior:f(a.exterior,1,15),
    interior:a.interior==null?null:f(a.interior,1,20),
    neighborhood:f(a.neighborhood,2,80),city:f(a.city,2,80),
    state:f(a.state,2,80),postalCode:a.postalCode,
    isDefault:a.isDefault===true};
}
const view=(r:AddressRow)=>Object.freeze({id:r.id,label:r.label,
  street:r.street,exterior:r.exterior,interior:r.interior,
  neighborhood:r.neighborhood,city:r.city,state:r.state,
  postalCode:r.postal_code,isDefault:r.is_default,version:r.version});
async function list(c:PoolClient,id:string){
  const r=await c.query<AddressRow>('SELECT '+columns+
    ' FROM tala_users_v2.saved_addresses WHERE account_id=$1::uuid'+
    ' ORDER BY is_default DESC,created_at,id',[id]);
  return Object.freeze(r.rows.map(view));
}
type Session={sessionToken:string,secret:Buffer};
export async function listMyAddresses(pool:Pool,auth:Session){
  return withAuthenticatedIdentity(pool,auth,async(c,id)=>
    Object.freeze({addresses:await list(c,id)}),true);
}
export async function saveMyAddress(pool:Pool,
  args:Session&{address:AddressInput,idempotencyKey:string}){
  const a=inputAddress(args.address);
  const key=eventFingerprint(args.idempotencyKey,'create_address');
  return withAuthenticatedIdentity(pool,args,async(c,id)=>{
    const old=await c.query<AddressRow>('SELECT '+columns+
      ' FROM tala_users_v2.saved_addresses WHERE account_id=$1::uuid'+
      ' AND creation_event_key=$2',[id,key]);
    if(old.rows[0])return Object.freeze({address:view(old.rows[0]),replayed:true});
    const count=await c.query<{count:number}>(
      'SELECT count(*)::int AS count FROM tala_users_v2.saved_addresses WHERE account_id=$1::uuid',[id]);
    const n=count.rows[0]?.count??0;
    if(n>=10)throw new UsersError('USERS_ADDRESS_LIMIT');
    const makeDefault=a.isDefault||n===0;
    if(makeDefault)await c.query(
      'UPDATE tala_users_v2.saved_addresses SET is_default=false WHERE account_id=$1::uuid AND is_default',
      [id]);
    const r=await c.query<AddressRow>('INSERT INTO tala_users_v2.saved_addresses'+
      '(account_id,label,street,exterior,interior,neighborhood,city,state,'+
      'postal_code,is_default,creation_event_key)'+
      ' VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING '+columns,
      [id,a.label,a.street,a.exterior,a.interior,a.neighborhood,a.city,a.state,
       a.postalCode,makeDefault,key]);
    return Object.freeze({address:view(r.rows[0]!),replayed:false});
  });
}
export async function updateMyAddress(pool:Pool,args:Session&{
  addressId:string,address:AddressInput,expectedVersion:number
}){
  const target=requireUserId(args.addressId),a=inputAddress(args.address);
  if(!Number.isSafeInteger(args.expectedVersion)||args.expectedVersion<1)
    throw new UsersError('USERS_VERSION_INVALID');
  return withAuthenticatedIdentity(pool,args,async(c,id)=>{
    const existing=await c.query<{version:number,is_default:boolean}>(
      'SELECT version,is_default FROM tala_users_v2.saved_addresses'+
      ' WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE',[id,target]);
    if(!existing.rows[0])throw new UsersError('USERS_ADDRESS_NOT_FOUND');
    if(existing.rows[0].version!==args.expectedVersion)
      throw new UsersError('USERS_VERSION_CONFLICT');
    const makeDefault=a.isDefault||existing.rows[0].is_default;
    if(makeDefault)await c.query('UPDATE tala_users_v2.saved_addresses'+
      ' SET is_default=false WHERE account_id=$1::uuid AND id<>$2::uuid AND is_default',
      [id,target]);
    const r=await c.query<AddressRow>(
      'UPDATE tala_users_v2.saved_addresses SET label=$3,street=$4,'+
      'exterior=$5,interior=$6,neighborhood=$7,city=$8,state=$9,'+
      'postal_code=$10,is_default=$11,version=version+1,'+
      'updated_at=clock_timestamp() WHERE account_id=$1::uuid'+
      ' AND id=$2::uuid RETURNING '+columns,
      [id,target,a.label,a.street,a.exterior,a.interior,a.neighborhood,
        a.city,a.state,a.postalCode,makeDefault]);
    return Object.freeze({address:view(r.rows[0]!)});
  });
}
export async function setMyDefaultAddress(pool:Pool,args:Session&{addressId:string}){
  const target=requireUserId(args.addressId);
  return withAuthenticatedIdentity(pool,args,async(c,id)=>{
    const r=await c.query<{is_default:boolean}>(
      'SELECT is_default FROM tala_users_v2.saved_addresses'+
      ' WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE',[id,target]);
    if(!r.rows[0])throw new UsersError('USERS_ADDRESS_NOT_FOUND');
    if(!r.rows[0].is_default){
      await c.query('UPDATE tala_users_v2.saved_addresses SET is_default=false'+
        ' WHERE account_id=$1::uuid AND is_default',[id]);
      await c.query('UPDATE tala_users_v2.saved_addresses'+
        ' SET is_default=true,version=version+1 WHERE account_id=$1::uuid'+
        ' AND id=$2::uuid',[id,target]);
    }
    return Object.freeze({defaultAddressId:target});
  });
}
export async function deleteMyAddress(pool:Pool,args:Session&{addressId:string}){
  const target=requireUserId(args.addressId);
  return withAuthenticatedIdentity(pool,args,async(c,id)=>{
    const r=await c.query<{is_default:boolean}>(
      'DELETE FROM tala_users_v2.saved_addresses WHERE account_id=$1::uuid'+
      ' AND id=$2::uuid RETURNING is_default',[id,target]);
    if(r.rows[0]?.is_default)await c.query(
      'UPDATE tala_users_v2.saved_addresses SET is_default=true,'+
      ' version=version+1 WHERE id=(SELECT id FROM tala_users_v2.saved_addresses'+
      ' WHERE account_id=$1::uuid ORDER BY created_at,id LIMIT 1)',[id]);
    return Object.freeze({deleted:r.rowCount===1});
  });
}
export async function readMyPreferences(pool:Pool,auth:Session){
  return withAuthenticatedIdentity(pool,auth,async(c,id)=>{
    const r=await c.query<{locale:string,marketing_opt_in:boolean}>(
      'SELECT locale,marketing_opt_in FROM tala_users_v2.user_preferences'+
      ' WHERE account_id=$1::uuid',[id]);
    return Object.freeze({locale:r.rows[0]?.locale??'es-MX',
      marketingOptIn:r.rows[0]?.marketing_opt_in??false});
  },true);
}
export async function updateMyPreferences(pool:Pool,args:Session&{
  locale:string,marketingOptIn:boolean
}){
  if(!['es-MX','en-US'].includes(args.locale)||
     typeof args.marketingOptIn!=='boolean')
    throw new UsersError('USERS_PREFERENCES_INVALID');
  return withAuthenticatedIdentity(pool,args,async(c,id)=>{
    const r=await c.query<{locale:string,marketing_opt_in:boolean}>(
      'INSERT INTO tala_users_v2.user_preferences(account_id,locale,marketing_opt_in)'+
      ' VALUES($1::uuid,$2,$3) ON CONFLICT(account_id) DO UPDATE SET'+
      ' locale=EXCLUDED.locale,marketing_opt_in=EXCLUDED.marketing_opt_in,'+
      ' updated_at=clock_timestamp() RETURNING locale,marketing_opt_in',
      [id,args.locale,args.marketingOptIn]);
    return Object.freeze({locale:r.rows[0]!.locale,
      marketingOptIn:r.rows[0]!.marketing_opt_in});
  });
}
export async function exportMyData(pool:Pool,auth:Session){
  return withAuthenticatedIdentity(pool,auth,async(c,id)=>{
    const acc=await c.query<{id:string,email_normalized:string,
      display_name:string,status:string,created_at:Date}>(
      'SELECT id,email_normalized,display_name,status,created_at'+
      ' FROM tala_users_v2.accounts WHERE id=$1::uuid',[id]);
    const role=await c.query<{role:string}>(
      'SELECT role FROM tala_users_v2.account_roles WHERE account_id=$1::uuid',[id]);
    const prefs=await c.query<{locale:string,marketing_opt_in:boolean}>(
      'SELECT locale,marketing_opt_in FROM tala_users_v2.user_preferences WHERE account_id=$1::uuid',[id]);
    return Object.freeze({account:Object.freeze({
      id:acc.rows[0]!.id,email:acc.rows[0]!.email_normalized,
      displayName:acc.rows[0]!.display_name,status:acc.rows[0]!.status,
      createdAt:acc.rows[0]!.created_at.toISOString()}),
      role:role.rows[0]?.role??'customer',
      preferences:Object.freeze({locale:prefs.rows[0]?.locale??'es-MX',
        marketingOptIn:prefs.rows[0]?.marketing_opt_in??false}),
      addresses:await list(c,id)});
  },true);
}
