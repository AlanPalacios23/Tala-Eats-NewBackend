# Módulo 3 — Finanzas LAB3 · libro auxiliar de obligaciones retenidas para repartidores

**Estado:** validación exclusiva en PostgreSQL de laboratorio. PR #5 Draft.
**Independiente:** rama `feat/core-v2-finanzas-foundation` directamente sobre `main`.
**Prohibido confundir:** obligación retenida != trabajo validado != saldo disponible != transferencia.

## Qué se implementó

La migración `003_driver_held_subledger.sql` crea un libro auxiliar
`driver_held_claims`, inmutable y con una única atribución de repartidor
por asignación retenida. Tiene identidad compuesta de orden/asiento/restaurante
y un evento de idempotencia único. Un trigger en PostgreSQL bloquea el asiento
original para comprobar que es de tipo entrega, que el importe coincide
exactamente con la parte reservada para logística y que el original no fue
revertido.

La función interna `assignLabDriverHeldClaim` atribuye la obligación a un
conductor **en un experimento aislado**, sin alterar el libro mayor, modificar
ningún importe ni acreditar dinero disponible. No verifica identidad del
conductor ni prueba de entrega; eso corresponderá a los futuros contratos
autenticados de Logística. El caller no debe exponerse a una PWA o HTTP.

`readDriverHeldBalance` ofrece la suma atribuida todavía retenida,
disponible=0 y retiro no autorizado. Si el asiento origen es compensado por
un reverso completo, la vista de saldo pendiente deja de contarlo aunque el
registro de atribución histórico permanezca inmutable.

## Seguridad probada

- Doce reintentos simultáneos de la misma atribución producen exactamente
  un registro, incluso ante contención de base de datos.
- Dos repartidores que compiten por la misma orden no pueden obtener ambos
  la atribución contable.
- Reverso que compite contra atribución no deja saldo pendiente ficticio.
- Se rechaza pickup sin obligación logística, importe distinto del original,
  atribución cruzada de pedidos/restaurantes, atribución después del reverso
  y modificaciones/borrados de registros previos.
- No se genera un asiento adicional en el libro mayor por la atribución;
  por tanto, no se duplica el dinero del pedido.

Estas son pruebas sintéticas de laboratorio. La base PostgreSQL que usa
GitHub Actions es descartable.

## Punto de decisión: siguiente módulo

**Sí se puede desarrollar otro módulo en paralelo o en una nueva rama
independiente:** M3 cuenta con contratos contables, asientos retenidos,
compensaciones, auditoría, estados de cuenta de comercios, y ahora atribuciones
auxiliares de repartidor. Los módulos restantes pueden diseñar sus propias
interfaces sin copiar ni desplegar la base M3.

**No está aprobado declarar Finanzas completamente terminado ni lanzarlo en
producción:** faltan al menos los siguientes hitos propios del módulo:

1. Custodia y arqueo real de efectivo, con entregas parciales, faltantes
   y pruebas independientes de los movimientos físicos.
2. Reglas de liberación de retenciones a saldos disponibles tras hechos
   autorizados, incluyendo reservas, bloqueos, contracargos contables
   y reconciliación de pasivos de comercio y repartidor.
3. Conciliación financiera completa por período y cierre contable,
   auditoría de permisos mínimos de base de datos y alertas.
4. Integración autenticada con M1/M2 y el futuro módulo de Pagos,
   pruebas E2E y una decisión comercial documentada del 15% vs 17%
   de comisión que hoy figura en versiones distintas.

Hasta superar esos controles, `availableMinor` permanece en cero.
Ninguna transacción o servicio real de Kali, Stripe LIVE o las PWA fue alterado.
