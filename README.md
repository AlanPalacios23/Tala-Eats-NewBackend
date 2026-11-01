# TALA EATS CORE v2

Backend modular nuevo de **TALA EATS**, desarrollado por fases.

> **Estado actual: PEDIDOS funcional en laboratorio aislado (NO-GO comercial).**
> API HTTP con login, catálogo, cotización, checkout cash, cocina y cancelación.
> No está desplegado en Kali ni acepta pagos Stripe o pedidos comerciales.
> No comparte PostgreSQL con el backend anterior.

## Arquitectura
- **Node.js 24 + Express + TypeScript** como monolito modular.
- **PostgreSQL** para pedidos, transacciones y eventos persistentes.
- Futuro **Redis + workers** para GPS, colas, notificaciones y recuperación;
  se añadirán cuando un módulo los necesite.
- Varias interfaces: Usuarios, Restaurantes, Repartidores y ADMIN.
- Una funcionalidad principal a la vez: **PEDIDOS primero**.

## Estructura actual

```
src/
  modules/
    orders/
      order-machine.ts   # maquina de estados determinista
      pricing.ts         # calculadora 17% + servicio, centavos bigint
      merchant-orders.ts # acciones restaurante transaccionales (SIN HTTP)
  server.ts              # GET /health y /ready; API solo con gate LAB
migrations/
  001_orders.sql         # orders, items, eventos inmutables, outbox
  002_order_permissions.sql # membresías restaurante desactivadas por defecto
  003_orders_http_lab.sql # cuentas, sesiones, catálogo (solo LAB)
tests/
  orders.test.mjs        # reglas de estados y precios
  postgres-schema.test.mjs # restricciones PostgreSQL, CI aislada
  merchant-order-transactions.test.mjs # concurrencia, authz, rollback en PG aislado
  orders-http-lab.test.mjs # E2E HTTP multirrol, inventario y cancelación
docs/
  ARQUITECTURA_Y_MIGRACION.md
.github/workflows/
  core-v2-ci.yml
```

## Primeros pasos locales (aislados)

1. Instalar Node.js **24** y una instancia **PostgreSQL aislada**.
2. `npm install`; después `npm test` y `npm run build`.
3. Copiar `.env.example` a `.env` y apuntar exclusivamente a una DB nueva
   de laboratorio (jamás `tala_node_live` ni `tala_node_stage`).
4. Aplicar las migraciones `001`, `002`, `003` **solo en una DB llamada `tala_core_v2_lab`**.
5. Arranque normal: `CORE_V2_WRITES_ENABLED=false` y `npm run dev`.
6. Para activar **únicamente el laboratorio**, usar `CORE_V2_RUNTIME=isolated-lab`,
   `CORE_V2_WRITES_ENABLED=true`, host `127.0.0.1`, DB local `tala_core_v2_lab`.
7. Consultar `http://127.0.0.1:18210/ready`, sembrar un comercio con
   `scripts/seed-lab.mjs` e ingresar con `POST /api/v2/auth/login`.
   Ver los contratos detallados en `docs/MODULO1-PEDIDOS-HTTP-LAB.md`.

El pipeline de CI crea su propia DB PostgreSQL 16 descartable para pruebas.
Aún falta generar y versionar `package-lock.json` para dependencias
completamente reproducibles.

## Qué ya existe
- Reglas de estados: received, confirmed, preparing, ready, assigned,
  picked_up, on_the_way, delivered, cancelled, con control de actor y evidencia.
- Cotización pura con importes en centavos y comisión **objetivo 17%**,
  más 7% de servicio (tope $25), envío y pago driver parametrizados.
- Tablas de pedidos, líneas, eventos inmutables y outbox.
- API LAB con sesiones reales, catálogo, checkout en efectivo e idempotencia,
  inventario atómico, lectura por propiedad y cancelaciones compensadas.
- Comandos **internos** de aceptar, preparar y marcar listo: membership activo, versión,
  idempotencia y actualización conjunta del pedido, evento de auditoría y outbox.
  No hay ruta HTTP ni habilitación de operaciones comerciales. Las membresías
  únicamente podrán ser gestionadas por un futuro servicio de identidad confiable.
- Pruebas unitarias y de esquema; no hay pruebas comerciales E2E todavía.

## Qué falta antes de cerrar PEDIDOS
- Autenticación real y provisión verificada de identidades y miembros autorizados
  (la autorización transaccional por membership ya está implementada).
- Checkout Stripe TEST y comprobación firmada del pago (el cash LAB ya opera).
- Idempotencia en creación y checkout, integración de eventos/outbox con trabajadores.
  Las transiciones internas de restaurante ya son transaccionales y probadas en CI.
- Endpoints comerciales y autenticación de producción: el contrato HTTP LAB
  está construido, pero no ha sido conectado a las PWA y no está certificado LIVE.
- Pruebas de reversión de inventario/pagos, concurrencia, E2E multirrol.
- Stripe TEST con webhook auténtico y conciliación de dinero, sin LIVE.
- Integración de las PWA, monitoreo y recuperación/rollback verificados.

## Backend anterior (no modificar)
El backend previo sigue en
[AlanPalacios23-tala-eats-backend](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend).
No se apaga ni se elimina hasta que se demuestre una migración segura.
Su [checklist de operación comercial #206](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/206)
sigue siendo una referencia de controles P0.

Auditoría y endurecimiento del Módulo 1:
[MODULO1-AUDITORIA-HARDENING.md](docs/MODULO1-AUDITORIA-HARDENING.md).
La suite de pruebas PostgreSQL 16 incluye permisos, idempotencia, carreras
aceptar/cancelar, dirección pickup, rate limiting y timeout SQL.

Lee [ARQUITECTURA_Y_MIGRACION.md](docs/ARQUITECTURA_Y_MIGRACION.md)
para conocer la estrategia de convivencia y retiro del backend anterior.
