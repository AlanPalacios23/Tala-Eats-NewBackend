# Tala Eats Core v2 — Estado del conjunto de 10 módulos

**Corte:** 5 de noviembre de 2026.
**Finalidad:** registrar con precisión qué significa haber desarrollado diez módulos en laboratorios separados y qué falta para que exista un monolito modular real.

## Inventario de PR verificado en GitHub

| Módulo | Dominio | PR | Base del PR al 05-nov-2026 | Situación |
| --- | --- | --- | --- | --- |
| M1 | Pedidos | [#1](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/1) | `main` | Draft; candidato staging, no producción |
| M2 | Logística | [#4](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/4) | **`feat/core-v2-pedidos-foundation`** | Draft; dependencia explícita con M1 |
| M3 | Finanzas | [#5](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/5) | `main` | Draft; ledger/wallets en laboratorio |
| M4 | Usuarios | [#6](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/6) | `main` | Draft; login, identidad, MFA, privacidad en laboratorio |
| M5 | Notificaciones | [#7](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/7) | `main` | Draft; eventos y canales en laboratorio |
| M6 | Restaurantes | [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8) | `main` | Draft; comercios en laboratorio |
| M7 | Ubicaciones | [#9](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/9) | `main` | Draft; privacidad y zonas, revisar gate actual |
| M8 | Pagos | [#10](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/10) | `main` | Draft; Stripe TEST simulado y controles de pago LAB3 |
| M9 | Seguridad | [#11](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/11) | `main` | Draft; LAB2 revocación, antirreplay, auditoría |
| M10 | Analítica | [#12](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/12) | `main` | Draft; LAB2 read model, firma, métricas, reconciliación |

Existe también el [PR transversal M1/M2 #3](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/3), basado en la rama de Pedidos. La cadena M2/M1 requiere resolver cambios compartidos y revisar los commits comparados antes de fusionar. **No afirmar que todos los PR son independientes de `main` ni que pueden fusionarse en cualquier orden.**

**Estado confirmado:** los diez dominios están **representados en ramas y PRs abiertos de desarrollo**. La rama `main` del repositorio se mantiene prácticamente vacía de código funcional y aún no contiene los diez módulos, por lo que **no existe un único ejecutable, despliegue o CI integrado que certifique el monolito completo**.

## Responsabilidades y datos

- M1: orden y total autoritativo.
- M2: entrega, logística y estado de viaje.
- M3: contabilidad de doble entrada, conciliación, wallets y saldos.
- M4: identidad, sesiones, MFA y permisos centrales de usuario.
- M5: notificaciones y canales.
- M6: restaurantes, comercios y catálogo.
- M7: zonas geográficas, ubicación y privacidad.
- M8: hechos de cobro/reembolso verificados por proveedor y control de pago.
- M9: protección transversal, autorizaciones firmadas, anti-replay y alertas.
- M10: hechos firmados, métricas agregadas y reconstrucción del read model.

Ninguna base, clave ni API del backend Kali anterior debe modificarse como resultado automático de crear o cerrar un laboratorio.

## Plan recomendado para construir el monolito real

### Puerta 1 — Integración de código (sin producción)

1. Crear una rama **nueva, exclusiva de integración** desde `main` una vez acordado el orden de merges. Nunca suponer que un PR Draft está integrado.
2. Inspeccionar base y commits de M1, M2 y el PR transversal #3; resolver su dependencia deliberadamente. Traer después M3–M10 de manera controlada y registrar la procedencia de cada cambio.
3. Definir un solo servidor Node TypeScript/gateway, enrutamiento versionado, errores estables, registro central de módulos, configuración por entorno y reglas de importación de dominio. Los adaptadores HTTP loopback de los LAB no son endpoints listos para Internet.
4. Definir contratos TS/JSON versionados entre módulos sin FKs cruzadas, sin acceso directo a tablas ajenas, y sin decisiones basadas en un simple UUID provisto por el frontend.

### Puerta 2 — Staging unificado verificable

5. Construir CI única que compile todos los módulos y ejecute pruebas de PostgreSQL, rutas HTTP, contratos cruzados y pruebas de fallas, restitución y concurrencia.
6. Crear una **base de staging descartable**, no reutilizar ni montar los volúmenes del backend Kali LIVE. Usar roles SQL de privilegio mínimo y separación por esquema.
7. Probar primero: M4/M9 autentican/validan; M1 crea pedido; M8 Stripe TEST valida PaymentIntent y webhook con cuenta de test real; M3 registra hechos del proveedor sin doble cómputo; M2 registra entrega; M5 notifica; M10 observa la operación una sola vez.
8. Definir outbox durable, redrive, idempotencia, DLQ y conciliación de mensajes para que una caída de un consumidor no pierda el pago, entrega ni métricas. Las firmas sintéticas de LAB no prueban flujos comerciales.
9. Resolver tarifas y comisiones acordadas **antes de calcular ingresos:** discrepancias previas 15 % vs 17 % no deben mezclarse silenciosamente en reportes o wallets.

### Puerta 3 — Preproducción, lanzamiento y rollback

10. Probar Stripe TEST, reembolsos, entregas y efectivo punta a punta con las apps Usuarios/Restaurantes/Repartidores/ADMIN, sin exponer LIVE.
11. Seguridad: TLS, vault/rotación de secretos, rate limit en edge, auditoría, autorización multiempresa, privacidad y eliminación de datos, alertas, carga/estrés, backup/restore y rollback.
12. Preparar migración versionada/canary y compatibilidad con el backend Kali previo. **Despliegue y activación LIVE solo con una aprobación explícita independiente** después de pasar todos los gates.

## Decisión y terminología

- **Al terminar M10 LAB2:** completamos la *fase de construcción individual de los diez dominios*.
- **No completado:** unificación del monolito, integración de datos/procesos, Stripe real, lanzamiento y migración de las aplicaciones.
- **GO a continuación:** una fase dedicada exclusivamente a integrar y validar, sin añadir funciones de producto innecesarias.
- **NO-GO:** fusionar todo o desplegar al servidor Kali de forma automática por el solo hecho de que los módulos tienen CI individual aprobada.
