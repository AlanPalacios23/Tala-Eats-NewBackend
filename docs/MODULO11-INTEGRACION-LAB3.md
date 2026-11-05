# Tala Eats Core v2 — M11 Integración LAB3

**Fecha:** 5 de noviembre de 2026.
**Rama:** `feat/core-v2-integracion-monolito-m11`, independiente de `main`.
**PR:** [#13](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/13), Draft.
**Fase:** conectar adaptadores reales de identidad, seguridad y notificaciones sin modificar M1–M10.
**Estado:** implementación lista para validación CI global del último HEAD.
**Operación comercial:** **NO-GO**. Nada de Stripe LIVE, transferencias, cancelaciones reales ni despliegue Kali.

## Entregables LAB3

### 1. M11 → M5 Notificaciones: bandeja real y destinatario inmutable

`modules/integration/adapters/notifications-lab.ts` usa
`publishNotification` del **código auténtico de M5**, no una implementación
sustituta. Los estados que puede notificar son:

| Evento M11 (fuente) | Evento M5 de destino | App |
| --- | --- | --- |
| `restaurants.order_ready` (M6 futuro) | `order.ready` | Cliente |
| `logistics.delivery_completed` (M2 futuro) | `order.delivered` | Cliente |
| `orders.order_created` (M1 futuro) | **BLOQUEADO** | — |

**P0 comercial:** registrar un pedido **no acredita pago**. No se
enviará `restaurant.new_order` hasta recibir un evento diferente de
pago verificado y ligado al pedido, respaldado por M8/Stripe y validado
por M1. Evita notificar y preparar pedidos aún no pagados.

Un resolver del host confiable debe devolver `recipientId`, `orderId`,
`merchantId` y `sourceEventId` que coincidan exactamente con el evento
original. **M11 no utiliza un destinatario proporcionado por el frontend.**
La tabla aislada `tala_integration_v2.notification_bindings` fija
inmutablemente ese destinatario ANTES de enviar a M5. Si otro resolver
intenta asociar una segunda cuenta al mismo evento, se rechaza.
Ningún correo o nombre se almacena en M11: solo identificadores UUID.

M5 sigue gestionando sus propias preferencias, centro de notificaciones,
recibos idempotentes y envío por canal. En pruebas se desactivan email/push
para verificar bandeja real **sin comunicaciones salientes**.

**E2E entre bases:** evento M11 → binding irrevocable M11 →
`publishNotification` en DB M5 → `readInbox` real.
Se simula la caída tras el commit M5 y antes del ACK M11: el reintento
mantiene una sola notificación para ese destinatario. Se rechaza un
segundo destinatario y un evento con comercio manipulado.

### 2. M4 Usuarios → M9 Seguridad: autorización real de laboratorio

`modules/integration/adapters/identity-security-lab.ts` llama primero
al **M4 real** (`readAuthenticatedProfile`) para comprobar la sesión,
incluidas su caducidad, revocación y requisitos MFA propios de M4.
Solo toma `id` del perfil, no lo registra ni guarda la contraseña o el
token en M11.

Un host de laboratorio verifica por separado la propiedad del recurso
usando `verifyOwnershipFromHost`, con identificación de actor y pedido
y prueba de fuente `trusted_lab_host`. Tras esa condición necesaria,
M11 firma internamente un grant de 45 s para `orders.cancel` y llama
al **M9 real** (`authorizeSecurityAction`): su PostgreSQL valida firma,
vinculación de recurso, single-use, revocación y límites de frecuencia.

**Importante:** el callback de propiedad sigue siendo un doble de
laboratorio y **NO una comprobación contra pedidos reales de M1**. El
adaptador devuelve `orderMutationPerformed=false` y **nunca llama
`cancelOrder`**. El módulo dueño M1 debe hacer la verificación final del
estado y la cancelación dentro de su propia transacción, mediante un
adaptador posterior.

Las pruebas crean una cuenta real de LAB en M4, verifican correo,
inician sesión con contraseña, comprueban el permiso M9, hacen logout
y exigen rechazo antes de cualquier consulta de propiedad.
Asimismo rechazan un pedido ajeno, un session token manipulado y una
atestación con origen no confiable.

### 3. Control de aislamiento en SQL y colas

La migración `002_notification_binding.sql` solo admite las DB
`tala_integration_v2_test` y `tala_integration_v2_lab`. La CI confirma
que una base distinta rechaza tanto la migración 001 como la 002.
La asignación de un `eventId` a una persona no puede modificarse o
borrarse mediante SQL por el trigger inmutable.

`claimDelivery` admite un `eventId` opcional para redrive acotado:
permite recuperar exactamente una entrega sin consumir la de otro
usuario. Sigue manteniendo locks, leases, `claimId` y DLQ.

## Gates de CI LAB3

- SHAs pinneados de M1–M10 intactos; mismo proceso Node 24; todas las
  pruebas/compilaciones previas en PostgreSQL 16 con DBs aisladas.
- Escenarios de contratos LAB2 y adaptador real M11→M10.
- M11→M5: bandeja del cliente, relación confiable, duplicación cero
  tras caída, rechazo del cambio de destinatario, bloqueo de mensaje
  de pedido no pagado y cero envíos externos de prueba.
- M4→M9: registro/verificación/login reales, grant con autorización
  acotada, rechazo de pedido ajeno, logout e identidad inválida.
- `NODE_ENV=production` y flags LIVE siguen bloqueados; no se
  expone un endpoint para emitir grants, publicar mensajes o cobrar.
- No se fusionan PR, no hay modificación del backend Kali.

## Qué NO se ha logrado aún

- Emisión real de los eventos de M1/M6/M2 dentro del mismo commit
  transaccional que su estado de negocio. El host en LAB todavía es
  simulado y debe reemplazarse por outbox firmado.
- Propiedad real de un pedido: M4 y M1 tienen esquemas de identidad
  separados. Antes de permitir cancelaciones, debe construirse
  equivalencia de identidad M4→M1 auditada, sin aceptar un UUID del cliente.
- Autorización y cobro real M8 Stripe TEST, confirmación de fondos y
  cierre M3 finanzas en doble partida. No se puede introducir el dinero
  en M11 por un flag.
- Consumo real de los eventos por M2, adopción de stock M6, cobertura
  M7 y notificaciones de cobro verificado.
- Gateway unificado y seguro para las apps Flutter/PWA; E2E desde el
  checkout hasta entrega, reembolso, PIN, efectivo y wallet.
- Migración controlada de las DB a esquemas en un solo Postgres, roles
  mínimos, backups, trazas, alertas y rollback.

**Decisión:** LAB3 podrá considerarse aprobado solo después de
GitHub Actions SUCCESS en el HEAD final de esta rama. Aun así la
habilitación comercial seguirá prohibida.
