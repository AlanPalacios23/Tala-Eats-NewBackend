# Módulo 4 — Usuarios · TALA EATS CORE v2 (LAB3)

**Rama:** `feat/core-v2-usuarios-foundation` → `main`, PR #6 Draft.  
**Aislamiento:** `modules/users/`, `tala_users_v2` PostgreSQL 16,
`.github/workflows/module4-users-ci.yml`.
**Estado:** flujo completo de identidad validado en LAB; NO-GO comercial.

## Responsabilidad exclusiva

Usuarios administra **identidades, perfiles, credenciales, acceso y privacidad
de cuentas**. No gestiona pedidos, despacho, inventarios, wallets, pagos,
cobros, comisiones ni transferencias; no utiliza código, DB o secretos de
M1 Pedidos, M2 Logística o M3 Finanzas.

Se distingue entre los servicios internos de dominio
(`src/domain.ts`, `src/store.ts`), credenciales/sesiones
(`src/auth.ts`) y un adaptador **HTTP de laboratorio exclusivamente local**
(`src/http-lab.ts`). Ninguno de los servidores de Kali o las PWA actuales
se ha modificado para consumirlos.

## Capacidades actuales

- Cuenta con correo normalizado, perfil validado y versión optimista.
- Registro idempotente **pendiente de verificación** con contraseña
  protegida por `scrypt`, sal aleatoria y clave externa de aplicación.
- Verificación de correo por HMAC con comprobante de un solo uso, caducidad,
  persistencia de intentos errados, bloqueo y reenvío con intervalo mínimo.
- Inicio de sesión con verificación de contraseña y bloqueo temporal tras
  cinco errores. Respuesta genérica para usuarios desconocidos/inactivos.
- Bearers aleatorios de 256 bits; almacena solamente su HMAC, duración de
  doce horas, revocación tras logout, suspensión y cambios de contraseña.
- Lectura y actualización del propio perfil con comprobación de sesión
  y bloqueo de versión, de forma atómica en PostgreSQL.
- Recuperación por correo simulada, con comprobante temporal, cinco intentos,
  consumo único, revocación de sesiones y auditoría inmutable.
- Solicitud de eliminación autenticada; finalización interna que
  seudonimiza la cuenta, libera el correo, elimina secretos temporales,
  credenciales y sesiones y conserva auditoría sin PII directa.

Las migraciones `001`, `002`, `003`, `004` están restringidas
a bases descartables `tala_users_v2_lab` y `tala_users_v2_test`.
La CI prueba que fallan sobre bases ajenas.

## Validación E2E

Se ejecuta el recorrido completo mediante funciones internas y mediante
**HTTP real en 127.0.0.1**, con un adaptador de envío de correo **simulado**.
Incluye pruebas de concurrencia, duplicados, intentos fallidos, suspensión,
reversión de estado, contraseñas, sesión vencida y revocada, recuperación,
eliminación, colisiones de versión, fallos de entrega de correo y
consulta del propio perfil.

Documento con rutas y criterios:
[`MODULO4-USUARIOS-LAB3-E2E.md`](MODULO4-USUARIOS-LAB3-E2E.md).

## Lo que aún bloquea el lanzamiento comercial

- **Correo real**: proveedor, entrega, seguimiento de fallos y vínculo
  de verificación verdadero. El laboratorio NO prueba posesión de email.
- **Autorización real**: roles de cliente, comerciante, repartidor y staff,
  acciones administrativas con verificaciones y 2FA/passkeys;
  las primitivas LAB `actorId` no son autenticación.
- **Infraestructura segura**: TLS/API Gateway, secretos con vault,
  rate limiting distribuido, limitación por identidad/dispositivo,
  permisos mínimos SQL, backups, detección de abuso y métricas.
- **Perfil/privacidad**: direcciones y contactos, exportación, retención
  y borrado verificable, incluyendo backups y sistemas conectados.
- **Integración y E2E comercial**: clientes Android/iOS reales,
  compatibilidad de contratos de módulos y despliegue gradual a producción.

**No convertir el servidor `http-lab.ts` en producción.** Es para
validaciones de loopback y no es un API público endurecido.
No se ha fusionado a `main`, desplegado en Kali ni conectado a Stripe.
