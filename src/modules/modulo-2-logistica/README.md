# Módulo 2 — Logística

Módulo **independiente** dentro de Tala Eats CORE v2.

## Responsabilidades exclusivas
- Disponibilidad y capacidad de repartidores
- Elegibilidad y selección determinista para asignaciones de entrega
- Futuros: presencia distribuida, despacho con bloqueo transaccional, ruta y ETA, GPS, reasignación y recuperación

## Contrato de entrada
Consume **solo los datos necesarios** de una orden lista para entregar:
`orderId`, `restaurantId`, `fulfillment`, `orderStatus`, `deliveryZone`.

No conoce ni modifica precios, pagos, propinas, PIN, cuentas del cliente, inventario ni conciliaciones.

## Estado real
**Fase de fundación de Módulo 2.** Implementado `planCourierAssignment` puro,
con filtros de aprobación, conexión reciente, capacidad y zona, y selección reproducible.
**No** está integrado a rutas HTTP ni PostgreSQL, ni sustituye todavía el claim de repartidor
existente en Módulo 1. No equivale a despacho comercial.

## Interacción futura
Módulo 1 conserva la propiedad de `orders`, estados, PIN y entrega.
Módulo 2 propondrá un repartidor mediante contrato; Módulo 1 comprobará y registrará
el claim atómicamente dentro de la misma transacción.
No habrá importaciones circulares entre módulos ni tablas duplicadas.
