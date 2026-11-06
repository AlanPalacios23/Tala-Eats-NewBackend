# Tala Eats Core v2 — M11 Integración del monolito (LAB9 + RC1 aislado)

**Rama:** `feat/core-v2-integracion-monolito-m11`, creada desde `main`.
**Estado:** **LAB8 VALIDADO en CI:** pickup en efectivo LAB7 + pedido Stripe TEST LAB8 sobre M1/M6/M8, sin dinero LIVE; M3 HELD, M5/M10 comprobados en LAB7. **NO-GO LIVE, merge o Kali.**
**El conjunto de fuentes aún NO equivale a un backend comercialmente integrado.**

## RC2 — ingreso HTTP autenticado, aislado y sin mutaciones comerciales

Se añadió `src/authenticated-gateway-lab.ts`, gateway independiente dentro de M11: `GET /v2/lab/orders/:id/can-cancel` usa un **puerto de host confiable** implementado mediante el adaptador M4→vínculo M1→M9 existente. Debe validar sesión M4 vigente, rol cliente, propiedad REAL del pedido en M1, vínculo no revocado y concesión M9 firmada y acotada. **No cancela pedidos ni permite checkout**; la decisión es solo de autorización y puede registrar auditoría de seguridad LAB.

- Vinculación actual M4/M1 aún exige dos sesiones activas; no es la identidad unificada definitiva para producción.
- Solo interfaz loopback, modo `isolated-lab`, tokens en encabezado Bearer; no se aceptan cookies ni consultas con tokens.
- Falta de sesión: 401, otro propietario: 403; cualquier error inesperado: 503 sin filtrar datos internos. Sin CORS, con `no-store` y sin tokens ni PII en respuestas.
- Todo endpoint mutador devuelve 503. `/v2/ready` **503 incluso con autorización correcta**.
- Las pruebas incluyen negative paths y el montaje REAL de M4, M1 y M9 sobre PostgreSQL 16 aislado.

**Esto avanza una parte de G3, pero todavía NO autoriza abrir acceso de clientes, LIVE ni unificar identidades.**

## LAB9 — ensamblaje real de los diez módulos en un único proceso (PR #16)

- `src/assembly-lab9.ts` carga los **entrypoints reales** de M1–M10 desde los árboles fijados mediante `source-lock.json`, sin copiar lógica comercial a M11.
- M2 Logística y M3 Finanzas permanecen como módulos internos, sin rutas públicas. M1/M4/M5/M6/M7/M8/M9/M10 aportan factories HTTP; únicamente se delega un subconjunto de **health**. El endpoint de M4 indica 503 mientras la DB de M4 esté desconectada.
- `/v2/health` informa de ensamblaje, **no readiness**. `/v2/ready` devuelve **503** siempre. Mutaciones comerciales, Stripe, sesiones, wallets, datos privados y endpoints con query devuelven **503**. No hay conexión a Stripe ni DB productiva; el pool usado es inerte.
- El proceso admite solo loopback, `CORE_V2_INTEGRATION_RUNTIME=isolated-lab`, diez URL locales nombradas y `NODE_ENV!==production`. Se conserva un servidor LAB1 de diagnóstico, distinto al nuevo ensamblador.
- `tests/assembly-lab9.test.ts` valida factories reales, rutas de salud y bloqueo de tráfico comercial.
- `tests/pricing-finance-lab9.test.ts` compara **M1 pricing real** contra **M3 ledger HELD** para tarifas 17 % comercio, 7 % de servicio sin tope, envío $39, repartidor $32 y propina sin comisión.

**RC1 pricing corregido (solo rama de integración):** M1 eliminó el tope anterior de **$25 MXN**; una compra de $500 MXN cobra ahora **$35 MXN** de servicio (7 %) y **$85 MXN** de comisión al comercio (17 %). La nueva política se identifica como `pilot-2026-11-v3-17pct-7pct-uncapped`; pedidos anteriores conservan su `policyVersion` y snapshot original. `src/policy-v3.ts` obliga a validar porcentajes, redondeos y reparto antes de registrar un asiento M3 HELD o aceptar la finalización M8 Stripe TEST en M11. Las pruebas incluyen manipulación de campos, tickets grandes, redondeo en centavos y propinas sin comisión. Esta aprobación **no** equivale a habilitar pagos ni contabilidad LIVE.

