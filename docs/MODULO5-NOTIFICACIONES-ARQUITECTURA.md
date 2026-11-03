# Módulo 5 — Notificaciones · CORE v2 · LAB4

**Estado:** funcional en PostgreSQL y HTTP loopback de laboratorio,
independiente, **NO-GO LIVE**. PR #7 Draft contra `main`.

## Responsabilidades exclusivas

1. Generación de mensajes a partir de un catálogo de eventos permitidos.
2. Bandeja in-app por usuario y app, lectura, descartado y paginación.
3. Registro cifrado y revocación de tokens de notificaciones push.
4. Preferencias por canal y categoría con marketing opt-in.
5. Preparación de mensajes para correo electrónico y FCM Android/iOS/PWA.
6. Outbox y workers con reintentos, backoff, leases, auditoría y dead-letter.
7. Señales de cambio PG LISTEN/NOTIFY tras commit, con consulta de bandeja
   como respaldo durable.
8. Contrato HTTP **solo** para pruebas con autorización inyectada.

No contiene identidades, cuentas, contraseñas, pedidos, asignación de
repartidores, pagos ni cálculo de dinero. Los productores futuros envían
`sourceEventId`, `recipientId`, `app`, `eventType` y opcionalmente
`resourceId`. El módulo decide plantilla y canales. Ningún productor
puede inyectar título, cuerpo, URL externa ni token por este contrato.

## Canales y audiencias

| Audiencia | Ejemplos | In-app | Push | Correo |
| --- | --- | --- | --- | --- |
| Cliente | Confirmación, aceptado, preparando, listo, en camino, entregado, cancelado, reembolso, soporte, seguridad | Sí | FCM | Resend en eventos habilitados |
| Restaurante | Nuevo pedido, cancelación, menú, estado de cuenta | Sí | FCM | Resend en eventos habilitados |
| Repartidor | Oferta, asignación, recogida lista, resumen | Sí | FCM | Resend en eventos habilitados |
| Admin | Soporte y alerta de seguridad | Sí | FCM | Resend en eventos habilitados |

Correo y push están **simulados en CI**; los adaptadores de proveedores
no están activados con credenciales ni en producción.

## Almacenamiento

Esquema: `tala_notifications_v2`; BD permitida solo
`tala_notifications_v2_lab` o `tala_notifications_v2_test`.

- `inbox`: notificaciones, estado leído/descartado, IDs de origen.
- `preferences`: opt-in por destinatario, aplicación, categoría y canal.
- `devices`: tokens AES-256-GCM, HMAC de búsqueda, dueño y revocación.
- `deliveries`: una entrega por email o dispositivo, estado duradero.
- `delivery_attempts`: registro inmutable del intento y error sanitizado.

Publicación y creación de trabajos ocurren en una transacción. Si un
proveedor falla, la bandeja no se pierde. Workers concurrentes reclaman
con `SKIP LOCKED` y lease de 60 s, máximo 5 intentos, backoff y DLQ.

**No se garantiza exactamente una entrega externa**: un worker puede
morir después de enviar y antes de confirmar. Las apps deduplican por
`notificationId`. Resend permite claves idempotentes dentro de su
ventana de 24 horas; FCM HTTP v1 no ofrece esa garantía equivalente.

## Interfaces de integración (sin imports entre módulos)

Productor interno:
`publishNotification(pool,{sourceEventId,recipientId,app,eventType,resourceId?})`.
Se requiere identidad/autorización del productor fuera de M5.

Consumidor:
`createNotificationsLabHttpServer({pool,deviceSecret,authenticate})`
inyecta una identidad confiable en cada solicitud de loopback. No
acepta `recipientId` ni `app` del JSON del usuario. El backend principal
futuro debe envolver las funciones internas con autenticación real,
autorización y gateway TLS; **no desplegar el adaptador LAB públicamente**.

Worker:
`processDeliveryBatch(pool,{secret,resolveVerifiedEmail,sendEmail,sendPush})`.
Los datos personales para correo provienen de un resolver inyectado que
debe devolver solo correos verificados; M5 no los conserva.

Adaptadores configurables:
`createResendEmailSender` y `createFcmPushSender`. FCM requiere un
token OAuth2 con alcance `firebase.messaging` obtenido por un servicio
de confianza; APNs debe estar configurado en Firebase para iOS.
Para Web/PWA es necesario registrar FCM Web SDK, service worker,
permisos y clave Web Push. No hay llaves en el repo.

## Criterios de pruebas

La CI propia de M5 usa Node 24, TypeScript estricto, PostgreSQL 16,
base descartable, migración cerrada a bases ajenas y pruebas de:

- Catálogo de cuatro audiencias, URLs seguras y campos no autorizados.
- Dispositivos cifrados y protección contra transferencia a otra cuenta.
- Consentimientos, marketing opt-in, avisos de seguridad obligatorios.
- Concurrencia de publicación (12 solicitudes), idempotencia y fanout.
- Inbox privado, cursores, lectura, descartado.
- Worker y provider mocks, crash/lease, retry, DLQ, requeue y auditoría.
- Resend 409 concurrente frente a conflicto real, FCM Android/iOS/Web.
- API HTTP loopback con identidad inyectada y prohibición de suplantación.
- PG NOTIFY posterior al commit y aislamiento por usuario/app.

## Requisitos antes de operar con personas reales

Conexión real de eventos autenticados; aprobación de permisos; correo con
dominio verificado; Firebase/APNs/WebPush en Android, iOS y PWA; infraestructura
TLS, secretos gestionados, workers supervisados, backup/restore, retención y
borrado de datos, límites contra abuso, observabilidad, pruebas de carga,
revisión de seguridad y QA de las apps. Los correos sensibles de verificación
y recuperación de contraseñas se integrarán con M4 sin volcar secretos
a notificaciones persistentes.

