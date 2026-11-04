# M8 Pagos — LAB1, matriz de pruebas y plan de integración

**Rama:** `feat/core-v2-pagos-foundation` desde `main`.
**PR:** [#10](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/10), Draft, sin merge.
**Estado:** pruebas en GitHub Actions en curso; **NO-GO LIVE / NO-GO mover dinero**.

## Checklist LAB1

| Gate | Prueba |
| --- | --- |
| Datos de dinero | Enteros en centavos, MXN únicamente, límites y sin floats |
| Idempotencia | Mismo actor/operationId/parámetros devuelve la misma entidad y su estado durable; reuse con payload distinto se rechaza |
| Pago por orden | `orderRef` único en M8, no equivale a verificar el pedido del M1 |
| Estados | Solo `pending` transiciona a `succeeded/failed/canceled`; eventos tardíos no resucitan pagos |
| Firma simulada | HMAC SHA-256 de bytes exactos, tolerancia ±300 s, firma errónea no aplica mutación |
| Eventos | Identificador único, replay equivalente sin doble efecto; replay mutado se rechaza |
| Monto | Callback debe corresponder exactamente al importe y moneda del registro |
| Reembolsos | Solo a pagos confirmados por simulador, nunca sobre el total; reservas `requested` contabilizadas para impedir sobre-reembolso concurrente |
| Reembolso fallido | Libera capacidad para una nueva solicitud; no genera hecho de reembolso confirmado |
| Hechos | Solo exitosos en `verified_facts`, siempre marcados `source=simulated_lab` |
| SQL inmutable | `provider_events`, `verified_facts` y `audit` sin UPDATE/DELETE |
| Fronteras | Solo `modules/payments`, esquema exclusivo PG LAB, bloqueos de imports y gateway LIVE |
| HTTP | Host asigna capacidades; sin rol en body, loopback, bloqueo `NODE_ENV=production`, no-store, sin CORS público |
| Base de datos | Migración 001 falla fuera de `tala_payments_v2_test` y `tala_payments_v2_lab` |

## Riesgos de integración que no deben confundirse con LAB1

- Los pagos de este laboratorio **no se conectan a Stripe TEST ni LIVE**; `payment.succeeded` es un evento de prueba autenticado con clave local y **no prueba liquidación**.
- El flujo de producción requiere crear o validar un PaymentIntent real del proveedor, verificar los callbacks nativos y reconsultar resultados ante ambigüedad; usar la misma validación de importe, moneda y propietario.
- M8 no debe acceder directamente a `tala_finance_v2` ni escribir wallets. Una futura interfaz duradera, autenticada, idempotente y de mínimo privilegio notificará a M3 de cobros/reembolsos realmente verificados.
- El cliente no controla las comisiones, el total ni las referencias externas. El gateway debe vincular el monto con un snapshot de precio firmado/versionado desde M1.
- No se implementan fondos disponibles, captura de tarjetas, facturación, pagos en efectivo, Stripe Connect payouts, disputas o retrocesos bancarios reales en LAB1.

## Criterio de avance

Tras comprobar **CI PASS en el último commit**, LAB1 puede considerarse una base autónoma segura para continuar con el **adaptador de Stripe TEST** dentro de M8, sin invadir M3/M1. No se solicita ni autoriza despliegue LIVE ni merge del PR #10.
