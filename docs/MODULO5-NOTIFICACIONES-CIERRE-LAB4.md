# TALA EATS CORE v2 — Cierre formal del Módulo 5: Notificaciones

**Fecha:** 2026-11-03  
**Hito:** LAB4, contrato independiente consolidado.  
**Decisión:** **GO para empezar otro módulo aislado; NO-GO para producción**.  
**Pull request:** [#7](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/7) (Draft, sin merge).  
**Rama:** `feat/core-v2-notificaciones-foundation`; base `main`.

## Alcance congelado en LAB4

1. Notificaciones in-app de las cuatro audiencias (`customer`, `restaurant`, `courier`, `admin`), con catálogo de eventos permitido, contador de no leídas, marcado, descarte y paginación.
2. Preferencias independientes por `in_app`, `email` y `push`, consentimiento promocional desactivado inicialmente y alertas de seguridad obligatorias.
3. Recibos de publicación idempotentes, incluidos los eventos suprimidos, y fanout transaccional de la bandeja y el outbox.
4. Registro de dispositivos Android/iOS/PWA con secreto cifrado AES-256-GCM, huella HMAC, revocación y límite de 20 dispositivos activos por destinatario/app.
5. Worker de entregas `SKIP LOCKED`, leases, reintentos y `Retry-After`, prioridades de eventos, estado de entrega, cola de fallos y auditoría inmutable de intentos.
6. Adaptadores simulados para correo Resend y FCM HTTP v1; clasificación conservadora de errores `UNREGISTERED`, 400, 404 y otros fallos de proveedor.
7. Avisos de refresco en tiempo real PostgreSQL `LISTEN/NOTIFY` tras COMMIT y bandeja persistente como fuente de verdad.
8. Contadores operativos agregados, sin información personal; redacción acotada de contenido antiguo y de tokens revocados. Los plazos de retención son de LAB, no una política legal aprobada.

## Contrato de integración para otros módulos

```ts
import type { PublishInput } from './domain.js';
// Fuente interna y autenticada: NO es una ruta pública de usuarios.
const event: PublishInput = {
  sourceEventId: '<UUID estable de evento del productor>',
  recipientId: '<UUID asignado por un productor confiable>',
  app: 'customer',
  eventType: 'order.confirmed',
  resourceId: '<UUID de referencia opcional>'
};
```

**Reglas del contrato:**

- Cada productor proporciona un `sourceEventId` estable que pueda repetirse de forma segura; M5 deduplica por destinatario/evento y rechaza un mismo ID con contenido diferente.
- La autenticidad del productor, los permisos para la audiencia y la selección del destinatario deben verificarse **fuera** del módulo M5, mediante una interfaz de confianza. Nunca aceptar `recipientId` del propio cliente como autorización.
- M5 renderiza títulos, cuerpos, rutas y prioridades desde el catálogo; nunca recibe texto arbitrario, secretos OTP, datos de pago o URL externas del productor.
- M5 registra aceptación de transporte, no garantiza recepción física por el dispositivo ni entrega exactamente una vez. Las apps deduplicarán con `notificationId` y consultarán la bandeja tras reconexión.
- `resolveVerifiedEmail`, autenticación de la API y obtención OAuth para FCM son dependencias **inyectadas**; no existe un acoplamiento por imports ni FK a otras bases.
- El consumidor HTTP existente es **solo de LAB**, en loopback y bloqueado en `NODE_ENV=production`; no exponerlo públicamente.

## Verificación y evidencia

- Node 24, TypeScript estricto y PostgreSQL 16 con migraciones **001 → 004**, bajo `tala_notifications_v2_test`.
- Pruebas de cuatro apps, consentimiento, privacidad, cifrado, aislamiento, doble publicación, carreras de registro y una carga de 160 solicitudes de publicación.
- E2E con proveedores simulados, HTTP loopback, avisos en tiempo real, reintentos, vencimiento de leases, dead-letter, redacción y métricas.
- Resultado verificado antes de este documento: **31/31 PASS, 0 FAIL, 0 skipped**. Ejecución del commit `ca2c5ff7079b31307306bf1ebe1b14edd2730072`:
  [GitHub Actions #41703619486](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41703619486).
- La verificación final debe volver a ejecutarse después de cualquier commit, incluso solo documental. No confundir la aprobación de tests con certificación de seguridad en producción.

## Puertas que permanecen cerradas

**No aprobar LIVE** hasta demostrar entrega real mediante Resend (dominio remitente validado), Firebase FCM/APNs/Web Push (credenciales y service workers configurados), gateway HTTPS y autorizaciones confiables, workers operativos con alertas, recuperación y copias de seguridad, legalidad de retención y borrado, y pruebas E2E instaladas en Flutter Android/iOS y PWA.

Estas dependencias pasan al registro de integración del producto y **no bloquean empezar el siguiente módulo aislado**.

## Regla de continuidad

Conservar el PR #7 **abierto y Draft, sin fusionar ni desplegar**. Cerrar el desarrollo funcional LAB4; cualquier corrección posterior del M5 requerirá un cambio específico y nueva CI. Para el siguiente módulo, usar **otra rama nacida de `main`**, nunca basarse en la rama de M5 ni importar su implementación interna. El siguiente módulo podrá consumir el contrato de eventos de forma desacoplada cuando se integre la plataforma.
