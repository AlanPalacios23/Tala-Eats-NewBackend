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
