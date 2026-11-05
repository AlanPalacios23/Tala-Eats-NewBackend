# Tala Eats Core v2 — M9 Seguridad · Acta de cierre LAB2

**Fecha:** 5 de noviembre de 2026.
**Rama:** `feat/core-v2-seguridad-foundation`, creada desde `main`.
**PR:** [#11](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/11), Draft y sin merge.
**Objetivo:** cerrar el desarrollo **autónomo de laboratorio** del dominio Seguridad.
**Certificación:** **CERRADO EN LAB2** tras CI Node.js 24, TypeScript estricto y PostgreSQL 16.
**Producción:** **NO-GO para Kali, autenticación real, pagos, retiros y todas las acciones comerciales.**

## Frontera exacta del módulo

M9 evalúa una **condición de seguridad adicional**, no sustituye el control de acceso de cada dominio. El sistema confiable debe demostrar por sus propios medios identidad, rol, propiedad del recurso y MFA. Solo después puede firmar un `HostGrant` que M9 comprueba antes de una operación.

- **M4 Usuarios**: autenticación, TOTP, sesiones, revocación de sesión, identidad y privilegios originales.
- **M9 Seguridad**: verificación de un grant HMAC de vida corta, alcance por acción/recurso, step-up declarado por el host, uso único, revocación de grants, revocación global de autorizaciones emitidas para un sujeto, límites por minuto y señales locales de abuso.
- **M1/M2/M3/M5/M6/M7/M8**: mantienen cada uno sus reglas, bases de datos, transacciones y acciones. M9 no llama a ninguno ni accede a sus tablas.

**Un `M9_ALLOW` no puede por sí mismo ejecutar un pedido, cargo, reembolso, transferencia, cambio de rol o suspensión**; el módulo propietario debe continuar comprobando permisos y estados de negocio.

## Entrega completa en el laboratorio

| Control | Evidencia y límite |
| --- | --- |
| HMAC | Firma SHA-256, `kid` rotatorio, comparación de tiempo constante, issuer/audience exactos, 120 s máximo |
| Autorización | Vinculada a `subjectId`, `resourceId` y acción cerrada; se rechazan campos inesperados |
| Step-up | Requisito para `finance.payout.request`, `payments.refund.request`, `merchant.store.suspend` y `profile.export`; la prueba de MFA real corresponde al host |
| Antirreplay | `used_grants` con unicidad de nonce UUID en transacción, una sola decisión positiva con 18 solicitudes concurrentes |
| Revocación LAB2 | `grant_revocations` y `subject_revocations`, con bloqueo transaccional por hash de sujeto para coordinarse con autorización |
| Rate limiting | Cuotas por acción y seudónimo de sujeto, PostgreSQL atómico, 60 s; no reemplaza defensa por IP o DDoS en proxy |
| Alertas locales LAB2 | Tres denegaciones de tipo replay, scope o rate en cinco minutos generan alerta deduplicada; sin notificaciones externas |
| Privacidad | Solo hash HMAC de sujeto y acción/categoría en auditoría; sin correo, IP, contraseña o token firmado en SQL |
| Observabilidad | Métricas agregadas de decisiones y alertas (24 h) solo con `canMonitorSecurity` |
| Inmutabilidad | `audit_events` y `abuse_alerts` con trigger que rechaza UPDATE/DELETE |
| Retención LAB | Limpieza explícita de nonces, buckets y revocaciones de grants vencidas; una política de retención de auditoría aún debe aprobarse |
| Lab HTTP | Solo loopback, sin API de emisión de grants, bloqueo con `NODE_ENV=production`, respuestas no-store y sin CORS público |
| Aislamiento | `modules/security/**`, SQL `001` y `002` únicamente en `tala_security_v2_test` / `tala_security_v2_lab`, Node 24 + PG16 |

## Riesgos y restricciones que permanecen abiertos

1. **No hay conexión real** al emisor de grants: M4 Usuarios y el API gateway aún no producen ni revocan estas autorizaciones en operación. Un booleano de privilegio del host solo es seguro si el host ya fue autenticado y autorizado.
2. Los grants `m9-security-lab` no son equivalentes a roles reales, sesiones verificadas ni firmas de producción. El código HTTP de loopback no se debe exponer públicamente.
3. Las alertas son **locales**, no hay envío a PagerDuty, correo, consola SOC ni otro canal de respuesta. No detectan floods sin firma válida que se rechazan antes de identificar al actor: eso corresponde al reverse proxy y la telemetría de infraestructura.
4. No existe una política aprobada para el ciclo de vida del audit seudonimizado inmutable, restauración de backups ni acceso de lectores SQL.
5. La revocación detiene autorizaciones *futuras*; no deshace operaciones de negocio ya consumadas. Un módulo propietario debe hacer su propia comprobación final de estado y permisos.
6. Falta ejercer rotación de claves operacional, sincronización del reloj, recuperación ante incidentes, claves en vault, roles SQL mínimos, pruebas E2E con usuarios reales y pruebas de penetración/red.
7. Ninguna instrucción aquí autoriza cobros Stripe LIVE, despachos, cambios de comercio, acceso a datos personales o despliegue Kali.

## Decisión

**GO exclusivamente para iniciar el siguiente módulo autónomo cuando GitHub Actions confirme SUCCESS sobre el último HEAD.** Se conservará este PR en Draft para no integrar sistemas no verificados. **NO-GO para fusionar, desplegar o declarar que las aplicaciones están protegidas por M9 en LIVE.**

## Evidencia

- [README](../modules/security/README.md)
- [Arquitectura](MODULO9-SEGURIDAD-ARQUITECTURA.md)
- [PR #11](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/11)
- **CI LAB2:** [GitHub Actions #41970995091](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41970995091) — **SUCCESS** sobre commit `244acb8956197061cd41d36d345b9ff091a40c7b`. La ejecución validó firma HMAC, SQL 001–002, TypeScript, revocación, 18 replays simultáneos, limitación, alertas, HTTP local y rechazo de migración a bases ajenas. La presente actualización del acta no modifica el código funcional.
