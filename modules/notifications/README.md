# TALA EATS CORE v2 — Módulo 5: Notificaciones

**LAB4 independiente · NO-GO comercial.** Rama `feat/core-v2-notificaciones-foundation`,
PR #7 (Draft), base `main`. No importa código ni tablas de Pedidos,
Logística, Finanzas, Usuarios ni Pagos. No utiliza los servicios LIVE del
servidor Kali, Firebase, Stripe ni el backend anterior.

## Canales implementados

| Canal | Trabajo del M5 | Estado |
| --- | --- | --- |
| In-app | Bandeja PostgreSQL por usuario y app; paginación, leídas, descartadas | Validable en LAB |
| Android/iOS | Tokens cifrados, fanout y adaptador Firebase FCM HTTP v1 | Proveedor simulado |
| PWA/Web | FCM web, registro/revocación y señales PG en tiempo real | Proveedor simulado, falta SDK/service worker |
| Correo | Adaptador Resend, plantilla sin PII, reintentos idempotentes | Proveedor simulado, sin dominio/claves |

Las cuatro aplicaciones `customer`, `restaurant`, `courier` y `admin`
tienen eventos tipados en `src/domain.ts`. Se incluyen estados de pedidos,
avisos para restaurante, ofertas y asignaciones de repartidor, soporte,
seguridad, estados de cuenta y campañas opcionales. M5 **no acepta**
cualquier texto/URL enviada por una app: renderiza plantillas conocidas
y vínculos internos, sin ejecutar la acción de negocio.

## Arquitectura

```text
M1 / M2 / M3 / M4 / otras fuentes (integración FUTURA)
                  |
       Evento interno autenticado
                  |
      M5 publishNotification (transaction)
                  |
      +-----------+-------------+
      |                         |
Bandeja in-app             Outbox durable
PostgreSQL                 email / push por dispositivo
  |                            |
LISTEN/NOTIFY hint           Worker SKIP LOCKED
  |                          60s lease, 5 intentos
App obtiene bandeja           |          |
por API autenticada        Resend      FCM v1
                            email      Android/iOS/Web
```

El `sourceEventId` es idempotente por destinatario y el contenido
de la notificación tiene una huella; un segundo evento con mismo ID
pero otro tipo se rechaza. Publicar no implica que el correo o push
llegó: la bandeja se confirma en la transacción de publicación, y el
trabajador confirma separadamente cada entrega.

**At least once:** los workers usan `FOR UPDATE SKIP LOCKED`, lease,
reintentos, `dead_letter` y auditoría inmutable de cada intento. Una
interrupción después de enviar y antes de confirmar puede duplicar
push FCM; Resend admite idempotencia, su ventana es limitada. Las apps
deben deduplicar por `notificationId` y tratar las señales en tiempo
real como *hints*, no como fuente de verdad.

## Seguridad y consentimiento

- Los dispositivos se registran con token **cifrado AES-256-GCM** en
  PostgreSQL, AAD ligado al usuario/app/plataforma y HMAC para deduplicar.
  Ningún token de FCM se devuelve en el listado.
- Preferencias para `in_app`, `push` y `email`; los avisos transaccionales
  habilitados por defecto y marketing deshabilitado por defecto.
  Los avisos de seguridad no son opt-out.
- Se vuelven a comprobar preferencias y revocación del token **en el envío**.
- El M5 no autentica credenciales del M4. `recipientId` en funciones
  internas es una afirmación de un **productor verificado externamente**,
  no autorización por sí sola.
- `src/http-lab.ts` recibe `authenticate(req)` como dependencia externa,
  toma identidad solamente de ese callback, rechaza campos extra y
  funciona exclusivamente en `127.0.0.1`; se bloquea en `NODE_ENV=production`.
- `resolveVerifiedEmail(recipientId,app)` es un callback de confianza
  provisto por el host; M5 no almacena correo del destinatario en la BD.
- No incluir tokens OTP, contraseñas, números de tarjeta, direcciones o
  información financiera sensible en plantillas ni en `data`.

## API de LAB para las apps

- `GET /v1/notifications?limit=20&before=<UUID>` — lista y no leídos.
- `POST /v1/notifications/read` — `notificationId`.
- `POST /v1/notifications/read-all` — cuerpo vacío.
- `POST /v1/notifications/dismiss` — `notificationId`.
- `GET /v1/notifications/preferences` y `PUT` para optar por canal/categoría.
- `GET /v1/notifications/devices`, `POST` para dar de alta
  `platform` (`android`, `ios`, `web`) y `token`.
