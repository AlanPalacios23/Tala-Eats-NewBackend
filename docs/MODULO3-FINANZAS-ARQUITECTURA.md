# TALA EATS CORE v2 — Arquitectura M3, Finanzas exclusivamente

El Módulo 3 mantiene **una rama y un espacio independientes**:

- Rama: `feat/core-v2-finanzas-foundation` → `main` (PR #5 Draft).
- Código: `modules/finance/src/`.
- Base: esquema `tala_finance_v2` y migración privada
  `modules/finance/migrations/001_finance_foundation.sql`.
- Pruebas y CI propias: `modules/finance/tests/`,
  `.github/workflows/module3-finance-ci.yml`.
- Sin imports de módulos Pedidos, Logística, Stripe, pasarelas o checkout.

## Dominios

**M1 Pedidos:** catálogo transaccional, pedido, versión de precios.  
**M2 Logística:** asignación, recogida, entrega, PIN, pruebas operativas.  
**M3 Finanzas:** diario, obligaciones, saldos/wallets, custodia y arqueo de
efectivo, cierres, ajustes internos, conciliaciones y reportes.  
**Pagos (futuro):** proveedor externo, autorización/captura, Stripe,
webhooks, refunds de pasarela y transferencias bancarias.

Un hecho financiero verificado por Pagos o un hecho de cumplimiento de
M2 podrá alimentar un asiento contable M3 mediante contrato autenticado,
versionado e idempotente. **Ese puente todavía no existe**.

## Estado LAB actual

- Contrato financiero de centavos `BigInt`, validación estricta de split;
  `policyVersion` conservada.
- Asiento *retenido* con una única contrapartida y cuentas pendientes para
  restaurante, entrega y plataforma.
- PostgreSQL rechaza partidas no balanceadas, merchant ajeno, metadatos
  adicionales, duplicados y mutaciones de asientos.
- Vista de wallet de restaurante: saldo pendiente, disponible cero.
- Auditoría interna de solo lectura que revisa integridad e importes.
- PostgreSQL 16 aislado, pruebas unitarias y de contención, sin despliegue.

Estos asientos son **simulaciones financieras de laboratorio**. No declaran
cobro recibido ni salario devengado, no autorizan retiros ni transferencias.

## Priorización

Trabajar ahora en **Finanzas**: ledger compensatorio, wallets pending/available
con reglas de liberación por evidencias, custodia de efectivo, reportes y
conciliación contable. No añadir nuevos proveedores o endpoints de pagos.

Documento detallado: [Límites Módulo 3](MODULO3-FINANZAS-ONLY.md).

**P0 pendiente:** comisión 17% actualmente calculada por M1 frente a la
política comercial previa 15%; se requiere ratificar la versión de precios
antes de conectar módulos. No recalcular históricos.

**NO-GO** para producción, Stripe LIVE, Kali y apps comerciales.
