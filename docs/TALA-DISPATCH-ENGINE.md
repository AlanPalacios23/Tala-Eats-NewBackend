# TALA Dispatch Engine — metodología v1 del Módulo 2 (LAB)

**Origen:** el nombre **TALA Dispatch Engine** lo ha definido el proyecto.
La imagen compartida solo contiene ese nombre. Las siguientes reglas son
la **propuesta técnica implementada para TALA EATS**, no una metodología
preexistente inferida de la imagen.

## El flujo T–A–L–A

1. **T — Trigger / disparador:** solo órdenes de tipo `delivery` que hayan
   alcanzado `ready` pueden ser candidatas. Se requerirá un adaptador
   autenticado desde Pedidos que verifique que el evento y la versión de la
   orden son verdaderos. **Aún no implementado.**
2. **A — Availability / disponibilidad:** exigir conductor aprobado, en
   línea, con zona compatible y heartbeat no más antiguo de 120 segundos.
   No se consulta ni se publica la dirección del comprador.
3. **L — Load / carga:** exigir `activeDeliveries < maxConcurrentDeliveries`.
   Entre los elegibles, primero menor número de entregas activas y, si
   empatan, UUID del repartidor ascendente. Política reproducible v1;
   **no** incluye aún distancia real, GPS, ETA ni optimización de rutas.
4. **A — Atomic assignment / reserva transaccional:** la evaluación pura
   devuelve solamente `PROPOSE`. La función `reserveDelivery` de Módulo 2
   revalida presencia/carga bajo bloqueo SQL (`SKIP LOCKED`), usa bloqueo
   por orden, hace una sola reserva y registra evento y outbox atómicamente.
   **No modifica el estado del pedido.**

## Código y API interna

- `src/modules/modulo-2-logistica/tala-dispatch-engine.ts`:
  `evaluateTalaDispatch` y `isDispatchTriggerReady`, deterministas,
  sin acceso a SQL, red o finanzas.
- `src/modules/modulo-2-logistica/assignment-policy.ts`:
  compatibilidad con la API previa `planCourierAssignment`, ahora
  delega en el motor.
- `src/modules/modulo-2-logistica/dispatch-service.ts`:
  persistencia, reserva segura, idempotencia y evidencias de asignación.
- `src/modules/modulo-2-logistica/migrations/001_logistics_lab.sql`:
  esquema independiente de Logística.
- En cada evento y mensaje de outbox se guarda el nombre y versión de
  la política, para poder auditar futuros cambios de asignación.

## Estados y motivos de decisión

| Decisión | Motivo | Significado |
|---|---|---|
| `NOT_ELIGIBLE` | `ORDER_NOT_READY` | No es entrega lista |
| `NO_AVAILABLE_COURIER` | `NO_ONLINE_COURIER` | Sin repartidores en línea/aprobados/frescos en zona |
| `NO_AVAILABLE_COURIER` | `NO_CAPACITY` | Todos los elegibles están completos |
| `PROPOSE` | `CANDIDATE_REQUIRES_DB_COMMIT` | Se propone candidato, aún sin reservar |

La **reserva confirmada** solo se representa como `RESERVED` después
de un `COMMIT` PostgreSQL exitoso; un `PROPOSE` nunca demuestra un pedido
asignado. El servicio SQL mantiene bloqueos, versiones y llaves de
idempotencia, y no expone endpoints HTTP.

## Puertas para la siguiente etapa

- Adaptador autenticado `Pedidos → Logística`, verificación de evento y
  versión real de la orden y confirmación/reversión transaccional.
- GPS autorizado y datos recientes, geocercas, cálculo de distancia de ruta
  por proveedor real, ETA y políticas de reintento/expiración de despacho.
- Reasignación recuperable, observabilidad, índices y pruebas de carga
  a volumen de operación comercial.
- Validaciones de seguridad de las PWAs e integridad de finanzas.

**NO-GO comercial.** Sin cambios a Kali, Stripe, wallets o módulo de Pedidos.
Las pruebas usan PostgreSQL 16 descartable de CI. El motor no fue
desplegado en Render ni conectado a las PWAs.
