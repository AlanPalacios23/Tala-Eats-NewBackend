# M4 Usuarios — TALA EATS CORE v2

Módulo de identidades y perfiles, autónomo. **LAB0 — NO-GO comercial**.

- Rama: `feat/core-v2-usuarios-foundation`, derivada de `main`.
- Paquete: `modules/users/`, TypeScript estricto + Node 24.
- Persistencia: esquema `tala_users_v2` en PostgreSQL 16 descartable.
- CI: `.github/workflows/module4-users-ci.yml`, sin builds de M1/M2/M3.
- Documento de límites: `docs/MODULO4-USUARIOS-ARQUITECTURA.md`.

## Operaciones internas

| Función | Resultado |
| --- | --- |
| `canonicalEmail` | Correo ASCII normalizado, validación restrictiva y sin ambigüedad |
| `registerPendingUser` | Registra una cuenta **pendiente de verificación**; no autentica |
| `transitionLabUser` | Aplica únicamente cambios de estado permitidos y auditados |
| `updateLabOwnProfile` | Actualiza el nombre si la cuenta está activa y la versión coincide |
| `readLabUser` | Consulta interna de una cuenta; contiene PII, no publicar |

Las escrituras se realizan mediante transacciones SQL. El correo es único,
la operación admite reintentos idempotentes y la cuenta usa una versión
incremental para impedir conflictos de actualización. Los eventos de auditoría
son inmutables. La eliminación es lógica/seu­donimizada: conserva identificador
y auditoría; la eliminación completa de copias conectadas y backups sigue pendiente.

## Pruebas

```sh
cd modules/users
npm install
npm run check
```

Los tests de PostgreSQL requieren la variable `USERS_CI_URL` con una base
independiente denominada `tala_users_v2_test`. El workflow la crea y
ejecuta los tests automáticamente. **No pasarle una BD de producción**.
La migración se niega en cualquier BD distinta de las variantes `_lab`
o `_test`.

## Siguientes fases de M4

1. Autenticación real (contraseñas con KDF moderno/passkeys, sesiones,
   verificación de correo, recuperación, revocación y controles antiabuso).
2. Autorización: roles separados de clientes, restaurantes, repartidores
   y staff, privilegios definidos por servidor, sin autoescalado a admin.
3. Dirección de entrega y contactos del usuario, preferencias y privacidad.
4. Borrado/retención legal y exportación de datos; control PII por endpoint.
5. Tests E2E desde clientes reales, rate limits, monitoreo y migraciones.

**No hay rutas HTTP ni integración con aplicaciones actuales**.
El parámetro `actorId` no acredita identidad ni autoridad: las mutaciones
deberán quedar protegidas por un futuro adaptador autenticado; nunca
publicarlas tal cual en la red.

Sin Stripe, tarjetas, wallets financieros, pedidos, despacho, cambios en Kali
ni exposición de claves LIVE.
