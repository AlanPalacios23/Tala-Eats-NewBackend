# Contrato de límites — TALA EATS CORE v2 · Módulo 3 FINANZAS

## 1. Responsabilidades y dueño de cada dato

| Función | Módulo responsable |
| --- | --- |
| Crear pedidos, precios y sus versiones | M1 Pedidos |
| Oferta, asignación, recogida, entrega, PIN y evidencias logísticas | M2 Logística |
| Diario contable, obligaciones, saldos, custodia de efectivo, liquidaciones contables, auditoría financiera | **M3 Finanzas** |
| Tarjetas, cobros, pasarelas, Stripe, webhooks, reembolsos de proveedor, transferencias externas | **Módulo de Pagos (futuro, no creado aquí)** |

**M3 no importa código ni tablas de M1, M2 o Pagos.** Evoluciona
independientemente en la rama `feat/core-v2-finanzas-foundation`, PR #5,
basada directamente en `main`.

## 2. Arquitectura financiera y garantías actuales

- **Diario de partida doble inmutable:** cada entrada financiera de
  laboratorio se registra en una transacción PostgreSQL y debe balancear.
- **Contratos de precios versionados:** valida sumas y participación de
  restaurante, logística y plataforma, pero no fija ni modifica tarifas.
- **Retenciones:** `liability.merchant_pending`,
  `liability.delivery_held`, `liability.platform_pending`;
  contrapartida `asset.external_clearing_pending`. No significa que
  el proveedor de pagos haya liquidado dinero ni que exista liquidez.
- **Proyección de wallet de restaurante:** suma de pendientes,
  disponible = 0 por diseño hasta integrar hechos confiables de cumplimiento.
- **Auditoría contable interna:** detecta inconsistencias entre snapshot,
  huellas y partidas. Solo lectura, acotada por orden o lote.
- **Reverso contable total:** `held_reversals` conserva una compensación
  inmutable, única por asignación. No efectúa devolución con proveedor.
- **Estado de cuenta financiero interno:** consulta por restaurante y páginas
  de movimientos retenidos y compensados; saldo disponible sigue en cero.

La función de registro `recordLabHeldAllocation` crea **asignaciones
contables de laboratorio**, no pagos. No está montada en HTTP y
no permite que una PWA o comprador la invoque.

## 3. Interfaces que se definirán al integrar módulos

**De M1:** `OrderFinancialSnapshot.v1` autenticado, con `orderId`,
`restaurantId`, `policyVersion`, MXN, subtotales y splits en centavos.

**De M2:** `FulfillmentConfirmed.v1` y `CashCustodyConfirmed.v1`
autorizados, idempotentes y auditables para contabilizar liberaciones
y arqueos, **sin que M3 adjudique repartidores ni verifique PIN**.

**Del futuro módulo de Pagos:** hechos firmados, verificados e idempotentes,
como `FundsConfirmed.v1`, `ProviderRefundConfirmed.v1` o
`ExternalPayoutCompleted.v1`. Finanzas solo registra las consecuencias
contables; no llama a la red de cobro ni realiza transferencias.

Estos nombres son **contratos propuestos, no integraciones existentes**.

## 4. Próximas tareas **exclusivas** de M3

1. **Wallets contables completos:** obligaciones retenidas, disponibles,
   reservas, transferencias en trámite y liquidaciones por comercio/repartidor,
   derivadas del ledger, con permisos y controles de saldo negativo.
2. **Custodia y arqueo de efectivo:** deudas de repartidor con restaurante/
   plataforma, abonos, faltantes, sobrantes y conciliación de caja;
   sin crear cobros a tarjeta.
3. **Libro auxiliar y ajustes compensatorios:** cancelaciones, provisiones,
   reversos internos y reglas de cierre; nunca reescribir el diario.
4. **Conciliación y reportes:** por negocio, periodo y pedido, con alertas
   de diferencias, estados financieros internos y trazabilidad.

## 5. Riesgos y bloqueo de salida a producción

- El origen autenticado de hechos de M1/M2/Pagos no está integrado.
- No está autorizado mover un saldo pendiente a disponible ni ejecutar retiros.
- Faltan saldos negativos, pruebas de contención de wallets, pruebas E2E,
  controles DB de mínimo privilegio y observabilidad.
- **Discrepancia P0:** M1 calcula comisión del 17 %, política previa del 15 %;
  requiere acuerdo y nueva versión de tarifa para futuras compras.
- Este módulo es **LAB ONLY**. Stripe LIVE y Kali no se modifican.

Los prototipos previos de Stripe se conservan en el historial Git, pero
sus archivos no forman parte del estado actual del Módulo 3.

Avance LAB2 y pruebas: [Compensaciones y estado de cuenta](MODULO3-FINANZAS-LAB2.md).
