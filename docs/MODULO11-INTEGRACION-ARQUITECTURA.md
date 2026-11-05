# Tala Eats Core v2 — M11 Integración: arquitectura aislada y puertas de staging

**Fecha:** 5 de noviembre de 2026.
**Rama:** `feat/core-v2-integracion-monolito-m11` (parent commit de `main`).
**PR:** integración aislada como nueva capa, no merge de PRs de módulos.
**Estado:** LAB2 aprobado y LAB3 en validación; integración M11→M10, M11→M5 y M4→M9 con componentes reales en laboratorio; sin fusión ni despliegue comercial.
**Protección:** NO-GO LIVE, NO-GO despliegue Kali, NO-GO sustituir backend anterior.

## 1. Ensamblaje físico comprobable

Se creó un **commit de árbol Git**, cuyos padres contienen solo la rama `main`; el árbol contiene exactamente el HEAD de M1/M2 preservado desde la rama descendiente M2 y los ocho subárboles completos de M3–M10 por SHA. Se siguió la dependencia M2→M1 deliberadamente: el comparador GitHub declaró M2 `ahead_by=56` y `behind_by=0` respecto a M1 actual.

`source-lock.json` fija las diez rutas/SHAs. El gate verifica que los subárboles de dominio no se modifiquen accidentalmente durante integración. Los PR originales siguen en Draft y no se tocaron.

```text
Tala-Eats-NewBackend/
├── src/modules/orders/                M1, desde M2 descendiente M1
├── src/modules/logistics/             M2
├── modules/finance/                   M3
├── modules/users/                     M4
├── modules/notifications/             M5
├── modules/restaurants/               M6
├── modules/locations/                 M7
├── modules/payments/                  M8
├── modules/security/                  M9
├── modules/analytics/                 M10
└── modules/integration/               M11, nuevo
    ├── source-lock.json
    ├── migrations/001_integration_inbox.sql
    ├── src/admission.ts
    ├── src/events.ts
    ├── src/bridge.ts
    ├── src/scenario.ts
    ├── src/http-lab.ts
    ├── tests/
    └── scripts/
```

## 2. Una CI real de todos los módulos, sin producción

`.github/workflows/module11-integrated-ci.yml` ejecuta:

- Node.js 24 y PostgreSQL 16, **un mismo proceso de servidor PostgreSQL en Actions** con diez bases separadas: `tala_core_v2_test`, `tala_finance_v2_test`, `tala_users_v2_test`, `tala_notifications_v2_test`, `tala_restaurants_v2_test`, `tala_locations_v2_test`, `tala_payments_v2_test`, `tala_security_v2_test`, `tala_analytics_v2_test`, `tala_integration_v2_test`.
- Pinned Git subtree verification M1–M10.
- Instalación Node de raíz y ocho paquetes de dominio sin hooks, más M11.
- **Importación de entradas de código real de M1–M10 en el mismo runtime Node 24**, sin ejecutar mutaciones.
- Migraciones en el orden de cada dominio usando sus guardas originales.
- Ejecutar los tests/build reales de M1/M2 y de M3–M10, así como la batería M11.
- Pruebas adversariales M11 de 25 mensajes concurrentes, lease y late ACK, retries, DLQ, escenarios de 10 interfaces simuladas, seguridad del shell HTTP y rechazo SQL sobre base externa.

Esto constituye una **verificación combinada de código y entorno**, pero todavía no demuestra un pedido pagado y entregado a través de adaptadores reales.

## 3. Contrato de comunicación M11

Los módulos no leen SQL de otros dominios. M11 aporta únicamente un **puente de transporte en LAB**, no autoridad de negocio:

```mermaid
flowchart LR
  A["M1 Pedidos · outbox futuro"] --> B["M11 inbox durable"]
  C["M6 Restaurantes · outbox futuro"] --> B
  D["M2 Logística · outbox futuro"] --> B
  B --> E["M5 Notificaciones"]
  B --> F["M2 Logística"]
  B --> G["M10 Analítica"]
```

