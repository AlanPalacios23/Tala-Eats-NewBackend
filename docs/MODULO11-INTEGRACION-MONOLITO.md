# M11 — Integración aislada del monolito modular (LAB1)

**Repositorio:** `AlanPalacios23/Tala-Eats-NewBackend`.
**Rama:** `feat/core-v2-monolito-integracion` (nace de `main`).
**Módulo:** `modules/integration`; no modifica ni fusiona código de M1–M10.
**Estado:** **LAB2 validado**, ensamblaje de diez dominios y transporte durable ficticio verificado en PostgreSQL 16; **NO-GO LIVE / NO-GO deploy / NO-GO merge**.

## Propósito y alcance REAL

La responsabilidad de M11 es construir **un único proceso de Node.js** que descubra, cargue y registre los puntos de entrada reales de M1 a M10 a partir de sus commits fijados, conservando la autoridad de cada módulo.

La CI descarga **nueve checkouts inmutables**, porque **M1 Pedidos y M2 Logística provienen juntos del commit descendiente de M2**. Se valida el ancestro de M1 mediante `git merge-base --is-ancestor` y se rechazan cambios de SHA.

No hay microservicios. Las factorías HTTP reales de M1/M4–M10 se crean **sin abrir puertos adicionales** y se enrutan desde un único `http.Server` de M11. M2 y M3 tienen implementaciones de trabajo internas cargadas, pero **no son endpoints HTTP públicos**; conservan sus propias reglas y bases.

**Es una integración de carga/composición**, no todavía de operaciones comerciales: los flujos de pago, entrega, wallet y registro de cliente siguen **bloqueados** hasta que los dominios se adapten a un único contexto autenticado, outbox común, staging y políticas financieras verificadas.

## Fuentes y dependencias

| Módulos | Check-out en CI | Entrada verificada | Responsabilidad |
| --- | --- | --- | --- |
| M1 + M2 | `orders-logistics` | `createOrderApp` + `expireDispatchOffers` | Pedidos y logística dependiente |
| M3 | `finance` | `recordLabHeldAllocation` | Finanzas: operación privada |
| M4 | `users` | `createUsersLabHttpServer` | Identidad y cuentas |
| M5 | `notifications` | `createNotificationsLabHttpServer` | Notificaciones |
| M6 | `restaurants` | `createRestaurantsLabHttpServer` | Comercios |
| M7 | `locations` | `createLocationsLabHttpServer` | Ubicaciones |
| M8 | `payments` | `createPaymentsLabHttpServer` | Pagos (solo laboratorio) |
| M9 | `security` | `createSecurityLabHttpServer` | Seguridad |
| M10 | `analytics` | `createAnalyticsLabHttpServer` | Analítica |

Los SHA están congelados en [`upstreams.json`](../modules/integration/upstreams.json). No seguir ramas móviles ni instalar automáticamente cambios de código sin auditar. El árbol de M2 **incluye** M1; nunca importar una segunda implementación de Pedidos por separado.

### API de integración

La única escucha permitida es `127.0.0.1` en puerto efímero (laboratorio) mediante `listenLocalOnly`.

```http
GET /v2/health            # assembled; commercialReady=false
GET /v2/ready             # 503: integración comercial NO terminada
GET /v2/modules           # 10 dominios cargados, M2/M3 solo internos
```

Únicamente se delegan operaciones `GET .../health` a las implementaciones originales de M1, M5, M6, M7, M8, M9 y M10. En M4, el propio health consume la cuota de tasa en DB privada: M11 responde explícitamente **503** hasta conectar su PostgreSQL de staging, en lugar de maquillar ese requisito.

Todos los demás endpoints —**incluidos** login, pedidos, registro, checkout, webhook, transferencias, wallets, reembolsos, lectura privada y creación de eventos analíticos— responden **503 `M11_BUSINESS_ROUTES_DISABLED`**. Esta denegación no es un feature flag reversible: el código no tiene ningún interruptor para habilitar writes.

En este laboratorio las dependencias usan un `pg.Pool` intencionalmente **inaccesible**, con conexión a puerto local no usado. El gateway nunca llega a activar operaciones que pudieran consultar o mutar una base. No se usan secretos del backend antiguo ni claves Stripe. Se generan secretos temporales por proceso solo para construir factories sin habilitar rutas.

### Qué prueba la CI

1. Los **diez dominios** tienen exportaciones reales de código importables en un mismo runtime Node 24.
2. Las fuentes son los SHA exactos del manifiesto; M1 es ancestro real de M2.
3. Un solo servidor HTTP del integrador responde /v2/health y lista diez módulos sin otros puertos.
4. Las rutas health delegadas usan **factories verdaderas**, no simulaciones de los módulos.
5. La puerta `/v2/ready` no afirma listos los flujos comerciales.
6. **Requests POST o privados** son bloqueados, incluso Stripe TEST webhooks, pedidos y eventos de analítica.
7. Arrancar con `NODE_ENV=production` o sin `M11_RUNTIME=isolated-lab` falla cerrado.
8. TypeScript estricto; se prohíbe código propio que invoque Stripe LIVE, despliegue o túneles.

**No prueba todavía** coordinación de DBs, recibos, conciliación, autenticación real entre M4/M9, outbox/redrive y ejecución de un pedido completo. No llamar a este ensamblaje “production ready”.

## LAB2 — transporte durable de eventos entre dominios

**Propietario:** exclusivamente M11, `modules/integration/src/fanout.ts`
y `migrations/001_durable_event_fanout.sql`. Ninguna tabla de
M1–M10 se altera. PostgreSQL 16 de CI:
`tala_integration_v2_test`. Migración protegida con rechazo en DB no
autorizadas.

