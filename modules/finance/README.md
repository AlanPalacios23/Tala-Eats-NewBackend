# TALA EATS CORE v2 — Módulo 3: FINANZAS

**Finanzas exclusivamente. Rama independiente `feat/core-v2-finanzas-foundation` → `main`, PR #5 Draft.**  
**LAB3 financiero aislado / NO-GO comercial.**

## Responsabilidades propias de M3

- **Contabilidad financiera de doble entrada:** diario inmutable, partidas balanceadas, importes MXN en centavos enteros, idempotencia y eventos de auditoría.
- **Obligaciones y provisiones:** asignación interna entre restaurante, logística y plataforma, siempre pendiente/retenida hasta existir evidencia autorizada de cumplimiento.
- **Wallets financieros:** proyección del saldo contable pendiente; en este LAB el saldo disponible y retirable es **0**.
- **Conciliación interna:** comparación entre instantánea financiera y asientos, detección de inconsistencias sin modificar fondos.
- **Próxima implementación exclusiva:** liberación de obligaciones por hechos de entrega/custodia autenticados, arqueo y custodia de efectivo, libros auxiliares, ajustes, liquidaciones **contables internas** y reportes financieros.

## Lo que no pertenece a Finanzas

**El futuro Módulo de Pagos**, por separado, será responsable de:
checkout/cobros, Stripe u otros proveedores, PaymentIntents, webhooks de
pasarela, captura de tarjeta, reembolsos contra el proveedor y ejecución externa
de transferencias/payouts. No hay integración de proveedor en la rama actual.

Las implementaciones Stripe TEST experimentales anteriores quedan en el
**historial Git** de este PR, pero se retiraron de la versión actual del M3.
No se ha creado todavía ningún Módulo de Pagos nuevo.

## Implementación en este laboratorio

```
modules/finance/
├── src/
│   ├── ledger.mjs            # contrato financiero y partidas retenidas
│   ├── store.mjs             # diario PostgreSQL + proyección wallet
│   └── reconciliation.mjs    # auditoría contable interna solo lectura
├── migrations/
│   ├── 001_finance_foundation.sql
│   └── 002_full_held_reversal.sql
├── tests/
│   ├── ledger.test.mjs
│   ├── finance-db.test.mjs
│   ├── reversal-db.test.mjs
│   ├── statement-db.test.mjs
│   └── schema.sql
└── package.json
```

- Esquema propio `tala_finance_v2`, sin tablas ni rutas de M1/M2.
- Solo aplica en BD descartables `tala_finance_v2_test` o `tala_finance_v2_lab`.
- `recordLabHeldAllocation` es una función **interna de laboratorio**; no
  confirma que el cliente pagó, que un pedido se entregó, ni autoriza
  un retiro. No se expone por HTTP.
- `readMerchantFinancialBalance`: saldo *pendiente neto* de compensaciones.
- `reverseLabHeldAllocation`: reverso **completo y único** por asignación, con
  movimiento compensatorio inmutable, sin borrar el original ni mover dinero.
- `readMerchantLedgerStatement`: histórico interno por restaurante, paginado,
  con movimientos positivos y compensaciones negativas; saldo disponible cero.
- `assignLabDriverHeldClaim`: atribución única de la porción **retenida**
  de logística a un repartidor, sin crear nuevos asientos ni hacerla cobrable;
  está aislada de cualquier verificación real de entrega.
- `readDriverHeldBalance`: saldo atribuido y retenido por repartidor;
  ante reverso contable del pedido deja de contar, siempre disponible cero.
- `migrations/003_driver_held_subledger.sql`: libro auxiliar inmutable,
  verificación SQL de repartidor, importe y vínculo con asiento original.
- `tests/driver-held-db.test.mjs`: doble atribución concurrente,
  contención contra reversos y ataques SQL de referencias cruzadas.
- `auditInternalLedger`: verificación de hash, partidas y políticas,
  limitada a un lote de 100 entradas; no equivale a conciliación bancaria.

Pruebas puras: `cd modules/finance && npm install && npm run check`.
La integración PostgreSQL se ejecuta con `FINANCE_CI_URL` en la propia CI.

## Interfaces futuras y bloqueos

Pedidos (M1) proporcionará el snapshot de precios versionado; Logística
(M2) entregará hechos validados de entrega/custodia; el futuro módulo de
Pagos proporcionará eventos financieros de proveedor autenticados. M3
**no** implementa, consulta ni suplanta esas fuentes de verdad.

**P0 comercial sin resolver:** M1 mantiene una comisión del 17 % frente
al 15 % previamente establecido. Antes de integrar, ratificar la tarifa
y su versión; no cambiar ni recalcular los pedidos históricos.

Ningún servicio de LIVE, Kali, stripe, banco ni PWA fue modificado.
No hay saldo retirable ni cierre financiero comercial aprobado.

Consulta `docs/MODULO3-FINANZAS-ONLY.md` para el contrato de límites y
`docs/MODULO3-FINANZAS-LAB2.md` para los reversos y estados de cuenta.
El avance LAB3, sus límites y el criterio para desarrollar el siguiente
módulo se documentan en `docs/MODULO3-FINANZAS-LAB3-CRITERIOS.md`.
