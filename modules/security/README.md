# M9 Seguridad — Tala Eats Core v2 · LAB2

**M9 CERRADO EN LAB2 como módulo independiente**, con revocación, protección criptográfica, detección local de abuso y pruebas CI. **NO-GO LIVE / NO-GO merge / NO-GO despliegue Kali.**

M9 verifica **grants firmados por un gateway de confianza**, autorización por acción y recurso, requisitos de MFA recientes declarados por el host, uso único de grants, limitación de operaciones sensibles y auditoría mínima con hashes HMAC. Es una capa transversal de evaluación, **no** un servicio de identidad, login, TOTP, sesiones, roles de negocio, Stripe, pedidos ni wallets.

**Aislamiento:** `modules/security/**`, DB PostgreSQL propia `tala_security_v2_test` o `tala_security_v2_lab`, migración `001_security_foundation.sql`. No se conecta ni importa módulos anteriores.

## Acciones protegidas de LAB1

`orders.cancel`, `driver.delivery.complete`, `merchant.store.suspend`, `payments.refund.request`, `finance.payout.request`, `profile.export`.

Las autorizaciones son firmadas con HMAC-SHA256, tienen un identificador de clave rotatable, un nonce UUID, audiencia fija, vida de hasta 120 s y vinculación exacta de actor/acción/recurso. Las acciones sensibles requieren que el **host** certifique una verificación reforzada reciente. **M9 no realiza el MFA y no prueba por sí mismo quién posee el recurso.**

## LAB2 — revocaciones y señales de abuso

- `revokeSecurityGrant(config,trusted,signedGrant)`: revoca una autorización
  específica; exige `canRevokeSecurity` otorgado por el host.
- `revokeSecuritySubject(config,trusted,subjectId)`: invalida todas las
  autorizaciones antiguas de un sujeto; sincroniza con la autorización
  mediante bloqueo transaccional por seudónimo. Es revocación de grants,
  **no una suspensión de la cuenta** ni sustitución de logout de M4.
- `authorizeSecurityAction`: ahora rechaza antes de su consumo
  autorizaciones revocadas; revisa expiración dentro de la transacción
  y rechaza firmas HMAC con codificación base64url no canónica.
- `abuse_alerts`: una alerta interna por sujeto/acción/tipo/ventana de
  cinco minutos tras tres denegaciones de replay, alcance o rate;
  append-only y sin IP, correo ni secretos.
- `readSecurityMetrics`: incluye conteos agregados de alertas. **No
  envía alertas a servicios externos**, ni pretende proteger contra
  ataques sin firma válida en la red: eso corresponde al gateway.
- `pruneExpiredSecurityState`: limpia nonces, buckets, revocaciones
  individuales expiradas y revocaciones de sujeto una vez que todos
  los grants previos ya caducaron.

El laboratorio emplea migraciones `001_security_foundation.sql` y
`002_revocation_abuse.sql` con PostgreSQL 16.

[Acta y alcance del cierre LAB2](../../docs/MODULO9-SEGURIDAD-CIERRE-LAB2.md).

## API LAB loopback

- `GET /v1/security/health`
- `POST /v1/security/authorize` (body `{grant,action,resourceId}`)
- `GET /v1/security/metrics` (solo host autorizado)

El servidor de laboratorio rechaza `NODE_ENV=production`. No hay API de firma de tokens. Identidad y grants vienen del host confiable, nunca del frontend. Sin CORS público.

## Cómo validar

```bash
cd modules/security
npm install --ignore-scripts --no-audit --no-fund
npm run check
```

La CI configura PostgreSQL 16 descartable con `SECURITY_CI_URL`, aplica ambas migraciones y ejecuta los E2E de base, revocación, abuso y HTTP. El código jamás debe conectarse a la DB de Kali.

**Pendiente antes de LIVE:** federación segura desde M4, pruebas reales de MFA/roles y propiedad de recurso, rotación de secretos, antiabuso en proxy, alertas, borrado y retención de hashes, control de acceso de DB, backups y validación E2E con las aplicaciones.

[Arquitectura y límites de M9](../../docs/MODULO9-SEGURIDAD-ARQUITECTURA.md).
