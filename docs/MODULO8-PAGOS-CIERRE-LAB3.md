# TALA EATS Core v2 — Acta de cierre independiente del Módulo 8 (Pagos)

**Fecha:** 4 de noviembre de 2026.
**Entrega:** LAB3 — dominio de Pagos, Stripe TEST aislado y endurecimiento SQL.
**Rama:** `feat/core-v2-pagos-foundation` (creada desde `main`).
**PR:** [#10](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/10) — debe permanecer **Draft**, sin merge.
**Ejecución:** Node.js 24, TypeScript estricto y PostgreSQL 16 descartable, esquema único `tala_payments_v2`.
**Estado de certificación:** **CERRADO EN LAB3**, validado con CI Node 24/PostgreSQL 16. Cierre estrictamente autónomo, no comercial.
**Despliegue comercial:** **NO-GO**, sin claves de Stripe LIVE, sin cargos reales, sin payouts y sin Kali.

## Alcance terminado, y dueño del dato

M8 es responsable exclusivamente de los registros de operaciones con el proveedor de pago, sus eventos firmados, reembolsos externos solicitados, idempotencia, hechos de proveedor y diagnóstico del mismo. Se entrega sin código importado, FK ni queries a tablas de otros módulos. El trabajo permanece aislado en `modules/payments/**` y las migraciones `001–003`.

| Función | Garantía aislada M8 |
| --- | --- |
| Solicitud de cobro | Una referencia de pedido por operación, identificadores UUID, importe MXN en centavos, operación idempotente |
| Estados LAB | `pending` a `succeeded/failed/canceled` por evento; ningún estado terminal vuelve a pendiente |
| Reembolsos | Solicitud parcial/total, saldo reservado `requested+succeeded`, reembolso fallido libera reserva; rechazo de sobre-reembolso |
| Stripe TEST | Cliente limitado a `sk_test_`, endpoints PaymentIntents/Refunds, sin `confirm=true`, transferencias, payouts ni Connect |
| Resiliencia | Clave de idempotencia externa persistida antes del POST remoto, lease 45 s y límite conservador de 20 h sin asignación; tras ese límite exige conciliación manual |
| Webhooks | HMAC del simulador separado de `Stripe-Signature` oficial, bytes originales, timestamp ±300 s, `livemode=false`, monto/moneda/referencia exactos, replay idempotente |
| Separación financiera | `verified_facts` del simulador y `stripe_test_facts` no comparten fuente ni se envían a M3; no significan dinero LIVE |
| Controles de consulta | Lectura privada solo de pagos cuyo `customer_ref` corresponde al actor. Lectura de todo requiere `canReadAllPayments` **y** `canReadPayments` inyectados por host |
| Monitor | `canMonitorPayments` separado y métricas agregadas, sin tarjetas, secretos ni datos personales |
| SQL endurecido | Trigger guard 003 para inmutabilidad de monto/moneda/ref, versiones, estados finales, máximo reembolsable; reservas serializadas por bloqueo del pago |
| Auditoría | Eventos, hechos y diario mínimo append-only; no se persisten datos de tarjeta, CVV ni secretos |
| HTTP LAB | Loopback, autenticación del host, limitación de entrada, respuesta no-store, sin CORS público, inhabilitado en `NODE_ENV=production` |

## Riesgos encontrados y corregidos durante la etapa de cierre

**1. IDOR de lectura de pagos:** el antiguo `canReadPayments` permitía consultar cualquier UUID. Ahora exige ser propietario o contar con permiso adicional `canReadAllPayments`; ante una referencia ajena devuelve el mismo código de no encontrado que ante inexistencia, evitando revelar existencias.

**2. Webhooks contradictorios:** `payment_intent.payment_failed` se valida como fallo de intento, no éxito de cobro; `refund.failed` exige estado fallido. Eventos con tipo/estado incompatibles son rechazados sin registrar pagos ni reembolsos exitosos.

**3. Manipulación directa de SQL:** la migración `003_integrity_guards.sql` bloquea cambios al monto, moneda y referencias de pagos; impide revivir pagos o reembolsos terminados; restringe cambios de proveedor y verifica que las reservas combinadas no superen el cargo, también ante inserciones SQL simultáneas.

**4. Riesgo de deadlock en triggers:** la reserva nueva adquiere bloqueo por pago; las actualizaciones de reembolsos (que no pueden aumentar montos) leen el pago sin invertir el orden de bloqueo de la API.

## Matriz de pruebas antes del cierre

- TypeScript estricto y pruebas de dominio centavos MXN, UUID, roles e inputs rechazados.
- PostgreSQL real en CI: migraciones `001 → 002 → 003`, rechazo de la instalación en otras bases.
- Ciclo de cobro y reembolso simulado, eventos HMAC válidos/alterados, timestamps, replays, cambios de estado, 12 callbacks simultáneos.
- Stripe TEST mediante transporte **simulado offline** (sin llamadas a Stripe): `PaymentIntent`, refund, diferencias de monto, livemode, permiso, respuesta incierta, lease/reintentos, contrato HTTP y firma oficial.
- Pruebas adversariales LAB3: lector de otra cuenta recibe no encontrado; eventos contradictorios rechazados; UPDATE directo de montos/refs/estados terminales y cuatro INSERT concurrentes de refund bajo 70 % del importe solo aceptan uno.
- Eventos y hechos inmutables en DB, sin integración financiera, transferencias externas ni cargos reales.
- Las pruebas de la cuenta Stripe TEST real **NO** se han efectuado. Los fixtures con formato Stripe no son certificación de interacción con un proveedor.

## Puertas independientes pendientes para una integración o LIVE

1. Probar una cuenta **Stripe TEST real** con su configuración de API y versiones confirmadas; webhooks oficiales por endpoint real, reconexión, replay, reembolsos y 3-D Secure. La versión de API fijada en el cliente deberá comprobarse contra dicha cuenta antes de permitir un despliegue.
2. Vinculación confiable con M1: snapshot de orden, importe y cliente autenticados por host, con precios/comisiones conciliados (no reutilizar datos del frontend sin verificación).
3. Integración con M3 mediante contrato `FundsConfirmed.v1` / `ProviderRefundConfirmed.v1` real, firmado e idempotente, **outbox durable**, ledger, conciliación y liquidación; NO transformar hechos TEST en fondos de producción.
4. Seguridad de servicio/gateway: permisos y revocaciones de usuarios reales, tasa de peticiones, límites, secreto rotado, roles SQL mínimos, TLS, monitorización, antiabuso y restauración de backups.
5. Manejo de dinero real: transacciones de Stripe LIVE, recuperación de resultados ambiguos, disputas, devoluciones asíncronas, manejo de contracargos, conciliación por periodos, transferencias Connect y retiros, todo fuera de esta aprobación.
6. Pruebas E2E Flutter Usuarios, app Restaurante, PWA Repartidores y operaciones de ADMIN sin modificar la titularidad de sus funciones.

## Decisión de avance de ingeniería

- **GO para desarrollar el siguiente módulo independiente** tras la validación de CI LAB3. Cada módulo nuevo debe nacer desde `main`; nunca depender del PR #10 Draft como rama base.
- **NO-GO para publicación, fusión a `main`, Stripe LIVE, transferencias, wallets operativas y reemplazo del backend Kali.**
- M8 se reabrirá ante un defecto o cuando se apruebe una integración externa. El cierre LAB no significa producción lista.

## Evidencia

[Arquitectura](MODULO8-PAGOS-ARQUITECTURA.md) ·
[LAB1](MODULO8-PAGOS-LAB1.md) ·
[LAB2 Stripe TEST](MODULO8-PAGOS-LAB2-STRIPE-TEST.md) ·
[README M8](../modules/payments/README.md).

**CI verificada:** [GitHub Actions #41899643591](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41899643591) — **SUCCESS** sobre commit `d1269474c29717f6c1a5685aad8031f1b9bc406d`; pruebas completas, migraciones 001–003, TypeScript y protección de base ajena. El presente ajuste documental no modifica el código funcional; verificar que su commit también apruebe CI.