**No es una Release Candidate desplegable todavía.** El acceso público, autenticación M4/M9, flujo de Stripe TEST real, holds durables de M6 y checkout M1, entrega M2/M7, conciliación M3/M8, monitoreo y staging permanecen como gates P0 en `docs/CORE-V2-RC-LIVE-GATES.md`. Sin merge, sin Kali y sin operaciones LIVE.

## Qué hay realmente dentro de esta rama

- **M1 Pedidos + M2 Logística**: copiados en el árbol de raíz desde `feat/core-v2-logistica-lab1`, rama descendiente directa del HEAD vigente de M1 Pedidos. No se duplicó M1.
- **M3–M10**: conservan sus subárboles exactos `modules/finance`, `modules/users`, `modules/notifications`, `modules/restaurants`, `modules/locations`, `modules/payments`, `modules/security`, `modules/analytics`.
- **M11**: nuevo `modules/integration/**`, completamente separado de la implementación interna de M1–M10.
- **Proveniencia reproducible**: `source-lock.json` fija los SHA Git de los diez subárboles. `npm run verify:snapshots` comprueba que ninguno fue alterado al ensamblar. Si se actualiza deliberadamente un módulo, corresponde revisar el contrato, la CI y subir una nueva versión del lock.
- **Carga en un único runtime Node 24**: `npm run probe:imports` importa código real de los diez dominios. Esto verifica carga/compatibilidad de módulos **sin ejecutar pagos ni mutaciones**.
- **CI combinada**: usa **un servidor PostgreSQL 16 descartable** con **diez bases de datos LAB** (M1+M2 comparten `tala_core_v2_test`, M3–M10 una por dominio y M11 `tala_integration_v2_test`). Cada base se migra con SQL propia y se ejecutan los tests y compilaciones reales de cada módulo.

**Por qué no una única base todavía:** las migraciones M1–M10 contienen guardas que aceptan solo sus nombres de DB de laboratorio. Eliminar esas guardas precipitadamente o ejecutar las migraciones sobre el banco de datos Kali podría modificar datos reales. La meta posterior es una sola infraestructura Postgres con esquemas separados y privilegios mínimos, tras aprobar migraciones de integración versionadas y rollback.

## Contrato M11 de eventos

M11 provee un **inbox con entregas durables, reintentos y DLQ**, sin alterar las tablas propias de M1–M10. No es un reemplazo del outbox de los productores.

Eventos LAB aceptados:

| Emisor | Evento | Consumidores permitidos |
| --- | --- | --- |
| Pedidos | `orders.order_created` | **Ninguno**: no hay pago verificado |
| Restaurantes | `restaurants.order_ready` | Logística, Notificaciones |
| Logística | `logistics.delivery_completed` | Notificaciones, Analítica |

Formato: `schemaVersion=1`, `eventId`, `source`, `kind`, `merchantId`, `orderId`, `occurredAt` (UTC). Se rechazan campos inesperados, datos personales y montos financieros.

La API **in-process** `publishEvent(pool,trustedPublisher,event)` exige que el host marque al emisor como verificado y que coincida con `source` en un mapa cerrado. El origen **no se determina por un JSON enviado por el frontend**. No existe endpoint de Internet para publicar eventos.

- `events`: registro inmutable del hecho mínimo, `eventId` único y SHA-256 del contenido.
- `deliveries`: entrada independiente por evento + consumidor, con estados `pending`, `leased`, `delivered`, `dead`.
- `claimDelivery`: bloqueo `FOR UPDATE SKIP LOCKED`, lease de 30 s, `claimId` distinto por intento.
- `acknowledgeDelivery`: el ACK tardío de un worker anterior no puede cerrar un lease nuevo.
- `rejectDelivery`: reintentos limitados a 3, después `dead` para diagnóstico manual. No se almacena mensaje de excepción porque podría incluir tokens o datos personales.
- `readBridgeMetrics`: solo personal autorizado por host, conteos agregados por consumidor/estado.
- El **consumidor final debe ser idempotente** ante entregas repetidas, y debe usar `eventId+consumer` como clave. M11 garantiza entrega **al menos una vez**, no exactly-once de efectos externos.
- **Pendiente:** fuente real de outbox transaccional M1/M2/M6, autenticación de productores, worker real con bindings M5/M2/M10 y reconciliación de fallos de red.

## LAB2 — primer adaptador real M11 → M10 (solo datos simulados)

