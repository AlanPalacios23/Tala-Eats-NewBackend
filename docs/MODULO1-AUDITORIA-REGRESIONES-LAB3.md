# Pedidos · Segunda auditoría P0 de errores y regresiones
Fecha: 2026-11-01 · Release: `0.2.0-lab.3` · Alcance: exclusivamente `src/modules/orders` y sus migraciones/tests/admisión.

## Hallazgos reales reparados

| Hallazgo | Riesgo previo | Corrección y prueba |
|---|---|---|
| Cancelación confirmada | El servicio admitía cancelar tras `confirmed` mientras la máquina de estados lo prohibía | Política única: buyer solo `received`, merchant `received` y `confirmed`; transición central + restock en misma transacción; nueva prueba HTTP de cancelación tras aceptar |
| UUID con mayúsculas | UUID válidos podían no coincidir con claves normalizadas devueltas por PostgreSQL; error o producto aparentemente no disponible, y hash idempotente distinto | Normalización a minúsculas en duplicados, lookup, quote, snapshot y `request_hash`; replay con misma intención no descuenta stock otra vez |
| Carritos demasiado caros | `quoteOrder()` arrojaba Error genérico, que el adaptador HTTP convertía en `500 INTERNAL_ERROR` | Mapear solo los errores de dinero/rango previstos a `CART_TOTAL_OUT_OF_RANGE` HTTP 400; no mutar inventario |
| Dirección mutable y evidencia alterable | Migración 005 no congelaba `delivery_address`; los acuses de efectivo y PIN consumido admitían UPDATE posterior | Nueva migración 007 de PostgreSQL, trigger de snapshot y de prueba write-once, sin impedir los estados legítimos |

## Alcance confirmado
- Pedido CASH en LAB desde cotización hasta `delivered`: recogida y domicilio.
- Precio, stock, estado, evento append-only y outbox transaccionales.
- Autorización por comprador, comercio y repartidor asignado.
- PIN con vencimiento, límite de intentos, límite de emisiones, verificación de un solo uso.
- Contrato estricto de cancelación y compensación de inventario.
- Migrations SQL `001`–`007` en PostgreSQL **únicamente local descartable**.
- Arranque del servidor exige nuevo trigger de prueba `trg_order_handoff_proof_immutable`.

## Evidencia automatizada
- `tests/orders-hardening.test.mjs` incluye: UUID case-insensitive, replay mismo pedido, duplicados case-insensitive, cancelación tras confirmación, carrito demasiado grande con status 400 y stock intacto.
- `tests/orders-integrity.test.mjs` intenta actualizar dirección original, borrar acuse de efectivo y desconsumir PIN y exige error SQL `23514`.
- Pruebas preexistentes de concurrencia, entrega, seguridad, conflictos, locks y arranque seguro siguen aplicando.
- Estado verificable en GitHub Actions por SHA final; no usar pruebas antiguas como garantía para un commit nuevo.

## Riesgos pendientes
- El módulo puede pasar su validación técnica interna en LAB sin ser una plataforma comercial. No se ha probado contra producción ni con PWAs Android/iOS.
- Antes de LIVE hacen falta contrato comercial de tarifas (CORE v2 17% vs piloto previo 15%), conciliación de efectivo, liquidación, Stripe TEST firmado, seguridad distribuida, despliegue y rollback.
- Un estado `paid` por doble acuse de cash significa efectivo recibido por el custodio, **no** liquidado o conciliado.
- La protección de triggers limita cambios ordinarios de filas, no convierte una cuenta superusuario de PostgreSQL comprometida en inmutable.

**Decisión recomendada:** mantener PR #1 DRAFT y producción intacta; permitir planificación del siguiente módulo solo tras CI PASS en SHA final.
