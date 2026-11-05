# M11 Integración — Estado del ensamblaje y gates LAB1

**Fecha:** 5 de noviembre de 2026.
**Rama:** `feat/core-v2-integracion-monolito-m11` desde `main`.
**Objetivo:** consolidar las copias **de código** de M1–M10 en una sola rama de integración, sin fusionar PRs originales, y crear el módulo M11 para transportar eventos de dominio mínimos en laboratorio.
**Veredicto:** pendiente de CI unificada sobre último HEAD.
**Comercial:** NO-GO — sin pagos LIVE, escrituras financieras, conexión a las apps o despliegue en Kali.

## Avances verificables

1. El snapshot está hecho de árboles Git completos, no de muestras/reconstrucciones; cada árbol fuente tiene un SHA fijado en `modules/integration/source-lock.json`.
2. La parte M2 viene de una rama descendiente exactamente de M1 HEAD (comparación GitHub: M2 por delante de M1, cero commits detrás), de modo que no se perdió una corrección M1 al incorporar Logística.
3. M11 no modifica fuentes originales ni consume tablas de otros dominios; define su propia DB `tala_integration_v2_test/lab`.
4. Se registra un inbox de eventos tipados, mínimos y sin PII con deduplicación y fanout por consumidores, claims transaccionales, leases de 30 s, protección de ACK tardío y DLQ tras 3 intentos.
5. Hay una simulación de contratos de los diez módulos que exige sesión válida, autorización, cobertura, cotización total coherente, pago `simulated_lab`, preparación/entrega simuladas, vista previa M3 **sin escrituras**, notificación y métricas de prueba.
6. Un shell HTTP M11 **solo de lectura** expone salud/composición en loopback. Declara `tenRealPortsConnected=false` y `commercialReady=false`.
7. La CI crea **un servidor PostgreSQL 16 y diez bases LAB separadas**, migra y ejecuta tests/build de los diez módulos reales, importa las diez entradas en el mismo Node 24 y luego valida M11. No contiene secretos de producción.

## Gates que la CI M11 debe superar

| Gate | Criterio |
| --- | --- |
| Proveniencia | 10 SHAs de subárboles exactos |
| Runtime | 10 módulos cargan en un único Node 24 |
| M1+M2 | `npm run check` de la base conjunta con PostgreSQL 16 |
| M3–M10 | `npm run check` de cada dominio con PG compartido como servidor, DB aislada |
| Finanzas | Suite adicional de archivos `tests/*.test.mjs` |
| Migraciones | 9 grupos SQL más M1/M2, cada uno en su DB autorizada |
| M11 dominio | Payloads validados, origen y consumidor según allowlist |
| Idempotencia | 25 entregas simultáneas equivalen a 1 evento almacenado |
| Resiliencia | 30 s de lease, rechazo de ACK obsoleto, 3 intentos y DLQ |
| Simulación | Escenario de diez ports; fail-closed si el monto o la prueba de pago no coincide |
| Privacidad | Nada de PAN, email, teléfono, ubicación o secretos en el envelope |
| HTTP | Servidor loopback, solo GET diagnósticos, no rutas comerciales |
| Aislamiento | Migración SQL M11 rechazada en base ajena |
| Producción | Flags de LIVE, payout, escritura y HTTP público rechazadas |

## Riesgos sin resolver, incluso si todos los tests pasan

- Los diez módulos **compilan y pueden convivir en la misma rama**, pero todavía usan DB separadas y servidores LAB distintos. No se les ha conectado a un único gateway Express con autenticación de cuenta real y adaptadores comerciales.
- Las pruebas M11 de escenario utilizan **puertos simulados**, no las funciones de los diez módulos; no prueban un flujo real pagado/pedido/entrega/refund.
- Los mensajes M11 son enviados por un host de laboratorio. Falta outbox durable **en cada productor dentro de su transacción** y consumidores reales con claves de idempotencia, en especial para efectos M3 y M8.
- Stripe TEST con una cuenta real, M3 wallets/ledger, M9 grants, M4 roles, M6 stock, M7 zonas y M2 dispatch deben validarse juntos, antes de cualquier anuncio de integración operativa.
- Tarifas y política de comisiones históricas deben reconciliarse. No derivar utilidades de totales ficticios.
- Falta seguridad infra (TLS, vault, privilegios SQL, DDoS, monitoreo, backup/restore, gestión de IP, canary y rollback).

**Decisión planeada:** GO para siguiente etapa de integración real **solo si la CI unificada PASS**. NO-GO para merge, Stripe LIVE, transferencia de dinero, sustitución de backend Kali o publicación a clientes.

[Arquitectura M11](MODULO11-INTEGRACION-ARQUITECTURA.md) ·
[README M11](../modules/integration/README.md).
