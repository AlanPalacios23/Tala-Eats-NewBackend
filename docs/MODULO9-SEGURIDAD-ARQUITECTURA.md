# Tala Eats Core v2 — M9 Seguridad: arquitectura independiente (LAB2)

**Rama:** `feat/core-v2-seguridad-foundation`, creada **desde `main`**, sin depender de los PR de M1–M8.
**Estado:** LAB2, cierre técnico sujeto a CI; **NO-GO LIVE, NO-GO merge, NO-GO despliegue Kali**.
**Infraestructura:** Node 24 + TypeScript estricto + PostgreSQL 16 descartable, DB `tala_security_v2_test` / `tala_security_v2_lab`, esquema `tala_security_v2`.

## LAB2 — revocación transaccional y detección local de abuso

La migración `002_revocation_abuse.sql`, exclusiva de las bases descartables
M9, añade `grant_revocations`, `subject_revocations` y `abuse_alerts`.

El host verificado puede revocar un grant firmado o todos los grants emitidos
para un sujeto hasta el segundo de revocación, usando
`canRevokeSecurity=true`. La evaluación de un grant, su consumo único y
las revocaciones se coordinan con el mismo bloqueo transaccional de un hash
de sujeto. La revocación invalida **nuevas autorizaciones**, pero no revierte
transacciones de negocio ya realizadas.

Se generan alertas internas cuando se observan **3 o más** denegaciones
del mismo tipo en una ventana de **5 minutos** para un sujeto y acción,
incluidos intentos de replay, alcance indebido y exceso de solicitudes.
Las alertas son idempotentes, inmutables y se consultan como agregados por
un operador con `canMonitorSecurity`. No existe un worker externo de
notificaciones o sistema de defensa en el edge; esas integraciones siguen
siendo pendientes explícitos.

Para evitar retención indefinida de seudónimos, el mantenimiento LAB limpia
revocaciones de grants vencidos y revocaciones de sujeto después de 150
segundos, tiempo suficiente para que hayan expirado todos los grants
previos de TTL máximo 120 segundos. **La retención de auditorías y alertas
requiere una política legal/operacional aparte**. El pseudonym key debe ser
estable dentro de la ventana; una rotación sin migración invalidaría
revocaciones y cuotas previas.

[Acta de cierre LAB2](MODULO9-SEGURIDAD-CIERRE-LAB2.md).

## Responsabilidad del módulo

| Dominio | Dueño |
| --- | --- |
| **M9 Seguridad** | Verificación de autorizaciones firmadas por host, vinculación de alcance/recurso, exigencia de step-up, anti-replay, limitación distribuida por acción, auditoría seudonimizada y métricas de seguridad |
| M4 Usuarios | Identidad, registro, contraseñas, sesiones, TOTP/MFA, rol de cuenta, emisión/revocación de credenciales, verificación de rol de propietario |
| M1 Pedidos | Pedidos y autorización operativa de su propietario |
| M2 Logística | Flujos de asignación, entrega, presencia y autorización del conductor |
| M3 Finanzas | Ledger, saldos, cobros en efectivo, transferencias y autorización de tesorería |
| M5 Notificaciones | Avisos, mensajes y canales |
| M6 Restaurantes | Perfil comercial, catálogo, sucursales y permisos de negocio |
| M7 Ubicaciones | GPS, direcciones y sus permisos |
| M8 Pagos | PSP Stripe, cobros, refunds y verificación del proveedor |

M9 no puede confirmar que una persona sea efectivamente un propietario, repartidor o empleado: esa prueba la realiza el servicio anfitrión **antes de emitir** la autorización firmada. Tampoco realiza llamadas a APIs de módulos vecinos ni escribe en sus bases. No crea sesiones de usuario ni sustituye el MFA de M4. El throttling de login propio de M4 sigue siendo de M4; M9 limita operaciones **transversales** de alto valor.

## Contrato firmado de servidor

