# Tala Eats Core v2 — M10 Analítica: arquitectura independiente

**Rama:** `feat/core-v2-analitica-foundation`, creada **directamente desde `main`**.
**Estado:** LAB1 en validación, sin merge, sin despliegue y sin acceso a fondos/usuarios reales.
**Runtime:** Node.js 24 + TypeScript estricto + PostgreSQL 16, `tala_analytics_v2_test` o `tala_analytics_v2_lab`.
**PR:** módulo 10 autónomo, sin dependencias de los PR de M1–M9.

## Responsabilidad

M10 es un **read model de indicadores operativos**, nunca fuente de verdad para pedidos, movimientos contables o pagos. Solo recibe hechos del productor verificado por HMAC y mantiene estadísticas materializadas propias.

| Productor futuro | Hecho mínimo que consume M10 | Owner del hecho |
| --- | --- | --- |
| M1 Pedidos | `order.completed`, `order.canceled` | M1 valida ciclo de pedido, comercio y total congelado |
| M8 Pagos | `payment.confirmed`, `refund.confirmed` | M8 verifica con el PSP **real**; hechos `simulated_lab` y `stripe_test` no son publicables |
| M2 Logística | `delivery.completed` | M2 verifica finalización y entrega, no M10 |

Otros módulos M3 Finanzas, M4 Usuarios, M5 Notificaciones, M6 Restaurantes, M7 Ubicaciones y M9 Seguridad mantienen sus datos en sus propias tablas. **M10 no importa código ni consulta tablas de otro módulo.**

Ningún productor comercial se conecta todavía: los tests usan firmas y eventos propios **ficticios**. Para producción deben acordarse los eventos reales, outbox/transporte durables, autenticación entre servicios, claves por emisor, esquema versionado y estrategia de retrocarga.

## Contrato cerrado de evento

Cada evento tiene **exactamente siete campos**, sin metadata adicional:

```json
{
 "eventId":"5f682c2c-1f76-4980-83f8-b161fab28a46",
 "kind":"order.completed",
 "merchantId":"9db1c49e-9a0f-491e-92b5-7ec7a4288b9d",
 "orderId":"6c2f23fe-27f9-48c9-b903-8a9fd013aef2",
 "refundId":null,
 "amountCents":49900,
 "occurredAt":"2026-11-05T01:00:00Z"
}
```

Los UUID anteriores son ejemplos ficticios. El campo `refundId` solo tiene valor en `refund.confirmed`. `order.canceled` y `delivery.completed` tienen importe cero; los demás requieren centavos enteros positivos, con tope validado en LAB.

**No se admiten** cliente, correo, teléfono, dirección, GPS, método de pago, tarjeta, ID de dispositivo ni otras propiedades de identificación personal. Los únicos identificadores son referencias UUID operativas. La ausencia de PII directo no garantiza anonimización: las referencias pueden permitir vinculaciones si otros sistemas conocen su relación.

`occurredAt` es UTC ISO 8601 `YYYY-MM-DDTHH:mm:ssZ`, acepta hechos de hasta **90 días antes** y como máximo 5 minutos en el futuro. Las métricas se agrupan por **día UTC**; la visualización comercial puede convertir etiquetas a la zona local, pero no alterar silenciosamente los agregados.

## Firma / emisores confiables

Cada emisor (`orders`, `payments`, `logistics`) tiene un keyring de HMAC-SHA256 **independiente**. El gateway anfitrión configura claves secretas de 32 bytes o más, nunca las almacena M10 ni las acepta en el cuerpo HTTP.

Cabeceras HTTP LAB:
```http
x-m10-issuer: orders
x-m10-key-id: ops01
x-m10-signature: t=<unix-seconds>,v1=<sha256-hex>
```

Se firma `issuer + "." + kid + "." + timestamp + "." + rawBody`; se verifica sobre bytes originales, con ventana de ±300 s y comparación de tiempo constante. El mapa de tipos impide que `logistics` firme un pago o `payments` afirme que un pedido se completó. Los tests usan claves ficticias y transportes locales. **La prueba de firma acredita identidad de clave, no que un hecho comercial se haya liquidado**: el productor debe mantener esa garantía.

