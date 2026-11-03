# Módulo 4 — Usuarios · CORE v2 (LAB0)

**Proyecto:** TALA EATS.  
**Rama independiente:** `feat/core-v2-usuarios-foundation`, creada directamente desde `main`.  
**Ruta:** `modules/users/`.  
**Estado:** laboratorio; no atiende usuarios reales y no sustituye al backend actual.

## Alcance

M4 es la **fuente de verdad de identidad y ciclo de vida de las cuentas**.
No importa tablas ni código de M1 Pedidos, M2 Logística ni M3 Finanzas.
No crea pedidos, viajes, comercios, wallets, cobros, solicitudes de
reparto ni pagos. No posee secretos de Stripe.

La base inicial incluye:

- Normalización de correo y nombre de perfil con validaciones estrictas.
- Registro de **cuentas pendientes de verificación**; no activa cuentas automáticamente.
- Unicidad de correo, idempotencia transaccional y protección ante concurrencia.
- Versión optimista de cuenta y edición del perfil propio con control de versiones.
- Estados: `pending_verification`, `active`, `suspended`,
  `deletion_requested`, `deleted`, con transiciones explícitas y auditadas.
- Eliminación lógica seudonimizada: se libera el correo para nuevo registro,
  pero permanecen referencias técnicas para trazabilidad.
- Historial de auditoría inmutable sin guardar correo/nombre en cada evento.
- PostgreSQL 16 independiente y pruebas de seguridad sobre una base descartable.

## Arquitectura

```
modules/users/
├── src/
│   ├── domain.ts          # contratos, normalización, máquina de estados
│   └── store.ts           # registro y perfil mediante transacciones PostgreSQL
├── migrations/
│   └── 001_users_foundation.sql
├── tests/
│   ├── domain.test.ts
│   └── users-db.test.ts
├── package.json
└── tsconfig.json
.github/workflows/module4-users-ci.yml
```

BD permitidas: `tala_users_v2_lab` y `tala_users_v2_test`.
Esquema propio: `tala_users_v2`. La migración falla expresamente fuera
del laboratorio. CI con Node.js 24, TypeScript estricto y PostgreSQL 16.

## Seguridad y límites importantes

**Las funciones actuales son primitivas internas de LAB, NO endpoints
públicos de autenticación.** El parámetro `actorId` identifica al autor
solamente en la traza; **no prueba permisos ni identidad**. En la fase
siguiente deberán existir verificación criptográfica del email, contraseñas
protegidas o passkeys, sesiones/revocación, recuperación, límites de
intentos, 2FA para personal privilegiado, reglas de autorización reales,
protección contra enumeración, logs y observabilidad.

No crear interfaces HTTP públicas para `transitionLabUser` ni exponer
`readLabUser` (contiene PII) sin adaptador de autorización verificado.
`email_verified` solo puede provenir de un componente interno confiable;
este laboratorio **no demuestra la verificación de un correo real**.

La seudonimización no equivale a borrar todos los datos personales de
backups o aplicaciones conectadas. Falta definir periodos de retención,
solicitudes de privacidad y procedimiento legal de eliminación real.

En producción hay que restringir a mínimo privilegio las cuentas DB,
validar derechos por operación, configurar una estrategia de migraciones
repetibles y demostrar E2E de acceso/registro antes de activar este módulo.

## Integración futura por contratos, no imports directos

- Pedidos M1 podrá referenciar `userId`, sin cambiar la tabla de M4.
- Logística M2 podrá referenciar `userId` de repartidor autorizado,
  sin que M4 se convierta en despachador.
- Finanzas M3 podrá referenciar `userId`/actor de auditoría,
  sin incluir balances ni pagos en Usuarios.
- Un módulo de Autenticación o un adaptador seguro verificará sesión,
  acciones, permisos, correo, restablecimientos y eventos de confianza.

Se separarán identidades de clientes, cuentas de tiendas, choferes y
personal con **roles y permisos explícitos** antes de integración.
En esta base no se permite que un registro público se autoconceda el
rol ADMIN, OWNER, comerciante o repartidor verificado.

**Sin desplegar a Kali, sin tocar Stripe LIVE y sin merge a main.**
