# M11 Integración LAB7 — Flujo funcional de retiro en efectivo, eventos y contabilidad retenida

**Fecha:** 5–6 de noviembre de 2026 (México).
**Rama:** `feat/core-v2-integracion-monolito-m11`.
**PR:** [#13](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/13), Draft.
**Estado:** nueva batería de integración M1/M4/M5/M6/M10/M3 en validación CI.
**Política de seguridad:** NO-GO LIVE, NO-GO merge, NO-GO Kali, NO-GO Stripe LIVE, transferencias o retiros automáticos.

## Qué queda conectado en código real

El flujo de **retiro (pickup) / efectivo pendiente** reutiliza los servicios originales:

```text
M4 sesión comprador + vínculo dual M4↔M1 (LAB4)
   ↓
M6 variante / stock físico de sucursal + reserva y evento (LAB5–LAB6)
   ↓
M1 createCashOrder -> precio congelado + outbox + stock espejo
   ↓
M6 hold confirmed; M11 checkout intent confirmed
   ↓
M1 cuenta de comerciante y restaurant_memberships activas
   ↓
M1 merchant confirmed -> preparing -> ready (outbox real)
   ↓
M11 relay verificado de outbox M1 -> orders.pickup_ready
   ↓
M5 publishNotification -> inbox real del cliente M4
   ↓
M4 cliente solicita PIN -> comprador y comerciante atestiguan efectivo
   ↓
M1 finishCashOrder verifica PIN de un solo uso y 2 acuses
   ↓
M1 order.delivered / pago cash paid, custodia todavía NO conciliada
   ↓
M11 relay verificado de outbox M1 -> orders.pickup_completed
   ├─> M5 inbox real: order.delivered
   └─> M10 ingestAnalyticsEvent real: order.completed / GMV de pickup
   ↓
M3 recordLabHeldAllocation (SOLO RETENIDO), snapshot M1 real
   └─> wallet available=0, withdrawable=false, custodial cash unset
```

**M2 Logística no se usa en pickup**, porque no participa un repartidor; el código M2 y sus pruebas originales siguen en la CI global. Para domicilio hay que integrar M2 despacho/PIN/ruta de manera independiente.

## Adaptadores nuevos de M11

- `adapters/pickup-lifecycle-lab.ts`: exige sesión real legacy M1 con rol y pertenencia activa para el comerciante, vínculo de hold M6 confirmado, y en cada acto llama a `advanceMerchantOrder`, `issueBuyerHandoffPin`, `attestCash` y `finishCashOrder` reales de M1. El comprador se identifica con su sesión M4 y vínculo M4→M1; nunca mediante `buyerId` del frontend. El PIN no se persiste en M11.
- **Relay de outbox:** lee filas `tala_core_v2.outbox` con `order_events` del mismo `event_key`; comprueba estado, actor, contexto de comercio, reserva M6 y evidencia PIN/doble acuse antes de publicar. El identificador M11 se calcula de forma determinista desde `event_key`; un reintento no crea eventos ni notificaciones duplicados. El relay solo lo puede solicitar un host interno con `canRelayM1Outbox`; sin worker activo, los hechos esperan su publicación en M1.
- `migrations/006_m1_pickup_outbox_events.sql`: habilita únicamente `orders.pickup_ready` y `orders.pickup_completed` como fuentes `orders`. No convierte `orders.order_created` (sin pago verificado) en una notificación.
- `adapters/pickup-consumers-lab.ts`: resuelve el destinatario M5 desde M1 buyer y asociación M4↔M1 no revocada; verifica nuevamente la procedencia del evento. Emite `order.completed` firmado con clave **de laboratorio** a M10 y monto obtenido exclusivamente del pedido M1 entregado; **no emite** `payment.confirmed` (el efectivo no equivale a PSP).
- **M3 HELD:** después de verificar `payment_status=paid`, pedido `delivered`, PIN consumido, dos acuses de efectivo, monto coincidente, custodia NO liquidada y outbox real, se toma el `price_snapshot` original de M1 para `recordLabHeldAllocation` de M3. Este asiento tiene saldo **pendiente/retirables 0**; no liquida efectivo ni crea una transferencia. Idempotencia por pedido y clave fija.
- La API sigue siendo **in-process**; no se publican endpoints comerciales ni se reutiliza la autenticación de los laboratorios en Internet.

## Pruebas LAB7

La batería E2E de PostgreSQL crea cuentas M4+M1, tienda M6 con stock real, retiro y cuenta comercial M1; sigue todas las transiciones de preparación, PIN y efectivo; comprueba los outboxes y que M5, M10 y M3 **consuman hechos del módulo fuente**, no mensajes fabricados por un navegador. Los casos negativos incluyen cliente ajeno, comerciante sin sesión/permiso, ausencia de evento comprometido, ausencia de doble acuse, sesión errónea y prohibición de asientos M3 antes de la entrega.

Efectos idempotentes comprobados: un único pedido, una reserva confirmada, dos notificaciones (listo y entregado), una métrica `ordersCompleted=1`, ninguna `paymentsConfirmed` ni `deliveriesCompleted` falsa y exactamente **un diario contable HELD**, retirable cero. La CI usa solo datos ficticios.

## Qué impide declarar «monolito completamente funcional»

1. **M8 Stripe TEST en la misma orden:** `M1.createCashOrder` solo crea órdenes `paymentMethod='cash'`. Aunque M8 tiene `createPayment`, cliente Stripe TEST y webhooks firmados, vincular un pago a una orden cash por SQL o fingirlo como pagado sería inseguro. Se requiere una **entrada M1 para órdenes Stripe `awaiting_payment`**, con total congelado y referencia M8 verificada en su propia máquina de estados. Solo después conectar `payment_intent.succeeded` firmado del proveedor en TEST, idempotencia y confirmación transaccional en M1. Sin credenciales TEST reales no se confirma el circuito remoto.
2. **Inventario:** los holds viven en una extensión provisional de M11 que escribe en el esquema M6 LAB; debe migrarse a una API propia de M6 con servicio autenticado. M1 todavía conserva stock espejo, sin transacción distribuida.
3. **Comisiones:** M1 calcula **17 %** sobre productos, frente al acuerdo comercial del **15 %**. El ledger M3 refleja fielmente el snapshot M1 pero no constituye tarifa aprobada ni liquidación.
4. **Dinero efectivo:** `paymentStatus=paid` en M1 significa que el custodio recibió efectivo; `custody_settled_at` permanece NULL. Faltan arqueo, handoff formal, conciliación y retenciones/payouts, con pruebas de fraude/contracargos.
5. **M2 y M7:** domicilio real necesita zonas/direcciones, disponibilidad/dispatch/presencia, entrega con PIN y reintentos. No reinterpretar el flujo de pickup como domicilio.
6. **Workers y gateway:** falta un runtime Express único con sesiones definitivas M4, roles SQL mínimos, consumo automático del outbox M1, backpressure, redrive, DLQ, alarmas, E2E apps, backups y rollback. Los eventos del relay requieren ejecución explícita en este LAB.
7. **LIVE:** no hay despliegue autorizado ni aprobación para merge a `main`. Las aplicaciones existentes del servidor Kali continúan fuera de este ensamblaje.

**Decisión:** se puede considerar funcional el **circuito LAB de retiro en efectivo** solo si la CI final de este commit pasa. No se puede llamar al conjunto «backend comercialmente funcional al 100 %» hasta resolver estas condiciones.
