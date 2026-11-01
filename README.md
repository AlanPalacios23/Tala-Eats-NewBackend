# TALA EATS CORE v2

Backend modular nuevo de **TALA EATS**, desarrollado por fases.

> **Estado actual: PEDIDOS funcional en laboratorio aislado (NO-GO comercial).**
> API HTTP con login, checkout cash, cocina, pickup/delivery, PIN y custodia de efectivo.
> No está desplegado en Kali ni acepta pagos Stripe o pedidos comerciales.
> No comparte PostgreSQL con el backend anterior.

## Arquitectura
- **Node.js 24 + Express + TypeScript** como monolito modular.
- **PostgreSQL** para pedidos, transacciones y eventos persistentes.
- Futuro **Redis + workers** para GPS, colas, notificaciones y recuperación;
  se añadirán cuando un módulo los necesite.
- Varias interfaces: Usuarios, Restaurantes, Repartidores y ADMIN.
- Una funcionalidad principal a la vez: **PEDIDOS primero**.

## Módulos independientes

```
src/
  modules/
    modulo-1-pedidos/
      order-machine.ts       # estados y prueba de entrega del pedido
      checkout.ts            # compra, inventario, idempotencia
      merchant-orders.ts     # restaurante acepta y cocina
      cancel.ts              # compensación de inventario
      handoff.ts             # cierre del pedido, PIN y acuses de efectivo
      pricing.ts             # desglose interno de pedidos
      lab-auth.ts            # autenticación aislada del laboratorio
      lab-http.ts            # rutas HTTP del laboratorio
      orders-read.ts         # historial y comprobante
      orders-audit.ts        # auditoría de integridad
      migrations/            # SQL 001–007 EXCLUSIVO de Pedidos
    modulo-2-logistica/
      contracts.ts           # contrato independiente
      assignment-policy.ts   # selección elegible de repartidor
      index.ts               # API pública del módulo
      dispatch-service.ts    # presencia y reservas SQL transaccionales
      migrations/001_logistics_lab.sql # tablas/logs/outbox propios
      README.md              # alcance, interfaces y estado real
  server.ts                  # composición /health, /ready, gates
tests/
  orders*.test.mjs           # regresiones Módulo 1
  logistica.test.mjs         # pruebas Módulo 2
scripts/
  render-staging-init.mjs    # migraciones bajo Módulo 1; solo Render seguro
```

**Separación:** Pedidos conserva compra, inventario, cocina, prueba PIN y
cierre del pedido. Logística aporta disponibilidad, capacidad, zonas y selección
de repartidores, sin importar código de Pedidos, modificar dinero ni abrir rutas.
El endpoint heredado de `claim` dentro del LAB de Pedidos es parte de la
transición del pedido y seguirá funcionando. **Módulo 2 tiene su propia
persistencia PostgreSQL probada en CI**, pero no está integrado al servidor,
PWA ni a la base de Render. Su motor no reemplaza todavía la asignación
de Pedidos: falta un adaptador autenticado y la confirmación transaccional
del pedido para evitar asignaciones comerciales sin respaldo.

Arquitectura y contratos: [MODULOS-Y-CONTRATOS.md](docs/MODULOS-Y-CONTRATOS.md).

## Primeros pasos locales (aislados)

1. Instalar Node.js **24** y una instancia **PostgreSQL aislada**.
2. `npm install`; después `npm test` y `npm run build`.
3. Copiar `.env.example` a `.env` y apuntar exclusivamente a una DB nueva
   de laboratorio (jamás `tala_node_live` ni `tala_node_stage`).
4. Aplicar las migraciones `001`–`007` en orden **solo en una DB llamada `tala_core_v2_lab`**.
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

Lee [ARQUITECTURA_Y_MIGRACION.md](docs/ARQUITECTURA_Y_MIGRACION.md)
para conocer la estrategia de convivencia y retiro del backend anterior.

## Auditoría posterior al despliegue

Dos herramientas **sin escrituras**: `scripts/orders-postdeploy-audit.mjs` (requiere cuenta de solo lectura) y `scripts/orders-postdeploy-http.mjs` (solo solicitudes GET). Revisar [MODULO1-POSTPRODUCCION-GATES.md](docs/MODULO1-POSTPRODUCCION-GATES.md). El estado comercial actual continúa **NO-GO**: no habilitar LIVE solo por tener pruebas verdes.

## Criterio de cierre del Módulo 1

Consulta [MODULO1-CIERRE-TECNICO.md](docs/MODULO1-CIERRE-TECNICO.md) para
alcance congelado, riesgos comerciales y decisión GO/NO-GO.
