# Módulo 3 — Finanzas LAB2: compensaciones y estado de cuenta

**Estado:** LAB aislado, sin cobros ni pagos de salida, sin despliegue en Kali, PR #5 Draft.
**Rama:** `feat/core-v2-finanzas-foundation` → `main`.

## Funcionalidad desarrollada

**1. Reverso contable total de una retención.** `reverseLabHeldAllocation(pool,{orderId,commandKey})`
registra una operación compensatoria nueva y conserva el asiento original inmutable.
Invierte exactamente todas sus partidas de débito/crédito; no acepta diferencias de monto,
cuenta, propietario ni metadatos. La base exige una única compensación por asignación,
una huella idempotente por comando y correspondencia estricta entre orden, restaurante
y asiento original. Reintentos idénticos devuelven el mismo identificador; una orden
revertida con un comando distinto se rechaza. Es una **corrección contable**, no
reembolso de tarjeta ni operación bancaria.

**2. Saldos pendientes netos.** Las vistas `merchant_pending_balances` y
`held_liabilities` calculan las asignaciones menos compensaciones ya registradas.
Las cantidades disponibles y retirables siguen bloqueadas a cero; no se adelanta
reconocimiento de ganancias ni se concede saldo al repartidor.

**3. Estado de cuenta del restaurante.** `readMerchantLedgerStatement`
ofrece movimientos contables de retención y compensación con fechas,
identificadores e importes en centavos. Tiene paginación *keyset* con ordenación
estable y conserva los microsegundos de PostgreSQL, evita duplicados al paginar
y restringe la consulta a un único `restaurantId`. Es una función interna,
sin endpoint público ni datos de consumidores.

**4. Auditoría de reversos.** `auditInternalLedger` distingue
`held_internally_consistent`, `fully_reversed` y `needs_review`.
Comprueba la identidad del contrato, la suma de la asignación y que cada
compensación sea la inversión exacta del asiento original.

## Protección adicional

El script `migrations/002_full_held_reversal.sql` crea
`held_reversals` y `reversal_postings`. Una función trigger rechaza
inserciones fraudulentas incluso si un cliente SQL intenta compensar
parcialmente, alterar la cuenta, atribuirla a otra tienda o incluir
propiedades que signifiquen disponibilidad. Las dos tablas de asientos
son *append-only*. La migración se niega fuera de las bases efímeras
`tala_finance_v2_lab` y `tala_finance_v2_test`.

GitHub Actions verifica:
- cálculos puros de asignación/reverso y centavos exactos;
- reintentos concurrentes, 12 solicitudes iguales y comandos distintos;
- SQL adversarial (importe, identidad, campos inesperados, inmovilidad);
- saldo neto que llega a cero sin hacer disponible el dinero;
- movimientos paginados, aislados por comercio, con cursor inválido rechazado;
- auditoría y rechazo de despliegue de migraciones sobre una base ajena.

## Límites y siguiente trabajo propio de Finanzas

Las funciones **no autentican hechos externos por sí mismas**. El futuro
adaptador confiable del sistema deberá certificar cuándo corresponde asignar
o revertir una obligación; una cadena suministrada como `commandKey` no
constituye autorización. No existen por ahora liberaciones a saldo disponible,
custodia de efectivo operativa, registros de caja, conciliación bancaria,
transferencias, reembolsos de proveedor ni retiros.

Las siguientes prioridades son **exclusivamente contables**: libro auxiliar
de repartidores, modelo de custodia y arqueo de efectivo, reservas, reglas
de maduración de obligaciones después de recibir evidencia autorizada,
auditoría y cierres por período. Stripe, PaymentIntents, cobros, webhooks,
refunds de proveedor y payouts externos quedan fuera del Módulo 3.

La discrepancia de comisión (17 % en el cálculo vigente de M1 frente a
la política comercial previa del 15 %) sigue pendiente antes de integrar
módulos. No se modifican instantáneas históricas.
