# M11 Integración LAB6 — reservas físicas M6, confirmación M1 y recuperación

**Fecha:** 5 de noviembre de 2026 (México).
**Rama:** `feat/core-v2-integracion-monolito-m11`. [PR #13](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/13) **Draft**.
**Estado:** **LAB6 APROBADO en CI global funcional** — [#42162058259 — SUCCESS](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42162058259), **281 pruebas PASS, 0 FAIL**. Queda ratificar CI del último commit documental.
**Decisión comercial:** **NO-GO** para LIVE, merge, exposición pública, Stripe, tiendas, reparto, wallets o Kali.

## Problema que resuelve

En LAB5, la creación de pedidos descontaba existencias solo en el inventario
legado de M1, dejando sin cambios el stock de sucursal de M6. Eso
bloqueaba nuevos pedidos aun cuando había unidades suficientes.

LAB6 introduce una **reserva transaccional física de M6** antes de
invocar el `createCashOrder` real de M1. La operación exitosa decrementa
ambas tablas en dos transacciones separadas, sin fingir una transacción
atómica entre bases. Si una operación falla, M11 puede reconstruir el
estado mediante registros durables e intentar confirmar o compensar.

**Importante:** un inventario de M1 continúa existiendo como espejo
legado. LAB6 no permite declarar una arquitectura con una única fuente
de stock comercial hasta retirar/reconciliar ese espejo.

## Implementación por dominio y aislamiento

M1–M10 permanecen fijados por `source-lock.json`; no se editaron sus
árboles originales ni los PRs Draft de cada dominio.

- **M6 LAB (migración aditiva independiente en M11):**
  `modules/integration/m6-extension/008_order_stock_holds.sql`
  instalada **solo** en `tala_restaurants_v2_test/lab`.
  Crea `order_stock_holds`, `order_stock_hold_lines` y
  `order_stock_hold_events` dentro del esquema
  `tala_restaurants_v2`.
  Las líneas y eventos son inmutables. Se guarda la versión de variante,
  precio, nombre, cantidad y balance antes/después como snapshot mínimo.
- **Port transitorio M6:** `modules/integration/m6-extension/reservations.ts`
  maneja las tablas **de M6** con transacciones ACID, bloqueo sobre
  las filas físicas de `branch_stock`, serialización por `hold_id`,
  validación de estado de tienda/sucursal, horario, cierre, activación,
  precio y versión. Solo variantes con `branch_stock_enabled=true`.
- **M11 LAB:** `modules/integration/migrations/005_inventory_checkout_intents.sql`
  crea `inventory_checkout_intents` y eventos inmutables
  `inventory_intent_events`. Una intención queda vinculada a un comprador
  M1 autenticado, clave idempotente, hash del carrito y sucursal. No se
  guardan email, tarjeta, contraseña, token ni dinero LIVE.
- **Coordinador:** `modules/integration/adapters/inventory-checkout-lab.ts`
  utiliza sesión M4 ↔ cuenta M1 verificada de LAB4, mapa inmutable
  M6→M1 de LAB5, la función original `createCashOrder` M1 y las
  funciones de reserva/confirmación/liberación del port M6 de laboratorio.
  Ninguna de estas funciones es un endpoint HTTP público.

**Deuda de arquitectura:** el port M6 todavía vive en
`modules/integration/m6-extension` y escribe dentro del esquema M6.
**Antes de producción debe trasladarse y auditarse como API propia de
M6, con permisos SQL restringidos y un protocolo estable entre
módulos.** No se afirma que el aislamiento de dominios productivo ya
esté resuelto.

## Máquina de estados y seguridad

```text
M4 sesión válida + vínculo M4↔M1
    ↓
M11 crea intención durable (started)
    ↓
M6 reserva unidades por sucursal + snapshot + evento durable (reserved)
    ↓
M1 createCashOrder: stock espejo + pedido + líneas + outbox (pending)
    ↓
M6 confirma hold con orderId; M11 anota confirmed

Si M1 falla y M11 acredita que NO existe pedido:
    M6 libera unidades + evento → M11 released

Si M1 comprometió cambios y M11 cayó:
    M11 lee por buyerId + idempotencyKey
      → M1 verifica su hash de carrito
      → M6 confirma hold sin descontar otra vez
      → M11 confirmed

Si no es posible comprobar M1:
    M11 conserva hold y pasa a review (nunca libera a ciegas)
```

La reservación se serializa por variante/stock físico en la transacción
de M6. Un `hold_id` repetido con el mismo fingerprint devuelve
el recibo original; con un contenido diferente da error.
El coordinador mantiene una sesión PostgreSQL de M11 con un
**advisory lock por comprador y clave** durante todas las fases.
La reserva de stock de una variante no se revierte a causa de un
error parcial de otra línea: se hace rollback de toda la transacción.

Cada hold incluye `expires_at`, inicialmente cinco minutos.
**NO hay liberación automática solo por reloj:** `reconcileReservedLabIntent`
vuelve a consultar a M1 bajo el mismo lock de intención. Si el pedido
está comprometido, confirma incluso si el hold venció; si está
ausente y el hold venció, puede liberar. Si la DB no responde,
debe esperar revisión y mantener la reserva.

### Contratos no cubiertos

- La función interna `releaseM6BranchStock` no autentica por sí sola
  al dueño del pedido: **únicamente el coordinador M11 de LAB está
  autorizado a invocarla** después de acreditar la ausencia de pedido.
  En producción exigir credenciales de servicio y evidencia M1 firmada.
- El bloqueo M11 no impide que otras rutas M1/M6 muten productos
  directamente ni crea transacciones distribuidas. La comprobación
  de precio entre el preflight y el commit M1 aún tiene riesgo TOCTOU.
  Si M1 confirma valores divergentes, se retiene el hold y se requiere
  revisión; no se inventa un reembolso.
- El modo de prueba usa `pickup` y `cash` con estado
  `paymentStatus=pending`. **No se cobra, ni transfiere, ni se genera
  un evento comercial de pedido pagado**.
- La comisión sigue sin conciliarse: M1 calcula 17 %; la política
  comercial previa requiere 15 %. El resultado informa
  `policyApproved=false`, `commercialReady=false`.
- Sin worker 24/7 de expiración/redrive, observabilidad, DLQ de negocio,
  conciliación contable M3, pagos Stripe TEST reales M8 ni
  app E2E, LAB6 no es una solución lista para operar.

## Pruebas de CI

`modules/integration/tests/real-m6-stock-reservation-db.test.ts`
comprueba en PostgreSQL 16:

1. Creación de un pedido real M1 tras reservar stock físico M6;
   ambos inventarios bajan una sola vez; segundo pedido usa otras unidades.
2. Reintento concurrente del mismo `hold_id` sin doble decremento,
   fingerprint inmutable y confirmación idempotente.
3. Caída **después del commit M6** pero antes de invocar M1; reanudación
   desde el mismo `hold_id`.
4. Caída **después del commit M1** pero antes de confirmar M6;
   recuperación sin pedido ni débito duplicado.
5. Rechazo real M1 `OUT_OF_STOCK`, ausencia de orden verificada,
   compensación M6 y estado durable `released`.
6. Hold vencido sin pedido: reconciliación y restauración;
   hold vencido con pedido existente: **nunca restaurar**.
7. Dos clientes compiten por una unidad: una reserva/orden aceptada,
   otra denegada; nada de sobregiro de inventario.
8. Varias variantes: si una falla, rollback del hold completo.
9. Eventos append-only y bloqueo de liberación de un hold confirmado.

La CI integrada conserva las suites existentes de M1–M10,
más pruebas M11, y verifica también que las nuevas migraciones
se rechazan en una base diferente a su LAB correspondiente.

## Siguiente prioridad después de aprobar LAB6

**Migración funcional del port de reservas a M6 y retiro seguro
del espejo de inventario M1**, con protocolo de precio autoritativo,
outbox con consumidor idempotente, reconciliación y pruebas
de carreras con las APIs existentes. Después, integrar pago
real en **Stripe TEST mediante M8**, confirmación de fondos y
contabilización M3; la tarifa de comisión debe aprobarse antes de
esos pasos.


## Evidencia del cierre de LAB6

La [CI integrada #42162058259](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42162058259)
aprobó **281 ejecuciones, 0 fallos** sobre el árbol con las
ocho pruebas nuevas LAB6. Las pruebas incluyen autenticación original
M4/M1, checkout original M1, M6 branch stock, doble commit con
simulación de caídas, vencimiento con orden registrada que no debe
liberar, rollback de una operación multivariante y el rechazo de
migraciones M11/M6 en bases distintas.

La última edición de documentación exige una **nueva validación sobre
HEAD** antes de certificar el commit definitivo. Esta evidencia no
autoriza cobros, transferencias ni despliegue.
