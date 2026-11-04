# Tala Eats Core v2 — M8 Pagos: arquitectura aislada LAB1

**Fecha:** 4 de noviembre de 2026. **Estado:** LAB1 en desarrollo y pruebas.
**NO-GO para Stripe LIVE, pagos reales, merge y despliegue Kali.**

## Límites de responsabilidad

| Dominio | Propietario |
| --- | --- |
| Crear pedidos, cálculo de total y congelación de política de precios | M1 Pedidos |
| Inventario/catálogo/tienda | M6 Restaurantes |
| Identidad, sesión, permisos y validación de quién puede pagar | M4 Usuarios / gateway |
| Cargo, PSP, confirmación real firmada, reembolsos externos y futuras transferencias PSP | **M8 Pagos** |
| Doble partida, cash, cuentas por pagar, wallets y liquidaciones contables | M3 Finanzas |
| Repartidores, entrega física, prueba de entrega, ETAs y GPS | M2 Logística / M7 Ubicaciones |
| Notificaciones al cliente/comercio | M5 Notificaciones |

**M8 no importa código, no crea FKs ni realiza queries a tablas de ningún otro módulo**. El límite actual se expresa mediante campos UUID de referencia que el host debe autenticar y asociar antes de integrar. M8 tampoco controla tarifas, 15 % versus 17 %, ni calcula comisión/reparto de ingresos: esa diferencia pendiente se resuelve en el contrato de precios de M1 y Finanzas.

## Esquema propio

Migración `001_payments_foundation.sql` en `tala_payments_v2`, permitida únicamente en DB descartables `tala_payments_v2_lab` o `tala_payments_v2_test`. Tablas:

- `payments`: referencia externa de pedido única, referencia externa de comprador, centavos MXN, estado, versión y referencia de proveedor simulado.
- `refunds`: cantidades y estados solicitados/completados/fallidos, FK interna únicamente a `payments`.
- `idempotency_receipts`: operación única por actor con huella estable e ID resultado.
- `provider_events`: huellas e IDs de callbacks firmados del simulador; inmutable mediante trigger.
- `verified_facts`: solo registros derivados del simulador con `source='simulated_lab'`. Son **no autoritativos fuera de LAB**, no se envían a M3 ni activan fondos.
- `audit`: acciones mínimas sin datos de tarjeta ni contenido HTTP; inmutable mediante trigger.

## Modelo de transición

```text
             evento simulado firmado
pending ──── payment.succeeded ────> succeeded
   │
   ├─────── payment.failed ────────> failed
   │
   └─────── payment.canceled ──────> canceled

succeeded ── requestRefund(centavos) ──> refund.requested
                                          │
                              refund.succeeded / refund.failed
                                          │
                           refund.succeeded / refund.failed
```

El pago no pasa de `failed/canceled` a `succeeded` por una notificación tardía. El reembolso solo se solicita sobre `payment.succeeded` y reserva la cantidad contra el total de reembolsos pendientes o confirmados. Reembolsos fallidos liberan la reserva. La transacción bloquea el pago antes de reservar y verificar resultados, evitando sobre-reserva simultánea.

La semántica exacta del PSP futuro puede ser más compleja: intentos múltiples, cancelación durante captura, fallos temporales, disputas y autorizaciones parciales se modelarán **solo** al integrar el adaptador TEST y documentar su contrato.

## Seguridad de callbacks (solo simulador)

- Se valida HMAC SHA-256 sobre bytes exactos y timestamp local de tolerancia ±300 s, con comparación en tiempo constante.
- Eventos restringidos a cinco tipos; ID UUID, monto/currency exactos, referencia `lab_` y vinculación estricta al pago/reembolso.
- Deduplicación por `event_id` bajo bloqueo por pago; reenvíos exactos sin nuevos hechos; cambio de payload con mismo ID da error.
- `provider_events` y `verified_facts` no se modifican ni borran; no se copian payloads externos.
- Única referencia de proveedor permitida: `simulated_lab`; ningún acceso a Stripe LIVE ni TEST, bancos, wallets, proveedores externos ni estado del pedido.
- Solo loopback HTTP y `NODE_ENV!==production`. Capability `canCreatePayments/canRefundPayments/canReadPayments` suministrada por el host autenticado; nunca declarada en body.

## Contratos posteriores, aún no implementados

**M1 → M8:** `PaymentRequest.v1` autenticado, `orderId`, `customerId`, `amountCents`, `currency`, idempotencia, versión del precio, expiración y anti-replay.

**M8 → M3:** `FundsConfirmed.v1`, `ProviderRefundConfirmed.v1` verificables con identidad, referencias de PSP, origen **real** distinguible, validación de monto, firma entre módulos, outbox durable y reintentos, una vez certificado el adaptador PSP. **No usar `verified_facts` de LAB como si fuera conciliación bancaria.**

**M4 → M8:** permisos de servidor, identidad, control anti-fraude y límites de acceso a datos sensibles.

**M8 → proveedor:** Stripe TEST mediante adaptador separado, webhooks oficiales y verificación de su firma; Stripe Connect/payouts solo con reglas de plataforma y validaciones externas.

## Requisitos de cierre y de producción

**LAB1:** compilar con TypeScript estricto, migrar PostgreSQL 16 aislado, aprobar pruebas unitarias y E2E de red local, simulación HMAC, eventos fuera de orden, saldo reembolsable, concurrencia, inmovilidad SQL y guard contra migraciones externas. Solo entonces considerar GO para seguir otro módulo.

**LIVE:** explícitamente bloqueado hasta tener Stripe TEST real certificado, autenticación y autorización, interfaz contable segura con M3, conciliación vs PSP, disputas/reembolsos/redrive, monitoreo, backup restore y pruebas de seguridad/carga/dispositivos; no activar claves LIVE, transferencias a comercios ni retiros.
