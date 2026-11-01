# TALA EATS CORE v2 · MÓDULO 1 PEDIDOS RC — Flujo LAB completo
**Alcance:** sistema de pedidos CASH aislado en PostgreSQL local. **NO-GO comercial/LIVE**.

## Qué está implementado
El Módulo 1 opera con un único origen de verdad transaccional:
- Cliente: registro/login, catálogo, cotización desde BD, pedido efectivo con idempotencia y descuento de stock, historial, cancelación permitida con restitución.
- Comercio: lectura por membresía activa, aceptar, preparar, marcar listo, registrar recepción de efectivo de retiro, y completar pickup con PIN del comprador.
- Repartidor: cuenta lab provisionada/validada, perfil aprobado y en línea, consulta de pedidos delivery disponibles, reclama uno (bloqueo transaccional), recoge, sale en ruta, acusa efectivo y completa con PIN.
- Comprador: genera un PIN aleatorio de **8 dígitos**, solo visible desde sesión propia, válido 10 minutos; confirma que entregó el efectivo. Cinco PIN incorrectos bloquean el código; puede regenerarlo.
- Finalización: **doble acuse del efectivo (comprador + custodio correcto) y PIN**; cambio a `delivered`, `payment_status='paid'` por entrega de efectivo físicamente atestiguada, PIN consumido; evento y outbox en un solo COMMIT.
- El efectivo queda en `tala_core_v2.order_handoffs` con `cash_amount_minor`, `custodian_id`, `custodian_role` y `custody_settled_at=NULL`. **NO es saldo bancario conciliado, ni Stripe, ni transferencia al restaurante**.
- Ningún comprador puede registrar un restaurante o un repartidor. Las cuentas comerciales y de flota se crean solamente mediante semilla administrativa de LAB.

## Migraciones (solo DB local `tala_core_v2_lab`)
Aplicar **en este orden**: `001_orders.sql` → `002_order_permissions.sql` → `003_orders_http_lab.sql` → `004_order_handoffs_lab.sql` → `005_orders_integrity_lab.sql` → `006_order_pin_rate_lab.sql`.
No hay migración para ninguna base LIVE; `tala_node_live` y `tala_node_stage` están fuera de alcance.

## Rutas HTTP en LAB
| Actor | Ruta | Propósito |
|---|---|---|
| Cliente | `POST /api/v2/orders` | Crear pedido cash e inventario |
| Cliente | `GET /api/v2/orders/mine`, `GET /api/v2/orders/:id` | Consultar |
| Cliente | `POST /api/v2/orders/:id/cancel` | Cancelación restringida |
| Comercio | `GET /api/v2/merchant/orders` | Pedidos autorizados |
| Comercio | `PATCH /api/v2/merchant/orders/:id/status` | confirmed/preparing/ready |
| Repartidor | `GET /api/v2/driver/available` | Delivery listos para reclamar, sin exponer dirección |
| Repartidor | `GET /api/v2/driver/orders` | Pedidos asignados, con dirección |
| Repartidor | `POST /api/v2/driver/orders/:id/claim` | Reclamar entrega, status=assigned |
| Repartidor | `PATCH /api/v2/driver/orders/:id/status` | picked_up, on_the_way |
| Cliente | `POST /api/v2/orders/:id/handoff-pin` | Generar/rotar PIN, body `{}` |
| Cliente | `POST /api/v2/orders/:id/cash-paid` | Confirmar entrega de efectivo, body `{}` |
| Comercio | `POST /api/v2/merchant/orders/:id/cash-received` | Custodia efectivo pickup, body `{}` |
| Repartidor | `POST /api/v2/driver/orders/:id/cash-received` | Custodia efectivo domicilio, body `{}` |
| Comercio | `POST /api/v2/merchant/orders/:id/complete` | Pickup entregado con PIN |
| Repartidor | `POST /api/v2/driver/orders/:id/complete` | Delivery entregado con PIN |

Todos los POST/PATCH envían `Content-Type:application/json`, `X-Talaeats-Client:core-v2-lab`, cookie de sesión HttpOnly del mismo origen. Comandos de estado usan `{expectedVersion:"4",commandKey:"cmd-<UUID>"}`, completion añade `pin:"12345678"`. Los números de versión se leen de la respuesta previa; nunca se inventan. El backend deriva actor, precios y total de DB, no del cuerpo JSON.

## Activación solo para prueba
Seguir `docs/MODULO1-PEDIDOS-HTTP-LAB.md`, con migración 004 añadida. Crear perfiles:
- Restaurante: `CORE_V2_RUNTIME=isolated-lab`, `CORE_V2_DATABASE_URL=postgresql://...@127.0.0.1:15450/tala_core_v2_lab`, `CORE_V2_LAB_MERCHANT_EMAIL`, `CORE_V2_LAB_MERCHANT_PASSWORD` y `node --experimental-strip-types scripts/seed-lab.mjs`.
- Repartidor: misma URL local, `CORE_V2_LAB_DRIVER_EMAIL`, `CORE_V2_LAB_DRIVER_PASSWORD`, y `node --experimental-strip-types scripts/seed-driver-lab.mjs`.
- Arranque: `CORE_V2_RUNTIME=isolated-lab`, `CORE_V2_WRITES_ENABLED=true`, `CORE_V2_HOST=127.0.0.1`, `CORE_V2_PORT=18210`; el esquema completo 001–004 debe existir. En cualquier otro contexto las escrituras están deshabilitadas.
- Se requieren credenciales **exclusivas** y red aislada; nunca exportar secretos ni conectar a producción.

## Seguridad y límites críticos
- Locks transaccionales, `expectedVersion`, idempotencia, eventos append-only y outbox; nunca dos conductores aceptan el mismo pedido.
- PIN aleatorio, hash scrypt+sal, duración 10 minutos, 5 fallos máximo, consumido en la misma transacción que la entrega; no se almacena ni registra en claro.
- Emisión o rotación: máximo 6 PIN por pedido cada 10 minutos, con cuota persistente y HTTP 429 al excederla.
- El comprador debe acreditar el efectivo pagado y el custodio debe confirmar físicamente haberlo recibido. Sin ambos acuses y PIN correcto, la entrega es rechazada. Reutilizar la misma clave con otro PIN produce conflicto.
- Conductor exige rol `driver`, cuenta activa, aprobación, estado en línea para reclamar, asignación propia para operar.
- La cola de disponibles no incluye dirección ni identidad del cliente.
- El cierre de pedido **no prueba liquidación bancaria, que un banco vio el efectivo, ni la autenticidad física fuera de las dos declaraciones**.
- El registro de la entrega de efectivo es un control de aplicación, no un ledger completo; requiere conciliación financiera y resolución de disputas antes de LIVE.

## Validaciones requeridas y pendientes
- CI de Node 24 y PostgreSQL 16 con suite de pedidos, autorizaciones, flujo E2E pickup/delivery, PIN incorrecto/rotación, múltiples intentos, doble acuse y trazabilidad; no usa servicios externos.
- Pendiente antes de LIVE: Stripe TEST webhook firmado, conciliación, ledger/wallet, cálculo final de tarifas, integración de PWAs reales, GPS, seguimiento y despacho de flota, antiabuso distribuido, atención de disputas, pruebas Android/iOS, restore/rollback y autorización de cutover.
- `main` y Kali LIVE permanecen intactos hasta completar esas validaciones.

**Estado:** versión candidata funcional del Módulo Pedidos **en LAB**; aún no versión comercial publicable.
