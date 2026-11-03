# Módulo 3 Finanzas — LAB1.2: conciliación y controles de concurrencia

**Estado:** PR #5 Draft, rama `feat/core-v2-finanzas-foundation`, independiente de
M1 y M2, base PostgreSQL de prueba `tala_finance_v2_test`.
**NO-GO comercial**. Sin webhooks de la cuenta Stripe, sin LIVE y sin pagos.

## Motor nuevo: conciliación interna solo lectura

`src/reconciliation.mjs` expone internamente
`reconcileTestFinances(pool,{limit,orderIds})`; no se publica por HTTP,
no mueve dinero, no crea asientos, no declara un pago conciliado con Stripe.

Clasificación de cada contrato verificado:

- `awaiting_payment`: existe contrato, pero todavía no hay asiento ni recibo;
  **no es un fallo**, ni significa que Stripe haya cobrado.
- `captured_held`: hay asiento y recibo correspondientes, importes de débitos,
  créditos, restaurante, repartidor retenido y plataforma pendientes coinciden;
  **no autoriza payout**.
- `needs_review`: falta comprobante, importes o particiones no coinciden,
  el hash/aritmética del contrato es inválido, o hay asiento sin contrato.

Las anomalías incluyen `JOURNAL_WITHOUT_RECEIPT`,
`CAPTURE_AMOUNT_MISMATCH`, `CREDIT_AMOUNT_MISMATCH`,
`MERCHANT_ALLOCATION_MISMATCH`, `DRIVER_ALLOCATION_MISMATCH`,
`PLATFORM_ALLOCATION_MISMATCH`, `EVENT_MISMATCH`,
`INTENT_CONTRACT_INVALID` y registros huérfanos.
El cálculo compara importes en centavos, sin redondeo flotante, y utiliza
los datos almacenados de una única consulta transaccional de lectura.

`limit` acepta 1..100. `orderIds` permite auditar únicamente una lista
de identificadores UUID confiables, para reproducir incidentes. Sin scope
explícito solo revisa **el primer lote de hasta 100 contratos y huérfanos**;
los conteos de ese informe no son una conciliación global ni prometen
que todos los pedidos fueron revisados. No devuelve direcciones,
información de clientes, secretos HMAC o payloads crudos.

## Correcciones de integridad financiera

- Validación adicional del contrato contra las fórmulas de
  `validateFinancialSnapshot`: un atacante que pueda escribir directamente
  en SQL no puede convertir aritmética imposible en un registro "saludable"
  simplemente recalculando su hash.
- Controles de concurrencia: eventos repetidos para un mismo PaymentIntent,
  dos eventos distintos para la misma orden y el mismo ID de evento
  simultáneo sobre **dos PaymentIntents distintos**. El último caso se
  transforma en `WEBHOOK_REPLAY_CONFLICT`, nunca doble abono.
- Sigue vigente el bloqueo M3 LAB1.1: fondos pendientes/retenidos al capturar,
  sin saldos gastables; claves compuestas de recibo/intent/orden/asiento.

## Pruebas

`tests/reconciliation.test.mjs` inserta en PostgreSQL:
contrato aún pendiente, captura firmada correcta, asiento huérfano,
asiento con importe incorrecto y contrato SQL falsificado con hash válido
pero cuentas incorrectas. Exige clasificación exacta y confirma que
la conciliación no añadió movimientos.

`tests/stripe-integration.test.mjs` prueba colisiones simultáneas del
mismo evento en distintos PaymentIntents y que un único asiento y recibo
permanezcan tras la contención.

La CI exclusiva en
`.github/workflows/module3-finance-ci.yml` ejecuta las suites PostgreSQL,
criptografía, migraciones de seguridad y guards contra otras bases.

## Riesgos aún abiertos (bloquean producción)

1. **Stripe TEST real**: autenticidad de cuenta, PaymentIntent creado por
   backend autenticado, recepción real de webhooks y consulta de pagos,
   disputas y refunds vía API Stripe TEST.
2. **M1**: fuente de importes autenticada y política versionada (M1 reporta
   17 % comisión; política comercial previa 15 %). Nunca recalcular
   instantáneas históricas en silencio.
3. **M2**: evidencia confiable de entrega, custodia y efectivo antes de
   liberar obligaciones retenidas al restaurante/repartidor.
4. **Finanzas**: reversos, cancelaciones, balance disponible vs retenido,
   retiros, conciliación completa con cursor/paginación, seguridad de roles
   DB mínimos, observabilidad y alertas.
5. **E2E**: pruebas reales de Usuarios → Restaurante → Repartidor → Stripe
   → ledger → liquidación antes de activar fondos o desplegar a Kali.

**Una conciliación interna `captured_held` NO es evidencia de que Stripe
realmente recaudó dinero, ni de que existe liquidez para retirar.**
