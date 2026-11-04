# TALA EATS CORE v2 — M6 Restaurantes y Comercios

**Inicio de M6:** 2026-11-03.  
**Rama:** `feat/core-v2-restaurantes-foundation` (desde `main`).  
**PR:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8), Draft.  
**Estado:** LAB2, **NO-GO comercial ni despliegue**.

## Separación por dominios

```text
        Cliente/App Comercios (futuro)
                       |
            Gateway con identidad M4
                 (NO integrado)
                       |
        M6 Restaurantes y Comercios
          ├─ Comercio y permisos
          ├─ Sucursales y horarios
          ├─ Productos y variantes
          ├─ Stock y auditoría
          └─ Fotos (metadata, sin blobs)
                       |
           PostgreSQL M6 aislado
                       |
          Contratos de SOLO LECTURA
        (sin importar otros módulos)
              /                \
         M1 Pedidos         M2 Logística
        (futuro)             (futuro)
```

## Modelo comercial

Tala, Jalisco, es la primera ciudad del piloto. La base de datos permite
registrar ubicación en Ameca, Ahualulco, Tequila, Cuisillos y Amatitán
para expansiones futuras **sin anunciar cobertura activa**.

Las tiendas incluyen restaurantes, comercios de abarrotes, carnicerías,
verdulerías, papelerías, ferreterías, florerías y otros.

Una tienda se registra en `draft`; el propietario añade sucursal, horario
y catálogo, y puede marcar `ready` tras las validaciones internas.
`ready` significa únicamente que el onboarding de LAB está completo,
**no** que la tienda fue verificada comercialmente o se puede vender
en producción. `paused` detiene disponibilidad de lectura.

## Contratos con otros módulos

- **Identidad M4:** debe suministrar un UUID de usuario autenticado,
  y verificar invitaciones y el perfil autorizado antes de crear un
  colaborador. M6 conserva roles `owner/manager/editor` por tienda.
- **Pedidos M1:** `readOfferSnapshot(pool,{storeId,branchId,variantId})`
  devuelve la variante, precio en **centavos MXN**, peso fijo opcional,
  disponibilidad y versión. Es una lectura: no constituye reserva ni
  compra. Una transacción comercial deberá validar el precio y la
  disponibilidad al confirmar el pedido, implementando una política
  de reserva/concurrencia entre módulos. Debe consultar también
  `getBranchAvailability` para verificar horario y modo de entrega.
- **Logística M2:** `getBranchAvailability` indica apertura, pickup y
  delivery configurados. **No** calcula distancia, costo, despacho ni
  llegada de repartidor; eso compete a Logística y a su coordinación.
- **Notificaciones M5:** después de integrar productores autenticados,
  eventos de menú y estado pueden emitirse con contrato de eventos;
  M6 no importa el código de Notificaciones.
- **Finanzas M3:** M6 nunca calcula comisiones ni manipula pagos o wallets.

Los contratos se mantienen en el módulo porque el árbol principal aún
contiene solamente su README; no se crea ningún import al código de
otros PR en borrador.

## Garantías técnicas de LAB

- **Multi-tenant:** toda modificación exige miembro del establecimiento,
  con permiso correspondiente. Los IDs de terceros no pueden utilizarse
  para mutar catálogo, staff, horarios o stock.
- **Idempotencia:** `actorId+operationId` evita duplicados de creación,
  y compara huella del contenido para rechazar un replay con otro payload.
- **Concurrencia:** versión CAS para perfil, horario y precio, y sumas de
  inventario atómicas bajo bloqueo de PostgreSQL.
- **Stock:** tabla de ajustes con motivo y cantidades antes/después,
  bloqueo de saldos negativos y auditoría inmutable. La migración 002
  impide UPDATE/DELETE del historial y rechaza signos inconsistentes.
- **Dinero:** números enteros en centavos MXN. No floats ni cálculos
  de precio por kilogramo en tiempo real.
- **Fotos:** metadatos y claves generadas, SHA-256 y tipos MIME
  autorizados. No se afirma carga real: falta integrar almacenamiento
  y verificar bytes con un adaptador seguro.
- **Horas:** zona `America/Mexico_City`, semana local y pausa por
  sucursal, sin calcular días festivos, capacidad ni pedidos en cola.
- **CI:** Node 24, TypeScript estricto y PostgreSQL 16 de prueba,
  migraciones 001–002 y rechazo de nombres de bases no permitidos,
  tests de RBAC, onboarding, HTTP, inventario, imágenes y disponibilidad.

## Próxima fase del M6, antes de declarar cierre

1. Endurecer invitaciones y verificaciones comerciales con integración
   de M4, identidad de negocios, sucursales y documentos comerciales.
2. Almacenamiento real de fotografías con subida, validación por tamaño,
   hash, formato y ACL; miniaturas y CDN.
3. Disponibilidad avanzada: cierres festivos, operaciones del restaurante,
   franjas múltiples, preparación, agotados y tiempo de cambio de menú.
4. Contrato de inventario/reserva frente a Pedidos M1, evitando ventas
   duplicadas y definiciones inconsistentes de stock.
