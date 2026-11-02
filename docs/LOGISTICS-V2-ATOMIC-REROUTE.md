# TALA Dispatch Engine V2 — Reasignación atómica (LAB)

## Objetivo y frontera de responsabilidades

**Pedidos (M1)** es dueño de la orden, estados, titularidad del repartidor,
PIN, entrega, inventario y evidencias. **Logística (M2)** es dueño de la
selección por proximidad, disponibilidad GPS, capacidad de flota y reservas.
Los módulos no se importan entre sí. La coordinación vive en
`src/integrations/orders-logistics/`.

## Función oficial de integración

`reassignOrderDispatchAtomic(pool,orderId,expectedLogisticsVersion,
commandKey,restaurant,maxDistanceMeters)` es la única puerta interna
preparada para futuros servicios de backend de esta iteración.
No es ruta HTTP y **no autentica** a usuarios, repartidores o admins.

Reutiliza exactamente una transacción PostgreSQL para:

1. Bloquear la reserva y validar versión/comando HMAC de Logística.
2. Verificar mediante `verifyOrdersPrePickup` que M1 conserva el pedido
   `assigned` al repartidor original, `delivery`, con tienda correcta
   y sin prueba histórica de recogida, entrega o PIN consumido.
3. Verificar que el repartidor original ya no esté disponible.
4. Buscar un sustituto activo y aprobado en la zona, con GPS reciente
   y capacidad; bloquear su fila para evitar sobreventa de entregas.
5. Preparar la nueva reserva versionada en M2.
6. Ejecutar `commitOrdersReassignment`: confirmar conductor nuevo como
   cuenta activa y perfil aprobado de M1, reemplazar la asignación en M1,
   aumentar versión de orden, guardar evento y outbox.
7. Registrar `dispatch.reassigned` y outbox M2 y hacer **un solo COMMIT**.

Si una condición falla o el callback lanza una excepción, se hace
`ROLLBACK`: **ni M1 ni M2 cambian**. No se sobreescriben eventos
históricos, no se guardan coordenadas en evidencias de reasignación.

## Auditoría sin cambios automáticos

`inspectDispatchConsistency(pool,orderId)` compara, solo en un
entorno interno y por UUID, la reserva activa de M2 con el conductor y
estado de M1. Puede devolver `CONSISTENT`, `COURIER_MISMATCH`,
`ORDER_NOT_ASSIGNED`, `ORDER_MISSING`,
`MISSING_ORDER_ASSIGNMENT` o `NO_ACTIVE_RESERVATION`.
No publica una ruta, no envía notificaciones y no corrige nada solo.

## Casos automatizados ya cubiertos

- Éxito: ambos módulos almacenan el mismo repartidor y crean evidencia.
- Rechazo por recogida/PIN o por cambio de versión.
- Sustituto no aprobado en M1: se revierte la reserva M2.
- Excepción simulada después de actualizar M1: se revierten ambos.
- Concurrencia, reintentos exactos, cambios de parámetros, versionado
  y pérdida de GPS.
- Inspección detecta una discrepancia artificial creada en una BD
  desechable de GitHub Actions.

## Pendiente — NO-GO comercial

- **Primera asignación:** aún no enlazada a una orden real de M1 bajo
  esta nueva coordinación atómica. La entrada inicial de M2 en LAB sigue
  aceptando un contexto de pedido declarado por un llamador confiable.
- Autenticación/autorización y comprobación de propiedad real de PWA
  Repartidores, GPS consentido, protección antimanipulación de ubicación.
- Notificaciones/revocación de asignación en cliente y conductor, códigos
  de recogida y caducidad de tareas.
- API integrada de staging, despliegue seguro, pruebas E2E con las tres
  aplicaciones y observabilidad; rutas viales/ETA no están implementadas.
- Revisión de aislamiento y permisos SQL por rol antes de habilitar
  llamadas externas. El hecho de compartir base de datos es específico
  de este monolito modular de laboratorio.

**El PR #3 sigue DRAFT**; no habilitar Ruta HTTP, no modificar Kali ni
usar Stripe LIVE.
