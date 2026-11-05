# M9 Seguridad — Tala Eats Core v2

**LAB1 independiente · NO-GO LIVE**.

M9 verifica **grants firmados por un gateway de confianza**, autorización por acción y recurso, requisitos de MFA recientes declarados por el host, uso único de grants, limitación de operaciones sensibles y auditoría mínima con hashes HMAC. Es una capa transversal de evaluación, **no** un servicio de identidad, login, TOTP, sesiones, roles de negocio, Stripe, pedidos ni wallets.

**Aislamiento:** `modules/security/**`, DB PostgreSQL propia `tala_security_v2_test` o `tala_security_v2_lab`, migración `001_security_foundation.sql`. No se conecta ni importa módulos anteriores.

## Acciones protegidas de LAB1

`orders.cancel`, `driver.delivery.complete`, `merchant.store.suspend`, `payments.refund.request`, `finance.payout.request`, `profile.export`.

Las autorizaciones son firmadas con HMAC-SHA256, tienen un identificador de clave rotatable, un nonce UUID, audiencia fija, vida de hasta 120 s y vinculación exacta de actor/acción/recurso. Las acciones sensibles requieren que el **host** certifique una verificación reforzada reciente. **M9 no realiza el MFA y no prueba por sí mismo quién posee el recurso.**

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

La CI configura PostgreSQL 16 descartable con `SECURITY_CI_URL`, aplica la migración y ejecuta los E2E de base y HTTP. El código jamás debe conectarse a la DB de Kali.

**Pendiente antes de LIVE:** federación segura desde M4, pruebas reales de MFA/roles y propiedad de recurso, rotación de secretos, antiabuso en proxy, alertas, borrado y retención de hashes, control de acceso de DB, backups y validación E2E con las aplicaciones.

[Arquitectura y límites de M9](../../docs/MODULO9-SEGURIDAD-ARQUITECTURA.md).
