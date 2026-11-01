# TALA EATS CORE v2 — límites de Módulos

## Estructura de código
- `src/modules/modulo-1-pedidos/`: **código y migraciones SQL 001–007 de Pedidos**.
- `src/modules/modulo-2-logistica/`: **contratos y algoritmos de Logística**.
- `src/server.ts`: composición de módulos bajo gates; no mezcla de lógica.
- `scripts/`, `tests/`, `docs/` y `.github/`: infraestructura transversal, pruebas y documentación.

## Módulo 1 — Pedidos (cerrado técnicamente para LAB)
Propietario único de órdenes, descuentos y restituciones de inventario,
precios y snapshots, fases de restaurante, evidencias, PIN, confirmación
de efectivo, historial, comprobante y auditoría.
La entrega final y su PIN son **evidencia del pedido** y no
constituyen por sí mismas un servicio de despacho de flota.

La ruta actual del laboratorio para `driver/claim` y sus transiciones
sigue dentro del adaptador de Pedidos únicamente para **conservar las
52 pruebas E2E ya validadas**. No es aún el servicio definitivo de
despacho ni se abrirá como endpoint de Logística en Render.

## Módulo 2 — Logística (fundación independiente)
Responsable de elegibilidad de repartidores, presencia, capacidad,
zonas, selección de candidatos y, en fases siguientes, despacho
transaccional, reasignaciones, geolocalización, ETA y seguimiento de rutas.
Su política inicial es pura y determinista, sin importaciones de Pedidos,
sin conexiones de base ni rutas públicas.

### Contrato entre módulos
`DeliveryAssignmentRequest` contiene únicamente `orderId`,
`restaurantId`, `fulfillment`, `orderStatus` y `deliveryZone`.
`CourierCapacity` contiene únicamente datos operativos del conductor,
sin teléfono, dirección del comprador ni datos financieros.

El Módulo 2 **propone** un conductor; el Módulo 1 mantiene la única
autoridad para confirmar y registrar una transición del pedido.
En la integración posterior, no se permitirán duplicados ni escrituras
a una orden sin su versión y validaciones transaccionales.

## Condiciones de seguridad
- Ningún cambio a Kali, a la base anterior o a Stripe LIVE.
- Módulo 2 no administra pagos, PIN, wallets ni inventario.
- El despliegue en Render continúa con `CORE_V2_WRITES_ENABLED=false`;
  `commercialReady:false` hasta aprobación de los gates comerciales.
- La rama independiente `feat/core-v2-modulos-pedidos-logistica`
  parte del cierre técnico de Módulo 1, sin fusionarlo ni modificar
  el PR #1.
- Toda modificación a Pedidos exige correr la regresión completa,
  incluidos los escenarios de autorización, checkout y handoff.
