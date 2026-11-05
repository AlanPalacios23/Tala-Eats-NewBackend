import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {LocationError,point,distanceMeters,city,slug,integer} from '../src/domain.js';
import {PrivateLocationCipher} from '../src/crypto.js';
const fail=(run:()=>unknown,code:string)=>assert.throws(run,
 (e:unknown)=>e instanceof LocationError&&e.code===code);
test('M7 geographic validation rejects NaN, out-of-range and untrusted fields',()=>{
 assert.deepEqual(point({latitude:20.6543214,longitude:-103.4567894}),
  {latitude:20.654321,longitude:-103.456789});
 for(const invalid of [
  {latitude:Number.NaN,longitude:0},{latitude:91,longitude:0},
  {latitude:0,longitude:-181},{latitude:0,longitude:Infinity},
  {latitude:0,longitude:0,actorId:randomUUID()}])
  fail(()=>point(invalid),'M7_COORDINATES_INVALID');
 fail(()=>city('guadalajara'),'M7_CITY_INVALID');
 fail(()=>slug('Tala Centro'),'M7_SLUG_INVALID');
 fail(()=>integer(2.5,1,20,'INVALID'),'INVALID');
 assert.equal(distanceMeters({latitude:20,longitude:-103},
  {latitude:20,longitude:-103}),0);
 assert.ok(distanceMeters({latitude:20,longitude:-103},
  {latitude:20.01,longitude:-103})>1100);
});
test('M7 AES-256-GCM binds ciphertext to owner and record; no plaintext bytes',()=>{
 const key=randomBytes(32),cipher=new PrivateLocationCipher(key);
 const owner=randomUUID(),id=randomUUID(),foreign=randomUUID();
 const data={point:{latitude:20.7,longitude:-103.4},
  addressLine:'Calle Confidencial 500'};
 const encrypted=cipher.encrypt(owner,id,data);
 assert.ok(!encrypted.ciphertext.toString('utf8').includes('Confidencial'));
 assert.deepEqual(cipher.decrypt(owner,id,encrypted),data);
 fail(()=>cipher.decrypt(foreign,id,encrypted),'M7_DECRYPT_FAILED');
 fail(()=>cipher.decrypt(owner,foreign,encrypted),'M7_DECRYPT_FAILED');
 const modified={...encrypted,ciphertext:Buffer.from(encrypted.ciphertext)};
 modified.ciphertext[0]=modified.ciphertext[0]!^1;
 fail(()=>cipher.decrypt(owner,id,modified),'M7_DECRYPT_FAILED');
 fail(()=>new PrivateLocationCipher(randomBytes(16)),'M7_ENCRYPTION_KEY_INVALID');
});
