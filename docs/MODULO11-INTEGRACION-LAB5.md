# M11 Integración LAB5 — M6 Restaurantes → M1 Pedidos

**Fecha de desarrollo:** 5 de noviembre de 2026 (LAB).
**Rama:** `feat/core-v2-integracion-monolito-m11`.
**PR:** [#13 — sigue Draft](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/13).
**Validación:** pendiente del resultado de CI global en último HEAD.
**Operación:** NO-GO Stripe LIVE, entrega, wallets, deployment Kali y merge.

## Problema real encontrado

**M6 y M1 son dominios independientes y cada uno contiene su propio inventario:**

- M6 gobierna `stores/branches/products/variants`, presentación (500 g / 1 kg), precio exacto en centavos, horarios, cierres, pausas, activación y stock efectivo por sucursal.
- M1 mantiene `restaurants/catalog_products` con otro ID de negocio y otro producto. Su `createCashOrder` **descuenta stock únicamente en M1**, y en la misma transacción guarda las líneas, el precio congelado, la orden y un outbox.
- **M11 no puede convertir dos inventarios independientes en uno mediante una lectura o un bloqueo local:** un cambio concurrente en M6 no participa de la transacción de M1. Tampoco hay un evento M6 transaccional de reserva/descuento integrado.

Por tanto, LAB5 se implementa con una **pasarela aislada y conservadora** que rechaza discrepancias; todavía no autoriza venta comercial.

## Adaptador real M6↔M1

**Archivo:** `modules/integration/adapters/catalog-checkout-lab.ts`.

### Asociación controlada

`linkM6VariantToM1Catalog` permite a un **host administrativo autenticado** con `canLinkCatalog` asociar:

- `(m6_store_id,m6_branch_id)` a `m1_restaurant_id`;
- `(m6_branch_id,m6_variant_id)` a `m1_product_id`.

Antes de registrar el vínculo, llama a **`getBranchAvailability` y `readOfferSnapshot` reales de M6** y consulta el catálogo real M1. Comprueba:

1. Sucursal preparada y abierta para **retiro/pickup** en la hora actual, producto y variante activos.
2. M6 ofrece unidades con `track_stock=true`, stock positivo y MXN.
3. Producto M1 disponible y restaurante M1 abierto.
4. M1 tiene **precio idéntico en centavos** al de M6, nombre completo `Producto — variante` y **stock exactamente igual**.
5. Dos sucursales M6 no pueden apuntar al mismo restaurante M1; un producto M1 no puede quedar vinculado a variantes diferentes.

Los identificadores se fijan en M11 mediante `004_branch_catalog_links.sql`, con relaciones únicas e inmutables. No almacena claves, fotos, PII ni precio proporcionado por el cliente. No existe ruta pública de registro.

**Limitación:** `canLinkCatalog` viene de un host interno de laboratorio; todavía falta demostrar la correspondencia de titularidad legal/operativa de negocios M6↔M1 mediante roles reales M4/M6.

### Previsualización auténtica de dos fuentes

`previewLinkedM6M1Pickup` recibe **únicamente IDs de M6, cantidad y versión esperada de variante**, nunca un precio a confiar. Consulta el vínculo irrevocable, vuelve a leer el precio, nombre, versión y disponibilidad de M6 y compara precio, nombre, unidades y stock de M1.

Después llama a **`previewCart` real de M1**, el que aplica su propia política de precio, y comprueba que el importe de productos y cada línea coincidan exactamente con M6.

**Se rechaza (fail closed):** SKU equivocado, variante de otra tienda, paquete duplicado, precio alterado, cambio de versión, falta de stock, inventario divergente, sucursal cerrada, productos deshabilitados y datos adicionales en el carrito.

Solamente se admite `pickup` en LAB5. No se calcula envío por distancia, tarifa del repartidor, propinas ni transferencia.

### Pedido M1 de prueba con snapshot inmutable

`createLinkedLabCashPickup` primero valida **sesión y rol cliente del M4 real** y busca su asociación de cuentas de LAB4 M4↔M1. No toma `buyerId` de la app. Bajo lock de la sucursal en PostgreSQL M11:

1. Deduplica por `buyer_id` e `idempotencyKey` originales de M1.
2. Para una orden nueva, vuelve a ejecutar la doble comprobación M6→M1 y `previewCart` de M1.
3. Solo después llama a **`createCashOrder` real de M1**, donde stock M1, pedido, líneas de importe congelado, precios y outbox se guardan en una misma transacción.
4. Devuelve `paid=false`, `commercialReady=false`, `policyApproved=false`, `m6StockReserved=false`, `inventoryNeedsReconciliation=true`.

Si un primer pedido descuenta stock M1 y M6 aún no se actualiza, el siguiente pedido de prueba nuevo se **rechaza por diferencia de inventario**; no se le permite continuar sin una conciliación deliberada de origen. Los reintentos del **mismo pedido y misma clave** vuelven a M1 para que su idempotencia nativa devuelva el pedido existente sin descontar stock nuevamente. Un carrito cambiado con la misma clave se rechaza.

Esto es una **demostración transaccional de M1 usando cotización auténtica de M6**, **no** una reserva M6 ni un checkout multi-base de negocio. En caso de fallo entre DBs, sigue faltando conciliación/redrive y la garantía de stock real por sucursal.

## Gate de precios: bloqueo comercial

El código M1 de `pricing.ts` mantiene la política `pilot-2026-11-v2-17pct` y comisión al comercio de **17 %**, mientras una decisión comercial previa de Tala Eats estableció **15 %**. No se ha cambiado silenciosamente ninguna de las dos políticas.

Por ello, el adaptador retorna **`pricingPolicyApproved=false`** o **`policyApproved=false`** y toda prueba de checkout se ejecuta solo en bases ficticias. **No usar resultados del cotizador como precios/comisiones públicos, cobros Stripe o saldos en M3 hasta aprobar una política única.**

## Batería nueva de CI

**`tests/real-m6-m1-catalog-db.test.ts`:**

- Crea comercio, sucursal en Tala, horarios, producto y variante 500 g usando **los servicios reales de M6**; crea la sombra M1 con SQL en base LAB.
- Verifica vínculo y cotización `M6→M1.previewCart` con precio exacto, versión del catálogo y tarifa informada de M1.
- Crea usuario verificado M4 y cuenta M1 independientes, vincula ambas bajo las reglas de LAB4 y crea un **pedido real de efectivo pendiente de M1**.
- Comprueba `orders.price_snapshot`, productos, importes, comprador verdadero e idempotencia.
- Verifica negativa por precio/versión/stock diferente, tienda pausada, SKU ajeno, variante duplicada y unidades insuficientes.
- Dos intentos de compra nuevos concurrentes se serializan en la misma sucursal y solo uno puede continuar si M1/M6 dejan de coincidir.
- Las migraciones M11 siguen blindadas para bases `tala_integration_v2_test/lab`. Los diez snapshots Git de M1–M10 continúan sin mutaciones.

## Condiciones para el siguiente LAB y producción

- **Inventario único / reservas de stock auténticas:** M6 debe ser el origen de stock. Diseñar hold de stock por sucursal en M6, con capacidad concurrente, TTL, operación idempotente, compensación y outbox; M1 debe consumir reservas y liberar/confirmar sin acceso a tablas M6. El inventario paralelo de M1 debe retirarse o mantenerse solo como espejo con protocolo duradero y reconciliación.
- **Precio autoritativo:** congelar precio de M6 en el pedido M1 con ID de variante, versión, cantidad y sucursal, y consolidar la política 15 % / 17 % antes de LIVE.
- **Conexión de socios:** demostrar permisos reales de comercio en M4/M6 para cada sucursal, en lugar de una bandera de host de LAB.
- **Pagos:** solo tras el pedido/reserva estable, conectar M8 Stripe **TEST** de cuenta real, webhooks firmados, M3 contabilidad y cierres por estado; nunca inferir pago a partir de `orders.order_created`.
- **Entrega y apps:** zona M7, M2 presencia/despacho/PIN, M5 notificaciones después de confirmación verificable, M10 métricas de hechos verdaderos; E2E con apps.
- **Seguridad de lanzamiento:** migraciones y rollback versionados, rate limit edge, backups, roles SQL mínimos, revisión de sesión/TOCTOU y estrés multiworker.

**Veredicto LAB5:** solo cerrar tras CI integrada SUCCESS sobre el último commit. Sin merge ni despliegue Kali.
