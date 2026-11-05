# M10 Analítica — Tala Eats Core v2

**Último módulo de la propuesta modular. LAB2 independiente — cierre técnico sujeto a validación CI final. NO-GO para LIVE, merge o despliegue Kali.**

M10 es un **read model** de KPIs operativos a partir de eventos mínimos, firmados por productores confiables. Es dueño solo de sus propias estadísticas, no de pagos, wallets, catálogo, cuentas, logística ni los datos de pedido.

**Repositorio/rama:** `AlanPalacios23/Tala-Eats-NewBackend` — `feat/core-v2-analitica-foundation`, nacida directamente desde `main`. No importa ningún módulo M1–M9 ni se conecta al backend anterior.

## Eventos aceptados

- `order.completed`, `order.canceled` firmados por `orders` (futuro M1).
- `payment.confirmed`, `refund.confirmed` firmados por `payments` (futuro M8, únicamente hechos comerciales verdaderamente verificados por PSP).
- `delivery.completed` firmado por `logistics` (futuro M2).

Formato exacto: `eventId`, `kind`, `merchantId`, `orderId`, `refundId` (null si no aplica), `amountCents`, `occurredAt` (UTC). No se admiten campos de clientes, direcciones, GPS ni otras propiedades. Cada emisor tiene un HMAC-SHA256 separado; la firma incluye el emisor, ID de clave, timestamp y bytes originales del JSON.

## Consultas

**KPIs agregados diarios por comercio o plataforma:** pedidos completados/cancelados, entregas completadas, cobros confirmados, reembolsos confirmados, valor operativo bruto de pedidos, volumen de cobros/devoluciones y flujo de cobros menos devoluciones del periodo. Se representan cantidades en **centavos de MXN** y cadenas decimales, no flotantes.

```http
GET  /v1/analytics/health
POST /v1/analytics/events
GET  /v1/analytics/merchant/:merchantId?from=2026-11-01&to=2026-11-05
GET  /v1/analytics/platform?from=2026-11-01&to=2026-11-05
```

La vista de comercio requiere rol concedido por el host y `actor.merchantId` igual al comercio consultado. La vista global necesita `canReadPlatformAnalytics=true` más autenticación verificada por el host. Las rutas existen solo en el servidor de **laboratorio loopback**, bloqueado al detectar `NODE_ENV=production`.

## Garantías de consistencia

- PostgreSQL 16 en base **descartable** `tala_analytics_v2_test` o `tala_analytics_v2_lab`, migración `001_analytics_foundation.sql`.
- `eventId` único y hash de payload previenen contabilizaciones dobles. Un mismo ID con otro contenido devuelve error; un evento idéntico repetido no afecta agregados.
- IDs de negocio únicos impiden dos `order.completed` para un pedido o dos `payment.confirmed`; cada refund tiene referencia irrepetible.
- Los reembolsos confirmados se vinculan a un pago previamente registrado y nunca pueden sumar más que lo capturado en el modelo.
- Una única transacción combina validación, inserción de hecho y actualización de agregados diarios; usa bloqueo de orden para serializar concurrencia.
- Hechos inmutables: no se permite editar/borrar silenciosamente el histórico.

## LAB2 — conciliación verificable del read model

M10 también contiene `src/reconciliation.ts`, una función **interna**
(no endpoint público) para auditar y reconstruir contadores diarios
derivados. `reconcileMerchantDay(pool,actor,merchantId,day,'audit')`
compara la tabla `daily_merchant_metrics` con `ingested_events` sin
cambios. La opción `'repair'` requiere
`authenticated=true`, `canAuditAnalytics=true` y
`canRepairAnalytics=true` concedidos por el host.

Un bloqueo transaccional **por comercio y día** impide que una reparación
compita con ingestiones concurrentes y pierda incrementos. Los eventos
inmutables no se modifican. M10 verifica además que los distintos hechos
de un mismo pedido no atribuyan ventas a comercios distintos y serializa
los intentos de reutilizar un `eventId` entre pedidos diferentes.

Esta conciliación es **del contador analítico contra los hechos ya
recibidos**, no contra M1, M2, M3 ni Stripe. La detección de eventos
perdidos en origen, los ajustes históricos y el reenvío de un outbox
necesitan integración posterior.

[Acta de cierre M10 LAB2](../../docs/MODULO10-ANALITICA-CIERRE-LAB.md) ·
[Estado real de los diez módulos](../../docs/CORE-V2-ESTADO-DIEZ-MODULOS.md).

## Ejecutar pruebas LAB

```bash
cd modules/analytics
npm install --ignore-scripts --no-audit --no-fund
npm run check
```

La CI prepara PostgreSQL 16, aplica `001`, configura `ANALYTICS_CI_URL` con una base aislada, ejecuta HMAC, 20 callbacks simultáneos, refunds parciales, verificación de origen, aislamiento entre comercios, reparación concurrente de agregados, fechas UTC, HTTP E2E y rechazo de migraciones a una base distinta. El `npm run check` local sin DB permite ejecutar solo las pruebas de contrato; las de integración se omiten cuando falta `ANALYTICS_CI_URL`.

**Limitaciones obligatorias antes de producción:** contratos/outbox reales M1/M2/M8, M3 como verdad de finanzas, liquidación y comisiones, backfill/replay, correcciones/reversos, múltiples capturas, alertas, retención, sincronización de permisos, cargas, backups y E2E completos de las aplicaciones.

[Arquitectura completa de M10](../../docs/MODULO10-ANALITICA-ARQUITECTURA.md).

**Terminados los laboratorios separados de los diez módulos no significa que estén integrados al monolito:** cada rama necesita un proceso posterior de fusión, resolución de contratos, CI combinada, staging y despliegue por fases. El backend Kali anterior continúa intacto.
