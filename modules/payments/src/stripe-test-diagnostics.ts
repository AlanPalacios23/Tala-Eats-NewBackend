/** M8 Stripe TEST read-only operational diagnostics.
 * Aggregate counts only: no customer, card, address or Stripe secrets.
 * Detects local inconsistencies but NEVER confirms bank settlement.
 */
import type {Pool} from 'pg';
import {requireActor,type Actor} from './domain.js';
import {tx} from './db.js';

export async function readStripeTestDiagnostics(pool:Pool,actor:Actor){
 requireActor(actor,'canMonitorPayments');
 return tx(pool,async c=>{
  const intents=await c.query<{
   total:number,unattached:number,leases:number,
   manual_reconciliation:number,awaiting_payment:number
  }>(
   'SELECT count(*)::int AS total,'+
   'count(*) FILTER (WHERE i.stripe_intent_id IS NULL)::int AS unattached,'+
   'count(*) FILTER (WHERE i.lease_until>clock_timestamp())::int AS leases,'+
   "count(*) FILTER (WHERE i.stripe_intent_id IS NULL AND "+
   "i.operation_started_at<=clock_timestamp()-interval '20 hours')::int "+
   'AS manual_reconciliation,'+
   "count(*) FILTER (WHERE p.state='pending' AND "+
   'i.stripe_intent_id IS NOT NULL)::int AS awaiting_payment '+
   'FROM tala_payments_v2.stripe_test_intents i '+
   'JOIN tala_payments_v2.payments p ON p.id=i.payment_id');
  const refunds=await c.query<{
   total:number,unattached:number,manual_reconciliation:number,
   requested:number,failed:number
  }>(
   'SELECT count(*)::int AS total,'+
   'count(*) FILTER (WHERE s.stripe_refund_id IS NULL)::int AS unattached,'+
   'count(*) FILTER (WHERE s.stripe_refund_id IS NULL AND '+
   "s.operation_started_at<=clock_timestamp()-interval '20 hours')::int "+
   'AS manual_reconciliation,'+
   "count(*) FILTER (WHERE r.state='requested')::int AS requested,"+
   "count(*) FILTER (WHERE r.state='failed')::int AS failed "+
   'FROM tala_payments_v2.stripe_test_refunds s '+
   'JOIN tala_payments_v2.refunds r ON r.id=s.refund_id');
  const facts=await c.query<{payment_missing:number,refund_missing:number}>(
   'SELECT '+
   "(SELECT count(*)::int FROM tala_payments_v2.payments p "+
   "WHERE p.provider='stripe_test' AND p.state='succeeded' "+
   'AND NOT EXISTS (SELECT 1 FROM tala_payments_v2.stripe_test_facts f '+
   "WHERE f.payment_id=p.id AND f.fact_type='FundsConfirmed.v1')) "+
   'AS payment_missing,'+
   '(SELECT count(*)::int FROM tala_payments_v2.refunds r '+
   'JOIN tala_payments_v2.payments p ON p.id=r.payment_id '+
   "WHERE p.provider='stripe_test' AND r.state='succeeded' "+
   'AND NOT EXISTS (SELECT 1 FROM tala_payments_v2.stripe_test_facts f '+
   "WHERE f.refund_id=r.id AND f.fact_type='ProviderRefundConfirmed.v1')) "+
   'AS refund_missing');
  const events=await c.query<{total:number,applied:number,noop:number}>(
   'SELECT count(*)::int AS total,'+
   "count(*) FILTER (WHERE outcome='applied')::int AS applied,"+
   "count(*) FILTER (WHERE outcome='noop')::int AS noop "+
   'FROM tala_payments_v2.stripe_test_events');
  return Object.freeze({
   model:'m8_stripe_test_diagnostics_v1' as const,
   environment:'test_only' as const,liveFunds:false as const,
   intents:Object.freeze(intents.rows[0]!),
   refunds:Object.freeze(refunds.rows[0]!),
   events:Object.freeze(events.rows[0]!),
   integrity:Object.freeze(facts.rows[0]!)
  });
 },true);
}
