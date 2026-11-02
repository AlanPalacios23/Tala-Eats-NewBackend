# TALA EATS CORE v2 — Módulo 2 Logística · LAB 1

Motor **independiente** de Pedidos, bajo `src/modules/modulo-2-logistica/`.

## Metodología TALA Dispatch Engine

**T**rigger (pedido listo para delivery) → **A**vailability (repartidor
aprobado, online y reciente) → **L**oad (zona, capacidad y carga) →
**A**tomic assignment (reserva SQL idempotente).

`evaluateTalaDispatch` produce una propuesta y una traza de etapas;
`reserveDelivery` verifica nuevamente bajo bloqueo y confirma la reserva.
El cálculo de distancia GPS, ETA y optimización real de rutas **no** se han
implementado. Ver [documentación de metodología](../../../docs/TALA-DISPATCH-ENGINE.md).

## Funciones ya desarrolladas
- `enrollCourier`: alta interna, sin autoaprobar conductores
- `approveCourier`: aprobación o revocación; revocar obliga quedar offline
- `setCourierOnline`: presencia validada con hora del servidor
- `planCourierAssignment`: política pura de zona, aprobación, actividad y capacidad
- `reserveDelivery`: reserva SQL atómica para órdenes de domicilio declaradas `ready` por un **adaptador interno confiable**, nunca por un cliente público
- `finalizeDispatch`: cierre/release de la reserva; devuelve capacidad y mantiene historia
- Eventos inmutables + outbox propio de Logística
- PostgreSQL 16: migración `migrations/001_logistics_lab.sql` en esquema `tala_logistics_v2`

## Barreras
- No modifica `tala_core_v2.orders`, el estado del pedido, inventario, efectivo,
  Stripe, PIN ni los eventos de Módulo 1.
- No hay rutas HTTP de Logística públicas o privadas en el servidor.
- **No hay aún adaptador de identidad** ni verificación transaccional del estado
  del pedido con Módulo 1; solo código interno probado con datos sintéticos.
- No entrega a repartidores ningún dato personal del comprador.
- No integra GPS, ETA ni rutas de vehículos todavía.
- Los nombres de comandos no son credenciales de autorización: el llamador
  de este servicio debe ser un backend confiable y autenticado.

## Integración planificada
El módulo de Pedidos emitirá un evento `order.ready`; un adaptador autenticado
consultará elegibilidad, invocará `reserveDelivery` y confirmará la asignación
en la transacción propietaria de Pedidos. Si esa confirmación falla, revertirá
la reserva logística mediante compensación idempotente. No usar el motor directo
como si ya existiera el flujo comercial de las PWA.

## Validación
Las pruebas SQL se ejecutan exclusivamente con `PG_CI_URL` apuntando a
`tala_core_v2_test` en CI (PostgreSQL 16 desechable). La migración Logística
se aplica después de 001–007 Pedidos, sin tocar sus tablas.

## GPS y proximidad — LAB 2
- Migración `002_courier_position_lab.sql`: **solo la última posición** del conductor, con restricciones de coordenadas y precisión. Se elimina al ponerse offline o perder aprobación.
- `recordCourierPosition`: entrada interna y validada; se exige aprobado, online y presencia reciente. Sello temporal del servidor, sin endpoint público. Falta verificar identidad del conductor y origen auténtico del GPS.
- `listNearbyCouriers`: sugiere candidatos elegibles por zona y posición de hace máximo 120 segundos, con capacidad libre; **devuelve distancia recta aproximada, nunca coordenadas privadas**.
- `straightLineMeters`: Haversine. **No** conoce calles, rutas reales, tráfico ni ETA. No sustituye la selección SQL v1 que ya está probada; la proximidad será integrada a la reserva solo después de un adaptador de identidad y pedido verificado.
- Se aplicó el cambio solo al backend de LAB y CI, no a Render ni a Kali.

## V2 — reserva por cercanía y recuperación transaccional (LAB)
- `reserveNearestDelivery` selecciona al conductor geográficamente más cercano
  al punto de recogida verificado por un **futuro adaptador interno de Pedidos**,
  siempre bajo bloqueo SQL y con GPS vigente, zona compatible y capacidad libre.
  La política `reserveDelivery` por carga de V1 sigue vigente y probada.
- Se registra `dispatchMethod: proximity` y `dispatchEngineVersion: 2.0.0-lab`
  en eventos y outbox. Reutilizar una llave idempotente cambiando de método
  provoca `LOGISTICS_DISPATCH_MODE_CONFLICT`, no una confirmación engañosa.
- Migración `003_dispatch_reassignment_lab.sql`: eventos inmutables
  `dispatch.reassigned` y outbox correspondientes.
- `reassignUnavailableDelivery` permite mover una reserva **originada
  por GEO** cuando el conductor ya no está disponible. Bloquea la orden
  y al nuevo conductor, revalida GPS/capacidad, incrementa versión y
  registra origen y destino en un mismo COMMIT. No altera Módulo 1.
- El motor no distingue si el conductor ya recogió el pedido; **queda
  prohibido usar esta reasignación comercialmente** hasta verificar
  el estado de recogida y la versión del pedido mediante un adaptador
  autorizado de Pedidos. Tampoco existe autenticación del GPS desde PWA.
- Ninguna función se expone como API en Render, Kali o la PWA; las
  pruebas se ejecutan solamente en PostgreSQL 16 de GitHub Actions.

## V2 — endurecimiento de contratos y frontera con Pedidos (LAB)
- Los comandos de reserva, finalización y reasignación guardan un digest
  SHA-256 del contenido canónico (orden, tienda, zona, coordenadas
  y radio según corresponda). Una llave reusada con otros datos se
  **rechaza** sin crear otra asignación; el digest no expone posiciones GPS.
- Tras una segunda asignación, reintentar un comprobante anterior se
  rechaza como `LOGISTICS_RESERVATION_SUPERSEDED` o
  `LOGISTICS_REROUTE_SUPERSEDED`, en vez de devolver una persona
  que ya no tiene asignada esa orden.
- `reassignUnavailableDelivery` **exige** un callback interno
  `VerifyPrePickup`. Sin él o si rechaza el pedido, no mueve ninguna
  reserva. La verificación se ejecuta **dentro de la transacción actual**.
- El puente independiente
  `src/integrations/orders-logistics/verify-pre-pickup.ts`
  consulta `tala_core_v2.orders` bajo lock de lectura, comprueba
  estado `assigned`, `fulfillment=delivery`, tienda, conductor
  de M1 y ausencia de evidencia de `picked_up/on_the_way/delivered`
  o PIN consumido. El Módulo 2 **no importa código de Pedidos**.
- Este puente **no autentica a un cliente HTTP** ni modifica la
  asignación que guarda M1. La coordinación de commit entre M1 y M2,
  el registro del cambio de conductor en M1, autenticación PWA/GPS,
  notificaciones y recuperación con reintentos están **PENDIENTES**.
  Los callbacks permisivos existen solo dentro de pruebas desechables;
  nunca deben utilizarse en el servicio publicado.
