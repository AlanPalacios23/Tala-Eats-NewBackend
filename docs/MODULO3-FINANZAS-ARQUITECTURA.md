# Módulo 3 · Finanzas · Contrato de independencia

## Repositorio y evolución independiente

| Área | Espacio | PR base |
| --- | --- | --- |
| M1 Pedidos | `src/modules/orders/`, rama `feat/core-v2-pedidos-foundation` | `main` |
| M2 Logística | `src/modules/logistics/`, rama `feat/core-v2-logistica-lab1` | M1 (temporal) |
| M3 Finanzas | **`modules/finance/`**, rama `feat/core-v2-finanzas-foundation` | **`main`** |

M3 es autónomo: esquema `tala_finance_v2`, migraciones ordenadas localmente,
pruebas y workflow CI propios. Nunca ejecutar su migración en base M1/M2 o LIVE.
Su contrato de entrada será un evento versionado de pago/custodia verificado,
con `orderId`, `policyVersion`, desglose de centavos y evidencia de origen.
Las tablas y APIs M1/M2 no se importan ni se escriben desde Finanzas.

## Controles de integridad pendientes

- **P0**: M1 usa comisión 17%; comercial previamente aprobado 15%.
  Requiere acuerdo y política versionada para pedidos nuevos. No modificar
  snapshots de pedidos ya creados.
- Evidencia criptográfica del proveedor: solo TEST hasta completar verificación.
- Fuente de verdad de efectivo: custodia y evidencia de entregas antes de acreditar wallets.
- Idempotencia durable por ID de evento y una captura por pedido.
- Reversos y reembolsos compensatorios; nunca borrar asientos.
- Liquidez y payouts: balances contables **no** son dinero disponible para transferir.
- Conciliación entre pedidos, ledger, Stripe y custodia; fallos y reintentos seguros.

## Gates para integración

1. Suite M3 y base local PostgreSQL propias, sin accesos cruzados.
2. M1 emite contrato de importes versionado y verificado.
3. M2 emite hechos de custodia/entrega independientes de rutas internas.
4. Solo después de gates E2E, revisión de seguridad y aprobación explícita
   preparar despliegue. No se activa ningún flujo comercial en esta fase.
