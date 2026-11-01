# TALA EATS CORE v2 — Módulo 1 PEDIDOS · Cierre técnico

**Versión:** `0.2.0-lab.4`. **Fecha:** 2026-11-01.
**Decisión:** GO para continuar desarrollando los siguientes módulos **solo después de CI verde y revisión del PR**; NO-GO para cambiar el backend comercial ni procesar pagos reales.

## Alcance congelado del módulo
Pedidos es el dueño de la orden y de las transiciones verificables:
- creación y cotización de un pedido CASH con precios del catálogo, líneas y snapshot inmutable;
- reserva/descuento de stock y compensación transaccional en cancelaciones permitidas;
- lectura por comprador o comercio autorizado, versionado e idempotencia;
- historial append-only de cambios y outbox de eventos atómicos;
- `received → confirmed → preparing → ready`, con control del restaurante;
- pickup: PIN de comprador, dos acuses de efectivo y entrega;
- domicilio: asignación mínima de un repartidor aprobado al pedido,
  `assigned → picked_up → on_the_way → delivered`, PIN y dos acuses de efectivo;
- monto efectivo en custodia de un actor identificado **sin reclamar liquidación bancaria**.

Este es un contrato limitado del módulo Pedidos, **no** es implementación del
motor general de Logística, del ledger de Finanzas ni del procesador de Pagos.
Redis/workers y los otros módulos del diagrama quedan intactos.

## Controles P0 incorporados
- Atomicidad en PostgreSQL: stock + orden + líneas + evidencias + outbox.
- Reintentos de acciones de restaurante y repartidor: resultado original
  almacenado en el evento (status y version), no el estado más nuevo.
- Bloqueos de concurrencia, versión, límites de espera y retry idempotente.
- Historial de eventos inmutable, líneas del pedido, total, snapshot de
  precios y monto de efectivo protegidos por triggers SQL.
- FK de producto vendido; el SKU se puede desactivar pero no eliminar
  mientras existan líneas históricas.
- PIN aleatorio de 8 dígitos, hash scrypt con sal, expiración 10 min,
  máximo 5 intentos erróneos y 6 emisiones cada 10 min por pedido;
  reintentos de entrega deben presentar el PIN original.
- Pertenencia a pedido o comercio verificada al mutar, sin elevación pública
  de roles. Dirección de entrega oculta hasta la asignación.
- Arranque fail-closed: lab local y migraciones 001–007 completas;
  sin Stripe LIVE, ni conexión a la DB de producción.

## Evidencia de cierre de laboratorio
- GitHub Actions en PostgreSQL 16 + Node.js 24.
- Suite P0: flujos HTTP pickup y delivery, PIN, rotación/límite,
  cancelación, restitución de stock, concurrencia y cross-account auth.
- Validación directa de CHECK/FK/triggers SQL; pagos y totales inmutables.
- Build TS, semillas LAB de restaurante/repartidor, smoke HTTP y
  pruebas negativas de arranque para entornos no autorizados e incompletos.
- Verificar el resultado y SHA de la última ejecución de Actions antes de dar GO.

## NO-GO comercial (dependencias ajenas al cierre interno de Pedidos)
- **Pagos:** Stripe TEST con webhook firmado, idempotencia del proveedor,
  captura real, reembolso seguro y reconciliación.
- **Finanzas:** ledger por partida doble, saldo real, custodia, settlement
  al restaurante/repartidor, efectivo perdido o en disputa.
- **Logística:** asignación geográfica, geocercas, GPS y prueba física.
- **Identidad/Seguridad:** tokens/autenticación de producción, SMS/OTP,
  antifraude y rate limits distribuidos.
- **Integración:** adaptar aplicaciones de usuarios/restaurantes/repartidores
  al contrato HTTP, E2E Android/iOS, notificaciones reales y outbox worker.
- **Operación:** pruebas de estrés, backup/restauración y rollback con
  aprobación expresa de despliegue sobre infraestructura aislada.
- **Política de negocio:** CORE v2 considera comisión 17%, piloto previo 15%;
  resolver la diferencia antes de operaciones reales.

## Regla de avance
**Sí se puede pasar al próximo módulo en el PLAN DE DESARROLLO** si se
acepta que Pedidos está completo **para el entorno LAB y su contrato interno**.
NO se debe fusionar `main`, tocar `tala_node_live`, migrar PWAs comerciales
ni anunciar que la aplicación acepta pedidos reales mientras las dependencias
anteriormente enumeradas sigan sin pasar sus propios gates.

Mantener el PR en borrador hasta revisión y definición del proceso de merge.
