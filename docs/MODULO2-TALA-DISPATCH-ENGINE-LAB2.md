# TALA EATS · Módulo 2 — Tala Dispatch Engine LAB2

**Estado: implementación de laboratorio. NO-GO comercial.** Depende del PR #1 Pedidos y de Logística LAB1 del PR #4.

## Política de despacho actual

- Pedidos **cash/pending** a domicilio en estado **ready**; se selecciona el más antiguo primero.
- Un trabajador interno invoca `dispatchNext(pool)`; no hay endpoint HTTP público para iniciar el despacho.
- Orden de candidatos: repartidor activo, aprobado, online, libre (capacidad=1), sin ofertas pendientes, sin ofertas previas del mismo pedido; prioridad `presence_updated_at`, luego ID para resultados deterministas.
- El motor **no fuerza una asignación**: genera una oferta con vencimiento a **60 segundos**. El conductor acepta o rechaza voluntariamente.
- Una oferta pendiente por pedido y por conductor, garantizado mediante índices únicos parciales PostgreSQL, incluso bajo concurrencia.
- Después de diez ofertas históricas para un pedido, no se generan nuevas ofertas automáticas; requiere revisión humana. No es una garantía de que exista repartidor.
- No hay coordenadas verificadas de comercios; por lo tanto **NO calcula cercanía, ruta óptima, distancia o ETA** ni sugiere tiempos simulados.

## API exclusivamente en LAB local

| Método | Ruta | Propósito |
| --- | --- | --- |
| GET | `/api/v2/driver/dispatch-offers` | Muestra únicamente ofertas propias vigentes, restaurante y vencimiento; jamás el domicilio ni el nombre del comprador. |
| POST | `/api/v2/driver/dispatch-offers/:offerId/accept` | Requiere identidad driver y cuerpo JSON `{}`; valida vencimiento, perfil, versión, efectivo y capacidad en una transacción. |
| POST | `/api/v2/driver/dispatch-offers/:offerId/decline` | Rechazo seguro; un reintento del mismo rechazo es idempotente. |

Las rutas existentes de `claim` se bloquean mientras una oferta pendiente afecte al pedido o al conductor. El domicilio solo se lee por su titular o un repartidor con asignación confirmada.

## Worker y recuperación

- Runner de **un ciclo**: `scripts/dispatch-lab-once.mjs`. Requiere `CORE_V2_RUNTIME=isolated-lab`, `CORE_V2_WRITES_ENABLED=true`, `NODE_ENV` distinto de production, PostgreSQL localhost y nombre `tala_core_v2_lab` o `tala_core_v2_test`.
- El runner no se instala como servicio, no tiene cron y no está desplegado a Render/Kali; ejecutar varias veces es una decisión explícita del operador de LAB.
- `expireDispatchOffers(pool)` libera ofertas caducadas con bloqueos en orden **pedido → oferta**, registra eventos append-only y outbox. No toca un pedido ya recogido.
- `recoverUncollectedAssignment(pool, orderId, expectedVersion, commandKey)` es una función **interna para revisión manual**, nunca una ruta HTTP. Requiere estado `assigned`, asignación con 20 minutos o más, y **sin PIN emitido, efectivo confirmado ni evidencia de custodia**. Rechaza `picked_up` y `on_the_way`; registra recuperación y elimina solo GPS efímero del conductor anterior.
- Todas las operaciones persistentes usan transacciones, versionado de pedidos, eventos y outbox. **Aceptar efectivo no equivale a liquidarlo**; el módulo de Finanzas aún no implementa ledger final.

## Esquema y pruebas

- Migración nueva `migrations/009_tala_dispatch_engine_lab.sql`, **después de 001–008, únicamente en una base descartable**.
- `tests/tala-dispatch-engine.test.mjs`: dos trabajadores concurrentes, propiedad de ofertas, consentimiento, bloqueo de self-claim, idempotencia, vencimiento y recuperación protegida.
- La suite CI usa PostgreSQL 16 aislado y comprueba el gate de servidor: en Render público las rutas de logística/despacho siguen inexistentes (`CORE_V2_WRITES_ENABLED=false`).

## Pendiente antes de cualquier GO

Geocodificación y consentimiento del usuario; coordenadas verificadas de comercio/entrega y alcance geográfico; GPS autenticado en dispositivos; ETA de proveedor real; propuesta/ranking espacial; límites por zona; seguridad contra ataques de ubicación; cola de trabajo con reintentos distribuidos y alertas; expiración programada; respaldo/rollback; integración PWA; reconciliación financiera; prueba E2E comercial. **Ninguno está certificado en LAB2.**

**Kali, PM2, apps de producción, Stripe LIVE, el servicio Render y su base Free no se modifican.**