## Modelo SQL M10 y consistencia

- `ingested_events`: event UUID global, issuer, tipo, IDs, monto, día, SHA-256 de payload. Trigger append-only.
- `order_outcomes`: un único resultado terminal por pedido (`completed` o `canceled`) con `orderId` único.
- `payment_facts`: una sola confirmación de cobro por `orderId` en este contrato LAB; no soporta aún múltiples capturas reales.
- `refund_facts`: idempotencia por `refundId`, parcial/total, con suma acumulada que no supera el pago confirmado; si el pago previo no ha llegado, se rechaza para que el productor repita tras conciliar.
- `delivery_facts`: un cierre de entrega por pedido; cancelación final y entrega se excluyen.
- `daily_merchant_metrics`: incrementos transaccionales por `merchantId + event_day`; retiene conteos y centavos como BIGINT, sin decimales flotantes.

La inserción de evento, control de unicidad empresarial, registro de hecho y actualización del resumen diario se ejecutan **en una única transacción PostgreSQL**. Cada pedido adquiere un bloqueo de transacción para serializar resultados y reembolsos concurrentes. Los eventos con mismo `eventId` y payload se reconocen como duplicados y no alteran la estadística. Un mismo UUID con otro payload o una segunda finalización con UUID distinto son **conflictos**, no nuevos ingresos.

**No hay reescrituras ni borrados silenciosos de hechos.** Los ajustes de registros históricos, múltiples PaymentIntents/capturas, disputas y reversos necesitan un contrato de eventos de corrección versionado antes de LIVE.

## Endpoints HTTP LAB (solo loopback)

```http
GET  /v1/analytics/health
POST /v1/analytics/events
GET  /v1/analytics/merchant/:merchantId?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /v1/analytics/platform?from=YYYY-MM-DD&to=YYYY-MM-DD
```

- Ingestión exclusivamente a través de HMAC de emisor; **sin endpoint que firme eventos** ni carga manual de ventas.
- El host autentica las lecturas. Comerciante requiere `authenticated=true`, `canReadMerchantAnalytics=true` y `actor.merchantId` idéntico a `:merchantId`. No se infiere propiedad a partir del parámetro de URL.
- Plataforma solo se entrega con `canReadPlatformAnalytics=true` más identidad autenticada. Este privilegio no se puede enviar como parámetro HTTP.
- Ventana máxima de **31 días inclusivos**; salidas con conteos e importes **en cadenas de enteros** para conservar exactitud de BIGINT, `netPaymentFlowCents` puede ser negativo en periodos con devoluciones de cobros anteriores.
- `orderGmvCents` es valor registrado de pedidos completados, **no ingreso neto ni beneficio**. `paymentsCents` y `refundsCents` son hechos operativos, **no liquidación**. El propietario de wallets, comisiones, doble partida y conciliación es M3.
- HTTP LAB rechaza `NODE_ENV=production` y conexiones que no sean loopback. No publica CORS, tokens de issuer ni datos personales.

## GO / NO-GO de laboratorio

**GO LAB:** TypeScript estricto, validación HMAC, anti-tampering, autorización merchant/platform, 20 solicitudes concurrentes con evento repetido, únicos de negocio, refunds parciales, alcance fecha, migración SQL rechazada fuera de DB M10 y HTTP local, documentado en CI.

**NO-GO producción:** productores reales, reconciliación de datos desde M1/M2/M8, política de tasas y comisiones M1/M3 (incluida divergencia histórica 15% vs 17%), outbox durable, backfill, trazabilidad de eventos perdidos, monitoreo, alertas, limitación de tráfico upstream, seguridad de host, backups, retención, multi-capturas/ajustes, pruebas de carga, y E2E de todas las apps.

El cierre de M10 **completa el conjunto de diez candidatos modulares independientes**, pero **no equivale a integrar o desplegar un monolito modular**: la rama `main` sigue sin contener esos diez módulos y los PR permanecen abiertos sin fusionar.