**Pasa la fase de laboratorio; no habilita LIVE ni sustituye el backend.**


## LAB4 — criterios reforzados y evidencia de cierre

**Persistencia:** migraciones `001` → `004` en la base descartable
`tala_notifications_v2_test`. La CI aplica cada una en secuencia,
comprueba que ninguna puede ejecutarse contra una base ajena y prohíbe
imports hacia otros módulos. Es el M5 autónomo, no una integración LIVE.

**Decisiones de entrega:** la tabla `publication_receipts` registra tanto
eventos enviados como suprimidos. La ausencia de consentimiento en
`in_app` no impide enviar correo o push expresamente habilitado. La
bandeja muestra únicamente avisos `visible_in_app`; los avisos ocultos
no admiten lectura ni uso como cursor. Al autorizar marketing después
no se reactivan eventos anteriormente rechazados.

**Prioridad interna:** el evento, no el cliente, determina prioridad:
seguridad 100, solicitudes de repartidor 95, nuevos pedidos 90,
eventos operativos urgentes 80, transaccionales 60 y marketing 10.
Trabajos aún no vencidos no entran en cola incluso con prioridad alta.
No reemplaza el ciclo de vida o las restricciones del dominio origen.

**Resiliencia:** la recuperación de trabajadores fallidos usa lotes
bloqueados y registra `LEASE_EXPIRED` o `LEASE_EXHAUSTED` para
cada intento interrumpido. Los proveedores pueden confirmar aceptación,
pero esto NO equivale a entrega en el dispositivo. FCM `UNREGISTERED`
expresamente autenticado como error de registro revoca el token afectado;
un 404 genérico del proyecto no basta. Los adaptadores pueden respetar
`Retry-After` limitado sin exponer respuesta sensible.

**Capacidad y privacidad:** máximo 20 tokens activos por usuario/app,
incluso bajo peticiones simultáneas; información cifrada AES-GCM,
búsqueda HMAC, revocación y caducidad por barridos. Métricas agregadas
y sin PII. Se puede redactar contenido de notificaciones terminales
antiguas y secretos de tokens ya revocados sin modificar el historial
inmutable de intentos; los recibos de publicación persisten para
impedir reenvíos por reintentos.

**Pruebas:** contratos, correo/FCM simulados, confidencialidad del inbox,
preferencias, distintas apps, carrera de deduplicación, lote de alta
concurrencia, prioridad de entregas, reintentos y leases, métricas,
retención de contenidos y migraciones PostgreSQL 16. Consultar el
último GitHub Actions de la rama para número exacto de pruebas.

**Limitaciones que no deben ocultarse:** no hay claves de Firebase/Resend,
APNs ni dominios verificados; no existe integración con las PWAs/Flutter
desplegadas ni producción, operación continua ni integración de eventos
firmados. El borrado/portabilidad de datos debe validarse a nivel
plataforma y copias de seguridad; un barrido de retención no sustituye
una orden legal de eliminación. Faltan pruebas de recuperación ante
caída de servicios, carga sostenida y observabilidad real.

## LAB3 — Fiabilidad, seguridad y operación (3 noviembre 2026)

Esta evolución conserva el módulo **aislado**, sin accesos a datos LIVE.

- **Consentimiento independiente por canal:** desactivar `in_app` no cancela
  correo o push autorizado. Un evento oculto conserva el rastreo
  transaccional sin aparecer como no leído en el centro de notificaciones.
- **Recibos de publicación:** `publication_receipts` conserva también
  los eventos suprimidos, impidiendo revivir promociones antiguas al
  cambiar las preferencias.
- **Límite de dispositivos:** máximo 20 activos por usuario y app;
  bloqueo transaccional para evitar altas concurrentes descontroladas.
- **Priorización:** avisos de seguridad, pedidos nuevos y solicitudes de
  repartidores por encima de campañas de marketing, sin alterar
  decisiones de negocio.
- **Recuperación de trabajadores:** vencimiento de leases, reintentos,
  auditoría de cada intento y cola `dead_letter`. Las entregas externas
  siguen siendo *al menos una vez*, no exactamente una.
- **FCM:** solo un error de token `UNREGISTERED` confirmado permite
  desactivar automáticamente ese dispositivo; errores de proyecto o
  payload no implican que haya caducado el registro.
- **Retry-After:** adaptadores interpretan segundos o fecha HTTP;
  la espera respetada es acotada a 3600 segundos y nunca reduce el
  backoff mínimo de seguridad.
- **Métricas sin PII:** `readNotificationOperations` permite vigilar
  estados, trabajos pendientes, leases vencidas y aceptaciones por
  proveedor en 24 horas. No se ofrece en la API de clientes.
- **Retención en lotes:** `redactExpiredNotificationData` sustituye
  material de tokens revocados de más de 30 días; redacciona contenido
  de notificaciones de más de 180 días solo cuando no hay entrega
  pendiente. Mantiene recibos e intentos para auditar. Estos plazos
  son ejemplos LAB que requieren aprobación de política legal.
- **Carga:** batería de 160 publicaciones, cuatro apps, y pruebas
  adversas sobre dispositivos, consentimiento y workers.

**NO-GO:** aún hacen falta Firebase/APNs/WebPush reales, dominio
remitente verificado, autenticación de productores y consumidores,
servicios supervisados, alertas, backups y pruebas Android/iOS/PWA.
La retención del LAB no elimina copias de respaldo ni implementa
por sí sola la supresión legal completa de una cuenta.