*Nota:* los conectores de outbox de origen y los adaptadores reales de consumidores son **pendientes**. En LAB M11 recibe eventos mediante una función de host confiable y los entrega a adaptadores inyectados de prueba. La fuente de verdad de los pedidos, estados, dinero e identidad permanece en los módulos titulares.

### Garantías del bridge

- Envelope cerrado con `schemaVersion`, UUID evento/comercio/pedido, origen, tipo y UTC; sin PII, tarjetas, montos, dirección, GPS ni credenciales.
- Tres temas mínimos y un mapa explícito de productores/consumidores. No se aceptan `payments.succeeded` ficticios, eventos de transferencia ni una ruta para emitir hechos financieros reales.
- Inserción transaccional del hecho y fanout a consumidores.
- `eventId` + hash del contenido para idempotencia ante reentregas; alteraciones del mismo ID se rechazan.
- Un registro por `(eventId,consumer)`, reclamación `SKIP LOCKED` y lease de 30 segundos para concurrencia.
- `claimId` por intento; un worker con lease vencido no puede ACKear el lease de otro.
- Tres intentos como máximo y estado `dead` como DLQ manual. El error de runtime **no se persiste en texto libre**.
- At-least-once, no exactly-once de efectos externos. Cada consumidor debe almacenar sus propias claves idempotentes.
- Métricas agregadas únicamente al host con `canMonitorIntegration`.

### Seguridad

`checkIntegrationAdmission` bloquea `NODE_ENV=production`, flags de escrituras, Stripe LIVE, payouts, HTTP público, URLs que no apunten a bases de laboratorio exactas y hosts de DB remotos. El shell M11 permite **solo dos GET de estado en loopback**. Los laboratorios de dominio no pasan automáticamente a ser endpoints públicos.

**La fuente de autoridad real todavía no está conectada**: M4 autenticaría identidad, M9 verificaría grants y autorización reforzada, M6 precio/stock/aceptación, M7 cobertura, M8 PSP TEST, M3 ledger, M2 entrega, M5 notificación, M10 KPI. Un mero import de código no valida esa secuencia.

## 3.1 Primer puente de código real a un módulo consumidor

LAB2 incorpora `modules/integration/adapters/analytics-lab.ts`.
Cuando M11 recibe un evento `logistics.delivery_completed`
**sintético** de su host de laboratorio, el adaptador llama a
`ingestAnalyticsEvent` **del M10 real** con un hecho de entrega de
monto cero, `eventId` original y firma HMAC logística de pruebas.

La CI usa dos bases propias, `tala_integration_v2_test` y
`tala_analytics_v2_test`, dentro del mismo PostgreSQL y verifica
que una caída después del commit en M10 y antes del ACK M11 provoque
un segundo intento sin duplicar métricas. También impide que se
traduzcan eventos no logísticos o se creen hechos financieros.

Esta prueba es un **enlace de funciones reales M11→M10**, pero no
una prueba de M2 real ni un mensaje firmado y emitido por el outbox
auténtico de Logística. La custodia de la clave de emisor debe pasar a
M2 antes de LIVE. No se consideran listos otros ports del monolito.

## 3.2 LAB3 — nuevos enlaces reales y bloqueo de pedidos impagos

**M11→M5 Notificaciones:** el adaptador llama a
`publishNotification` y `readInbox` de M5 en su DB real de LAB,
con recibos idempotentes y un binding irreversible de destinatario
en la DB de M11. El `recipientId` es resuelto fuera del frontend
por un host que acredita el vínculo con pedido/comercio/evento.
Un retry con un destinatario diferente se rechaza; un retry después
del commit M5 pero antes del ACK M11 no duplica el aviso.

