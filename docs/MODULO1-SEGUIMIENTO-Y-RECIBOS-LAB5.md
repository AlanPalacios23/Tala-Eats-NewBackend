# CORE v2 · Módulo 1 Pedidos · Lectura y seguimiento 0.2.0-lab.5

**Ámbito:** exclusivamente pedidos en PostgreSQL de LAB. No se agregaron funciones a Logística, Pagos, Finanzas, Usuarios, Redis ni Workers. No existen nuevas migraciones ni cambios LIVE.

## Funciones nuevas

| Rol | Ruta (GET) | Resultado |
|---|---|---|
| Cliente | `/api/v2/orders/:id/timeline` | Estado actual, versión e historial de cambios reales |
| Cliente | `/api/v2/orders/:id/receipt` | Comprobante de precios congelados de su pedido |
| Restaurante | `/api/v2/merchant/orders/:id` | Detalle autorizado, sin depender del listado de 100 |
| Restaurante | `/api/v2/merchant/orders/:id/timeline` | Historial de cambios del pedido de su comercio |
| Repartidor asignado | `/api/v2/driver/orders/:id/timeline` | Historial solo con asignación autorizada y perfil aprobado |

Cada ruta usa la sesión existente, verifica **propiedad/membresía/asignación en SQL** y devuelve `404 ORDER_NOT_FOUND` si no tiene acceso. Roles incorrectos devuelven `403 ROLE_FORBIDDEN`. Todos los datos son solo lectura.

## Ejemplo de historial seguro

```json
{
  "orderId": "5e1aa1bf-0fda-45bb-918f-2ae3aa4406e6",
  "status": "ready",
  "version": "4",
  "history": [
    {"from": null, "to": "received", "occurredAt": "2026-11-01T08:00:00.000Z"},
    {"from": "received", "to": "confirmed", "occurredAt": "2026-11-01T08:01:00.000Z"},
    {"from": "confirmed", "to": "preparing", "occurredAt": "2026-11-01T08:02:00.000Z"},
    {"from": "preparing", "to": "ready", "occurredAt": "2026-11-01T08:05:00.000Z"}
  ]
}
```

Las marcas de tiempo son ilustrativas; el backend devuelve las fechas reales de PostgreSQL. La consulta obtiene estado e historial desde el **mismo snapshot SQL**. Incluye solo transiciones verdaderas; omite emisión/rotación de PIN, acuses de efectivo, IDs de actores, payload de auditoría, comando idempotente y eventos privados de outbox. No hay seguimiento GPS.

## Comprobante del comprador

El comprobante ofrece `orderId,status,paymentMethod,paymentStatus,currency,fulfillment,itemsMinor,serviceFeeMinor,deliveryFeeMinor,tipMinor,totalMinor,lines`; cada línea incluye nombre, cantidad, precio por unidad y subtotal. **Todas las cantidades son centavos de MXN como strings**; jamás usar flotantes para sumas.

- Se crea desde el snapshot original, no desde precios actuales del catálogo.
- Verifica suma de líneas, servicios, envío y propina contra el total original.
- Nunca expone comisión del restaurante, pago del repartidor, margen de TALA EATS, dirección privada ni campos internos del JSON.
- Si la orden histórica carece del snapshot requerido, responde `409 RECEIPT_UNAVAILABLE` en lugar de inventar números.
- `paymentStatus:"paid"` para un pedido cash significa efectivo recibido según el doble acuse de la entrega, **no** liquidado por el banco ni conciliado financieramente.

## Verificaciones

`tests/orders-read.test.mjs` prueba:
- Recibo pickup, recibo delivery (incluido costo de envío), recibo inalterable tras modificar el precio del catálogo.
- Lectura individual del restaurante incluso si la orden es más antigua que las 100 del listado.
- Timeline con orden y versión, reflejando aceptación, preparación, listo, asignado y entregado.
- PIN y datos de efectivo omitidos; ninguna cuenta puede ver el historial o recibo ajeno.
- Repartidor sin asignación o con aprobación revocada: 404.
- Snapshot anterior incompleto: error recuperable 409; sin exponer un 500 ni precio falso.

**Release:** `0.2.0-lab.5`; no fusionar ni publicar en Kali sin validación posterior de producción.