Se añadió `adapters/analytics-lab.ts`, que **invoca la función real
`ingestAnalyticsEvent` de M10** usando su propia base
`tala_analytics_v2_test`. Toma un hecho M11
`logistics.delivery_completed`, lo adapta al contrato
`delivery.completed` de M10, lo firma con una clave HMAC **de pruebas**
del emisor Logística y conserva `eventId`, `merchantId`, `orderId`
y UTC. No calcula ingresos, pagos, refunds ni wallets.

El test `real-analytics-db.test.ts` valida dos hechos en el PostgreSQL
real de CI, y simula un crash **después** del commit en M10 pero **antes**
del ACK de M11: el reprocesamiento no duplica `deliveriesCompleted`,
el claim viejo no puede confirmar el nuevo lease y M10 mantiene las dos
entregas exactas.

**Límite de confianza:** para producción, la clave HMAC debe ser
custodiada por **M2** y el evento debe nacer de su outbox durable
firmado. El adaptador LAB actual firma datos ya admitidos por un host
de pruebas: no demuestra la autenticidad de un conductor ni que la
entrega ocurrió realmente. Los otros consumidores
Notificaciones/Logística y Finanzas/Pagos siguen pendientes de integración.

## LAB3 — puentes reales M11→M5 y M4→M9

**Notificaciones M5:** `adapters/notifications-lab.ts` llama al
`publishNotification` real de M5 para `order.ready` y
`order.delivered`. El destinatario no sale del frontend: un resolver
del host debe probar asociación con evento, pedido y comercio. La
migración `002_notification_binding.sql` guarda esa identidad en M11
como binding inmutable. Tras caída de M11, el reintento usa el recibo
idempotente de M5: no crea otra notificación. Un cambio de destinatario
se rechaza. **Un mero `orders.order_created` no encola notificación ni
dispara preparación; faltan confirmación PSP verdadera y validación M1.**
La CI desactiva email/push al probar la bandeja para no enviar mensajes.

**Identidad M4 y seguridad M9:**
`adapters/identity-security-lab.ts` invoca
`readAuthenticatedProfile` del M4 real, exige una declaración de
propiedad de recurso emitida por un host confiable (simulado en LAB),
firma un grant de 45 segundos y obtiene una decisión del M9 real.
El logout invalida sesiones y bloquea el intento antes de otorgar
permiso. **No cancela pedidos** y el callback de propiedad todavía
no lee M1; `orderMutationPerformed=false`.

Estos vínculos forman pruebas **entre funciones reales de M4, M5 y M9**,
no un API operativo ni un pedido extremo a extremo. Los productores
siguen siendo eventos de laboratorio emitidos por host, no outboxes
transaccionales de los módulos.

[LAB3: pruebas, bloqueos y alcance](../../docs/MODULO11-INTEGRACION-LAB3.md).

## LAB4 — vínculo auténtico entre cuentas M4 y dueño de pedido M1

`adapters/order-ownership-lab.ts` usa **las sesiones y funciones reales**
de M4 y M1. Es importante porque los dos módulos tienen identidades
independientes: **comparar emails o confiar en `buyerId` enviado por
la app no prueba que sea la misma persona**.

- Alta del vínculo: se comprueban simultáneamente una sesión M4 vigente
  y otra sesión legacy M1 vigente, rol cliente en ambas cuentas y el mismo
  correo normalizado. Es una **prueba dual de control**, no una
  equivalencia inferida por email.
- `003_customer_identity_links.sql`: tabla M11 de identificadores UUID
  inmutables y revocación append-only; no guarda tokens, correos, nombres,
  direcciones ni contraseñas. Una cuenta M1 no puede vincularse con dos
  cuentas M4, ni al revés.
- Lectura de propiedad: M11 consulta el vínculo vigente y verifica con la
  función **`readOrderTimeline` real de M1**, que aplica el
  `orders.buyer_id` dentro de SQL. Se confirma además que la cuenta
  legacy siga activa y tenga rol cliente.
- Autorización: M4 valida la sesión y **rol actual** en cada solicitud,
  el resolver M1 comprueba al propietario del pedido y M9 verifica el
  grant firmado. Devuelve `orderMutationPerformed=false`:
  **no cancela ni modifica el pedido**.
- Pruebas SQL de dos clientes reales, checkout de efectivo real de M1,
  titularidad y acceso cruzado, expiración/revocación de sesiones, mismatch
  de email, desactivación de M1 y revocación irrevocable de vínculos.

Este método dual-sesión es una **solución de migración de LAB**;
antes de producción requiere migrar/unificar credenciales e identidades,
cortar la dependencia de la sesión legacy y certificar el flujo E2E.