**Decisión importante:** `orders.order_created` conserva su
registro de hecho, pero ahora tiene **cero consumidores**. M11 nunca
despacha `restaurant.new_order` desde una mera creación de pedido
sin confirmación financiera. Para notificar a la tienda se deberá
introducir un evento versionado y respaldado por M8/M1 que acredite
el pago verificado. Evitamos pendientes que terminarían en DLQ por
eventos cuyo aviso no es procedente.

**M4→M9:** un adaptador del M11 comprueba una sesión real en M4,
exige que un host confiable acredite la propiedad del pedido, y
usa firmas/grants reales del M9 para autorizar el recurso concreto.
No firma `step_up` para permisos que M4 no haya verificado:
solo `orders.cancel` con sesión; el módulo M1 **no recibe la orden
de cancelación**. La futura atestación de propiedad deberá basarse
en M1 y resolver la vinculación M4↔M1.

Las pruebas usan PostgreSQL real de M4, M5, M9 y M11 con cuentas,
sesiones, auditorías y bandejas de entrada **solo de laboratorio**.
No se considera probado un flujo de dinero ni un pedido de producción.

[Acta LAB3](MODULO11-INTEGRACION-LAB3.md).

## 4. Condiciones bloqueantes de un monolito modular realmente funcional

1. **Contratos/ports de implementación** M1–M10 con tipado compartido, sin importar subtablas ni exponer interfaces LAB en Internet.
2. **Auth gateway real** M4/M9 y autorización por recurso/rol, privilegios de staff, respaldo de sesiones y auditoría de seguridad.
3. **Pedidos y catálogo**: total congelado M1 igual a M6, capacidad real de M6 de aceptar/restar stock, zonas M7 validables, configuración de tarifas de M3.
4. **Stripe TEST real** conectado a una cuenta TEST con webhook nativo, PaymentIntent de M8, refund y conciliación M3. Nunca transformar `simulated_lab` en `FundsConfirmed.v1` real.
5. **Finanzas**: políticas de comisiones y tarifas consistentes, outbox con exact-once contable en consumidores, reconciliación de terceros, wallets y transferencia en HOLD hasta autorización.
6. **Logística**: asignación y presencia reales, PIN, entrega, reintentos, reserva de pedidos y efectivo.
7. **Workers de transporte** y control de backpressure, métricas de backlog/DLQ, firmas por productor, alertas/retención y recovery tras caídas.
8. **DB staging**: estrategia posterior para consolidar a una base con esquemas y permisos mínimos, sin quitar guardas LAB sin migraciones y backups. Hoy las diez DB están aisladas intencionalmente.
9. **Pruebas E2E de aplicaciones** Clientes→Restaurantes→Repartidores→Finanzas/ADMIN→Analítica. Un contrato simulado de diez interfaces solo verifica orden e invariantes, no tráfico comercial.
10. **Despliegue**: CI global, pruebas de estrés/seguridad, compatibilidad hacia atrás, backups/restore, rollback, canary y aprobación explícita antes de tocar Kali.

## Decisión

- **GO LAB1** si la CI integrada demuestra árboles pinneados, imports reales, build/tests de diez dominios, bridge M11 y SQL con guardas en un mismo ambiente descartable.
- **NO-GO para declarar comercialmente integrado:** no hay wiring real de las diez funciones en un único servidor Express, ni pagos Stripe TEST reales, ni E2E de las tres apps.
- **NO-GO para LIVE / merge / Kali:** mantener PR M11 Draft y los diez PR originales sin fusionar.

[M11 README](../modules/integration/README.md).

## Evidencia de CI

La [ejecución integrada #42073939450](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42073939450) aprobó en el HEAD funcional `be494737588f788e8202ae83cbb80ac71fae0154` las suites individuales de M1–M10 y los tests M11 (260 ejecuciones PASS contando la batería financiera adicional), incluida la prueba real de duplicación evitada en M10 ante reenvío de M11.

**Certificación solo de ensamblaje y puente LAB2:** todavía faltan bindings comerciales reales de los demás módulos, un gateway único de escritura y E2E de aplicaciones.
