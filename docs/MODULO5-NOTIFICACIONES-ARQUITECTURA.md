# Módulo 5 — Notificaciones · CORE v2 · LAB1

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
