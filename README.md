# TALA EATS CORE v2

Backend modular nuevo de **TALA EATS**, desarrollado por fases.

> **Estado actual: fundamento de PEDIDOS en desarrollo (NO-GO comercial).**
> Este sistema no está desplegado en el servidor Kali, no procesa pedidos reales,
> no comparte bases de datos con el backend anterior y no acepta cobros.

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
  server.ts              # GET /health y GET /ready, SOLO LECTURA
migrations/
  001_orders.sql         # orders, items, eventos inmutables, outbox
tests/
  orders.test.mjs        # reglas de estados y precios
  postgres-schema.test.mjs # restricciones PostgreSQL, CI aislada
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
4. Aplicar `migrations/001_orders.sql` **sólo en esa DB**.
5. Ejecutar `npm run dev`, con `CORE_V2_WRITES_ENABLED=false`.
6. Consultar `http://127.0.0.1:18210/health` y `/ready`.

El pipeline de CI crea su propia DB PostgreSQL 16 descartable para pruebas.
Aún falta generar y versionar `package-lock.json` para dependencias
completamente reproducibles.

## Qué ya existe
- Reglas de estados: received, confirmed, preparing, ready, assigned,
  picked_up, on_the_way, delivered, cancelled, con control de actor y evidencia.
- Cotización pura con importes en centavos y comisión **objetivo 17%**,
  más 7% de servicio (tope $25), envío y pago driver parametrizados.
- Tablas de pedidos, líneas, eventos inmutables y outbox.
- Pruebas unitarias y de esquema; no hay pruebas comerciales E2E todavía.

## Qué falta antes de cerrar PEDIDOS
- Autorización y ownership de usuarios/comercios.
- Checkout y persistencia transaccional de precio, stock y orden.
- Aplicación real de idempotencia, versiones y eventos/outbox.
- Endpoints autenticados para crear, leer, aceptar y cancelar.
- Pruebas de reversión de inventario/pagos, concurrencia, E2E multirrol.
- Stripe TEST con webhook auténtico y conciliación de dinero, sin LIVE.
- Integración de las PWA, monitoreo y recuperación/rollback verificados.

## Backend anterior (no modificar)
El backend previo sigue en
[AlanPalacios23-tala-eats-backend](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend).
No se apaga ni se elimina hasta que se demuestre una migración segura.
Su [checklist de operación comercial #206](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/206)
sigue siendo una referencia de controles P0.

Lee [ARQUITECTURA_Y_MIGRACION.md](docs/ARQUITECTURA_Y_MIGRACION.md)
para conocer la estrategia de convivencia y retiro del backend anterior.
