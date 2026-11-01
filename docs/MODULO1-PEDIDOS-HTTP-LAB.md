# CORE v2 · Módulo 1 PEDIDOS — HTTP de laboratorio (RC1)
**Estado:** API de pedidos cash completa en LAB con pickup/delivery. No comercial LIVE.
Ver contrato ampliado en [MODULO1-RC-FLUJO-COMPLETO-LAB.md](MODULO1-RC-FLUJO-COMPLETO-LAB.md).

## Contrato implementado
- `POST /api/v2/auth/register` alta de **customer** únicamente (email, displayName, password).
- `POST /api/v2/auth/login`, `GET /api/v2/auth/me`, `POST /api/v2/auth/logout`: sesión aleatoria en PostgreSQL, cookie HttpOnly SameSite Strict, TTL 24 horas.
- `GET /api/v2/restaurants` y `GET /api/v2/restaurants/:id/menu`: comercio abierto y catálogo desde PostgreSQL.
- `POST /api/v2/orders/quote`: id del restaurante, `fulfillment` pickup/delivery, `lines:[{productId,quantity}]`; el cliente nunca entrega precio.
- `POST /api/v2/orders`: los datos de la cotización más `paymentMethod:"cash"` e `idempotencyKey` de 16–128 caracteres. Crea pedido `received`, descuenta stock, almacena snapshot de precio, líneas, evento y outbox **en una transacción**.
- `GET /api/v2/orders/mine`, `GET /api/v2/orders/:id` (cliente propietario).
- `GET /api/v2/merchant/orders` (miembros activos, rol merchant).
- `PATCH /api/v2/merchant/orders/:id/status` con `{status:"confirmed"|"preparing"|"ready",expectedVersion:"1",commandKey:"..."}`: estado, versión, auditoría y outbox atómicos.
- `POST /api/v2/orders/:id/cancel` y `POST /api/v2/merchant/orders/:id/cancel` con `{expectedVersion,commandKey}`: **solo efectivo pendiente**, antes de preparación (cliente: recibido; comercio: recibido o confirmado). Devuelve el stock exactamente una vez.
- El handoff cash y los pasos del driver **sí están disponibles en LAB**; ver el contrato ampliado. No existen Stripe LIVE, payout, GPS verificado, ledger de liquidación ni reembolso.

Toda mutación necesita `Content-Type: application/json`, `X-Talaeats-Client: core-v2-lab`, origen coincidente y sesión cuando corresponda. La sesión se obtiene de una cookie segura para el alcance LAB; no hay credenciales por rol enviadas desde el cliente. `register` no permite crear comercios; el bootstrap de cuentas merchant es exclusivo del script de laboratorio.

## Activación aislada
1. Crear una DB PostgreSQL **nueva** llamada `tala_core_v2_lab` en loopback, con usuario propio sin acceso a `tala_node_live` ni `tala_node_stage`. Nunca reutilizar DB del backend en producción.
2. `npm install --ignore-scripts`, `npm test` y `npm run build`.
3. Aplicar, en orden, `migrations/001_orders.sql`, `002_order_permissions.sql`, `003_orders_http_lab.sql`, `004_order_handoffs_lab.sql` exclusivamente con la URL de LAB.
4. Preparar `.env`: `CORE_V2_DATABASE_URL` con hostname `127.0.0.1` y DB `tala_core_v2_lab`, `CORE_V2_HOST=127.0.0.1`, `CORE_V2_PORT=18210`, `CORE_V2_RUNTIME=isolated-lab`, `CORE_V2_WRITES_ENABLED=true`. **Todo otro entorno rechaza escrituras al arrancar.**
5. Proveer `CORE_V2_LAB_MERCHANT_EMAIL` y `CORE_V2_LAB_MERCHANT_PASSWORD` por entorno, ejecutar `node --experimental-strip-types scripts/seed-lab.mjs`. Proveer `CORE_V2_LAB_DRIVER_EMAIL` y `CORE_V2_LAB_DRIVER_PASSWORD` para `node --experimental-strip-types scripts/seed-driver-lab.mjs`. No subir credenciales a Git.
6. `npm run dev`, solicitar `GET http://127.0.0.1:18210/ready` y luego `GET /api/v2/health`. `ready=true` comprueba migraciones esenciales, **no certifica finanzas**.

## Secuencia de uso
- Crear buyer con `POST /auth/register`, iniciar sesión con `POST /auth/login` y conservar cookie HttpOnly del mismo origen.
- Consultar `GET /restaurants` y `GET /restaurants/:id/menu`; cotizar con `POST /orders/quote`.
- Comprar **en efectivo** con una `idempotencyKey` nueva por intención. Si se corta la red, repetir exactamente la misma clave y payload, nunca crear una intención distinta para la misma compra.
- El comerciante inicia sesión con la cuenta seed de laboratorio, consulta `GET /merchant/orders` y avanza `received → confirmed → preparing → ready`. Cada acción lleva `expectedVersion` del último GET y una `commandKey` nueva.
- La cancelación cash solo ocurre antes de preparar. En `ready` puede entregarse por pickup o reclamada por driver LAB; el comprador genera PIN y ambas partes acusan el efectivo antes de finalizar.

## Requisitos pendientes para producción
- Validar físicamente la entrega de cash, custodia, conciliación y resolución de disputas en operaciones reales; el acuse y PIN LAB no prueban una transferencia financiera.
- Logística comercial: despacho automático, GPS verificado, medidas antifraude, PIN y evidencias en apps reales.
- Stripe TEST con webhook firmado, estados reales de pago, reembolsos y ledger/conciliación.
- Vincular las PWAs reales a este contrato y validar compatibilidad, autenticación, avisos y UX.
- Rate limiting, MFA/OTP, protección de sesiones web en HTTPS detrás de reverse proxy, vigilancia de intentos fraudulentos.
- Workers para outbox, reintentos y notificaciones, observabilidad, alertas y respaldo/restore.
- Validar la tarifa propuesta: CORE v2 usa **17%**, frente al piloto histórico de **15%**; no publicarla sin decisión comercial.
- Test completo de Android/iOS, carga, seguridad, respaldo/rollback y migración progresiva, sin dos escritores en la misma operación.

**Pruebas:** `tests/orders-http-lab.test.mjs` recorre HTTP y PostgreSQL 16 con autenticación real de laboratorio, venta, idempotencia, pago no soportado, concurrencia, cancelación, inventario y eventos. Nunca usa Stripe o la DB LIVE.
