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
Su política inicial es pura y determinista. Además, el módulo ya contiene
un servicio PostgreSQL transaccional independiente (alta interna de repartidores,
aprobación, presencia, reservas de entrega, finalización y liberación de
capacidad) en `tala_logistics_v2`, con eventos inmutables y outbox propio.

La migración del laboratorio es
`src/modules/modulo-2-logistica/migrations/001_logistics_lab.sql`. El servicio
`dispatch-service.ts` sí utiliza PostgreSQL, pero **no consulta ni modifica
las tablas o el código de Pedidos**. Sigue sin rutas HTTP ni permisos de ejecución
pública. La política pura sigue separada en `assignment-policy.ts`.

La reserva únicamente toma como entrada el estado `ready` comunicado por un
adaptador de confianza todavía no implementado; **no verifica por sí sola**
si el pedido existe en Módulo 1, así que esta etapa es solo de LAB.
Existe ahora `geo.ts` y `location-service.ts` para registrar la última
ubicación GPS y consultar candidatos próximos al restaurante, junto con la
migración `002_courier_position_lab.sql` en el esquema exclusivo de Logística.
Estos servicios todavía no tienen endpoint autenticado, pero la reserva
interna **`reserveNearestDelivery`** ya puede elegir al repartidor
cercano con verificación GPS y bloqueo SQL. La política por carga de
`reserveDelivery` sigue disponible y se conserva la regresión completa.
La distancia es recta: **no es ETA vial**.
Existe también `reassignUnavailableDelivery` para recuperar una
reserva GEO de un conductor offline o con presencia/GPS vencidos, de
manera versionada e idempotente. **No debe usarse tras recogida real**;
necesita que Pedidos certifique el estado y autorice esa operación.
Faltan conexión transaccional/compensación con Pedidos, autenticación
del repartidor, GPS desde PWA, ETA vial y operaciones comerciales.

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

## Verificación cruzada de LAB — frontera M1/M2
`src/integrations/orders-logistics/verify-pre-pickup.ts` es el
**adaptador externo**, separado de los dos módulos. Comprueba
transaccionalmente `orders.status='assigned'`, entrega,
`restaurant_id`, `order_driver_assignments.driver_id` y evidencia
de que no hubo recogida, entrega ni PIN consumido antes de autorizar
`reassignUnavailableDelivery`.

No es un endpoint de aplicación ni permite a un cliente crear una
autorización. **La asignación de Pedidos sigue siendo la autoridad final.**
En LAB, el adaptador `commit-reassignment.ts` actualiza Pedidos (conductor,
versión, evento y outbox) en la **misma transacción** donde Logística cambia
la reserva. Si falla la aprobación, el estado o el evento, ambas
operaciones se revierten. `inspect-consistency.ts` permite detectar
desajustes sin modificar datos ni exponer un endpoint público.

**Límites pendientes:** el despacho inicial todavía no coordina M1/M2
en una transacción y no hay autenticación de PWA/GPS, notificaciones
ni recuperación operativa de entregas. Por ello sigue NO-GO comercial.
