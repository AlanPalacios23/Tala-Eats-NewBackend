# TALA EATS CORE v2 · arquitectura y transicion

## Fuente de verdad
- Backend heredado: conserva por ahora las apps comerciales y los datos existentes.
- CORE v2: nuevo sistema completamente separado, en esta nueva cuenta de repositorio.
- Nunca conectar dos escritores a una misma orden o movimiento financiero.
- No importar registros antiguos sin inventario, contrato de compatibilidad,
  auditoria por conteos/saldos, pruebas de integridad y aprobacion de corte.

## Infraestructura
API: Node.js 24 + Express + TypeScript, monolito modular.
Persistencia: PostgreSQL (transacciones, ordenes, eventos, ledger futuro).
Cache/queue: Redis + BullMQ cuando el modulo lo requiera, aislados del viejo.
Runtime de pruebas: servicio local 127.0.0.1:18210 y BD distinta.
API LIVE actual: NO MODIFICAR ni reiniciar procesos PM2 ni tuneles Cloudflare.

## Modulos y secuencia principal
1. PEDIDOS: idempotencia real, estados, auth, stock, checkout, E2E.
2. LOGISTICA: capacidad, ETA, GPS, PIN, asignacion y recuperacion.
3. FINANZAS: libro mayor y conciliacion de efectivos/Stripe/Wallet/Connect.
4. RESTAURANTES, UBICACIONES, USUARIOS, SEGURIDAD, NOTIFICACIONES,
   ANALITICA conforme a contratos y prioridades.
Nota: seguridad, pagos verificables y contabilidad minima son P0 transversal:
no se posponen si se necesita dinero para validar PEDIDOS.

## Plan de corte futuro (NO IMPLEMENTADO)
- Determinar SHA y contratos vigentes del backend anterior, exportar
  esquema y evidencias de backup/restore.
- Mantener operaciones abiertas del backend viejo en ese backend hasta cierre.
- Preparar en staging externo pruebas de las tres apps sin cobros reales.
- Habilitar una cohorte/mercado con un solo backend escritor por pedido.
- Conciliar dinero, productos, usuarios y eventos al centavo.
- Verificar rollback, tiempos, permisos y operacion de soporte.
- Retirar backend viejo solo despues de un GO formal y ventana aprobada.

## Condiciones NO-GO
- Sin migraciones sobre bases LIVE o uso de secretos compartidos.
- Sin Stripe LIVE, payouts, refunds ni retiros por la existencia del proyecto.
- No asumir que pruebas unitarias y compilacion prueban todo el checkout.
- La tarifa de comision objetivo es 17%; el backend viejo documenta
  15% en ciertas versiones, asi que se requiere politica/contrato validado.
- El checklist de seguridad y finanzas del issue #206 del repo anterior
  permanece como referencia obligatoria para el lanzamiento.
