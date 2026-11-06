# Tala Eats Core v2 — M11 LAB4: identidad M4 → propietario de pedido M1

**Fecha:** 5 de noviembre de 2026.
**Rama de trabajo:** `feat/core-v2-integracion-monolito-m11` (desde `main`, no merge).
**PR:** [#13 — Integración](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/13), Draft.
**Estado:** candidato de laboratorio; la CI sobre HEAD decide si aprueba LAB4.
**NO-GO:** producción, Stripe LIVE, wallets, transferencias, despliegue Kali y cancelaciones comerciales.

## Problema de identidad real encontrado

M4 Usuarios tiene su propio registro, verificación de correo, contraseñas y sesiones. M1 Pedidos conserva otro `tala_core_v2.accounts` y sesiones propias. **Un correo igual no constituye prueba de que ambos ID representen al mismo usuario**, porque los sistemas fueron creados de manera independiente y M1 aún usa su autenticación LAB propia.

No hay FK entre las dos DB. No se deben unir UUIDs por coincidencia ni elegir el `buyer_id` aportado por el navegador.

## Vinculación verificada con dos sesiones distintas

`adapters/order-ownership-lab.ts` implementa:

- `linkControlledCustomerAccounts`: valida una **sesión activa en M4** por `readAuthenticatedProfile` (incluye comprobación de email, actividad, expiración/revocación y MFA si corresponde) y una **sesión activa de M1** por `resolveSession`. Ambos deben tener rol de **cliente** y el mismo correo normalizado. La coincidencia de correo es un control adicional, **nunca la prueba principal**.
- Persiste únicamente `m4_user_id` ↔ `m1_customer_id` y el método `dual_active_sessions_lab`; **no persiste correo, password, hashes de sesiones, tokens ni direcciones**. La tabla M11 tiene unicidad para ambos ID, trigger de inmutabilidad y ninguna ruta HTTP pública de asociación.
- Una nueva sesión de M4 sirve para usar la asociación ya verificada. No es necesario volver a iniciar sesión en M1 en cada consulta, pero sí que la cuenta M1 siga activa y con rol cliente.
- `createVerifiedM1OwnershipResolver`: para un usuario autenticado de M4 obtiene su asociación activa, exige cuenta M1 activa y usa **la función real de M1 `readOrderTimeline`** con el ID del cliente M1 vinculado. M1 resuelve la propiedad mediante `orders.buyer_id`, con autorización SQL. **No hay una consulta directa de M11 a los datos de pedido** ni lectura de direcciones para comprobar la propiedad.
- `revokeLinkedCustomerAccount`: operación interna de respuesta a incidentes que requiere host autenticado y `canRevokeIdentityLinks=true`; escribe un registro append-only. Una vinculación revocada no se puede reutilizar silenciosamente. Su restitución exigiría otro protocolo administrativo auditado.

El resolver se conecta al adaptador ya existente `createIdentitySecurityLabGate`: sesión M4 → vínculo M11 → propiedad **M1 real** → grant firmado y verificado por **M9 real**. **M9 autoriza `orders.cancel` pero el resultado señala `orderMutationPerformed=false`: no ejecuta la cancelación.** El M1 dueño del pedido debe volver a comprobar estado/version/ownership y compensaciones dentro de su propia transacción antes de mutarlo.

## Modelo SQL independiente

`modules/integration/migrations/003_customer_identity_links.sql` crea:

- `tala_integration_v2.customer_identity_links`: par M4↔M1 único e inmutable.
- `tala_integration_v2.customer_link_revocations`: revocación única por cuenta M4; motivo restringido y registro inmutable.

La migración falla fuera de `tala_integration_v2_test` o `tala_integration_v2_lab`. No crea FKs cruzadas, no modifica una sola tabla de M1/M4/M9 ni libera la rama `main`. La CI tiene un gate negativo que debe comprobar este rechazo.

## Casos de laboratorio con las funciones reales

La batería `tests/real-m4-m1-order-ownership-db.test.ts` utiliza PostgreSQL 16 para:

1. Crear dos cuentas M4 reales de LAB, activar la verificación de email e iniciar sesión con su propia autenticación.
2. Crear dos cuentas M1 reales de LAB con su sistema de contraseñas y sesiones.
3. Crear pedidos de efectivo **reales de M1** con `createCashOrder` para clientes distintos (stock, snapshot del precio, evento/outbox y orden en la DB de pruebas).
4. Asociar ambas identidades con **dos sesiones activas** y verificar el dueño del pedido mediante la función real M1; M9 permite únicamente el recurso que corresponde.
5. Rechazar pedidos del otro cliente, pedidos inexistentes, sesión M4 cerrada, sesiones falsas y correos distintos.
6. Bloquear al desactivar la cuenta M1. Revocar el vínculo desde un host autorizado, rechazar su reutilización y comprobar que el histórico SQL no puede alterarse.
7. Comprobar que M11 no almacenó correos ni tokens de las dos sesiones en la tabla de asociación.

**Sin pagos reales:** son pedidos de efectivo `pending` únicamente para probar propiedad. M11 no captura dinero, no avisa al restaurante ni cancela pedidos.

## Riesgos bloqueantes restantes

- El método dual-sesión es transitorio para migrar identidades existentes; antes de producción hace falta un proceso seguro de **migración/unificación de cuentas M1 y M4**, con soporte, anti-toma de cuenta, recuperación y protección de vinculaciones.
- La sesión M1 se verifica durante el alta de asociación, pero no se puede mantener una transacción atómica con M4 y M11 por estar en DB distintas. La autorización M4/M9 y lectura de M1 son secuenciales, no sustituyen la comprobación transaccional de M1 antes de una mutación.
- Falta un gateway comercial autenticado; la función de enlace no está publicada como API de clientes.
- Falta integrar catálogo/stock M6 y precios congelados M1; pagos Stripe TEST de una cuenta real mediante M8; asientos M3 y logística M2; outbox de productores, eventos, notificaciones y analítica.
- Se mantiene el HOLD de discrepancias históricas de comisiones 15 % vs 17 % y de transferencias/payouts.

**Criterio de cierre LAB4:** pasar pruebas de M1–M10 y M11 sobre el último HEAD, con la nueva prueba de propiedad real, TypeScript estricto y SQL en DB autorizada; mantener PR Draft, sin despliegue ni merge.
