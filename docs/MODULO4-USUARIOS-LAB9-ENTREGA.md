# M4 Usuarios — LAB9 · identidad completa de laboratorio, criterios de publicación

**Estado del PR:** #6 Draft sobre `main`, rama `feat/core-v2-usuarios-foundation`.
No sustituye el backend LIVE, no hay correos enviados en producción, y el
servidor HTTP `http-lab.ts` solo escucha loopback durante las pruebas.

## 1. Funciones construidas exclusivamente en Usuarios

| Área | Alcance verificado en LAB |
| --- | --- |
| Registro | Correo único, nombre validado, contraseña scrypt protegida, versiones e idempotencia |
| Confirmación | Comprobante HMAC de un uso, límite de 5 errores, caducidad y cooldown |
| Sesiones | Tokens opacos de 256 bits, HMAC en base, 12 horas, cierre de sesión y revocación |
| Recuperación | Token de restablecimiento de un uso, limitación, rotación y revocación de todas las sesiones |
| Roles | Cliente por defecto, roles definidos para cliente/comercio/repartidor/staff/owner, sin promoción por API pública |
| MFA | TOTP RFC 6238, secreto AES-256-GCM con AAD del usuario, confirmación, resistencia a replay y exigencia en login |
| Endurecimiento de roles | Al elevar/cambiar rol se revocan sesiones; staff/owner requiere factor activo; consulta de rol de solo lectura |
| Perfil | Direcciones, una predeterminada, máximo 10, versiones, controles por dueño y claves idempotentes |
| Preferencias | Idioma es-MX/en-US, consentimiento comercial inicialmente desactivado |
| Privacidad | Exportación de datos del propio usuario, seudonimización y eliminación de datos privados al finalizar baja |
| Retención | Limpieza interna de comprobantes caducados, sesiones antiguas y TOTP incompletos, con auditoría conservada |
| Correo | Adaptador HTTPS Resend configurable, 3 intentos, idempotencia y tokens en fragmentos de URL |
| Antiabuso | Contador PostgreSQL por minuto e IP/ruta HMAC, compartido entre instancias; limpieza de buckets |
| Base | Migraciones 001–009, solo DB `tala_users_v2_lab` o `tala_users_v2_test`; rol SQL sin LOGIN y sin GRANT a tabla de roles |
| Validación | TypeScript estricto, PostgreSQL 16, tests contra duplicados, concurrencia, cross-user y HTTP loopback |

## 2. Límites y fronteras de autorización

El registro público siempre produce la identidad **customer**. Las altas de
staff/owner, comerciante o repartidor requieren un proceso de aprovisionamiento
de confianza **fuera de las APIs públicas**, con validación de negocio propia.
M4 conserva solamente identidad y clasificación; **no** valida una tienda,
habilita despacho, liquida dinero o permite retirar fondos.

El rol de aplicación PostgreSQL definido en `008_least_privilege_lab.sql`
no puede actualizar `account_roles`, aunque sí puede crear cuentas
customer a través del trigger `SECURITY DEFINER` de propietario con
`search_path` fijado. Un DBA o quien posea credenciales de propietario
sí puede alterar información: **los secretos de propietario no deben estar
en el proceso HTTP real**.

Las funciones internas que aceptan `actorId` no prueban identidad por
sí mismas. Nunca conectarlas directamente a un cliente o exponerlas por
HTTP sin verificar bearer, permisos y factor elevado.

## 3. Integración del correo

Se preparó `src/mail-resend.ts` con un cliente HTTPS hacia el endpoint
oficial de Resend, con `Idempotency-Key`. Solo acepta remitente válido
y páginas HTTPS explícitas sin credenciales en URL. Se inyecta en
`sendVerification` y `sendPasswordReset` como servicio externo
configurado. **No hay clave real, dominio remitente verificado ni envío
real en CI**; las pruebas usan `fetch` simulado. No subir API keys al
repositorio, a capturas ni a logs.

Para habilitarlo fuera de LAB hacen falta una cuenta/proveedor configurado,
dominio verificado y páginas HTTPS reales para recibir el fragmento y
enviarlo al endpoint autorizado sin conservarlo en el historial. También
hacen falta cola durable, control de reintentos de mensajería y revisión
de suplantación/enumeración en todos los caminos públicos.

## 4. Contrato del perfil del usuario

- `GET /v1/users/me`, `PATCH /v1/users/me`: datos personales propios
- `GET /v1/users/addresses`, `POST /v1/users/addresses`,
  `PATCH /v1/users/addresses`, `POST /v1/users/addresses/default`,
  `POST /v1/users/addresses/delete`
- `GET /v1/users/preferences`, `PUT /v1/users/preferences`
- `GET /v1/users/export`
- `GET /v1/users/role`
- `POST /v1/users/mfa/start`, `POST /v1/users/mfa/confirm`
- `GET /v1/users/sessions`, `POST /v1/users/sessions/revoke`,
  `POST /v1/users/sessions/revoke-others`

Todas estas rutas existen **solo en el adaptador HTTP de laboratorio**;
no son contrato comercial publicado. No exponer claves HMAC, sesiones ni
datos de otra cuenta. Sin geocodificación ni cálculo de envíos.

## 5. Qué sigue bloqueando una publicación comercial

- Configurar servicio real de envío y dominio validado; comprobar
  entregabilidad, reintentos después de una caída y privacidad del token.
- Configurar gateway HTTPS y política de proxies confiables, vault de
  secretos, rotaciones, red de entrada y controles antiabuso por dispositivo
  y cuenta. PostgreSQL limita por IP/ruta, pero **no sustituye** WAF ni
  detección distribuida de bots.
- MFA: implementar recuperación segura de un factor extraviado; considerar
  passkeys y revisión del procedimiento de enrolamiento de staff.
- Separación real de credenciales DB owner/runtime, despliegue de
  migraciones con rollback respaldado, restore probado, métricas/alertas,
  pruebas de carga y auditoría independiente de seguridad.
- Política legal de conservación y eliminación de PII en archivos,
  respaldos y servicios externos; automatizar el worker de retención.
- Implementar adapters Android/iOS con almacenamiento seguro del bearer,
  reautenticación, mensajes de error, casos offline y QA de dispositivos.
- Revisar protección de enumeración en el alta y errores del proveedor;
  el HTTP actual es **exclusivo de laboratorio** y no puede publicarse.

## 6. Criterio para empezar otro módulo

Se puede crear el siguiente módulo independiente en nueva rama desde
`main`, usando identificadores opacos de usuario como referencia y
contratos desacoplados. Esto **no** implica que Usuarios esté habilitado
para producción: primero hay que cerrar los bloques de la sección 5 y
aprobar E2E con las aplicaciones móviles reales.

Ningún commit de esta fase debe modificar M1, M2, M3, Pagos, Stripe LIVE
ni el servidor operativo Kali.
