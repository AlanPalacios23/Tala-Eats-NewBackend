import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {IntegrationError} from '../src/events.js';
import {assertFrozenOrderLines,assertStoredM1OrderLines}
 from '../src/stored-order-lines.js';

const id='129a9ba5-5dda-4bdb-82d8-19bac483e7e1';
const another='219a9ba5-5dda-4bdb-82d8-19bac483e7e1';
const stored=[
 {product_id:id,unit_minor:'101',quantity:2},
 {product_id:another,unit_minor:'333',quantity:1}
];
const frozen={lines:[
 {productId:id,unitMinor:'101',quantity:2,name:'Valid A'},
 {productId:another,unitMinor:'333',quantity:1,name:'Valid B'}
]};
const reject=(snapshot:unknown,actual=stored)=>
 assert.throws(()=>assertFrozenOrderLines(snapshot,actual),
  (err:unknown)=>err instanceof IntegrationError&&
   err.code==='M11_ORDER_LINES_MISMATCH');

test('frozen DB order lines match persisted M1 snapshot exactly',()=>{
 assert.equal(assertFrozenOrderLines(frozen,stored),true);
});
test('rejects changed DB price, quantity, product, missing and reordered lines',()=>{
 reject(frozen,[{...stored[0]!,unit_minor:'102'},stored[1]!]);
 reject(frozen,[{...stored[0]!,quantity:3},stored[1]!]);
 reject(frozen,[{...stored[0]!,product_id:another},stored[1]!]);
 reject(frozen,[stored[1]!,stored[0]!]);
 reject(frozen,[stored[0]!]);
 reject({...frozen,lines:[{...frozen.lines[0],quantity:3},frozen.lines[1]]});
 reject({...frozen,lines:[{...frozen.lines[0],unitMinor:'102'},frozen.lines[1]]});
 reject(null);
 reject({lines:[]});
});
test('M11 order-lines database query is read only and order-id scoped',async()=>{
 const calls:Array<{sql:string,params:unknown[]}>= [];
 const pool={query:async(sql:string,params:unknown[])=>{
  calls.push({sql,params});
  return {rows:stored};
 }} as unknown as Pool;
 assert.equal(await assertStoredM1OrderLines(pool,id,frozen),true);
 assert.equal(calls.length,1);
 assert.match(calls[0]!.sql,/SELECT product_id,unit_minor::text,quantity/);
 assert.match(calls[0]!.sql,/WHERE order_id=\$1::uuid ORDER BY line_number/);
 assert.deepEqual(calls[0]!.params,[id]);
});
