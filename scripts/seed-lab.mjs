/**
 * One-off isolated merchant + catalog bootstrap.
 * Usage:
 * CORE_V2_RUNTIME=isolated-lab CORE_V2_DATABASE_URL=postgresql://.../tala_core_v2_lab \
 * CORE_V2_LAB_MERCHANT_EMAIL=lab@example.test CORE_V2_LAB_MERCHANT_PASSWORD='...' \
 * node --experimental-strip-types scripts/seed-lab.mjs
 *
 * No LIVE credentials or connection strings are printed.
 */
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {hashPassword} from '../src/modules/modulo-1-pedidos/lab-auth.ts';

const urlText=process.env.CORE_V2_DATABASE_URL;
if(!urlText||process.env.CORE_V2_RUNTIME!=='isolated-lab')
  throw Error('ISOLATED_LAB_REQUIRED');
const url=new URL(urlText);
if(!['127.0.0.1','localhost'].includes(url.hostname)
  ||!['tala_core_v2_test','tala_core_v2_lab'].includes(url.pathname.slice(1)))
  throw Error('ISOLATED_LAB_DATABASE_REQUIRED');
const email=process.env.CORE_V2_LAB_MERCHANT_EMAIL?.toLowerCase().trim();
const password=process.env.CORE_V2_LAB_MERCHANT_PASSWORD;
if(!email||!/^\S+@\S+\.\S+$/.test(email)||!password||password.length<12)
  throw Error('MERCHANT_EMAIL_AND_STRONG_PASSWORD_REQUIRED');
const pool=new Pool({connectionString:urlText,max:1});
const client=await pool.connect();
try{
  const digest=await hashPassword(password);
  await client.query('BEGIN');
  const user=await client.query(`
    INSERT INTO tala_core_v2.accounts (email,display_name,password_hash,role)
    VALUES ($1,'Comercio laboratorio',$2,'merchant')
    RETURNING id`,[email,digest]);
  const userId=user.rows[0].id;
  const storeId=randomUUID();
  await client.query(`
    INSERT INTO tala_core_v2.restaurants(id,name,is_open)
    VALUES ($1::uuid,'Tala Eats Lab',true)`,[storeId]);
  await client.query(`
    INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
    VALUES ($1::uuid,$2::uuid,true)`,[storeId,userId]);
  const products=[
    {name:'Torta de pierna (Lab)',price:8500,stock:20},
    {name:'Tacos surtidos (Lab)',price:12000,stock:15},
    {name:'Agua fresca (Lab)',price:3500,stock:30}
  ];
  for(const p of products){
    await client.query(`
      INSERT INTO tala_core_v2.catalog_products
        (restaurant_id,name,price_minor,stock,is_available)
      VALUES($1::uuid,$2,$3,$4,true)`,[storeId,p.name,p.price,p.stock]);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({seed:'PASS',environment:'isolated-lab',
    merchantEmail:email,restaurantId:storeId,products:products.length}));
}catch(e){await client.query('ROLLBACK');throw e;}
finally{client.release();await pool.end();}
