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

## LAB 2 — ubicación GPS y proximidad (versión 2.0.0-lab)

La metodología T–A–L–A v1 y la selección transaccional original permanecen
sin cambios para conservar la regresión. Se agregó una **capacidad separada
de propuesta geográfica**, no una asignación comercial:

- `geo.ts`: Haversine, validación de coordenadas y orden de candidatos
  por distancia recta al restaurante, luego carga y UUID.
- `location-service.ts`: `recordCourierPosition` y
  `listNearbyCouriers`. Solo acceso interno; no hay rutas HTTP públicas.
- `migrations/002_courier_position_lab.sql`: almacena **un único último
  punto GPS por conductor**, sin historial de recorridos. La base borra ese
  punto al pasar a offline o revocar aprobación.
- Un reporte solo se acepta con precisión 0–100 metros y conductor aprobado,
  online y presencia no mayor a 120 segundos.
- La consulta excluye posiciones antiguas, conductores sin capacidad, de
  otra zona o no aprobados; devuelve solo identificador, carga, edad de
  posición y **distancia aproximada**, nunca coordenadas GPS.
- No se mantiene coordenada ni dirección de compradores en este módulo.

**Limitaciones:** la hora de recepción es del servidor; todavía NO existe
verificación de autenticidad de GPS del dispositivo ni vinculación de identidad
del conductor a las llamadas de ubicación. La distancia Haversine no equivale
a ruta vial ni ETA. El orden geográfico es una propuesta; no se conecta aún
al bloqueador transaccional de asignación ni modifica Pedidos.

**Pendiente para la siguiente fase:** autenticar las actualizaciones desde
la PWA Repartidores, consentimiento y privacidad GPS, verificación de eventos
de Pedidos, reserva más próxima con revalidación SQL, ruteo vial con proveedor
real y reasignación segura. Comercial sigue **NO-GO**.

## V2 — decisión por GPS con COMMIT y recuperación

La V1 sigue siendo compatible. Además, V2 incorpora:
1. `reserveNearestDelivery`: recibe el punto de recogida de un **adaptador
   de confianza todavía pendiente**. La consulta PostgreSQL filtra ubicación
   de no más de 120 segundos, aprobación, presencia, zona y capacidad; prioriza
   la menor distancia Haversine con `FOR UPDATE OF c SKIP LOCKED`. Confirma
   únicamente tras insertar reserva, evento y outbox en la misma transacción.
2. `reassignUnavailableDelivery`: solo permite recuperar una reserva GEO
   cuando el conductor original está offline, sin aprobación, sin presencia
   vigente o sin GPS reciente. La nueva asignación aumenta la versión y
   escribe el evento inmutable `dispatch.reassigned`.
3. Seguridad: un mismo comando no puede cambiar silenciosamente entre
   modalidad `capacity` y `proximity`. Los eventos no guardan coordenadas.
   Si no hay sustituto o el conductor sigue disponible, no cambia la reserva.

**Sin autorización comercial:** una persona podría recoger el producto antes de
que su GPS deje de reportar. El motor **no debe reasignar ese pedido**
hasta que Pedidos certifique que sigue sin recogerse. El servicio todavía
no consume un evento firmado/verificado `order.ready`, no autentica al
repartidor ni controla GPS del dispositivo. No hay ETA de carretera, rutas
turn-by-turn, integración financiera, pagos ni publicación en PWAs.

## LAB V2 Hardening — idempotencia y recogida verificada
La identidad del comando se valida con un SHA-256 de entrada canónica.
Reserva, finalización y recuperación se niegan si una misma llave
reutiliza otros valores. Una confirmación obsoleta de asignación nunca
se presenta como conductor actual. No se agregaron coordenadas a
eventos ni outbox.

La recuperación GEO requiere que un adaptador confiable compruebe
en la **misma transacción** que el pedido M1 existe, sigue
`assigned` a ese conductor, es de entrega a domicilio y no tiene
evidencia irreversible de recogida/entrega ni PIN consumido.
El adaptador `src/integrations/orders-logistics/verify-pre-pickup.ts`
es de solo lectura y se prueba con PostgreSQL 16; mantiene ambas
carpetas de negocio independientes.

**Todavía NO existe el handoff transaccional completo entre módulos**:
el cambio en la reserva de Logística NO actualiza el conductor asignado
en el módulo de Pedidos. Tampoco hay autenticación HTTP, permisos GPS
de la PWA, liquidación financiera, ETA vial o deploy público.
Prohibido utilizar el servicio como dispatcher comercial hasta
completar esa transacción multi-módulo y las pruebas E2E.
