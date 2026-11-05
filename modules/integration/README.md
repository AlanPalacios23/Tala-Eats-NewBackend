# Tala Eats Core v2 — M11 Integración del monolito (LAB1 aislado)

**Rama:** `feat/core-v2-integracion-monolito-m11`, creada desde `main`.
**Estado:** composición de código M1–M10 + contratos M11 y CI unificada de laboratorio. **NO-GO comercial, NO-GO merge, NO-GO Kali.**
**El conjunto de fuentes aún NO equivale a un backend comercialmente integrado.**

## Qué hay realmente dentro de esta rama

- **M1 Pedidos + M2 Logística**: copiados en el árbol de raíz desde `feat/core-v2-logistica-lab1`, rama descendiente directa del HEAD vigente de M1 Pedidos. No se duplicó M1.
- **M3–M10**: conservan sus subárboles exactos `modules/finance`, `modules/users`, `modules/notifications`, `modules/restaurants`, `modules/locations`, `modules/payments`, `modules/security`, `modules/analytics`.
- **M11**: nuevo `modules/integration/**`, completamente separado de la implementación interna de M1–M10.
- **Proveniencia reproducible**: `source-lock.json` fija los SHA Git de los diez subárboles. `npm run verify:snapshots` comprueba que ninguno fue alterado al ensamblar. Si se actualiza deliberadamente un módulo, corresponde revisar el contrato, la CI y subir una nueva versión del lock.
- **Carga en un único runtime Node 24**: `npm run probe:imports` importa código real de los diez dominios. Esto verifica carga/compatibilidad de módulos **sin ejecutar pagos ni mutaciones**.
- **CI combinada**: usa **un servidor PostgreSQL 16 descartable** con **diez bases de datos LAB** (M1+M2 comparten `tala_core_v2_test`, M3–M10 una por dominio y M11 `tala_integration_v2_test`). Cada base se migra con SQL propia y se ejecutan los tests y compilaciones reales de cada módulo.

**Por qué no una única base todavía:** las migraciones M1–M10 contienen guardas que aceptan solo sus nombres de DB de laboratorio. Eliminar esas guardas precipitadamente o ejecutar las migraciones sobre el banco de datos Kali podría modificar datos reales. La meta posterior es una sola infraestructura Postgres con esquemas separados y privilegios mínimos, tras aprobar migraciones de integración versionadas y rollback.

## Contrato M11 de eventos

M11 provee un **inbox con entregas durables, reintentos y DLQ**, sin alterar las tablas propias de M1–M10. No es un reemplazo del outbox de los productores.

Eventos LAB aceptados:

| Emisor | Evento | Consumidores permitidos |
| --- | --- | --- |
| Pedidos | `orders.order_created` | Notificaciones |
| Restaurantes | `restaurants.order_ready` | Logística, Notificaciones |
| Logística | `logistics.delivery_completed` | Notificaciones, Analítica |

Formato: `schemaVersion=1`, `eventId`, `source`, `kind`, `merchantId`, `orderId`, `occurredAt` (UTC). Se rechazan campos inesperados, datos personales y montos financieros.

La API **in-process** `publishEvent(pool,trustedPublisher,event)` exige que el host marque al emisor como verificado y que coincida con `source` en un mapa cerrado. El origen **no se determina por un JSON enviado por el frontend**. No existe endpoint de Internet para publicar eventos.

- `events`: registro inmutable del hecho mínimo, `eventId` único y SHA-256 del contenido.
- `deliveries`: entrada independiente por evento + consumidor, con estados `pending`, `leased`, `delivered`, `dead`.
- `claimDelivery`: bloqueo `FOR UPDATE SKIP LOCKED`, lease de 30 s, `claimId` distinto por intento.
- `acknowledgeDelivery`: el ACK tardío de un worker anterior no puede cerrar un lease nuevo.
- `rejectDelivery`: reintentos limitados a 3, después `dead` para diagnóstico manual. No se almacena mensaje de excepción porque podría incluir tokens o datos personales.
- `readBridgeMetrics`: solo personal autorizado por host, conteos agregados por consumidor/estado.
- El **consumidor final debe ser idempotente** ante entregas repetidas, y debe usar `eventId+consumer` como clave. M11 garantiza entrega **al menos una vez**, no exactly-once de efectos externos.
- **Pendiente:** fuente real de outbox transaccional M1/M2/M6, autenticación de productores, worker real con bindings M5/M2/M10 y reconciliación de fallos de red.

## Prueba de diez fronteras

`runIsolatedTenModuleSmoke` ejecuta un escenario de **contratos inyectados**, no endpoints de producción:

`M4 Usuario → M9 Seguridad → M7 Zona → M6 Cotización → M1 Pedido → M8 Pago simulado → M6 Preparación → M2 Entrega simulada → M3 Previsualización financiera SIN escritura → M5 Notificación simulada → M10 Métricas simuladas`.

Este escenario exige confirmación **exclusivamente `simulated_lab`**, monto coherente, ninguna escritura en wallets/ledger y cero datos LIVE. Los tests usan dobles de prueba para estas diez interfaces. **No se debe interpretar como prueba E2E real de las aplicaciones**.

## Arranque seguro

`checkIntegrationAdmission` exige:
- `CORE_V2_INTEGRATION_RUNTIME=isolated-lab`;
- `NODE_ENV` distinto de `production`;
- flags de escrituras, LIVE payments, payouts y exposición pública NO habilitadas;
- URLs PostgreSQL locales, con nombres exactos de DB LAB para los diez roles.

`createIntegrationLabHttpServer` es solo una vista read-only de ensamblaje:
- `GET /v1/integration/health`
- `GET /v1/integration/modules`

No monta ninguna ruta de cliente, cobros, restaurante, repartidor, wallet o retiros. Las rutas de los otros módulos son **sus laboratorios originales**, no un API de producción unificada.

## Próximas puertas técnicas para integración real

1. **CI unificada** de las diez fuentes en un commit, sin modificar `main`.
2. Contratos reales y adaptadores seguros entre M1/M4/M6/M7/M8, M8/M3, M2/M5/M10 y M9/ADMIN. Autoridad del total, usuario, comercio, ubicación y estado explícita.
3. Outbox de productor en la misma transacción que el hecho de negocio, redrive, idempotencia y DLQ, más pruebas de caídas y webhooks reales Stripe **TEST**.
4. Un único composition root Express/Node con autenticación real y módulos bajo rutas versionadas, conectado a roles SQL mínimos en staging (no reemplazar LAB HTTP automáticamente).
5. E2E de extremo a extremo con las apps Usuarios, Restaurantes, Repartidores y ADMIN, incluyendo refund, efectivo, PIN, conciliación M3 y métricas M10.
6. Auditoría de tarifas (15 % vs 17 %), snapshots y totales reales, backups/restauración, protección TLS, DDoS, QA, revertir y despliegue canario autorizado.

**No se han fusionado los PR M1–M10 a `main`; siguen abiertos para su revisión.** El backend antiguo de Kali sigue intacto.

[Arquitectura M11](../../docs/MODULO11-INTEGRACION-ARQUITECTURA.md)
