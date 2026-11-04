# TALA EATS CORE v2 — Módulo 6: Restaurantes y Comercios

**Estado:** LAB6 cerrado en laboratorio, **NO-GO comercial**.  
**Rama:** `feat/core-v2-restaurantes-foundation` (creada desde `main`).  
**PR:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8) (Draft, sin merge ni despliegue).

Este módulo gobierna la **identidad comercial y los productos** de tiendas locales.
No contiene pedidos, logística, pagos, transferencias, balances, login ni
notificaciones. Ninguna entidad tiene una FK hacia otro módulo.

## LAB8 — horarios divididos/nocturnos y preparación por sede

- Nueva migración aislada `007_branch_schedule_preparation.sql`: ventanas de apertura para cada día, hasta cuatro segmentos diarios, con soporte de cierre al día siguiente.
- `schedule.ts` rechaza traslapes dentro del día, entre días adyacentes y sábado→domingo; una actualización concurrente o inválida realiza rollback.
- Las lecturas de disponibilidad, escaparate, snapshot y descubrimiento usan una misma función SQL en el horario de `America/Mexico_City`.
- `preparation.ts` configura `prepMinutes` (5–240) y `parallelPrepSlots` (1–100), sin contabilizar órdenes o invadir M1.
- Endpoints HTTP LAB: `GET/PUT /v1/restaurants/:storeId/branches/:branchId/schedule` y `GET/PUT /v1/restaurants/:storeId/branches/:branchId/preparation`.
- Los horarios antiguos de un solo intervalo se mantienen para compatibilidad. El campo legado `hours` **no** representa intervalos nocturnos o divididos: usar `scheduleSlots` o `GET /schedule` en clientes nuevos.
- Pruebas SQL/HTTP E2E verifican concordancia entre lecturas, límites, permisos por comercio, colisiones y expiración de versión. Mantener PR Draft/NO-GO LIVE.

[Detalles de API, pruebas y fronteras LAB8](../../docs/MODULO6-RESTAURANTES-LAB8-HORARIOS-PREPARACION.md).

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
| Inventario | Stock general o físico por sucursal (opt-in), ajustes atómicos, idempotentes y auditados; no saldo negativo |
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

### LAB6 — operaciones físicas, recuperación y cierre del módulo

La etapa autónoma del M6 queda cerrada en LAB6. Las operaciones de almacén
ahora permiten **transferencias atómicas entre sucursales**, con débito/crédito
equilibrados y rollback si falta inventario o el destino está lleno; **conteos
físicos** con reconciliación y bloqueo de versiones obsoletas; e **historial
privado** que incluye ajustes, conteos y movimientos entre sedes. El nuevo
esquema `006_branch_inventory_operations.sql` mantiene trazas inmutables.
No reserva unidades para pedidos ni invoca pagos.

[Documento formal de cierre y puertas NO-GO](../../docs/MODULO6-RESTAURANTES-CIERRE-LAB6.md).

### LAB5 — existencias separadas por sucursal

Una variante con stock general debe conciliar su saldo a **cero** antes de
activar `branch_stock_enabled`. Este cambio es de una sola dirección;
desde ese momento los movimientos se registran por sucursal, sin copiar
unidades a otras sedes ni permitir ajustes en el saldo anterior. Las
bandejas de catálogo y la oferta usan el saldo de la sucursal consultada.
El comerciante puede consultar cantidades exactas en una vista privada;
el escaparate solo enseña disponibilidad.

[Contrato, restricciones y rutas LAB5](../../docs/MODULO6-RESTAURANTES-LAB5-INVENTARIO-SUCURSAL.md).

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
`pickupAvailable` y `deliveryAvailable`. La disponibilidad ya considera cierres extraordinarios y horarios divididos/nocturnos de LAB8. El tiempo de preparación se configura por sucursal; la saturación dinámica depende de la integración futura con M1.

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

## LAB3 — Cierres extraordinarios por sucursal

Sin acoplarse a pedidos ni repartidores, `003_branch_closures.sql` incorpora
intervalos temporales de cierre por sucursal:

- **Motivos:** festivo, mantenimiento, emergencia u otro.
- **Sólo propietario/gerente:** `scheduleBranchClosure`, `cancelBranchClosure`
  y listado autorizado. Los editores no pueden imponer cierres.
- **Idempotencia y concurrencia:** operación UUID, fingerprint y bloqueo
  sobre la tienda; impide intervalos solapados cuando dos gerentes actúan
  simultáneamente. Una operación cancelada no reaparece automáticamente.
- **Validación:** horas ISO UTC con milisegundos, fin posterior al inicio,
  máximo 31 días y vínculo del cierre con su tienda y sucursal.
- **Disponibilidad:** `getBranchAvailability` devuelve
  `EXCEPTIONAL_CLOSURE` mientras un cierre esté vigente, sin borrar el
  calendario semanal ni detener otras sucursales.
- **API HTTP LAB:** `GET/POST /v1/restaurants/:storeId/branches/:branchId/closures`
  y `POST .../closures/:closureId/cancel`, con identidad inyectada.
