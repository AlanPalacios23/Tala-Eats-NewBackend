# TALA EATS CORE v2 — Módulo 6, LAB5: inventario físico por sucursal

**Alcance:** exclusivamente Restaurantes y Comercios, sin reservas para pedidos, cobros,
repartidores ni conexiones a otros módulos. **Solo LAB, NO-GO comercial.**

## Contrato de stock

- Migración `005_branch_physical_stock.sql`: se aplica **solo** a la BD descartable
  `tala_restaurants_v2_test` o `tala_restaurants_v2_lab`.
- `variants.branch_stock_enabled=false` conserva el saldo anterior por
  establecimiento y las API existentes. Una variante puede pasar a inventario por
  sucursal únicamente cuando `stock_quantity=0` y `track_stock=true`.
  El cambio es **unidireccional** y usa versión optimista.
- Se debe conciliar el saldo antiguo a cero mediante el movimiento auditado ya
  existente antes de habilitar inventario por sucursal. **No se copian** existencias
  automáticamente a cada sucursal ni se permite duplicarlas.
- Después de activar el modo sucursales, los ajustes generales de la variante
  son rechazados; solo son válidos los ajustes de sucursal.
- Una sucursal sin saldo explícito se considera con **cero** unidades. La
  disponibilidad en `readOfferSnapshot` y `readBranchStorefront` usa el saldo
  exclusivo de esa sucursal (más horario, cierre excepcional y visibilidad de menú).
- Las cantidades internas exactas nunca aparecen en el escaparate público.
  La vista privada de inventario exige autorización del comercio.

## API interna (servidor HTTP solo de LAB)

| Método | Ruta | Función |
| --- | --- | --- |
| POST | `/v1/restaurants/:storeId/variants/:variantId/branch-inventory` | Habilitar modo por sucursal con `expectedVersion` (owner/manager) |
| GET | `/v1/restaurants/:storeId/branches/:branchId/stock` | Saldos privados por sucursal |
| POST | `/v1/restaurants/:storeId/branches/:branchId/variants/:variantId/stock` | `operationId`, `delta`, `reason` restock/correction/waste |

La identidad se **inyecta desde el host autenticado**, sin permisos otorgados
por datos enviados por la app. Todas las mutaciones validan pertenencia del
comercio, sucursal y variante. Un `operationId` repetido solo devuelve la
operación previa si la huella es idéntica; una reutilización incompatible falla.

## Garantías del laboratorio

- Transacción PostgreSQL, bloqueo por comercio, saldo de 0 a 1 000 000,
  movimiento firmado y registro inmutable de cada cambio.
- Protección contra doble ejecución y carreras concurrentes sin saldos negativos.
- Los balances exactos pertenecen al M6; no existen FKs hacia otras bases.
- CI debe aplicar migraciones 001→005, TypeScript estricto, tests de aislamiento,
  mermas, disponibilidad y ledger, y bloquear cualquier migración fuera de LAB.

## No incluye ni promete

No hay todavía reserva de stock cuando llega un pedido, transferencia de
unidades entre sucursales, conteo cíclico con aprobación, control de vencimientos,
subida real de imágenes ni autorización de producción. Estos flujos requieren
diseño y pruebas independientes antes de cualquier integración comercial.
