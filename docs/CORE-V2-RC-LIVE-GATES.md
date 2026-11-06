# Tala Eats Core v2 — RC LIVE: política y gates de liberación

Fecha: 2026-11-06. Rama de trabajo: `feat/core-v2-integracion-monolito-m11`. Estado: **PREPARACIÓN RC, NO-GO LIVE**.

## Política comercial aprobada
- Comisión del comercio: **17 %** de la base de productos, no de propinas.
- Tarifa de servicio del cliente: **7 %** conforme al contrato de checkout y su base gravable explícita.
- Propinas: comisión **0 %**.
- Importes enteros en centavos MXN; redondeo determinista por línea y total; sin floats para dinero.
- La política anterior del 15 % queda sustituida **para Core v2** por aprobación expresa del usuario el 6-nov-2026. Los documentos LAB5–LAB8 que marcan 17 % como discrepancia quedan históricos, no son el criterio vigente.
- Ningún módulo debe usar 15 % por defecto. Una aprobación de porcentajes **no** habilita pagos, wallets ni transferencias LIVE.

## RC1 integrado — cambio probado en rama de release

La rama `feat/core-v2-m11-rc1-pricing-and-gates` (PR de revisión) actualiza la política M1 a `pilot-2026-11-v3-17pct-7pct-uncapped`. El 17 % del comercio y 7 % de servicio cliente no tienen topes ocultos; propinas sin comisión. M11 exige cotización exacta y versionada antes de M3 HELD y la finalización Stripe TEST. Cambios de M1 reflejados mediante un nuevo pin de árbol en `modules/integration/source-lock.json`; los precios y asientos viejos no se reescriben. **Esto es cierre de un subconjunto de G2; no implica aprobación de G3–G9.**

## Criterios de aceptación antes de publicar

| Gate | Evidencia requerida | Estado |
| --- | --- | --- |
| G1 — Árbol único | LAB9 montó las factories de los 10 módulos desde una rama de M11; falta integrar el gateway real y resolver duplicación de PR #13/#14 | PARCIAL (NO-GO) |
| G2 — Contratos de dinero | Política v3 17/7 sin tope + prueba cruzada M1/M11/M3 y guardia M8 TEST; aún faltan impuestos, descuentos, cancelación, reembolsos, conciliación y wallets completos | PARCIAL (NO-GO) |
| G3 — Autorización | RC2 gateway local de permiso de cancelación verificado con M4→M1 ownership→M9; aún faltan identidad unificada, gateway público seguro y autorizaciones por cada mutación | PARCIAL (NO-GO) |
| G4 — Checkout definitivo | Migrar extensiones LAB de M1/M6 a módulos propietarios; reservas/compensaciones, expiración y recuperación tras crash | PENDIENTE |
| G5 — Stripe TEST real | Cuenta de prueba y webhooks remotos firmados; pagos tardíos, reembolsos, idempotencia, conciliación M8→M3 | PENDIENTE |
| G6 — Logística y efectivo | M1→M2/M7→M3, reparto, GPS, PIN, prueba de custodia, handoff efectivo y saldos retenidos | PENDIENTE |
| G7 — Transporte durable | Productores outbox, consumidores M3/M5/M10, workers persistentes, DLQ/redrive, monitoreo y reconciliación | PENDIENTE |
| G8 — Staging | Migraciones versionadas, roles SQL mínimos, secretos, TLS, backup/restauración, rollback, stress y E2E con apps Usuarios/Restaurantes/Repartidores/ADMIN | PENDIENTE |
| G9 — CI y release | CI global en HEAD final, artefacto versionado, smoke, /ready real, aprobación de despliegue y plan de canary/rollback | PENDIENTE |

## Bloqueos verificables

LAB8 usa Stripe TEST **offline**, con transporte inyectado y claves ficticias; no demuestra interacción con proveedor real. Los puertos M1/M6 para Stripe y holds son extensiones transitorias. El PR #14 bloquea explícitamente rutas comerciales y NODE_ENV=production; su CI verde valida ensamblaje y transporte LAB, no readiness comercial. PR #13 y #14 siguen Draft. `main` no contiene el monolito.

## Límites de operación

No modificar Kali LIVE, no desplegar, no ejecutar migraciones de producción, no activar Stripe LIVE, transferencias, retiros ni fondos disponibles durante la preparación RC. No declarar `productionReady=true` ni `/ready=200` hasta demostrar G1–G9. Los porcentajes 17/7 están aprobados, pero requieren tests de cálculo y contabilidad antes de operar.

## Siguiente incremento de ingeniería

1. Consolidar ramas M11 en una rama canónica con pruebas de no regresión.
2. Añadir pruebas de pricing 17/7 en pedidos/finanzas, sin introducir tarifas a ciegas.
3. Completar M1/M6/M8/M3 en staging, luego M2/M7 y M5/M10.
4. Ejecutar gates G1–G9 y preparar release candidate, **sin despliegue automático**.
