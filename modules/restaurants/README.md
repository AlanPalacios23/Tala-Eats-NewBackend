# TALA EATS CORE v2 — Módulo 6: Restaurantes y Comercios

**Estado:** LAB1 independiente, **NO-GO comercial**.  
**Rama:** `feat/core-v2-restaurantes-foundation` (creada desde `main`).  
**PR:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8) (Draft, sin merge ni despliegue).

Este módulo gobierna la **identidad comercial y los productos** de tiendas locales.
No contiene pedidos, logística, pagos, transferencias, balances, login ni
notificaciones. Ninguna entidad tiene una FK hacia otro módulo.

## Funcionalidad incluida

| Área | Implementación LAB |
| --- | --- |
| Comercios | Restaurant, grocery, butcher, greengrocer, stationery, hardware, florist, other |
| Alta | Nombre, slug, descripción, propietario, idempotencia de registro |
| Equipo | Propietario, gerente y editor; verificación RBAC por tienda |
| Sucursales | Dirección local, ciudad, coordenadas opcionales, pickup y delivery |
| Horarios | Semana 0=domingo a 6=sábado, intervalos locales por día, validación CAS |
| Disponibilidad | Estado ready/paused, horario local `America/Mexico_City`, sucursal activa |
| Productos | Nombre, categoría, descripción, activación, archivo y versiones |
| Presentaciones | Cada variante con `label`, precio en centavos MXN, peso fijo opcional y stock |
| Inventario | Ajustes atómicos, idempotentes y auditados; no saldo negativo |
| Fotografías | Reserva de clave de objeto, SHA-256, MIME restringido y confirmación de almacenamiento verificada |
| Auditoría | Eventos de modificación sin tokens ni pagos, filas inmutables |
| Integración | Snapshot de oferta y disponibilidad de sucursal, **solo lectura** |

### Catálogo por peso sin motor variable

Ejemplo de una carnicería:

- Carne de res, variante **500 g**, precio **$125.00 MXN** almacenado como `price_cents=12500`.
- Carne de res, variante **1 kg**, precio **$245.00 MXN** almacenado como `price_cents=24500`.
- Carne de res, variante **2 kg**, precio **$480.00 MXN** almacenado como `price_cents=48000`.

No se calcula un total por peso dinámico. Cada variante tiene identificador,
precio, disponibilidad y stock propios. M1 Pedidos realizará la reserva y
autorización del pedido **cuando exista una integración verificada**.

## Límites y roles

La identidad del usuario debe venir del **host autenticado**, no de un UUID
que el frontend declare. `store_staff` autoriza por establecimiento:
- `owner`: configura la tienda, estado y colaboradores; también catálogo.
- `manager`: ajusta perfil, sucursales, horarios, catálogo y stock.
- `editor`: gestiona productos, variantes, precios, stock y metadatos de fotos.

No se puede elevar la propia sesión a propietario ni reemplazar al propietario
registrado por la API. La asignación de personal exige validación de identidad
y procedimiento real de invitaciones en la futura integración con M4.

## Disponibilidad y activación

`changeStoreStatus(..., 'ready')` es únicamente una **marca de preparación
de LAB**: exige una sucursal activa con al menos un horario abierto y un
producto/variante activa y disponible. **No es aprobación comercial** y
no hace visible el establecimiento a clientes LIVE.

`getBranchAvailability(...)` evalúa estado del establecimiento,
estado de sucursal y día/hora local para indicar `isOpen`,
`pickupAvailable` y `deliveryAvailable`. La lógica no cubre cierres
festivos, tiempo de preparación, saturación del restaurante ni cierres
extraordinarios: deberán ampliarse antes de producción.

## Fotografías

`prepareProductPhoto` crea metadata con clave generada `m6/<store>/<product>/<uuid>.<ext>`.
La fotografía permanece `pending` hasta que un servicio de almacenamiento
**confiable e independiente** comprueba bytes, hash y tipo mediante el
callback `verifyProductPhoto`. La API pública LAB **no ofrece** una
ruta que acepte `verified=true`. La integración real de un proveedor de
objetos, almacenamiento, CDN, miniaturas, análisis de contenido, control de
tamaño y eliminación todavía **no está implementada**.