- **Control de alcance:** un cierre **no cancela pedidos** existentes ni
  avisa a clientes o repartidores. Esos efectos requieren contratos
  explícitos con M1/M2/M5 cuando se integren los módulos.

Se prueban una semana de horarios en `America/Mexico_City`,
falsificación de propietario, cancelación, superposición,
paralelismo entre gerentes, acceso HTTP y migración contra base ajena.
El módulo sigue **NO-GO comercial**.

## LAB4 — Menú por sucursal, catálogo seguro y operación comercial local

El desarrollo de esta etapa sigue limitado a Restaurantes/Comercios y su
PostgreSQL aislado; no incluye pedidos, cobros, asignaciones de reparto,
usuarios ni notificaciones. Se incorpora la migración
`004_branch_catalog_controls.sql` con relaciones tienda/sucursal/variante
validadas mediante claves foráneas de dos columnas.

### Control de catálogo por sucursal

- `setBranchVariantEnabled`: el propietario, gerente o editor puede
  activar u ocultar una presentación del menú para una sucursal concreta.
  Se comprueba la propiedad de la tienda, la pertenencia de la variante,
  el archivado del producto y la versión esperada.
- `expectedVersion=0` crea el primer control; actualizaciones posteriores
  requieren la versión vigente. El bloqueo de la tienda impide que
  decisiones concurrentes sobrescriban silenciosamente el menú.
- Una presentación deshabilitada se oculta en la proyección de la sucursal
  y deja de ser elegible en `readOfferSnapshot`, sin modificar el menú
  de otras sucursales del mismo establecimiento.
- **Advertencia:** este control no implementa inventario físico por
  sucursal. `stock_quantity` sigue siendo un saldo del establecimiento.
  Antes de pedidos reales con varias sucursales se necesitará un
  modelo explícito de existencias/asignaciones por punto de venta.

### Catálogo y descubrimiento internos

- `readBranchStorefront` devuelve exclusivamente nombre, categoría,
  variantes, precio MXN en centavos, disponibilidad y referencia de
  foto primaria verificada. Omite colaboradores, UUID del propietario,
  claves de archivos y cantidades exactas de inventario.
- Utiliza zona horaria `America/Mexico_City`, horario semanal y
  cierres extraordinarios. Un producto agotado sigue visible como
  agotado; un producto deshabilitado se oculta por completo.
- `discoverReadyBranches` permite buscar por las localidades aprobadas
  para el esquema, tipo de negocio y texto de nombre; solo incluye
  sucursales activas con catálogo vendible. La disponibilidad local
  distingue abierto/cerrado sin prometer tiempo de reparto.
- Ambas consultas son **contratos de laboratorio internos**. Un negocio
  marcado `ready` no equivale a verificado o aprobado por la plataforma.
  **No exponerlas al público comercial** hasta completar revisión de
  establecimientos, autorización de gateway y políticas de publicación.
- `readOfferSnapshot` ya reevalúa horario y cierre extraordinario en
  la fecha de consulta. No garantiza existencias futuras ni reserva stock.

### Panel privado y fotografías

- `readMerchantOverview`: conteos de sucursales, productos, variantes
  agotadas/disponibles, fotos pendientes/verificadas y cierres próximos,
  con acceso RBAC limitado a integrantes de la tienda; no calcula
  ingresos, wallet ni transferencias.
- `retireProductPhoto` permite retirar una foto pendiente o verificada,
  limpiar su marca de principal y sacarla del listado. El metadato
  permanece como lápida `rejected` para no reactivarla.
- Retirar **no elimina todavía los bytes del almacenamiento**: falta el
  adaptador de objetos y el proceso de borrado seguro verificable.

### API LAB añadida

- `PUT /v1/restaurants/:storeId/branches/:branchId/variants/:variantId/enabled`
- `GET /v1/restaurants/:storeId/branches/:branchId/storefront`
- `GET /v1/restaurants/discover?city=tala`
- `GET /v1/restaurants/:storeId/overview`
- `POST /v1/restaurants/:storeId/products/:productId/photos/:photoId/retire`

La API sigue siendo loopback con identidad inyectada, sin CORS y
deshabilitada en `NODE_ENV=production`. La exposición pública
requiere primero una nueva capa de gateway y validación de publicaciones.

La CI ejecuta migraciones 001→004 en PostgreSQL 16 descartable y rechaza
aplicarlas en otra base. Las pruebas contemplan catálogo por sucursal,
relevos simultáneos de versión, aislamiento entre establecimientos,
horarios/cierres, búsqueda local, privacidad de proyecciones, panel de
conteos, ciclo de vida de fotos e HTTP LAB E2E.

**No-objetivos:** compras, conciliación, wallets, documentos de identidad,
validación de créditos, transacciones Stripe, logística, notificaciones
y reservas de existencias. Los contratos de lectura son informativos
y requieren revalidación transaccional cuando se integren los pedidos.