Solo un emisor confiable, fuera del frontend, puede crear un `HostGrant`:
```json
{
 "version":1,
 "issuer":"tala-trusted-gateway-lab",
 "audience":"m9-security-lab",
 "grantId":"<uuid-aleatorio>",
 "subjectId":"<uuid-del-actor-verificado-por-host>",
 "resourceId":"<uuid-del-recurso-verificado-por-host>",
 "action":"payments.refund.request",
 "assurance":"step_up",
 "assuranceAt":1730000000,
 "issuedAt":1730000010,
 "expiresAt":1730000100
}
```
El contenido es ilustrativo, no un grant vigente. El token se serializa como `v1.<kid>.<JSON-base64url>.<HMAC-SHA256-base64url>`. La firma vincula versión, identificador de clave, bytes exactos del cuerpo, acción y recurso. El verificador usa una **keyring** con secretos de al menos 32 bytes para permitir rotación y valida en tiempo constante. Las claves nunca se registran en SQL ni se entregan al cliente; su custodia corresponde al host.

- TTL total máximo **120 segundos**.
- Límite de reloj del emisor: **+30 segundos**.
- Cada grant contiene un `grantId` aleatorio y se puede utilizar **una vez**.
- Acciones sensibles requieren `assurance=step_up` y `assuranceAt` reciente **≤300 s**, como declaración del host. M9 no verifica por sí mismo una prueba TOTP; M4/gateway debe verificarla antes de firmar.
- La autorización se vincula a una acción exacta y a un `resourceId` exacto. Un permiso de un comercio no es un permiso de otro.
- Se rechazan campos inesperados, duración excesiva, issuer/audience falsos y firmas manipuladas.

## Lista de decisiones LAB1

| Acción | Máximo por minuto y sujeto | Step-up |
| --- | ---: | --- |
| `orders.cancel` | 20 | No |
| `driver.delivery.complete` | 60 | No |
| `merchant.store.suspend` | 3 | Sí |
| `payments.refund.request` | 5 | Sí |
| `finance.payout.request` | 3 | Sí |
| `profile.export` | 3 | Sí |

Los cupos son límites **de laboratorio**, no política de producto aprobada. Operaciones nuevas requieren revisión de riesgos y un contrato firmado adicional. El host conserva la autoridad final de negocio. Las decisiones M9 son una **condición necesaria, nunca suficiente**, para ejecutar la mutación en su módulo titular.

## Almacenamiento, privacidad y concurrencia

**Tres tablas iniciales M9** en la migración 001 (más tres tablas LAB2 en la migración 002):

- `used_grants`: ID de nonce UUID, hash seudónimo del actor y caducidad, único por ID; condición de carrera resuelta con índice único en la misma transacción.
- `rate_buckets`: HMAC del par sujeto/acción (secreto propio del host), ventana de 60 s, UPSERT atómico y TTL.
- `audit_events`: hash seudónimo del actor, acción, decisión y hora; **append-only mediante trigger**.

No se almacenan IP, correos, contraseñas, tokens firmados, secreto TOTP, nombre o dirección. La auditoría seudonimizada **no es necesariamente anónima**: requiere política de retención y rotación compatible con privacidad. Una tarea externa debe llamar a `pruneExpiredSecurityState`; el audit inmutable no se elimina sin política de gobernanza de datos.

## Rutas locales de prueba

```http
GET  /v1/security/health
POST /v1/security/authorize
GET  /v1/security/metrics
```

La autorización recibe únicamente `{grant,action,resourceId}`. `/metrics` exige `canMonitorSecurity` provisto por `authenticateHost(req)` y devuelve **agregados**, no identificadores. **No existe endpoint para firmar grants.** Solo loopback y servidor prohibido con `NODE_ENV=production`. No sustituye un API Gateway endurecido ni hace pública la API.

## GO / NO-GO

**LAB1:** aprobar TypeScript estricto, unidad de firma/tiempo/rotación, PostgreSQL con 18 solicitudes concurrentes del mismo grant, cuota distribuida, auditoría inmutable, HTTP local y rechazo de migración en base ajena. Al pasar CI, solo habilita seguir mejorando el módulo aislado.

**LIVE prohibido** hasta disponer de integración real M4/gateway, emisión segura y revocación de grants, sincronización de clocks, aislamiento SQL y rotación de secretos, protección distribuida frente a DDoS, limitación por IP confiable en reverse-proxy, observabilidad y alertas, backups/restauración, política de retención y pruebas E2E contra los módulos reales. No hay despliegue Kali ni lectura de datos productivos.
