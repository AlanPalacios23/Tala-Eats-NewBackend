# TALA EATS CORE v2

Nuevo backend modular de **TALA EATS** (Node.js + TypeScript + PostgreSQL).

> **Estado: en desarrollo / NO-GO comercial.** Este repositorio es independiente del backend operativo anterior y **no** atiende todavía a las aplicaciones de Usuarios, Restaurantes o Repartidores.

## Metodología

Desarrollamos **un módulo principal a la vez**, comenzando por **PEDIDOS**.
Cada módulo se cierra con pruebas unitarias, integración PostgreSQL aislada,
E2E, seguridad, recuperación y evidencia de CI. Finanzas y autorización son
controles transversales P0, aunque otros módulos se desarrollen después.

## Arquitectura objetivo

- Monolito modular Node.js + TypeScript; API Express.
- PostgreSQL como fuente de verdad transaccional.
- Redis y workers cuando lo requieran despacho, notificaciones y reintentos.
- Sin microservicios innecesarios.
- Sin conexión a las bases, claves Stripe ni colas del backend anterior.

## Estado y ramas

- `main`: descripción del proyecto, sin endpoints comerciales.
- `feat/core-v2-pedidos-foundation`: base candidata de PEDIDOS, a revisar mediante PR.

No activar cobros, transferencias o retiros LIVE desde este repositorio.
Para iniciar pruebas se requiere una base de datos nueva y **aislada**.

## Backend anterior

Sigue separado en [AlanPalacios23-tala-eats-backend](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend).
No se apagará ni se sustituirá hasta probar todos los flujos, asegurar
compatibilidad y ejecutar una migración segura por versiones.

El [checklist #206](https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend/issues/206)
sigue siendo una referencia obligatoria de seguridad financiera y comercial.
