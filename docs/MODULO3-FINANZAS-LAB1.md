# TALA EATS — Módulo 3 Finanzas · LAB1 (Stripe TEST, NO-GO)

## Aislamiento real

Este desarrollo se encuentra únicamente en `modules/finance/` dentro de
la rama `feat/core-v2-finanzas-foundation` (PR #5 **Draft**, base `main`).
No importa código M1/M2, no migra sus tablas y no toca la instancia Kali,
Render, Stripe LIVE, PWAs ni el backend Node operativo.

- `src/ledger.mjs`: propuesta determinista de asientos con `BigInt` (MXN centavos).
- `src/stripe-test-webhook.mjs`: validación HMAC del **cuerpo crudo** del evento,
  timestamp +/-300 s, modo TEST, solo `payment_intent.succeeded`, moneda MXN,
  `status=succeeded` y `amount_received===amount`.
- `src/store.mjs`: adaptador PostgreSQL aislado. Un contrato interno
  `registerTestIntent` registra un pedido/importe esperados antes del webhook;
  `recordSignedTestCapture` valida firma, monto y hash del contrato, bloquea
  fila `FOR UPDATE` y escribe diario + recibo en una misma transacción.
- `migrations/001_finance_foundation.sql`: diario de doble entrada append-only,
  sumas exactas, unicidad por orden de captura y evento.
- `migrations/002_test_webhook_inbox.sql`: registro inmutable de TEST intents
  y recibos firmados, propio esquema `tala_finance_v2`.
- `tests/stripe-integration.test.mjs`: base PostgreSQL 16 real; 8 webhooks
  concurrentes, un único asiento, reenvío idempotente, importe incorrecto,
  segundo evento para la misma orden, hash distinto, intent inexistente,
  contrato duplicado/incompatible, firma falsa.
- `tests/webhook.test.mjs`: firma válida, cuerpo modificado, clave equivocada,
  timestamp viejo/futuro, LIVE, eventos distintos y moneda incorrecta.

El CI instala solamente las dependencias de Finanzas. En la base de pruebas
`tala_finance_v2_test` aplica 001/002 y ejecuta pruebas de transacciones.
Verifica también que migraciones sean rechazadas en otra base.
Para pruebas locales: `cd modules/finance && npm install && npm test`;
el test PostgreSQL se omite sin `FINANCE_CI_URL`, por lo que **la suite
local pura no sustituye la CI de base de datos**.

## Límites estrictos de la evidencia

**No es una integración operativa con Stripe TEST de la cuenta de Tala Eats.**
La suite genera payloads sintéticos con una clave HMAC de laboratorio. Se
ha demostrado criptografía y persistencia transaccional, no entrega de
webhooks reales desde Stripe ni cotejo con su API.

`registerTestIntent` es una interfaz interna de LAB. El hecho de registrar
un `paymentIntentId` **no demuestra** que Stripe haya creado dicho intento,
ni que el comprador haya pagado. Tampoco se expone por HTTP; conectar ese
contrato a M1 requerirá autenticación interna, snapshot firmado, creación
de PaymentIntent en Stripe TEST y asociación segura al pedido.

Un saldo contable registrado **no es un saldo disponible**. El laboratorio
todavía no define estados retenido/disponible, liquidaciones, custodia,
impuestos, refund, reversos ni la elegibilidad para pagar a repartidores.
En especial, no activar wallets ni transferencias basándose solo en el
asiento de captura.

## Problema abierto P0 — política de tarifas

La rama M1 mantiene una política `pilot-2026-11-v2-17pct` (17% comisión);
la configuración comercial anteriormente acordada fue 15%. M3 **no calcula
una tasa por sí solo** ni corrige el pasado: recibe un snapshot completo y
valida que sumas y participaciones cierren. Antes de producción se debe
aprobar explícitamente una política versionada y registrar su contrato
de origen para cada pedido.

## Fases siguientes

1. **LAB2 — Stripe TEST real:** API de PaymentIntent en modo TEST,
   webhook raw con secretos en gestor seguro, account/env y vinculación
   autenticada de M1; pruebas sandbox reales, 3DS y reintentos.
2. **LAB3 — wallets:** proyecciones contables verificadas para restaurante
   y conductor, separación de saldo pendiente, disponible y efectivo.
3. **LAB4 — conciliación:** disputes, cancelaciones y refunds
   compensatorios, checkout-custodia-entrega, retiro/payout idempotente.
4. **E2E comercial:** M1 Pedidos -> M2 Logística -> M3 Finanzas,
   rollback y trazabilidad, con revisión de riesgos y aprobación de GO.

**Se prohíben claves LIVE, transfers, refunds/payouts LIVE o despliegue comercial
en estas fases sin una autorización y revisión posterior.**