[Informe LAB4](../../docs/MODULO11-INTEGRACION-LAB4.md).

## LAB5 — catálogo real M6 → cotización/pedido real M1 (retiro LAB)

El nuevo `adapters/catalog-checkout-lab.ts` usa las funciones
**reales** `getBranchAvailability`, `readOfferSnapshot` de M6,
y `previewCart`, `createCashOrder` de M1:

- `004_branch_catalog_links.sql` vincula de forma irreversible sucursal
  M6 ↔ restaurante M1 y variante M6 ↔ producto M1. El registro exige
  host administrativo autenticado, ambas tiendas abiertas, misma
  descripción `Producto — variante`, precio MXN y stock idénticos.
- El preflight comprueba que la sucursal permite **pickup**, la
  variante está disponible, versión/stock/precio exactos y que el M1
  sombreador no diverge; ninguna cantidad/precio se acepta del frontend.
- Para un pedido **solo LAB**, resuelve el comprador con la sesión real
  M4 y la asociación M4↔M1 de LAB4, serializa por sucursal y llama
  a `createCashOrder` original de M1. Este guarda en una transacción
  el precio congelado, pedido, líneas, outbox y descuento del stock M1;
  sus reintentos no descuentan de nuevo ni aceptan carrito cambiado.
- **M6 no reserva ni descuenta stock**, porque los DB no comparten
  transacción. Tras el primer pedido, si ambos inventarios no
  coinciden, M11 **bloquea** nuevas operaciones. El checkout retorna
  `paid=false`, `commercialReady=false` y
  `inventoryNeedsReconciliation=true`.
- **Política comercial en HOLD:** M1 aún calcula comisión 17 %, frente
  a la decisión comercial previa de 15 %. No se modifica ni habilita
  ese pricing para producción; `pricingPolicyApproved=false`.