## API local para futuras PWA

`src/http-lab.ts` ofrece un adaptador de loopback con callback
`authenticate(req)` inyectado. La identidad y los permisos nunca
vienen del JSON de entrada. La API incluye:

- `GET/POST /v1/restaurants`
- `GET/PATCH /v1/restaurants/:storeId`
- `POST /v1/restaurants/:storeId/status`
- `PUT /v1/restaurants/:storeId/staff`
- `GET/POST /v1/restaurants/:storeId/branches`
- `PUT /v1/restaurants/:storeId/branches/:branchId/hours`
- `PUT /v1/restaurants/:storeId/branches/:branchId/active`
- `GET /v1/restaurants/:storeId/catalog`
- `POST /v1/restaurants/:storeId/products`, `PATCH /.../products/:productId`
- `POST /v1/restaurants/:storeId/products/:productId/archive`
- `POST /v1/restaurants/:storeId/products/:productId/variants`
- `PUT /v1/restaurants/:storeId/variants/:variantId/price`
- `POST /v1/restaurants/:storeId/variants/:variantId/stock`
- `GET/POST /v1/restaurants/:storeId/products/:productId/photos`
- `PUT /v1/restaurants/:storeId/products/:productId/photos/:photoId/primary`

Se bloquea con `NODE_ENV=production`, no ofrece CORS y debe permanecer
vinculada a `127.0.0.1`. Un gateway comercial futuro necesitará TLS,
autorización robusta, protección antiabuso y validación de sesión real.

## Independencia y esquema

PostgreSQL: esquema `tala_restaurants_v2`, nombres de BD permitidos
`tala_restaurants_v2_lab` y `tala_restaurants_v2_test`.

`stores`, `store_staff`, `branches`, `hours`, `products`,
`variants`, `stock_adjustments`, `product_photos`,
`idempotency_receipts` y `audit`.

No se migran ni leen tablas operativas. Tampoco se almacenan llaves Stripe,
contraseñas ni fotos reales.

## Pruebas de CI

La acción M6 propia levanta PostgreSQL 16 en base descartable, corre
`npm run check` (TypeScript estricto + tests puros), aplica migraciones 001 y 002,
ejecuta E2E de PostgreSQL/HTTP y rechaza aplicar migraciones en otras BD.

La batería cubre:
- Concurrencia e idempotencia; control de versión y errores de acceso.
- Owner, manager, editor y extraño entre tiendas.
- Horarios semanales, horario local y pausa de sucursal.
- Variantes 500 g/1 kg, precios enteros en centavos, stock negativo.
- Ajustes de inventario concurrentes e historial auditable.
- Foto pendiente/validada y acceso entre establecimientos.
- Flujo HTTP loopback sin asumir identidades declaradas por la app.

## Pendientes para GO comercial

Autenticación real con M4 y flujo de invitaciones; verificación/aprobación
de negocios, documentos/avisos legales; integración del almacenamiento de
imágenes con subida real y borrado; catálogo y órdenes E2E con M1;
disponibilidad por feriados/saturación, reservas de stock, sincronización
entre sucursales, soporte offline y localización; pruebas de estrés
reproducibles, observabilidad, copias/restore, pruebas de las PWA y permisos
comerciales/seguridad. No desplegar sobre Kali LIVE ni usar Stripe LIVE.

## LAB2 — Integridad del inventario

La migración `002_stock_integrity.sql` vuelve el historial de ajustes de
inventario **append-only** mediante un trigger SQL; no se pueden modificar ni
eliminar ajustes registrados. Además, `restock` solo admite delta positivo,
`waste` solo delta negativo y `correction` admite ambos con motivo
explícito. La API valida las mismas reglas antes de llegar a PostgreSQL.

Estas garantías se prueban en la CI aislada de M6 y no implican reserva
transaccional durante un pedido. La reserva/consumo final de existencias
requiere un contrato posterior con M1 Pedidos.
