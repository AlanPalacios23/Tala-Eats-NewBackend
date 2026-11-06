/** M11 financial evidence: replay the frozen M1 order-line table against
 * the independent JSON price snapshot before a held journal or TEST payment
 * state transition. Both tables belong to M1; never accept caller line items.
 */
import type {Pool} from 'pg';
import {IntegrationError,validUuid} from './events.js';

type DbLine={product_id:string,unit_minor:string,quantity:number};
const reject=():never=>{throw new IntegrationError('M11_ORDER_LINES_MISMATCH');};

/** Pure comparator also used by negative regression tests. Order is preserved
 * because M1 writes line_number and the snapshot atomically in one transaction.
 */
export function assertFrozenOrderLines(snapshot:unknown,stored:readonly DbLine[]){
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))
  return reject();
 const lines=(snapshot as Record<string,unknown>).lines;
 if(!Array.isArray(lines))return reject();
 if(lines.length<1||lines.length>100||
    lines.length!==stored.length)return reject();
 for(let i=0;i<lines.length;i++){
  const raw=lines[i];
  const db=stored[i];
  if(!db||!raw||typeof raw!=='object'||Array.isArray(raw))
   return reject();
  const line=raw as Record<string,unknown>;
  if(typeof line.productId!=='string')return reject();
  if(typeof line.unitMinor!=='string')return reject();
  if(typeof line.quantity!=='number')return reject();
  if(typeof db.product_id!=='string'||typeof db.unit_minor!=='string'||
     typeof db.quantity!=='number'||
     line.productId.toLowerCase()!==db.product_id.toLowerCase()||
     line.unitMinor!==db.unit_minor||
     line.quantity!==db.quantity)return reject();
 }
 return true as const;
}

export async function assertStoredM1OrderLines(
 pool:Pool,orderId:string,snapshot:unknown
){
 const id=validUuid(orderId);
 const {rows}=await pool.query<DbLine>(
  'SELECT product_id,unit_minor::text,quantity FROM '+
  'tala_core_v2.order_lines WHERE order_id=$1::uuid ORDER BY line_number',
  [id]);
 return assertFrozenOrderLines(snapshot,rows);
}
