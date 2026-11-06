# RC — Auditoría de endurecimiento del Módulo 1: Pedidos
Fecha: 2026-11-01 · Rama `feat/core-v2-pedidos-foundation` · ámbito **CORE v2 LAB solamente**.

## Fallos encontrados y corregidos

| Componente | Problema real | Corrección |
|---|---|---|
| Pickup checkout | La validación del HTTP rechazaba `deliveryAddress:""`; al saltársela, el insert podía incumplir CHECK | Permitir vacío solo en pickup, guardarlo como NULL; exigir dirección válida en delivery |
| Cocina | Validación del estado de efectivo duplicada | Eliminar repetición y mantener rechazo de efectivo fallido/reembolsado |
| Cancelaciones y cocina | Riesgo de inversión de locks de pedido/membresía | Bloquear `orders` primero y después membresía `FOR SHARE` en ambas rutas |
| Historial | Consulta de líneas repetida hasta 100 veces (N+1) | Obtener pedidos y todas sus líneas en **dos consultas** con `ANY(uuid[])` |
| Login | Credenciales incorrectas respondían 403 | `401 INVALID_CREDENTIALS`, sin distinguir si existe el usuario |
| Intentos de autenticación | Sin límite local en el servidor de laboratorio | Limitar registro a 6/minuto/IP y login a 12/minuto/IP; HTTP 429 |
| Protección solicitudes | Dependía solo de Origin y header custom | Verificar también `Sec-Fetch-Site`; conservar SameSite Strict, no confiar en X-Forwarded-For |
| Caché privado | Respuestas privadas sin `Cache-Control: no-store` explícito | Desactivar caché de respuestas de API |
| Entrada servidor | El flag y URL solos podían montar rutas antes de verificar el esquema activo | Rechazar producción, parámetros de URL no previstos, DB no permitida/esquema faltante antes de escuchar |
| Errores HTTP | JSON malformado y body excesivo podían parecer 500 | Respuestas 400/413 sin exponer stack ni SQL |
| Bloqueos de base de datos | Esperas SQL indefinidas en acciones críticas | `SET LOCAL`: lock 3 s, statement 10 s, idle tx 15 s; errores transitorios 503 y reintento idempotente manual |
| Catálogo | Menú de un restaurante cerrado se podía consultar por ID | Filtrar `is_open=true` para catálogo público |

## Evidencia de regresión
`tests/orders-hardening.test.mjs` cubre:
- Pickup con dirección vacía, historial íntegro y solo 2 consultas SQL.
- Un comprador no puede leer el pedido de otro, ni un comerciante sin membresía puede modificarlo.
- El comercio cerrado no recibe nuevos pedidos.
- Solicitudes cross-site, credenciales erróneas, bloqueo de autenticación.
- Confirmación simultánea de cocina y cancelación: una sola transición gana, stock/eventos/outbox no se duplican.
- JSON malformado 400, cuerpo excesivo 413, bloqueo de PostgreSQL 503, recuperación con la **misma clave idempotente**.

Las pruebas usan PostgreSQL 16 en GitHub Actions y cuentas de prueba aleatorias; nunca apuntan al Kali LIVE.

## Garantías y límites
- Transacciones: pedido, stock, líneas, eventos inmutables y outbox en el mismo commit.
- Repetir checkout por timeout obliga a reutilizar `idempotencyKey` **y el mismo contenido**. El HTTP 503 no autoriza repetir con otra clave.
- Ningún reintento automático de transacciones financieras.
- El limiter de autenticación es **solo en memoria por proceso**: antes de producción requiere rate limit distribuido + controles de identidad/MFA y reverse proxy HTTPS auditado.
- `CORE_V2_RUNTIME=isolated-lab`, host loopback, DB `tala_core_v2_lab` o `tala_core_v2_test`, y `CORE_V2_WRITES_ENABLED=true` son requisitos simultáneos. La DB debe tener **usuario aislado sin permisos** sobre datos LIVE. La verificación de nombre/host no sustituye aislamiento de red/roles.
- Los endpoints actuales solo cubren pedidos hasta `ready`; no hay entrega física certificada, liquidación de efectivo, Stripe TEST, despacho ni PIN real. No activar comercio real.
- Política de comisión CORE v2 todavía candidata a 17% (piloto anterior a 15%); requiere aprobación comercial/contable.

## Revisión posterior necesaria
Antes de LIVE: auth real multirol, anti-bots distribuido, token/OTP/móvil, ledger efectivo, entrega pickup y delivery comprobadas, Stripe TEST con conciliación, PWA E2E, monitoreo del outbox, backup/restore, pruebas de carga, políticas de precios versionadas y release/rollback con SHA aprobado.

**Clasificación:** LAB FUNCIONAL; despliegue comercial **NO-GO**.
