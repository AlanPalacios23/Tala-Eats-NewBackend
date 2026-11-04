# Tala Eats Core v2 — M8 Pagos LAB2: Stripe TEST profesional y aislado

**Fecha:** 4 de noviembre de 2026.
**Estado:** LAB2, **NO-GO para Stripe LIVE**, merge y despliegue Kali.
**PR Draft:** [#10](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/10).
**Rama:** `feat/core-v2-pagos-foundation` basada directamente en `main`.

## Qué se implementó

M8 conserva la simulación firmada de LAB1 y añade, **sin mezclar eventos ni resultados**, un adaptador de Stripe TEST para PaymentIntents y reembolsos. La red de Stripe no se utiliza durante las pruebas automatizadas: un transporte HTTP falso verifica los contratos mientras PostgreSQL 16 prueba la persistencia y los cambios de estado. El adaptador puede utilizarse con credenciales **solo TEST**, entregadas por un host de laboratorio confiable; **no se configuraron claves reales en este PR**.

| Área | Garantía LAB2 |
| --- | --- |
| Claves | `StripeTestClient` solo acepta prefijos `sk_test_`, con host fijo de Stripe, API versionada, sin endpoint de transferencias ni payouts |
| PaymentIntents | `POST /v1/payment_intents`, MXN en centavos, tarjeta, metadatos `m8_payment_id`, sin confirmación automática; retorno de `client_secret` únicamente al host autorizado |
| Reembolsos | `POST /v1/refunds` con `payment_intent` y monto exacto, `m8_refund_id`, sin considerar confirmada una respuesta HTTP |
| Estado persistente | `stripe_test_intents` y `stripe_test_refunds` guardan una intención y una clave de idempotencia estable **antes** de llamadas externas, con lease de 45 s |
| Ambigüedad de red | Mismo identificador de operación durante reintentos; al pasar 20 horas sin vincular resultado remoto se bloquea la repetición y se exige conciliación manual |
| Webhooks Stripe | Validación de `Stripe-Signature` real: bytes exactos del cuerpo, timestamp ±5 minutos, HMAC SHA-256 y comparación constante |
| Aislamiento de proveedor | Event `livemode=false` obligatorio; nunca se acepta que el webhook del simulador LAB1 confirme un pago de `stripe_test` |
| Verificación | ID `evt_` del evento, `pi_`/`re_`, asociación al UUID propio mediante metadatos, importe, moneda y estado; `payment_intent.payment_failed` **no** convierte un fallo de intento en fallo final del pago |
| Idempotencia y auditoría | Eventos y hechos de Stripe TEST en tablas separadas, inmutables, con UUID de M8 y referencias externas de Stripe preservadas |
| Consulta | `readPayment` ofrece `facts` del simulador por separado de `stripeTestFacts`; nunca se envían hechos a Finanzas |

### API LAB

El único servidor HTTP disponible está vinculado a loopback y se niega a iniciarse con `NODE_ENV=production`. Las rutas Stripe TEST **no existen funcionalmente** hasta que el host inyecta `stripeTest: {client, webhookSecret}`.

```http
POST /v1/payments
POST /v1/payments/:paymentId/stripe-test-intent
POST /v1/payments/:paymentId/refunds
POST /v1/payments/:paymentId/refunds/:refundId/stripe-test-send
POST /v1/payments/stripe-test-webhook
GET  /v1/payments/:paymentId
GET  /v1/payments/stripe-test/diagnostics
```

- La primera ruta crea **únicamente** la solicitud local de pago, con rol `canCreatePayments` provisto por el host. La activación Stripe TEST de la segunda ruta usa también este permiso; el `body` es `{}`.
- `/refunds` reserva un monto en M8 sin efectuar la devolución externa. `/stripe-test-send` necesita permiso `canRefundPayments`, compara el `refundId` con el `paymentId` del URL y después invoca al proveedor TEST; `body` es `{}`.
- `/stripe-test-webhook` recibe el cuerpo JSON **sin reserializar** y `Stripe-Signature`; la identidad de origen proviene de la firma válida, no de un rol del frontend.
- La API no permite tarjetas sin cifrar, PAN/CVV, claves en la solicitud, nombres de compradores, transferencias a cuentas ni creación directa de wallets.
- `GET` necesita `canReadPayments`; esta capacidad debe estar restringida por el gateway anfitrión a quienes realmente pueden ver ese pago.

## Flujo de una operación y recuperación

```text
M1 (futuro, host autenticado) entrega snapshot de pedido y precio
     |
M8 registra solicitud local, MXN / operación idempotente
     |
M8 Stripe TEST: almacena idempotency key / lease en PostgreSQL LAB
     |
     +-----> Stripe TEST PaymentIntent sin confirm=true
                  |
               App de prueba confirma con SDK Stripe TEST (no implementada)
                  |
          Stripe webhook: firma oficial + livemode=false
                  |
          M8 valida amount, currency, PI, metadatos, estado
                  |
          M8 guarda evento y hecho TEST inmutables
                  X
          NO se entrega a M3 ni se considera saldo LIVE
```

Si Stripe no devuelve respuesta, **no** se crea una segunda operación con clave distinta. Se permiten reintentos bajo la misma clave solo durante la ventana conservadora de 20 horas, y únicamente cuando termina el lease de la solicitud anterior. Si el resultado es incierto más allá de ese plazo, debe realizarse una conciliación manual antes de habilitar cualquier reintento. Esto evita que Stripe trate como nueva operación una clave cuya retención expiró. La documentación oficial indica que Stripe puede depurar claves tras al menos 24 horas: <https://docs.stripe.com/api/idempotent_requests>.

Los eventos Stripe TEST no son exactamente-una-vez en la red; nuestro procesamiento **deduplica efectos en una transacción local**. Si el webhook llega antes de que su PaymentIntent o reembolso quede vinculado, la ruta devuelve error recuperable; falta un proceso externo de replay y conciliación para GO LIVE.

## SQL y pruebas

Migraciones `001_payments_foundation.sql` y `002_stripe_test_gateway.sql`, **solo** en `tala_payments_v2_test` / `tala_payments_v2_lab`.

- `stripe_test_intents`: PaymentIntent ligado al pago interno, clave idempotente durable y lease, sin guardar `client_secret`.
- `stripe_test_refunds`: reembolso vinculado al refund local, registro durable del intento externo.
- `stripe_test_events`: IDs `evt_` opacos y hashes, tipo/correlación/resultado; append-only.
- `stripe_test_facts`: tipos `FundsConfirmed.v1` / `ProviderRefundConfirmed.v1`, **source = stripe_test** obligatorio. Nunca se confunde con simulador ni fondos reales.

La CI ejecuta Node 24, TypeScript estricto, PostgreSQL 16, HTTP E2E, firmas HMAC, colisiones/replays, imports prohibidos, pruebas de clave LIVE rechazada, error de red incierto, lease y ventana de reintentos, compras y devoluciones de laboratorio, migración rechazada fuera de bases propias.

## Puertas **NO-GO** que quedan abiertas

1. Probar contra una **cuenta real de Stripe TEST**, con credenciales almacenadas en un gestor seguro y endpoints registrados de prueba; hasta ahora los contratos HTTP se verificaron con transporte simulado y fixtures.
2. Autorizar montos y `customerRef` exclusivamente desde una orden autenticada y versionada de M1, con controles de inventario/cancelación.
3. Implementar conciliación automática: eventos perdidos, expiración de claves remotas, disputa, payout reversal, estado de PaymentIntent/Refund en el PSP y supervisión de errores.
4. Integración confiable y durable `M8 → M3`, firma del productor, outbox, esquema de liquidación y saldos; ningún TEST result se debe presentar como dinero comercial.
5. Autorización multiusuario, antiabuso, cuotas, secreto rotado y certificado TLS, roles de DB mínimos, backups/recovery, métricas/alertas y pruebas de carga.
6. SDK Flutter/PWA Stripe TEST, métodos de pago, 3-D Secure, reembolsos comprobados en la cuenta de pruebas, políticas de privacidad y cumplimiento de PCI/operación.
7. Stripe Connect, onboarding de cuentas, transferencias, retenciones, retiros automáticos y reconciliación de plataforma quedan fuera de LAB2.

### Documentación Stripe consultada

- <https://docs.stripe.com/api/payment_intents/create>
- <https://docs.stripe.com/api/refunds/create>
- <https://docs.stripe.com/events/manage-webhook-endpoints>
- <https://docs.stripe.com/api/idempotent_requests>

**Política:** no modificar ni fusionar ramas de M1–M7. No activar claves Stripe LIVE, no usar fondos reales y no realizar despliegue Kali desde M8 LAB2.