El transporte consume **solo los cinco hechos sintéticos del contrato
M10**: pedido completado/cancelado, pago/reembolso confirmado y entrega
finalizada. El test usa el HMAC real del código `M10` para verificar
mensajes falsificados, scopes por emisor y datos mínimos. No se almacena
el JSON original, direcciones o datos de cliente; solo campos UUID
operativos, fecha, centavos y digest de payload.

| Origen verificado | Consumidores futuros | Efecto del puente |
| --- | --- | --- |
| M1 Pedido completado / cancelado | M5 Notificaciones, M10 Analítica | Dos trabajos durables |
| M8 Pago / reembolso confirmado | M3 Finanzas, M5 Notificaciones, M10 Analítica | Tres trabajos durables |
| M2 Entrega completada | M3 Finanzas, M5 Notificaciones, M10 Analítica | Tres trabajos durables |

Los consumidores de esta tabla son **destinatarios pendientes de adaptar**,
no invocaciones realizadas a las APIs reales. El hecho firmado por M10
prueba identidad de productor a nivel de clave, **no que Stripe haya
transferido dinero o que el restaurante haya recibido efectivo**.

### Reglas y protección del bus

- `eventId` único, hash SHA-256 e identidad empresarial de orden,
  reembolso y comercio. Un mismo mensaje 20 veces solo genera una fila
  y sus trabajos iniciales.
- Inbox append-only: las actualizaciones/borrados de hechos son
  rechazados por PostgreSQL. Los consumos son independientes por destino;
  fallo de Finanzas no bloquea Notificaciones ni Analítica.
- `claimJobs` distribuye trabajos con `FOR UPDATE SKIP LOCKED`,
  token de lease aleatorio, timeout de 30 segundos y hasta 5 intentos.
- `settleJob` confirma el lease con su token, exige permisos del
  consumidor y admite éxito, retry con backoff limitado o dead-letter.
  No se envían errores sensibles a la base, solo códigos cerrados.
- El transporte es **at-least-once**. No afirmar `exactly once` de
  operaciones comerciales; cada consumidor debe ser idempotente y
  hacer commit de su resultado **antes de ack**.
- No hay endpoint HTTP de ingestión: solo API interna de un host
  con verificador de confianza. El gateway M11 continúa en
  `M11_BUSINESS_ROUTES_DISABLED`.
- El hash y las referencias no permiten recuperar un mensaje firmado
  original. Para una futura entrega **real a M10** después del TTL de
  firma faltará un contrato de *trusted replay* o persistencia segura
  específica; jamás regenerar una firma arbitraria sin productor
  verificado. Este puente aún no garantiza esa entrega comercial.

**CI validada:** [run 42173302893](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42173302893),
**9/9 tests PASS**, Node 24 + PostgreSQL 16. Cobertura: diez módulos
cargados en un proceso, autenticidad del evento vía verificador real
M10, concurrencia 20x, inbox inmutable, aislación de tiendas,
reintentos, backoff, DLQ y permisos del worker.

## La siguiente fase técnica: convertir el ensamblaje en un monolito operativo

**Gate G1 — Consolidación de base/schema:** los módulos existentes comprueban nombres *diferentes* de DB descartable y algunos usan un esquema SQL por módulo. Un solo PostgreSQL puede alojar varios DBs físicamente, pero **eso no cumple el objetivo de una única DB transaccional**. Se necesitan adaptadores y migraciones nuevas con schemas aislados, permisos SQL independientes y pruebas sin debilitar guardas de laboratorio.

**Gate G2 — Contrato de identidad:** M4 será fuente de identidad; M9 ejecutará step-up, antifraude y revocación; el gateway deberá inyectar identidades autenticadas/roles basados en sesión REAL, nunca flags de autorización recibidos del frontend.

**Gate G3 — Contratos e idempotencia de negocio:** M6 catálogo/precios → M1 pedido → M8 Stripe TEST webhook acreditado → M3 ledger/wallet → M2 entrega/PIN → M5 notificación → M10 eventos firmados. No registrar ingresos a partir de un simple estado `success` enviado por el cliente.

**Gate G4 — Outbox durable:** M11 ya tiene un **inbox/fanout LAB2** con reintentos y DLQ ficticios, pero faltan los productores outbox verdaderos M1/M2/M8, workers de consumo reales, secuencias, causación, conciliación de hechos perdidos, retención y observabilidad por dominio. El M10 actual reconoce únicamente los eventos que le llegan; no detecta hechos faltantes en otros módulos.

**Gate G5 — Aprobación de release:** E2E con tres apps + ADMIN, stress, backups, reconciliación de fondos, versión de API, rollback, migración versionada y revisión explícita del despliegue Kali. No hay ningún deploy en M11.

## Ejecución

La forma reproducible es ejecutar la workflow [`module11-integration-ci.yml`](../.github/workflows/module11-integration-ci.yml) en GitHub Actions. La CI obtiene cada commit fijado en `modules/integration/.upstream`, enlaza dependencias aisladas, ejecuta `npm run check` y valida la cadena de ancestría M1/M2.

Con solo el checkout de la rama M11 se puede ejecutar `npm run typecheck` y las pruebas de manifiesto; la prueba de **carga real** requiere además los nueve checkouts de upstream (en CI se exige `M11_REQUIRE_SOURCES=1`). No copiar el árbol `.upstream` a `main`, ni permitir que GitHub Actions publique artefactos de despliegue comercial.

## Estado documental

M1–M10 siguen en PRs Draft; la rama `main` conserva su estado original. M11 **no cierra** la integración de operaciones ni sustituye el backend actual de Tala Eats. La secuencia responsable es validar este ensamblaje y luego abordar G1–G5 sin activar LIVE prematuramente.
