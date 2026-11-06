# Tala Eats Core v2 — Integración LAB8: pedido Stripe TEST protegido por M8

**Fecha de trabajo:** 5 de noviembre de 2026, hora de México.
**Rama:** `feat/core-v2-integracion-monolito-m11`; PR #13 permanece en Draft.
**Alcance:** flujo TEST en PostgreSQL descartable con transporte Stripe inyectado, sin salir a Stripe, sin operaciones LIVE y sin merges o despliegue a Kali.
**Estado de aprobación:** **LAB8 aprobado en CI funcional** [#42169799206 — SUCCESS](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42169799206), 285 ejecuciones de prueba PASS y 0 FAIL; la edición documental final requiere una CI adicional.

## Problema original

El único checkout público/laboratorio de M1 existente era `createCashOrder`, que crea un pedido en `received`, con `payment_method='cash'` y `payment_status='pending'`. Usarlo para un PaymentIntent real alteraría la semántica del cobro, permitiría aceptación de restaurante antes de verificar el medio de pago y dejaría un caso complejo de contracargos.

LAB8 crea **exclusivamente dentro de M11** un port transitorio `m1-extension/stripe-test-orders.ts`, sin editar el código original de M1, y mantiene las extensiones `m6-extension` de LAB6. **No es todavía la implementación final de M1 para producción.**

## Flujo TEST implementado

1. **M4 + M11:** sesión vigente, vínculo M4↔M1 verificado en LAB4, idempotencia por `buyer + key`, identidad del comprador fuera del cuerpo de la solicitud.
2. **M6:** reserva física por sucursal que genera recibo durable; no se descuenta dos veces ante reintentos.
3. **M1 TEST:** el port `createLabM1StripeAwaitingPayment` verifica bajo bloqueo propio el inventario espejo, nombre, precio y cantidad contra la variante M6 reservada, descuenta espejo M1 y crea de manera atómica el pedido `awaiting_payment / stripe / pending`, snapshot financiero, líneas y outbox.
4. **M8 real:** `createPayment` vincula el `orderRef`, `customerRef`, importe en centavos y MXN; `createStripeTestIntent` usa clave `sk_test_`, idempotencia duradera y cliente Stripe TEST con transporte **offline** en CI.
5. **PSP TEST:** M8 comprueba `Stripe-Signature` en bytes exactos, el `livemode=false`, PaymentIntent vinculado a pago M8, metadatos `m8_payment_id`, moneda y monto; persiste `stripe_test_facts` por separado de `simulated_lab`.
6. **Reconciliador M11:** `reconcileStripeTestLabPickup` solo es invocable por un host interno autorizado. Lee el objeto M8 mediante `readPayment`, comprueba `FundsConfirmed.v1` con `source='stripe_test'` y monto/cliente/pedido coincidentes y solo entonces invoca el port LAB de M1 `commitVerifiedLabStripePayment`.
7. **M1 + M6:** en una transacción M1 se actualiza el pedido a `received / paid`, se agrega evento de auditoría y outbox; M6 confirma la reserva original y M11 anota el estado durable `verified`.

**Invariante:** si no hay webhook Stripe TEST firmado y validado en M8, M1 permanece `awaiting_payment`, M6 mantiene el hold y el comercio NO debe aceptar el pedido. Nunca se convierte `orders.order_created` en notificación de pago.

## Seguridad y validación

- Los IDs de tienda/variante se resuelven desde el vínculo M6↔M1, no de una oferta monetaria suministrada por el navegador.
- El precio de M1 se calcula sobre filas bloqueadas dentro de su propia transacción y se comprueba contra el snapshot de M6.
- Las funciones temporales M1 y M6 operan únicamente sobre bases de prueba; `NODE_ENV=production` se rechaza.
- Se rechazan eventos Stripe con `livemode=true`, firma manipulada, moneda/importe inconsistente o proveedor simulador sin hecho TEST.
- Un webhook legítimo repetido no duplica hechos M8 ni el evento de pago de M1. La intención del host es durable, pero un timeout ambiguo entre DB puede requerir redrive.
- Las claves `sk_test_` y `whsec_` usadas en CI son ficticias e inyectadas; **no hay contacto real con Stripe ni con tarjetas**.
- El frontend comercial no recibe ninguna ruta M11/checkout nueva: todo se invoca en funciones internas LAB.

## Restricciones restantes (NO-GO LIVE)

1. **Migrar el port `m1-extension` a una implementación de M1 con propiedad del código y contrato formal.** El argumento de prueba `source:'stripe_test_verified_in_m8_lab'` es un dato in-process y NO una credencial/productor autenticado de producción: el host debe demostrar con un comprobante autenticado M8 y autorización de servicio antes de permitir que M1 avance.
2. **Cancelaciones y expiración:** los PaymentIntents iniciados tienen TTL y riesgos de completarse después de un timeout. No liberar holds ni revertir stock mientras exista una liquidación Stripe TEST incierta. Debe añadirse la recuperación/cancelación de PaymentIntent, refunds probados y compensación entre M1, M6 y M8.
3. **Política de comisiones:** M1 mantiene `pilot-2026-11-v2-17pct` frente a 15 % fijado comercialmente; tanto M11 como M3 deben tratarla como **HOLD**, sin tasas LIVE ni saldos retirables.
4. **M3 y M5:** no registrar obligaciones disponibles ni notificar al comercio hasta que M1 haya confirmado el hecho financiero; aún falta extender el flujo Stripe TEST a preparación, entrega, reembolsos y conciliación.
5. **M2 entrega a domicilio/M7 zonas:** todavía sin cableado comercial de punta a punta; solo el retiro en efectivo de LAB7 dispone de prueba E2E completa.
6. **Infraestructura:** workers para relé de outbox, DLQ/redrive, autorización fuerte, roles SQL mínimos, auditoría y monitoreo, migraciones en staging, backup/rollback, estrés y pruebas reales de las apps.

**Conclusión:** LAB8 pasó el gate de código en GitHub Actions #42169799206; falta ratificar el último HEAD documental. Aun con CI en verde, **no se declara el backend comercial 100 % funcional**.

## Evidencia del LAB8 validado

- CI global M11: [#42169799206](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42169799206), **285 ejecuciones PASS, 0 FAIL**.
- Casos LAB8 reales: M6 hold → M1 awaiting_payment → M8 real (Stripe TEST vía transporte offline) → webhook con HMAC verificado → M1 received/paid y reserva confirmada; sin webhook firmado permanece pendiente.
- M8 original no se modificó. Un bridge de carga tipada usa los módulos M8 existentes, manteniendo la compilación estricta de M4/M11.
- La factura y movimientos bancarios NO fueron creados; la CI no usa tarjetas ni dinero real.
- El commit que actualiza esta evidencia documental será validado por una nueva ejecución antes de declarar cerrado el HEAD.
