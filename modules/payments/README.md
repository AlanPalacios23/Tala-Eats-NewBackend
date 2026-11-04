# Tala Eats Core v2 — M8 Pagos (LAB1 aislado)

**Estado:** **LAB2 — Stripe TEST aislado y pruebas del ciclo de proveedor**. **NO-GO LIVE / NO-GO merge / NO-GO dinero real**.

**Rama** `feat/core-v2-pagos-foundation`, creada directamente desde `main`.
**Código** `modules/payments/**`, **base** `tala_payments_v2_test` o `tala_payments_v2_lab`, esquema PostgreSQL `tala_payments_v2`.

## LAB2: integración TEST aislada, sin dinero comercial

El adaptador `src/stripe-test-client.ts` solo acepta `sk_test_` y contiene
los contratos actuales de PaymentIntents y reembolsos Stripe TEST. El módulo
persiste la intención externa y la clave de idempotencia antes de cualquier
petición de red: una respuesta ambigua **no genera una segunda operación**.
Los webhooks verifican la cabecera nativa `Stripe-Signature` sobre bytes
exactos, y exigen `livemode=false` en el evento. Los hechos de Stripe TEST se
guardan **por separado** de los eventos del simulador, sin publicarse a M3.

**Nuevas rutas loopback opcionales:**

- `POST /v1/payments/:paymentId/stripe-test-intent` — cuerpo `{}`, rol de
  creación autenticado por el host, devuelve el `clientSecret` solo al
  sistema autorizado.
- `POST /v1/payments/:paymentId/refunds/:refundId/stripe-test-send` — cuerpo
  `{}`, verifica pertenencia y permiso de refund; TEST únicamente.
- `POST /v1/payments/stripe-test-webhook` — cuerpo JSON raw y
  `Stripe-Signature` real, sin auth bearer, solo loopback.

Estas rutas requieren que el host configure explícitamente
`stripeTest: {client, webhookSecret}`. No existen claves configuradas en el
repositorio ni llamadas externas durante la CI (transporte falso inyectado).
`NODE_ENV=production` sigue bloqueado para el servidor LAB.

**Base:** aplicar migraciones `001` y `002`, solo a bases descartables M8.
Las tablas `stripe_test_intents`, `stripe_test_refunds`,
`stripe_test_events` y `stripe_test_facts` pertenecen exclusivamente a M8.
Revisar la
[documentación y puertas de salida LAB2](../../docs/MODULO8-PAGOS-LAB2-STRIPE-TEST.md).

## Funciones propias de M8 en LAB

| Propiedad M8 | Implementación |
| --- | --- |
| Solicitud de pago | Referencia externa de pedido, cuenta referida por UUID, importe entero MXN, recibo idempotente |
| Estado | `pending -> succeeded/failed/canceled` (solo evento HMAC de proveedor simulado) |
| Webhooks | Simulación firmada HMAC-SHA256, timestamp ±5 minutos, huella/ID únicos, rechazo de replay diferente |
| Reembolsos | Solicitudes con monto exacto; reservas concurrentes limitadas a lo cobrado; transición de `requested -> succeeded/failed` mediante simulación firmada |
| Verificaciones | Amount/currency exactos, asociación pago/reembolso, rechazo de eventos fuera de orden |
| Hechos de integración | `FundsConfirmed.v1` y `ProviderRefundConfirmed.v1` solo en tabla `verified_facts` propia, siempre `source=simulated_lab` |
| Seguridad | Capacidades del actor inyectadas desde host, transacciones PG, auditoría append-only, HTTP limitado a loopback |
| Independencia | Sin importar M1–M7, sin claves foráneas externas, sin Stripe ni red del proveedor |

**Importante:** los hechos `FundsConfirmed.v1` proceden exclusivamente de un **simulador de pago** con secreto de laboratorio. No demuestran que Stripe, un banco o el cliente hayan pagado y no se publican en M3.

