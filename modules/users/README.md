# TALA EATS — Módulo 4 Usuarios LAB9

**Estado:** desarrollo autónomo en PostgreSQL descartable, PR #6 Draft,
**NO-GO producción**. Rama `feat/core-v2-usuarios-foundation` desde
`main`. No toca Pedidos, Logística, Finanzas, Pagos, Stripe ni Kali LIVE.

## Qué funciona en LAB

- Registro con contraseña protegida mediante scrypt, identidades únicas,
  idempotencia, estado pendiente, comprobantes de correo HMAC de un uso.
- Inicio de sesión, recuperación de contraseña, cambio de contraseña y
  revocación de sesiones con prueba de extremo a extremo HTTP en loopback.
- Roles de identidad: customer predeterminado; merchant/courier/staff/owner
  solo por provisión de confianza fuera de la API de usuario.
- MFA TOTP cifrado con AES-256-GCM; personal privilegiado requiere factor
  confirmado; cambio de rol revoca todas las sesiones anteriores.
- Libro de direcciones privado, preferencia de idioma, consentimiento
  de marketing desactivado por defecto y exportación del usuario autenticado.
- Solicitud de eliminación, seudonimización y limpieza de datos privados,
  secretos/credenciales, sesiones y pruebas transitorias.
- Gestión de sesiones y dispositivos, limpieza de sesiones y tokens caducados.
- Limitación de peticiones por minuto con PostgreSQL y claves HMAC de
  ruta/IP compartidas entre instancias; no se persiste IP en claro.
- Adaptador de correo Resend sobre HTTPS, configuración separada, reintentos
  y clave idempotente. Las pruebas usan `fetch` simulado; no se envía correo.

## Cómo probar

```bash
cd modules/users
npm install --ignore-scripts
npm run check
```

Las pruebas de PostgreSQL requieren una DB **descartable**
`tala_users_v2_test`, las migraciones 001–009 aplicadas y la variable
`USERS_CI_URL`. La CI hace esto automáticamente en PostgreSQL 16.
`npm run test:e2e` ejecuta los recorridos completos, también en LAB.

Las funciones `src/auth.ts`, `src/private-profile.ts`,
`src/mail-resend.ts`, `src/maintenance.ts`, `src/rate-limit.ts`
y `src/totp.ts` solo abarcan datos y acceso a la identidad. El
adaptador `src/http-lab.ts` **solo** debe vincularse a loopback, y se
niega a ejecutarse con `NODE_ENV=production`.

No hay endpoints comerciales publicados ni conexión con apps móviles.

## Seguridad y alcance del cierre

Migración 008 añade el rol SQL `tala_users_v2_runtime`, sin LOGIN y sin
permisos para modificar `account_roles`; el trigger de cliente
predeterminado usa propietario definido y search_path fijado. La CI verifica
que la cuenta de aplicación no puede asignarse el rol owner.

El rol de negocio no equivale a ser propietario de un restaurante ni
a tener habilitación logística; esos permisos requieren sus propias
pruebas fuera del Módulo 4.

Para envío real faltan API key, dominio validado y páginas HTTPS
configuradas con secretos fuera del repositorio. Para producción faltan
gateway TLS, rotación/vault de secretos, recuperación de MFA,
validación de correo y tráfico reales, protección anti-enumeración,
worker programado de retención, privacidad en backups, análisis de
seguridad y E2E en Android/iOS. No declarar apto para producción sin ellos.

**Criterios completos:** [LAB9 y pendientes](../../docs/MODULO4-USUARIOS-LAB9-ENTREGA.md).