CI LAB5 [#42125648088 — SUCCESS](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42125648088):
**273 ejecuciones de prueba PASS, 0 FAIL**; las cuatro pruebas nuevas
cubren el flujo M6→M1, versiones, nombres, stock, cierres y carreras.

[Acta técnica LAB5](../../docs/MODULO11-INTEGRACION-LAB5.md).

## LAB6 — reserva de sucursal M6 + pedido M1 recuperable (solo LAB)

**Nuevo port transitorio:** `m6-extension/reservations.ts` y
`m6-extension/008_order_stock_holds.sql`, instalado únicamente en
la DB física **de M6 LAB**, sin editar su árbol original. Guarda
`hold_id`, líneas con precio/versión/unidades, eventos inmutables
de reserva, confirmación y liberación. M6 valida horario, tienda,
sucursal, stock físico y bloqueo de filas en su propia transacción.

**Coordinador `adapters/inventory-checkout-lab.ts`:** crea una
intención durable M11 para cliente M4 ↔ comprador M1 ya verificado,
reserva stock M6, llama al `createCashOrder` real de M1 y confirma
la reserva. Si M1 rechaza y **se demuestra que no se creó pedido**,
libera stock de M6. Si el resultado es incierto, conserva el hold
para revisión; reintentos después de un commit usan el pedido M1
idempotente para confirmar sin cobrar/descontar dos veces.

**TTL 5 min no implica liberación automática:** la reconciliación
comprueba primero que M1 no contiene el pedido. Las pruebas
adversariales demuestran caída entre commits, ausencia de overselling
de 1 unidad, 8-way retry, reembolso físico solo sin pedido,
hold vencido con pedido preservado y rollback íntegro de dos variantes.

El espejo de inventario M1 sigue activo; **M11 no tiene garantía de
atomicidad de bases cruzadas**, y el port M6 deberá migrarse al módulo
M6 verdadero con control de identidades de servicio. La comisión
M1 17 % todavía no concuerda con el 15 % comercial.

[Informe y pendientes LAB6](../../docs/MODULO11-INTEGRACION-LAB6.md).
[CI LAB6 — 281 PASS, 0 FAIL](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42162058259).

## LAB7 + LAB8 — pedidos reales de laboratorio, efectivo y Stripe TEST

**LAB7 efectivo/pickup:** el adaptador
`adapters/pickup-lifecycle-lab.ts` usa los métodos genuinos M1 de
aceptación, preparación, PIN, doble acuse y entrega de efectivo.
`pickup-consumers-lab.ts` verifica eventos comprometidos del outbox M1
antes de enviarlos a **M5** (bandeja del comprador), **M10**
(`order.completed` sin inventar pago PSP) y **M3** (asiento
`HELD`, `withdrawable=false`, efectivo sin conciliación).

**LAB8 Stripe TEST:** `m1-extension/stripe-test-orders.ts` construye
un pedido `awaiting_payment` en la base de **M1 LAB** con precio y
stock bajo bloqueo. `adapters/stripe-test-checkout-lab.ts` reserva
M6 y crea un PaymentIntent del **M8 original** usando un bridge tipado
`adapters/m8-test-boundary.ts`; el entorno CI inyecta un transporte
**offline**. M1 solo pasa a `received / paid` después de que M8
almacene `FundsConfirmed.v1` proveniente de un webhook Stripe TEST
firmado, con cliente, orderRef, moneda y monto vinculados.

El esquema `007_stripe_test_checkout_intents.sql` mantiene el estado
durable de la intención y se rechaza fuera de DB LAB. Con webhook
pendiente M1 permanece `awaiting_payment` y M6 mantiene el hold.
Reintentos no duplican orden, pago ni evento de M1. Se rechazan firma
incorrecta, monto incorrecto y `livemode=true`.

**Advertencia:** ninguna credencial REAL de Stripe ni tarjeta se usó
en CI. Las extensiones provisionales M1/M6 siguen bajo M11 y no
están listas para un gateway público; falta expiración/cancelación de
pago incierto, reembolsos, inventario sin espejo y conexión de la
ruta Stripe TEST con M5/M3/entrega completa.

[LAB7: retiro en efectivo](../../docs/MODULO11-INTEGRACION-LAB7.md) ·
[LAB8: Stripe TEST](../../docs/MODULO11-INTEGRACION-LAB8.md) ·
[CI LAB8 285 PASS / 0 FAIL](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42169799206).

## Prueba de diez fronteras

`runIsolatedTenModuleSmoke` ejecuta un escenario de **contratos inyectados**, no endpoints de producción:

`M4 Usuario → M9 Seguridad → M7 Zona → M6 Cotización → M1 Pedido → M8 Pago simulado → M6 Preparación → M2 Entrega simulada → M3 Previsualización financiera SIN escritura → M5 Notificación simulada → M10 Métricas simuladas`.

Este escenario exige confirmación **exclusivamente `simulated_lab`**, monto coherente, ninguna escritura en wallets/ledger y cero datos LIVE. Los tests usan dobles de prueba para estas diez interfaces. **No se debe interpretar como prueba E2E real de las aplicaciones**.

## Arranque seguro

`checkIntegrationAdmission` exige:
- `CORE_V2_INTEGRATION_RUNTIME=isolated-lab`;
- `NODE_ENV` distinto de `production`;
- flags de escrituras, LIVE payments, payouts y exposición pública NO habilitadas;
- URLs PostgreSQL locales, con nombres exactos de DB LAB para los diez roles.

`createIntegrationLabHttpServer` es solo una vista read-only de ensamblaje:
- `GET /v1/integration/health`
- `GET /v1/integration/modules`

No monta ninguna ruta de cliente, cobros, restaurante, repartidor, wallet o retiros. Las rutas de los otros módulos son **sus laboratorios originales**, no un API de producción unificada.

## Próximas puertas técnicas para integración real

1. **CI unificada** de las diez fuentes en un commit, sin modificar `main`.
2. Contratos reales y adaptadores seguros entre M1/M4/M6/M7/M8, M8/M3, M2/M5/M10 y M9/ADMIN. Autoridad del total, usuario, comercio, ubicación y estado explícita.
3. Outbox de productor en la misma transacción que el hecho de negocio, redrive, idempotencia y DLQ, más pruebas de caídas y webhooks reales Stripe **TEST**.
4. Un único composition root Express/Node con autenticación real y módulos bajo rutas versionadas, conectado a roles SQL mínimos en staging (no reemplazar LAB HTTP automáticamente).
5. E2E de extremo a extremo con las apps Usuarios, Restaurantes, Repartidores y ADMIN, incluyendo refund, efectivo, PIN, conciliación M3 y métricas M10.
6. Auditoría de tarifas (15 % vs 17 %), snapshots y totales reales, backups/restauración, protección TLS, DDoS, QA, revertir y despliegue canario autorizado.

**No se han fusionado los PR M1–M10 a `main`; siguen abiertos para su revisión.** El backend antiguo de Kali sigue intacto.

[Arquitectura M11](../../docs/MODULO11-INTEGRACION-ARQUITECTURA.md)