M8 no calcula tarifa de servicio, comisión de restaurante, pago a repartidor, propina ni split. M1 proporciona una referencia de pedido y monto validado en la integración futura. M3 recibe hechos confiables de pago externo en una integración posterior; nunca se escribe su ledger desde el laboratorio de M8.

## Contrato API de laboratorio

Solo disponible en loopback; está bloqueada en `NODE_ENV=production`.
El servidor necesita `authenticate(req)` del host y `webhookSecret` aleatorio de al menos 32 bytes. **No se proporcionan credenciales Stripe.**

- `GET /v1/payments/health`
- `POST /v1/payments` — solo `canCreatePayments` desde el host
- `GET /v1/payments/:paymentId` — solo `canReadPayments`
- `POST /v1/payments/:paymentId/refunds` — solo `canRefundPayments`
- `POST /v1/payments/lab-webhook` — evento firmado; sin identidad por bearer, solo firma HMAC y conexión local

Solicitud de creación:

```json
{
  "operationId": "<UUID>",
  "orderRef": "<UUID externo provisto por el host>",
  "customerRef": "<UUID externo provisto por el host>",
  "amountCents": 49900,
  "currency": "MXN"
}
```

El valor 49900 significa **$499.00 MXN**. El adaptador de laboratorio no recibe datos de tarjetas, números de cuenta, CLABE ni credenciales del cliente. El cliente no tiene autoridad para crear pagos directamente: el host debe autenticar y conceder la capacidad correspondiente.

Ejemplo de evento de laboratorio (solo pruebas, no proveedor real):

```json
{
  "eventId": "<UUID>",
  "kind": "payment.succeeded",
  "paymentId": "<UUID>",
  "amountCents": 49900,
  "currency": "MXN",
  "providerRef": "lab_payment_fixture001"
}
```

Se firma sobre los **bytes exactos del cuerpo** con HMAC SHA-256 de `<timestamp-segundos>.<cuerpo-json>` y cabeceras `X-Lab-Timestamp` y `X-Lab-Signature: v1=<hex>`. El secreto de la firma es únicamente del simulador y se entrega mediante el host (nunca en repositorio ni respuesta HTTP). El reenvío exacto de un evento ya aceptado se trata como replay sin efectos duplicados; un evento con el mismo ID y datos distintos se rechaza.

## Comprobaciones de laboratorio

```bash
cd modules/payments
npm install --ignore-scripts --no-audit --no-fund
npm run check
```

Las pruebas PostgreSQL completas requieren `PAYMENTS_CI_URL` hacia la base **descartable** `tala_payments_v2_test` con las migraciones `001_payments_foundation.sql` y `002_stripe_test_gateway.sql` aplicadas; el workflow específico de GitHub Actions configura PostgreSQL 16, Node 24, TypeScript estricto, tests de HMAC, reintentos/concurrencia/HTTP y el rechazo de la migración fuera de bases autorizadas.

## Puertas de producción que siguen cerradas

1. Integrar un **adaptador Stripe TEST real** con secret management y verificación de firmas nativas del proveedor; estos eventos del simulador no pueden utilizarse como hechos reales de pago.
2. Contrato firmado e idempotente para los importes y estado de pedido provenientes de M1; política de precios coherente entre módulos antes de lanzar pagos.
3. Conciliación de resultados y transferencias con el ledger de M3 mediante interfaz separada; no inferir saldos de una respuesta HTTP.
4. Reembolsos reales, reintentos seguros del proveedor, disputas, fallos de red, compensaciones y cierre de periodos.
5. Pruebas de infraestructura, seguridad, load/stress, backups/restore, alertas, permisos DB mínimos, antifraude, E2E en Flutter/PWA y cumplimiento fiscal.
6. Stripe Connect y pagos a comercios/repartidores tienen sus propias autorizaciones y requisitos; esta fase no inicia transferencias.

[Arquitectura y límites M8](../../docs/MODULO8-PAGOS-ARQUITECTURA.md).
