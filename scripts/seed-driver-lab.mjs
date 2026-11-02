/** Create ONE approved on-line LAB courier. No public driver registration. */
import {Pool} from 'pg';
import {hashPassword} from '../src/modules/modulo-1-pedidos/lab-auth.ts';

const urlText=process.env.CORE_V2_DATABASE_URL;
if(!urlText||process.env.CORE_V2_RUNTIME!=='isolated-lab')
  throw Error('ISOLATED_LAB_REQUIRED');
const url=new URL(urlText);
if(!['127.0.0.1','localhost'].includes(url.hostname)||
   !['postgres:','postgresql:'].includes(url.protocol)||
   !['tala_core_v2_lab','tala_core_v2_test'].includes(url.pathname.slice(1))||
   url.search||url.hash)
  throw Error('LAB_DATABASE_ONLY');
const email=process.env.CORE_V2_LAB_DRIVER_EMAIL?.toLowerCase().trim();
const password=process.env.CORE_V2_LAB_DRIVER_PASSWORD;
if(!email||!/^\S+@\S+\.\S+$/.test(email)||!password||password.length<12)
  throw Error('LAB_DRIVER_EMAIL_AND_PASSWORD_REQUIRED');
const pool=new Pool({connectionString:urlText,max:1});
const client=await pool.connect();
try{
  const hashed=await hashPassword(password);
  await client.query('BEGIN');
  const driver=await client.query(`
    INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role)
    VALUES($1,'Repartidor de laboratorio',$2,'driver') RETURNING id`,
    [email,hashed]);
  const id=driver.rows[0].id;
  await client.query(`
    INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online)
    VALUES($1::uuid,true,true)`,[id]);
  await client.query('COMMIT');
  console.log(JSON.stringify({seed:'PASS',environment:'isolated-lab',role:'driver',email}));
}catch(error){
  await client.query('ROLLBACK');
  throw error;
}finally{
  client.release();
  await pool.end();
}
