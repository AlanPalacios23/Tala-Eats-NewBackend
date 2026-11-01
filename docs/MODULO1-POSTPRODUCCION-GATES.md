# TALA EATS CORE v2 — PEDIDOS · Paquete de preparación posproducción

**Revisión:** 2026-11-01 · **Versión:** `0.2.0-lab.6`
**Estado: NO-GO para producción comercial.** Este paquete deja preparado el monitoreo inicial de **Pedidos** y los procedimientos de validación y reversión. **No** significa que el módulo se haya desplegado, ni autoriza activar LIVE. Solo se modificó Pedidos, scripts de revisión y CI.

## Qué se agregó
1. `src/modules/orders/orders-audit.ts`: inspecciona una instantánea `REPEATABLE READ READ ONLY` de órdenes existentes, con paginación por UUID, sin cambios SQL.
2. `scripts/orders-postdeploy-audit.mjs`: auditoría por lotes. Rechaza cuentas con privilegios de INSERT/UPDATE/DELETE o superusuario. Solo acepta una conexión dedicada de **SELECT**. No imprime IDs de pedidos, direcciones, PIN, cuentas ni importes individuales.
3. `scripts/orders-postdeploy-http.mjs`: smoke de HTTP exclusivamente con solicitudes **GET** a `/health`, `/ready` y `/api/v2/health`, HTTPS o loopback. Sin autenticación ni operaciones mutables.
4. `tests/orders-postdeploy.test.mjs` y CI: detectan órdenes correctas/inconsistentes, escaneos parciales, cuenta escritora prohibida y **NO-GO cuando `commercialReady=false`**.

## Indicadores detectados por la auditoría
- Pedidos sin líneas de productos.
- Descuadres entre líneas, desglose inmutable y total del pedido.
- Versión diferente del número de transiciones reales.
- Eventos de pedido sin salida en la outbox correspondiente.
- Pedidos delivery en curso o entregados sin asignación de conductor.
- Pedidos cash entregados sin doble acuse, PIN consumido, custodio identificado, cantidad correcta o estado de efectivo recibido.

Los informes ofrecen **contadores**, no exponen datos personales ni información de pago.

## Ejecución de auditoría tras un despliegue autorizado
**Precondiciones:** contar con aprobación de la versión, respaldo verificable, acceso a infraestructura propia y una cuenta PostgreSQL creada por infraestructura con solo `SELECT` sobre las tablas de Pedidos. Nunca reutilizar el usuario de escritura del backend.

En una terminal autorizada, proporcionar la URL de esa cuenta **por un mecanismo de secretos** y ejecutar:

```bash
CORE_V2_AUDIT_DATABASE_URL="$ORDERS_READONLY_DATABASE_URL" \
ORDER_AUDIT_MAX_ORDERS=10000 \
node --experimental-strip-types scripts/orders-postdeploy-audit.mjs
```

La salida tiene `module:"orders"`, `mode:"read-only"`, `scanned`, `hasMore`, `counters` y `status`:
- **PASS**, código 0: no se detectaron anomalías en el conjunto completo revisado.
- **FAIL**, código 2: se encontraron inconsistencias. **No promocionar**.
- **INCOMPLETE**, código 2: no hay órdenes para comprobar o excedió el límite de 10 000 órdenes; aumenta el límite de manera controlada hasta 100 000 como máximo, o analiza un subconjunto puntual. **No promocionar con análisis parcial.**
- Error de conexión, permisos o SQL: **NO-GO**, sin cambios en base de datos.

El límite garantiza un máximo operativo; no constituye un diagnóstico permanente y no sustituye alertas. Los tests de CI comprueban el funcionamiento con PostgreSQL de pruebas descartable.

## Smoke HTTP posdespliegue
Proporcionar la URL real de destino mediante variable de entorno; **no** modificar el script ni escribir un nombre de servidor en el repositorio:

```bash
CORE_V2_POSTDEPLOY_BASE_URL="$ORDERS_BASE_URL" \
node scripts/orders-postdeploy-http.mjs
```

- **GO (0):** los tres endpoints y sus indicadores confirman salud, esquema y **habilitación comercial explícita**.
- **NO_GO (2):** falta readiness, API o autorización comercial. El backend actual devuelve `commercialReady:false`, así que el **resultado esperado hoy es NO_GO**.
- No intenta pedidos de prueba, pagos, inserciones, reembolsos ni transferencias.

## Gate antes de autorizar una publicación comercial
**No habilitar escrituras de Pedidos para clientes reales hasta verificar todas estas dependencias:**

1. Contrato integrado y probado con las PWAs Usuarios, Restaurante y Repartidores; estados, sesiones, errores y versión de pedido.
2. Capa de identidad de producción con revocación, CSRF/cookies HTTPS y límites distribuidos; no utilizar cuentas de semilla LAB.
3. Pagos Stripe TEST firmados y conciliación verificable, o flujo efectivo con custodia, diferencias y liquidaciones de Finanzas, incluyendo disputas.
4. Entregas reales: evidencia de recogida y domicilio, asignación y GPS verificables en la infraestructura prevista.
5. Tarifas, comisiones y destino del efectivo conciliados con el acuerdo comercial. No publicar el 17% interno sin resolver la diferencia con el piloto del 15%.
6. Respaldo/restauración auditados, migraciones aprobadas para la base correspondiente, observabilidad, outbox y alarmas; pruebas de carga y clientes Android/iOS.
7. Release con SHA firmado/revisado, plan de canario y rollback verificado, y autorización expresa para desplegar.

**El servidor actual contiene una barrera deliberada**: solo habilita escrituras en `CORE_V2_RUNTIME=isolated-lab` sobre PostgreSQL local `tala_core_v2_lab`/`tala_core_v2_test`, con `CORE_V2_WRITES_ENABLED=true`. También exige `NODE_ENV` diferente de `production`. No cambiar esas barreras para obtener un GO aparente.

## Procedimiento de seguimiento y rollback
- **Antes:** verificar SHA/version de artefactos y esquema de la DB específica, salud de la plataforma actual, respaldos, ventanas de mantenimiento y capacidad de reversión.
- **Después:** comprobar `/health`, `/ready` y `/api/v2/health`; ejecutar la auditoría read-only; comparar número de pedidos, cambios de estado y errores esperados; vigilar anomalías de inventario, reclamos duplicados, PIN fallidos y outbox atrasada sin registrar PII.
- **Si hay anomalías:** detener la promoción/canario y **desactivar el tráfico hacia la versión candidata** mediante el mecanismo de despliegue autorizado; restaurar el binario anterior aprobado. No revertir automáticamente pedidos confirmados ni ejecutar DOWN migrations sobre datos comerciales.
- **Rollback de esquema:** requiere procedimiento de recuperación separado, restauración de backup/procedimientos compatibles y revisión de operaciones ejecutadas; nunca borrar evidencia ni eventos ya registrados.
- **Evidencia del cierre:** SHA, workflow CI, versión, resultados de health/audit y aprobación responsable. Si un gate falla: **NO-GO**.

## Advertencia sobre el alcance
`orders-postdeploy-audit` verifica invariantes de Pedidos, **no** acredita saldos bancarios, liquidaciones, GPS real, validez tributaria ni inexistencia de fraude. Este paquete no ejecuta ni simula despliegues remotos. El PR permanece abierto como borrador y Kali sin cambios.