- `POST /v1/notifications/devices/revoke` — `deviceId`.

El endpoint de publicación NO está disponible para clientes: los
eventos entran por llamada interna o un futuro bus/ingress autenticado.
No publicar el adaptador LAB como API comercial.

## Pruebas independientes

```bash
cd modules/notifications
npm install --ignore-scripts
npm run check
```

Los tests de integración PostgreSQL necesitan una BD descartable llamada
`tala_notifications_v2_test`, las migraciones `001`→`004` aplicadas y
`NOTIFICATIONS_CI_URL`. La CI propia del PR las prepara y rechaza
migraciones en otras bases. Se prueban contratos, inyección de audiencia,
consentimientos, ausencia de PII, cifrado, carrera de publicación,
paginación, reintentos, dead-letter, lease agotada, adapters simulados,
lectura HTTP autorizada y señales PG en tiempo real.

## LAB4 — resistencia, prioridad, seguridad y operaciones

- **Preferencias independientes:** una promoción con opt-in de correo no
  aparece automáticamente en la bandeja de la app si in-app está desactivado.
  La decisión de suprimir un evento queda registrada en
  `publication_receipts` para impedir reenvíos históricos al cambiar
  preferencias. La visibilidad del inbox se limita a los avisos autorizados.
- **Dispositivos:** máximo 20 tokens activos por usuario/app con bloqueo
  transaccional frente a registros concurrentes. Un token con respuesta FCM
  explícita `UNREGISTERED` se revoca; errores genéricos de proyecto,
  permisos o petición no deben cancelar tokens válidos.
- **Priorización:** el catálogo determina automáticamente el orden de cola:
  seguridad 100, ofertas de repartidor 95, pedido nuevo 90, estados urgentes
  80, transaccionales 60, promociones 10. El cliente no puede autodeclararse
  urgente. Migración 004 y pruebas de precedencia en PostgreSQL.
- **Resiliencia:** recuperación de leases vencidos acotada a lotes;
  un intento interrumpido genera una entrada de auditoría
  `LEASE_EXPIRED` antes de reintentar. Se conserva la trazabilidad
  hasta dead-letter y reenvío manual, sin declarar entrega exacta.
- **Operación:** `readNotificationOperations` produce conteos por
  canal/estado, atraso, leases vencidos y entregas/errores de 24h, sin
  identificadores de destinatarios ni tokens.
- **Retención:** el barrido de laboratorio `redactExpiredNotificationData`
  limita lotes y redacta secretos de dispositivos revocados y el contenido
  de notificaciones antiguas terminales, conservando la auditoría.
  No sustituye el borrado legal ni la política de respaldos.

Los cambios anteriores se prueban con los adaptadores de correo y
Firebase simulados, nunca con tokens, claves ni clientes LIVE.

## No-Go: requisitos para producción

1. Firebase Cloud Messaging del proyecto correcto, OAuth2 de servidor,
   registro/revocación de token, APNs para iOS, service workers y permisos
   PWA Web Push, notificaciones locales y apertura de `deepLink`.
2. Dominio remitente Resend verificado, API key de producción, resolver
   de correo verificado, consentimiento de marketing y entregabilidad.
3. Firma/autoridad de los productores de eventos, autorización efectiva
   en gateway, TLS y aislamiento de base/servicio.
4. Ejecutar workers permanentes, observabilidad, métricas, DLQ operator,
   tiempos de retención, protección de abuso, migración y restore.
5. Privacidad: borrado/exportación de notificaciones, borrado de tokens en
   respaldos y políticas de retención para la bandeja y auditoría.
6. Pruebas E2E con aplicaciones reales (Flutter Android/iOS + PWA),
   Firebase en entornos de prueba, conectividad intermitente y carga.
7. Los correos con enlaces sensibles para verificar/recuperar contraseña
   requieren **flujo confidencial propio del módulo de identidad**, no
   deben exponerse en la bandeja ni el payload de push. Integrar una
   plantilla segura con M4 a través de un contrato, no de imports.

**No desplegar ni fusionar este módulo hasta aprobar estos controles.**
