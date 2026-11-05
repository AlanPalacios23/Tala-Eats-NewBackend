# Tala Eats Core v2 — M10 Analítica · Acta técnica de cierre LAB2

**Fecha:** 5 de noviembre de 2026.
**Módulo:** 10/10 — Analítica.
**Rama:** `feat/core-v2-analitica-foundation` desde `main`.
**PR:** [#12](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/12), **Draft y sin merge**.
**Objeto:** cierre del desarrollo de laboratorio, **no** declaración de monolito unificado ni certificación comercial.
**Estado:** **M10 CERRADO EN LAB2** — último conjunto de pruebas y documentación aprobado en PostgreSQL 16. Esto certifica únicamente la fase de laboratorio.
**Operación comercial:** **NO-GO** — cero datos reales, cero Stripe LIVE, cero despliegues Kali.

## Alcance implementado

M10 procesa **solo cinco hechos** de dominios productores confiables y mantiene un modelo de lectura agregado, estrictamente propio:

| Hecho | Emisor autorizado | Métrica derivada |
| --- | --- | --- |
| `order.completed` | `orders` (futuro M1) | conteo de pedidos completados, GMV operativo en centavos |
| `order.canceled` | `orders` (futuro M1) | conteo de pedidos cancelados |
| `payment.confirmed` | `payments` (futuro M8) | conteo y monto de confirmaciones de pago |
| `refund.confirmed` | `payments` (futuro M8) | conteo y monto de devoluciones confirmadas |
| `delivery.completed` | `logistics` (futuro M2) | conteo de entregas completadas |

Los emisores se prueban con **claves de laboratorio** y eventos ficticios, no con el tráfico de M1, M2, M8 ni M3. Nunca se interpretan hechos `stripe_test` o `simulated_lab` como ventas comerciales. Los estados de M3 Finanzas prevalecen sobre cualquier métrica de M10 para dinero y ledger.

### Capas de seguridad y consistencia

1. **Datos mínimos:** siete campos exactos; no se acepta nombre, dirección, correo, teléfono, tarjeta, token, IP ni GPS. Solo UUID de operación, comercio y pedido; la presencia de UUID no garantiza anonimato frente a sistemas que conocen la relación.
2. **Firma HMAC-SHA256 por productor:** distinta keyring para `orders`, `payments` y `logistics`, identificador de clave, cuerpo original, timestamp ±300 s, comparación segura y autorización de tipo de evento por emisor.
3. **Idempotencia de red:** `eventId` único y SHA-256 del cuerpo. Evento idéntico repetido no incrementa métricas; contenido diferente con el mismo ID se rechaza.
4. **Idempotencia de negocio:** `orderId` único para resultado final de pedido, pago confirmado y entrega; `refundId` único para cada devolución parcial/total. Las cancelaciones y las entregas finalizadas son mutuamente excluyentes.
5. **Monto y coherencia:** MXN entero en centavos, monto positivo salvo cancelación/entrega; reembolsos sumados no superan el pago confirmado registrado. El mismo pedido no puede pertenecer a dos comercios.
6. **Concurrencia:** locks de `eventId`, `orderId` y `merchantId/día`, en orden fijo; hechos y contador diario se actualizan en **una misma transacción** PostgreSQL.
7. **Hechos inmutables:** `ingested_events`, `order_outcomes`, `payment_facts`, `refund_facts` y `delivery_facts` rechazan UPDATE y DELETE. No se borra, corrige ni duplica silenciosamente un hecho.
8. **Reportes privados:** `merchantAnalytics` requiere permiso host y coincidencia exacta de `actor.merchantId`; `platformAnalytics` exige capacidad global y sesión autenticada. Límite de 31 días inclusivos.
9. **Montos exactos:** BIGINT convertido a cadenas; `netPaymentFlowCents` es volumen neto del periodo, **no** utilidad, pago al comercio, efectivo en banco ni balance M3.
10. **Restauración del read model:** `reconcileMerchantDay` detecta diferencias entre `ingested_events` y `daily_merchant_metrics` y permite reconstruir solo los contadores derivados mediante permisos `canAuditAnalytics` y `canRepairAnalytics`, sin alterar los hechos.
11. **API LAB:** HTTP solo loopback, sin CORS abierto, `NODE_ENV=production` bloqueado. No hay API pública para firmar eventos, ni acceso a otros módulos.
12. **Migración protegida:** PostgreSQL schema `tala_analytics_v2`, base permitida exclusivamente `tala_analytics_v2_test` / `tala_analytics_v2_lab`. La CI verifica rechazo en una base distinta.

## Ensayos de laboratorio

Evidencia funcional ya comprobada antes del ajuste documental:
[GitHub Actions #41979503811](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41979503811) — **SUCCESS**, commit `e4682d23776e065c96c6a342adc7ac92acf03e3d`.

Resultado real de la última batería con código: **13/13 pruebas de integración + dominio aprobadas**, además de controles de compilación, migración y aislamiento.

**Verificación más reciente anterior a esta acta:** [GitHub Actions #41979991452](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41979991452), **SUCCESS** sobre `aac3b9b386466f28fb5f1305ddd5b64a3e6d676e`. Esta actualización textual del acta no altera las operaciones ni la migración; comprobar la nueva CI del commit documental antes de cerrar el PR.

Incluye 20 ingestiones simultáneas del mismo evento (una aplicada), 15 eventos concurrentes en paralelo con una reparación de agregado, misma referencia de evento entre pedidos distintos, separación entre comercios, errores de importe, devolución parcial, reclamos de diferentes emisores, HTTP E2E, fecha UTC histórica, alteración del contador diario y reparación privilegiada.

## Dependencias de producción no aprobadas

- **Integración real de los diez módulos:** las ramas y PR separados no están integrados en `main`. Faltan contratos versionados, integración de identidades M4/M9, precios y comisiones M1/M3, outbox M1/M2/M8, persistencia de productores y E2E global.
- **Conciliación y veracidad:** un productor debe acreditar sus hechos con estado comercial verdadero; M10 solo verifica firma y contrato. Faltan reconciliación periódica con M1/M2/M3/M8, redrive de outbox y observabilidad de lag/pérdidas de eventos.
- **Eventos avanzados:** capturas múltiples, disputas, reversos contables, cambios de restaurante, envíos parciales, cancelación posterior a entrega, ajuste manual y refund compensado requieren nuevas versiones de contrato.
- **Seguridad LIVE:** host autenticado, permisos multiempresa, gestión de claves/vault, rotación, SQL de mínimo privilegio, autorización staff, TLS, DDoS en proxy, backup/restore, retención y pruebas adversariales/carga.
- **Capa de producto:** faltan dashboards frontend/PWA reales, filtros de fechas amplios, KPIs de cliente con consentimiento, conversiones, adquisición, cohortes, AOV y reportes empresariales con fuentes adicionales. No inventar métricas sin datos fuente.
- **Política comercial:** antes de reportar beneficio o comisiones se requiere resolver discrepancias documentadas entre políticas del backend antiguo y nuevo. M10 no calcula ganancias ni cobra a nadie.
- **Kali y aplicaciones:** todo el código sigue en rama Draft. No hubo despliegue, merge, migración ni cambio de API de las apps Usuarios, Restaurante o Repartidor.

## Decisión de ingeniería

**M10 CERRADO EN LAB2:** la CI de la implementación y la documentación de arquitectura del módulo pasó en el último HEAD funcional verificado. Con eso se completará la **lista de diez dominios independientes propuestos** de Tala Eats Core v2, no un monolito ya ensamblado en `main`.

**GO siguiente fase:** preparar un plan explícito y seguro de fusión/integración, backend de staging único, contratos de eventos entre módulos, tests E2E comerciales y reconciliación antes de cualquier release.

**NO-GO LIVE:** Stripe, wallets, transferencias, datos de clientes, dashboards de negocio reales, deployment y sustitución del backend de Kali.

## Referencias

- [Arquitectura M10](MODULO10-ANALITICA-ARQUITECTURA.md)
- [README M10](../modules/analytics/README.md)
- [PR #12](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/12)
- [Estado real de los diez PR y la integración pendiente](CORE-V2-ESTADO-DIEZ-MODULOS.md)
