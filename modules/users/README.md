# TALA EATS CORE v2 — Módulo 4: Usuarios

**LAB3 · identidad, perfiles, credenciales y sesiones — NO-GO comercial.**

La implementación está aislada en `modules/users/` y en la rama
`feat/core-v2-usuarios-foundation` (PR #6, base `main`).
No depende del código ni de las tablas de Pedidos, Logística, Finanzas o Pagos.

## Funcionalidades propias de Usuarios

| Componente | Capacidades |
| --- | --- |
| `src/domain.ts` | Identidades, correos, nombres, estados y versión de perfil |
| `src/store.ts` | Registro pendiente, verificación interna de correo, auditoría y eliminación |
| `src/auth.ts` | Registro con contraseña protegida, login, sesiones, perfil autenticado, logout, cambio y recuperación de contraseña |
| `src/http-lab.ts` | API HTTP limitada a loopback, usada en pruebas de extremo a extremo |
| `migrations/001...004.sql` | PostgreSQL propio; versiones, pruebas, verificador scrypt, sesiones y recuperación |
| `tests/` | Pruebas unitarias, SQL, concurrencia, ataques y recorridos HTTP |

### Recorrido completo validable en laboratorio

```
Registro → cuenta pendiente y verificador de contraseña derivado con KDF
→ emisión de token de correo → entrega simulada
→ verificación única → inicio de sesión → perfil
→ edición de perfil → cierre de sesión
→ cambio o recuperación de contraseña
→ revocación de sesiones antiguas
→ solicitud de eliminación → estado bloqueado
→ finalización interna de eliminación con limpieza de secretos
```

La contraseña no se guarda en texto: se almacena un verificador derivado
con `scrypt`, sal aleatoria y secreto de aplicación. La sesión entrega un
bearer opaco de 256 bits, guarda solo su HMAC y vence en 12 horas. La
cuenta pierde sesiones activas al suspenderse, solicitar eliminación o
cambiar/restablecer contraseña. Los comprobantes de correo y recuperación
duran 10 minutos, con límite de cinco errores.

**Atención:** las pruebas de correo usan un adaptador de envío simulado.
No hay SMTP ni verificación de un correo real. Las APIs HTTP solo se montan
en `127.0.0.1` durante la CI. Nunca ejecutar `http-lab.ts` directamente
como servicio público. Ninguna operación se ha publicado en las PWA.

## Ejecutar pruebas

```bash
cd modules/users
npm install
npm run check
```

Las suites con PostgreSQL requieren `USERS_CI_URL` apuntando a una
base **descartable** `tala_users_v2_test` con migraciones 001→004
aplicadas. Sin esta variable, se ejecutan las pruebas puras y las pruebas
que requieren PostgreSQL se omiten. La CI del repositorio crea la base
aislada, aplica migraciones y ejecuta la batería completa.

`npm run test:e2e` ejecuta específicamente las pruebas de recorrido
interno, HTTP simulado y recuperación; también necesita la BD descartable.

## Bloqueos antes de producción

No existe despliegue ni endpoints comerciales. Faltan servicio real de
correo, secretos gestionados fuera de la aplicación, TLS y gateway,
rate limiting distribuido, autorización con roles, MFA/passkeys,
protección administrativa, privacidad de datos de perfil, recuperación
ante pérdida del dispositivo, revisión de permisos SQL, telemetría,
migración segura y E2E desde Android/iOS.

El adaptador LAB limita el tamaño del cuerpo y rechaza parámetros
inesperados, pero **no es un servidor público endurecido**. Las
primitivas `transitionLabUser` y `readLabUser` son internas:
`actorId` no constituye autorización.

Ver detalles y criterios de aceptación:
[`docs/MODULO4-USUARIOS-LAB3-E2E.md`](../../docs/MODULO4-USUARIOS-LAB3-E2E.md).

Sin cambios al backend LIVE Kali, Stripe, M1, M2 o M3.
