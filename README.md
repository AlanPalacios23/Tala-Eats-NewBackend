# TALA EATS CORE v2

Backend modular nuevo de **TALA EATS**, desarrollado por fases.

> **Estado actual: PEDIDOS + LOGÍSTICA LAB1 en laboratorio aislado (NO-GO comercial).**
> API HTTP con login, checkout cash, cocina, pickup/delivery, PIN y custodia de efectivo.
> No está desplegado en Kali ni acepta pagos Stripe o pedidos comerciales.
> No comparte PostgreSQL con el backend anterior.

## Arquitectura
- **Node.js 24 + Express + TypeScript** como monolito modular.
- **PostgreSQL** para pedidos, transacciones y eventos persistentes.
- Futuro **Redis + workers** para GPS, colas, notificaciones y recuperación;
  se añadirán cuando un módulo los necesite.
- Varias interfaces: Usuarios, Restaurantes, Repartidores y ADMIN.
- Evolución por módulos: **PEDIDOS (PR #1)** → **LOGÍSTICA LAB1 (PR #4)**.

## Estructura actual

```
src/
  modules/
    orders/
      order-machine.ts   # maquina de estados determinista
      pricing.ts         # calculadora 17% + servicio, centavos bigint
      merchant-orders.ts # acciones de cocina con permisos y eventos
      checkout.ts        # pedidos y stock idempotente
      cancel.ts          # cancelación y restitución atómica
      handoff.ts         # PIN, efectivo dual, conductor y entrega
      lab-http.ts        # API HTTP de laboratorio
      lab-auth.ts        # autenticación temporal de LAB
      orders-read.ts     # timeline por actor y recibo inmutable del comprador
      orders-audit.ts    # auditoría read-only de integridad y eventos
    logistics/
      driver-operations.ts # presencia, control de capacidad, GPS reciente
  server.ts              # GET /health y /ready; API solo con gate LAB
migrations/
  001_orders.sql         # orders, items, eventos inmutables, outbox
  002_order_permissions.sql # membresías restaurante desactivadas por defecto
  003_orders_http_lab.sql # cuentas, sesiones, catálogo (solo LAB)
  004_order_handoffs_lab.sql # repartidores, PIN y custodia de efectivo
  005_orders_integrity_lab.sql # snapshots/custodia inmutables y FK del SKU
  006_order_pin_rate_lab.sql # cuota SQL de PIN por pedido
  007_orders_address_handoff_integrity_lab.sql # dirección y evidencias write-once
  008_logistics_lab.sql # capacidad 1, comandos presencia, GPS más reciente
tests/
  orders.test.mjs        # reglas de estados y precios
  postgres-schema.test.mjs # restricciones PostgreSQL, CI aislada
  merchant-order-transactions.test.mjs # concurrencia, authz, rollback en PG aislado
  orders-http-lab.test.mjs # E2E HTTP checkout, cocina y cancelaciones
  orders-hardening.test.mjs # permisos, bloqueos SQL y seguridad HTTP
  orders-handoff.test.mjs # E2E pickup/delivery con PIN y efectivo
  orders-read.test.mjs # timeline multirrol, recibos, privacidad y detalle histórico
  orders-postdeploy.test.mjs # auditoría read-only de postdespliegue
  logistics-lab.test.mjs # capacidad concurrente, GPS/presencia, limpieza al entregar
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
4. En esta rama de Logística, aplicar las migraciones `001`–`008` en orden **solo en una DB llamada `tala_core_v2_lab`**.
5. Arranque normal: `CORE_V2_WRITES_ENABLED=false` y `npm run dev`.
6. Para activar **únicamente el laboratorio**, usar `CORE_V2_RUNTIME=isolated-lab`,
   `CORE_V2_WRITES_ENABLED=true`, host `127.0.0.1`, DB local `tala_core_v2_lab`.
7. Sembrar un comercio con `scripts/seed-lab.mjs` y un repartidor con
   `scripts/seed-driver-lab.mjs`, consultar `http://127.0.0.1:18210/ready`
   e ingresar con `POST /api/v2/auth/login`.
   Ver `docs/MODULO1-RC-FLUJO-COMPLETO-LAB.md` para las rutas completas.

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
- Cocina HTTP autorizada con versiones, idempotencia, eventos y outbox.
- Entrega pickup/delivery con PIN de comprador, acuse bilateral de cash y custodio
  identificado. El efectivo está cobrado pero **NO liquidado al comercio**.
- Repartidor solo si perfil LAB aprobado; reclamación atómica y acceso a la
  dirección exclusivamente después de asignación.
- Pruebas HTTP E2E completas de **laboratorio**, sin validación comercial LIVE.
- **Logística LAB1**: presencia online/offline con versión e idempotencia, una entrega activa por repartidor y último GPS privado sin historial, eliminado al completar la entrega. Solo disponibles en localhost de laboratorio.

## Qué falta antes de habilitar PEDIDOS en LIVE
- Autenticación real y provisión verificada de identidades y miembros autorizados
  (la autorización transaccional por membership ya está implementada).
- Checkout Stripe TEST y comprobación firmada del pago (el cash LAB ya opera).
- Idempotencia en creación y checkout, integración de eventos/outbox con trabajadores.
  Las transiciones internas de restaurante ya son transaccionales y probadas en CI.
- Endpoints comerciales y autenticación de producción: el contrato HTTP LAB
  está construido, pero no ha sido conectado a las PWA y no está certificado LIVE.
- Pruebas comerciales de dispositivos, pago proveedor/efectivo y conciliación.
  Los escenarios cash LAB multirrol y de concurrencia sí están automatizados.
- Stripe TEST con webhook auténtico y conciliación de dinero, sin LIVE.
- Integración de las PWA, monitoreo y recuperación/rollback verificados.

## Backend anterior (no modificar)
El backend previo sigue en
[AlanPalacios23-tala-eats-backend](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend).
No se apaga ni se elimina hasta que se demuestre una migración segura.
Su [checklist de operación comercial #206](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/206)
sigue siendo una referencia de controles P0.

Versión candidata del flujo cash completo:
[MODULO1-RC-FLUJO-COMPLETO-LAB.md](docs/MODULO1-RC-FLUJO-COMPLETO-LAB.md).

Seguimiento, recibos y detalle individual de Pedidos (LAB5):
[MODULO1-SEGUIMIENTO-Y-RECIBOS-LAB5.md](docs/MODULO1-SEGUIMIENTO-Y-RECIBOS-LAB5.md).

Auditoría adicional de seguridad y contratos (LAB4):
[MODULO1-AUDITORIA-LAB4.md](docs/MODULO1-AUDITORIA-LAB4.md).

Auditoría y endurecimiento del Módulo 1:
[MODULO1-AUDITORIA-HARDENING.md](docs/MODULO1-AUDITORIA-HARDENING.md).
La suite de pruebas PostgreSQL 16 incluye permisos, idempotencia, carreras
aceptar/cancelar, dirección pickup, rate limiting y timeout SQL.

Lee [MODULO2-LOGISTICA-LAB1.md](docs/MODULO2-LOGISTICA-LAB1.md) para la primera fase de Logística, sus pruebas y límites.

Lee [ARQUITECTURA_Y_MIGRACION.md](docs/ARQUITECTURA_Y_MIGRACION.md)
para conocer la estrategia de convivencia y retiro del backend anterior.

## Auditoría posterior al despliegue

Dos herramientas **sin escrituras**: `scripts/orders-postdeploy-audit.mjs` (requiere cuenta de solo lectura) y `scripts/orders-postdeploy-http.mjs` (solo solicitudes GET). Revisar [MODULO1-POSTPRODUCCION-GATES.md](docs/MODULO1-POSTPRODUCCION-GATES.md). El estado comercial actual continúa **NO-GO**: no habilitar LIVE solo por tener pruebas verdes.

## Criterio de cierre del Módulo 1

Consulta [MODULO1-CIERRE-TECNICO.md](docs/MODULO1-CIERRE-TECNICO.md) para
alcance congelado, riesgos comerciales y decisión GO/NO-GO.