5. Pruebas ampliadas de carga, regresión, seguridad, recuperación,
   backups, monitoreo y E2E PWA Restaurante + Usuarios.

**Este documento no autoriza desplegar a Kali ni activar cobros,
transferencias, wallets o pedidos reales.**

## Ampliación LAB3 — Cierres extraordinarios por sucursal

La migración `003_branch_closures.sql` incorpora excepciones al horario semanal
con ventanas UTC de máximo 31 días y motivos de cierre festivo,
mantenimiento, emergencia u otros. El módulo no depende de Pedidos ni
Logística para crear o cancelar estos intervalos.

- `scheduleBranchClosure`, `cancelBranchClosure` y
  `listBranchClosures` están acotados a la tienda y su sucursal,
  con autorización sólo del propietario o gerente para modificar.
- La concurrencia entre gerentes se serializa mediante bloqueo
  transaccional de la tienda. Se rechazan ventanas traslapadas y
  se conservan las operaciones idempotentes.
- `getBranchAvailability` informa `EXCEPTIONAL_CLOSURE`
  cuando corresponde, sin borrar horarios permanentes ni pausar
  otras sucursales.
- Existe API HTTP sólo de LAB con autenticación inyectada, pruebas
  de accesos cruzados y rechazo de editores/extraños.
- La CI aplica y valida migración 003 y comprueba que una base
  ajena no pueda modificar su esquema.

**Límite:** las excepciones son informativas de disponibilidad;
no cancelan pedidos pendientes, no hacen reembolsos ni notifican
automáticamente a clientes/repartidores. Requieren contratos futuros
y pruebas E2E con M1/M2/M5. La disponibilidad comercial depende también
de capacidad y reglas de despacho aún no implementadas.

## LAB4 — Catálogo por sucursal y proyecciones seguras

**Migración:** `004_branch_catalog_controls.sql`, limitada a
`tala_restaurants_v2_test` y `tala_restaurants_v2_lab`.

### Integridad de menú

- La entidad `branch_variant_controls` une `store_id`, `branch_id` y
  `variant_id` mediante claves foráneas compuestas; no se puede asignar
  una variante de otro establecimiento.
- `setBranchVariantEnabled` sólo admite propietario, gerente o editor,
  verifica el producto no archivado y exige control de concurrencia con
  `expectedVersion`. El valor inicial 0 representa creación y no
  sobrescribe una configuración existente.
- `readOfferSnapshot` rechaza una oferta deshabilitada para la sucursal
  indicada. La respuesta `available` sólo es verdadera si existe
  stock, horario abierto y ninguna excepción de cierre activa para la
  fecha suministrada. Es una **consulta**, no una reserva de inventario.
- Se mantiene un único saldo de `variants.stock_quantity` por tienda.
  **No afirmar control de stock físico independiente por sucursal**.

### Contratos de lectura internos

- `readBranchStorefront`: catálogo de una sucursal, hasta 50 variantes
  por página, orden estable, filtro de categoría, foto primaria verificada
  por ID, precio numérico entero en centavos MXN, indicador de agotado,
  apertura local y capacidades de retiro/entrega.
- `discoverReadyBranches`: consulta acotada por municipio permitido,
  tipo de comercio y coincidencia literal de nombre. Sólo muestra
  sucursales activas y tiendas con ofertas disponibles. No publica
  correo, propietario, teléfonos ni saldo exacto de inventario.
- `readMerchantOverview`: resumen privado autorizado por tienda de
  sucursales, productos, presentaciones agotadas, fotos y cierres próximos.
  No lee saldos financieros, pedidos ni empleados del módulo Usuarios.
- Ninguno de estos contratos expone directamente claves de almacenamiento
  ni puede aprobar comercios. `ready` es estado de LAB, **no validación
  comercial**; el gateway debe impedir visibilidad pública hasta que
  haya aprobación y políticas de negocio.

### Ciclo de fotos

`retireProductPhoto` marca `rejected` la fotografía de un producto,
elimina la selección `is_primary`, oculta el registro en el listado y
rechaza la reactivación mediante una verificación posterior. El sistema
sigue almacenando el metadato como registro de control. La eliminación
física de objetos y sus derivados deberá implementarse y probarse con
un adaptador de almacenamiento autorizado; ninguna API LAB borra rutas
elegidas por un cliente.

### Evidencia y controles de salida

- Node 24, TypeScript estricto, PostgreSQL 16 descartable y cuatro
  migraciones protegidas. La CI verifica también la denegación en una
  base de datos cuyo nombre no está autorizado.
- Pruebas de selector de menú bajo ocho mutaciones concurrentes, ofertas
  bloqueadas y permitido en otra sucursal, horarios mexicanos, paginación,
  catálogo sin información de propietarios, búsqueda por ciudad, panel
  autorizado, archivos retirados, y flujo de HTTP local.
- **NO-GO producción:** faltan autorización comercial/validación de
  establecimientos, control real de inventario por sucursal, separación
  y reserva de stock frente a pedidos, carga de imágenes con verificación
  de bytes y almacenamiento real, limitación de abuso, logs de auditoría,
  backups con prueba de restauración y E2E de PWA/Flutter. No habilitar
  pagos, despacho ni acceso público desde la API de LAB.
