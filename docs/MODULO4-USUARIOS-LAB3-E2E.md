# M4 Usuarios — LAB3, recorrido completo de identidad en laboratorio

**Estado: LAB3 validable, NO-GO producción.** PR #6 Draft en
`feat/core-v2-usuarios-foundation`, creado directamente desde `main`.
Sin imports ni tablas de Pedidos, Logística, Finanzas ni Pagos.

## Recorrido funcional E2E

Las pruebas automatizadas ejecutan **dos recorridos completos**:
**directamente con servicios internos** y **mediante HTTP en 127.0.0.1**.

```text
Cliente de laboratorio
  → registro de cuenta pendiente + contraseña protegida
  → token de verificación emitido para adaptador de correo simulado
  → verificación de correo, consume prueba una sola vez
  → inicio de sesión con contraseña
  → sesión bearer opaca de 12 horas
  → consulta y actualización de perfil por sesión autenticada
  → cierre de sesión y revocación inmediata
  → nuevo inicio de sesión
  → cambio o recuperación de contraseña
  → invalidación de todas las sesiones anteriores
  → solicitud de eliminación
  → suspensión/restricción del acceso
  → finalización interna de eliminación y seudonimización
```

Para pruebas, el adaptador de correo **captura el token en memoria** y lo
utiliza como si fuera una prueba entregada al destinatario. **No existe
envío real de email**, por lo que las pruebas NO demuestran posesión
de un buzón externo ni operación comercial.

## Esquema independiente

- `001_users_foundation.sql`: cuentas únicas, ciclo de vida versionado,
  auditoría inmutable, eliminación lógica controlada.
- `002_email_challenge.sql`: prueba de correo HMAC SHA-256 con consumo único,
  10 minutos y 5 intentos inválidos.
- `003_credentials_sessions.sql`: credenciales con scrypt N=16384,r=8,p=1,
  sal de 16 bytes y secreto externo; sesiones revocables, ventana de 12 horas;
  revocación al suspender/eliminar y limpieza de credenciales en tombstone.
- `004_password_recovery.sql`: prueba de recuperación HMAC y caducidad,
  cinco intentos, limpieza en eliminación y auditoría de cambio/restablecimiento.

Solo se pueden aplicar a las bases descartables `tala_users_v2_test` y
`tala_users_v2_lab`. Las cuatro migraciones rechazan bases ajenas.

Los valores secretos se proporcionan mediante `Buffer` de al menos
32 bytes a funciones internas de prueba: **nunca deben codificarse,
subirse a GitHub, persistirse en la base o escribirse en logs**.

## API HTTP exclusivamente de laboratorio

`src/http-lab.ts` crea el servidor, **pero no lo inicia ni expone
automáticamente**. En CI la prueba lo vincula a `127.0.0.1` y puerto
efímero. Rechaza conexiones cuyo destino no sea loopback y no se permite
crearlo cuando `NODE_ENV=production`.

| Operación | Ruta | Control |
| --- | --- | --- |
| Registrar cuenta | `POST /v1/users/register` | Correo, nombre, contraseña, idempotencia |
| Reenviar verificación | `POST /v1/users/resend-verification` | Misma respuesta exista o no la cuenta; cooldown |
| Verificar correo | `POST /v1/users/verify-email` | Comprobante válido, sin acceso privilegiado |
| Acceder | `POST /v1/users/login` | Contraseña, 5 intentos y bloqueo temporal |
| Consultar perfil | `GET /v1/users/me` | Bearer activo no revocado |
| Editar perfil | `PATCH /v1/users/me` | Bearer, versión de cuenta e idempotencia |
| Salir | `POST /v1/users/logout` | Revoca la sesión actual |
| Cambiar contraseña | `POST /v1/users/change-password` | Sesión y contraseña anterior |
| Solicitar recuperación | `POST /v1/users/forgot-password` | Respuesta indistinguible, servicio inyectado |
| Restablecer contraseña | `POST /v1/users/reset-password` | Comprobante consumible una sola vez |
| Solicitar eliminación | `POST /v1/users/request-deletion` | Bearer y versión de cuenta |

El token de verificación y el de recuperación **nunca se incluyen en
respuestas HTTP**; son entregados únicamente a funciones de envío de correo
inyectadas, sustituidas por mocks en CI. La finalización administrativa
de eliminación no se publica por HTTP.

Las respuestas deshabilitan almacenamiento en caché, no abren CORS y
rechazan parámetros inesperados. Existe un limitador local simple;
**no equivale a rate limiting distribuido ni a una solución antiabuso
comercial**. Los endpoints carecen deliberadamente de exposición pública.

## Batería de regresión

`npm run check` en `modules/users`: TypeScript estricto y pruebas puras.
Con `USERS_CI_URL` y las cuatro migraciones, la CI ejecuta además:

- registro concurrente y reintentos idempotentes;
- contraseñas protegidas, intentos errados, bloqueos y reinicio correcto;
- tokens de sesión invisibles en SQL, lectura segura de perfil;
- suspensión, reactivación sin resurrección de sesiones, vencimiento;
- versiones de perfil bajo carreras y aislamiento entre usuarios;
- recuperación de contraseña: 5 intentos, expiración, un solo uso,
  revocación de sesiones y no enumeración;
- correo inicial simulado, reenvío con cooldown, caída del adaptador y
  recuperación sin duplicar la cuenta;
- SQL adversarial contra transiciones, hard-delete, cambios de estado,
  y migraciones sobre otra base.

## Bloqueos para servir personas reales

1. Entrega y verificación real de correo, con proveedor y colas/reintentos.
2. Pasarela de entrada TLS, secreto gestionado por vault, controles
   antiabuso distribuidos, protección de credenciales y observabilidad.
3. Roles y permisos verificados en servidor: cliente, establecimiento,
   repartidor y staff, con protección adicional al acceso administrativo.
4. Segundo factor/passkeys, recuperación y administración de dispositivos,
   protección contra robo de sesión, almacenamiento de tokens en apps.
5. Direcciones/perfil privado, exportación de datos, tiempos de retención,
   borrado en respaldos, pruebas E2E con clientes móviles y cargas reales.
6. Pruebas de restore, migraciones de producción, privilegios mínimos
   en DB y auditoría de seguridad previa a deployment.

**La implementación actual prueba que el circuito técnico funciona en
un laboratorio. No significa que el módulo esté listo para Play Store,
que entregue correos reales ni que deba desplegarse en el Kali LIVE.**
