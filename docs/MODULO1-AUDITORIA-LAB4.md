# Módulo 1 — Auditoría P0 adicional · v0.2.0-lab.4
Fecha: 2026-11-01 · Solo módulo Pedidos de TALA EATS CORE v2.

## Hallazgos encontrados y corregidos

| Incidencia | Antes | Ahora |
|---|---|---|
| Cola de repartidor | `GET /api/v2/driver/available` no incluía `version`, aunque `claim` requiere `expectedVersion` | La cola expone `version` como string de PostgreSQL, pero **no la dirección** antes de ser asignado |
| UUID de acciones | Las claves de idempotencia de merchant, driver y cancel podían variar con la capitalización del UUID del pedido | El hash usa UUID canónico; la misma acción se reconoce en reintentos |
| Reutilización de clave en pasos del driver | Una misma `commandKey` se aceptaba para `picked_up` y `on_the_way` debido a namespaces diferentes | Mismo namespace de mutación, distinto objetivo → `409 IDEMPOTENCY_CONFLICT` |
| Autorización del repartidor revocada | Había un lapso entre comprobar aprobación y grabar el nuevo estado; la lista de asignados no filtraba cuentas desactivadas | El servicio mantiene bloqueos de lectura `FOR SHARE OF d,p,a` hasta commit y la lista solo muestra cuentas activas/aprobadas |
| Repetición de claim al pasar a offline | Si el driver reclamaba un pedido y luego quedaba offline, el retry con la misma clave fallaba | Los reintentos ya confirmados devuelven el evento original aun estando offline; **reclamar un pedido nuevo sigue exigiendo online** |

## Nuevas garantías de CI
- Las regresiones E2E verifican que `driver/available` incluya `version` (sin datos de dirección), replays usando UUID en mayúsculas, reutilización indebida de `commandKey`, revocación en medio de un pedido y repetición tras cambiar a offline.
- Node.js 24 valida sintaxis con `node --check` para **todos los tests/scripts .mjs y JS compilados**; TypeScript 5 realiza compilación estricta.
- Las pruebas PostgreSQL 16 cubren el flujo completo de Pedidos CASH LAB, permisos, idempotencia, stock, PIN, respaldos de evento y rechazo de arranque sin migraciones.
- El resultado de CI debe revisarse específicamente para el SHA final de esta release.

## Límites
No se modificó Logística, Pagos, Finanzas, Users, Redis ni Workers. No se fusionó con `main`, no hubo conexión a DB/Stripe LIVE ni despliegue Kali.

**No es posible garantizar formalmente ausencia absoluta de bugs** con una batería finita de pruebas. Este documento acredita las incidencias concretas corregidas y las evidencias automatizadas. El módulo sigue marcado **LAB FUNCIONAL / NO-GO comercial**.
