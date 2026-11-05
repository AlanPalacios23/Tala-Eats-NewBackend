# M10 Analítica — Tala Eats Core v2

**Último módulo de la propuesta modular. LAB1 independiente. NO-GO para LIVE, merge o despliegue Kali.**

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

## Ejecutar pruebas LAB

```bash
cd modules/analytics
npm install --ignore-scripts --no-audit --no-fund
npm run check
```

La CI prepara PostgreSQL 16, aplica `001`, configura `ANALYTICS_CI_URL` con una base aislada, ejecuta HMAC, 20 callbacks simultáneos, refund parcial, rango de fechas, acceso merchant/platform, HTTP E2E y rechazo de migraciones a una base diferente. El `npm run check` local sin DB permite ejecutar solo las pruebas de contrato; las de integración se omiten cuando falta `ANALYTICS_CI_URL`.

**Limitaciones obligatorias antes de producción:** contratos/outbox reales M1/M2/M8, M3 como verdad de finanzas, liquidación y comisiones, backfill/replay, correcciones/reversos, múltiples capturas, alertas, retención, sincronización de permisos, cargas, backups y E2E completos de las aplicaciones.

[Arquitectura completa de M10](../../docs/MODULO10-ANALITICA-ARQUITECTURA.md).

**Terminados los laboratorios separados de los diez módulos no significa que estén integrados al monolito:** cada rama necesita un proceso posterior de fusión, resolución de contratos, CI combinada, staging y despliegue por fases. El backend Kali anterior continúa intacto.
