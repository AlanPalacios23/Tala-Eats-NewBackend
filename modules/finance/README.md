# TALA EATS · Módulo 3 — Finanzas

**LAB0 / estructura independiente / NO-GO comercial.**

Este módulo vive por completo en \`modules/finance/\` dentro de
\`AlanPalacios23/Tala-Eats-NewBackend\` y trabaja en su propia rama
\`feat/core-v2-finanzas-foundation\`, basada directamente en \`main\`.
**No depende de fusionar Pedidos (PR #1) ni Logística (PR #4)**.
No se debe copiar código entre PR ni hacer un merge cruzado sin resolver contratos.

## Ámbitos separados

- **M1 Pedidos**: crea pedidos y firma la instantánea de precios, define el estado real.
- **M2 Logística**: controla asignaciones, prueba de recogida y entrega, PIN/custodia.
- **M3 Finanzas**: verificará hechos de pago, derivará asientos de doble entrada,
  wallets, liquidaciones y conciliación. **No cambia el estado de pedidos.**
- **Integración futura**: contratos versionados por eventos de outbox con IDs estables,
  transacciones idempotentes y reconciliación; sin acceso a tablas internas de M1/M2.

## Lo que existe en LAB0

1. \`src/ledger.mjs\`: validación monetaria con \`BigInt\`, sin cálculos flotantes,
   y propuesta inmutable de asientos balanceados para *capturas Stripe TEST*.
2. \`migrations/001_finance_foundation.sql\`: esquema **\`tala_finance_v2\`** propio,
   diario de asientos, restricciones de importe y balance, protección append-only,
   unicidad de (pedido, tipo) y (proveedor TEST, evento).
3. \`tests/\` y CI propios. No llama a Stripe ni a APIs LIVE.

**Una propuesta no demuestra que Stripe recibió dinero.** Un límite confiable de
webhook firmado, captura confirmada y conciliación debe añadirse **antes**
de cualquier escritura financiera real. La función no está conectada a HTTP,
Kali, PM2, Redis ni a las PWA.

## Contrato y discrepancia P0

M1 \`src/modules/orders/pricing.ts\` contiene \`pilot-2026-11-v2-17pct\`
(17 % comisión) y tope de servicio de 2,500 centavos. La política comercial
anteriormente aprobada era 15 % de comisión y 7 % de servicio. No deben
recalcularse importes históricamente guardados ni elegir una tasa en silencio:
**resolver versión de política comercial y verificar el snapshot recibido
antes de conectar Finanzas a Pedidos.** M3 valida sumas, no calcula tarifas.

## Próximas fases

- LAB1: almacén transaccional idempotente (no solo schema) con PostgreSQL aislado,
  webhook Stripe TEST firmado, eventos repetidos/fuera de orden, capturas y refunds.
- LAB2: wallets de restaurante y conductor como proyecciones del ledger,
  saldo disponible/pendiente, custodias de efectivo y conciliación inmutable.
- LAB3: pagos de salida, retiros, reversos, discrepancias, alertas,
  facturación e impuestos con política revisada.
- Integración E2E: orden de M1 → asignación/entrega M2 → fondos reales M3.

## Seguridad

- Sin credenciales LIVE, retiros, transferencias ni mutaciones de Stripe.
- SQL de laboratorio falla al ejecutarse fuera de bases descartables
  \`tala_finance_v2_lab\` o \`tala_finance_v2_test\`.
- No modifica \`tala_core_v2\` ni bases de datos antiguas.
- Estado actual: **no usar para liquidaciones comerciales**.

Ejecutar pruebas puras: \`cd modules/finance && npm test\`.
