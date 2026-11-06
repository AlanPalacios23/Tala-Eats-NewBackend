# Tala Eats Core v2 — M11 LAB9: preparación LIVE, NO despliegue

**Fecha:** 2026-11-06. **Rama:** `feat/core-v2-m11-live-readiness-lab9` (basada en M11 PR #13).  
**Decisión comercial del propietario:** comisión a negocios **17 %** del subtotal de artículos; tarifa de servicio al cliente **7 %** del subtotal. **Se conserva el tope de $25 MXN existente en M1**; esta implementación ya tenía tope y no se cambia implícitamente. Propinas sin comisión. La tarifa de envío depende del checkout: actualmente M1 LAB usa 39 MXN de envío y 32 MXN de base al repartidor para sus ejemplos fijos. Estos importes NO prueban cálculo por distancia.

## Cambio material LAB9

- M1 `quoteOrder` sigue siendo autoridad de cotización y versión `pilot-2026-11-v2-17pct`.
- Nuevo contrato M11 `adapters/pricing-policy-lab.ts`: `verifyApprovedM11PricingSnapshot`: antes de asentar dinero retenido en M3, reconstruye la cotización desde **las líneas auténticas de M1**, comprueba todos los importes en centavos, política, divisa, fulfillment y total del pedido.
- Rechaza diferenciales de comisión, tarifa, cap, total, moneda, líneas, entrega, propina o payout; no crea una nueva comisión en M11 ni altera M1–M10.
- El resultado `policyApproved=true` se refiere exclusivamente a la **política de precios verificada** para el asiento HELD del pedido de retiro en efectivo. `commercialReady=false`, `withdrawable=false` y `externalTransfersEnabled=false` continúan obligatorios.
- CI repite tests reales M1–M11 y nuevas pruebas de regresión 17 % / 7 % / tope / alteración de precios.

## Criterios obligatorios ANTES del primer despliegue comercial

| Gate | Condición verificable | Estado 06-nov |
| --- | --- | --- |
| Política | Recalcular 17 %/7 %, reconciliar M1→M3 con snapshots auténticos y cotización cliente, aprobar explícitamente tope existente | **Implementado en M11 LAB9; pendiente CI del HEAD y verificación en staging** |
| Integración única | Resolver duplicidad PR #13 vs #14; crear una sola rama de release con gateway/worker reales y CI completa | **PENDIENTE** |
| Runtime LIVE | Servidor seguro de producción y rutas auténticas de M1–M10 con auth M4/M9, aislamiento entre tiendas y roles SQL mínimos | **PENDIENTE** |
| M1/M6 | Convertir extensiones `m1-extension`/`m6-extension` en ports oficiales de cada módulo, resolver reservas/compensaciones y consistencia entre DB | **PENDIENTE** |
| Stripe TEST de proveedor | PaymentIntents y webhooks contra cuenta Stripe TEST auténtica; idempotencia, cobros tardíos, refund, cancelación, timeouts y reintentos | **PENDIENTE; LAB8 usa transporte offline** |
| Entrega M2/M7 | Domicilio E2E con zona/dirección, asignación real, presencia, recogida, PIN y reintentos bajo concurrencia | **PENDIENTE** |
| Finanzas | Conciliación M8↔M3, efectivo en custodia y entrega física, wallets y saldos retenidos, driver/merchant settlement; no habilitar pagos sin reconcile | **PENDIENTE** |
| Eventos | Outbox durable productor, workers permanentes, inbox idempotente M11, DLQ/redrive y métricas/alertas con pruebas de caída | **PENDIENTE** |
| Apps | Contratos y E2E verificables en Usuarios, Restaurantes, Repartidores y ADMIN contra staging independiente | **PENDIENTE** |
| Operaciones | Migraciones versionadas, secrets, backups restaurados, rollback probado, CI consolidada, observabilidad, estrés y canary | **PENDIENTE** |
| Activación | Revisión humana de evidencia; aprobación separada de migración, despliegue y habilitación de Stripe LIVE / transferencias | **PENDIENTE** |

## Secuencia controlada

1. Cerrar LAB9 con GitHub Actions verde al SHA exacto. Mantener PR Draft.
2. Consolidar #13 y #14 **sin merge directo a `main`** ni sobrescribir código aprobado de dominios.
3. Construir y comprobar un solo servidor/worker en preproducción con acceso restringido; completar gates P0 y pruebas de dinero.
4. Generar RC versionada y manifiesto de hashes, imágenes, migraciones `up`/reversión, backups y plan de compatibilidad con las apps.
5. Ejecutar preflight en Kali de **solo lectura** y preparar cutover/rollback. La activación LIVE requiere autorización explícita posterior.

**Limitación:** los guards de LAB rechazan deliberadamente `NODE_ENV=production`, las conexiones prod y los pagos LIVE. Aprobar 17 %/7 % **NO** autoriza saltarlos. No se deben copiar credenciales ni datos de producción a CI. M11 LAB9 no hace cargos, transferencias ni cambios en Kali.
