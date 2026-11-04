# TALA EATS CORE v2 — Cierre técnico del Módulo 6: Restaurantes y Comercios

**Hito:** LAB6. **Decisión:** GO para detener desarrollo funcional autónomo
y comenzar otro módulo separado. **NO-GO para LIVE, para fusionar sin revisión
y para ventas comerciales.**

**Rama:** `feat/core-v2-restaurantes-foundation`, nacida de `main`.
**Pull request:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8) (Draft).
**Código y DB:** `modules/restaurants`, `tala_restaurants_v2_test` o
`tala_restaurants_v2_lab` exclusivamente.
**Sin imports, FKs o conexión a M1–M5, al backend antiguo ni a Stripe LIVE.**

## Funcionalidades propias de M6 entregadas en LAB

1. Establecimientos de tipo restaurante/abarrotes/carnicería/verdulería/
   papelería/ferretería/florería/otros; estado de onboarding de LAB,
   perfil, propietario y colaboradores con roles propietario/gerente/editor.
2. Sucursales, municipio, dirección, coordenadas opcionales, modalidad de
   recoger/entregar, zona horaria `America/Mexico_City`, horarios semanales,
   estado de activación y cierres excepcionales.
3. Catálogo comercial de productos, presentaciones por peso fijo, precios
   en centavos MXN, publicación/ocultamiento por sucursal y archivo.
4. Fotografías: reserva de metadatos y hash, verificación de bytes delegada
   a un proveedor confiable (simulado en LAB), foto principal y retiro lógico.
5. Inventario legado por establecimiento y, **voluntariamente**, inventario
   físico por sucursal; conciliación obligatoria a cero antes de la
   conmutación. Existencias no se copian automáticamente.
6. Ajustes de existencias, mermas, reposiciones y correcciones idempotentes;
   saldos jamás negativos, libro de movimientos inmutable.
7. Transferencias físicas entre dos sucursales dentro de una única
   transacción, con débito y crédito equilibrados, límites superiores,
   idempotencia y rollback ante falta de stock o destino lleno.
8. Conteos físicos con versión optimista, diferencia positiva/negativa/cero
   auditada, protección contra un conteo obsoleto y registro inmutable.
9. Lectura privada de saldos e historial acotado de ajustes, conteos,
   transferencias entrantes y salientes. Resumen de comercio.
10. Catálogo de sucursal seguro, paginado, sin información interna de
    propietarios ni cantidades exactas y con disponibilidad acorde con
    horario, cierre, activación, menú e inventario de esa sucursal.
11. Contrato de lectura `readOfferSnapshot` para una integración posterior,
    sin reservar unidades, aceptar pedidos ni autorizar cobros.

## Seguridad y límites verificados

- Toda escritura comercial comprueba permisos por comercio antes de mutar;
  el rol del usuario NO se acepta del frontend. La autenticidad de la
  identidad es responsabilidad del host inyectado.
- Las operaciones sensibles se serializan por comercio en una transacción,
  usan enteros de unidades, `operationId` inmutable por actor/acción/
  parámetros y controles de pertenencia de variante/sucursal.
- Los saldos globales previos dejan de poder ajustarse cuando se habilita
  control por sucursal. La vista pública solo devuelve `in_stock`/
  `sold_out`, no saldo bruto ni claves de almacenamiento.
- Los movimientos, transferencias y conteos son append-only vía triggers.
- HTTP únicamente loopback en LAB y **bloqueado en `NODE_ENV=production`**.
  No publicar esta API en internet.
- Se aplican SQL 001–006 solo a `tala_restaurants_v2_test` o
  `tala_restaurants_v2_lab`. CI comprueba que una base distinta sea
  rechazada y conserva la frontera de imports.

## Pruebas de cierre

CI propia: Node 24, TypeScript estricto, PostgreSQL 16, seis migraciones,
pruebas funcionales, HTTP E2E autenticado en loopback, permisos/tenancy,
reintentos, carrera de transferencias, agotamiento, destino saturado,
rollback, conteos con y sin diferencia, lectura privada y auditoría SQL.
El resultado final se comprueba en el PR #8 después del último commit.
No confundir estos tests de LAB con certificación de producción.

## Responsabilidades que NO se incluyen en M6

- M1 Pedidos gestiona autorización, colocación y cancelación de pedidos,
  y requiere un contrato seguro de reserva/compromiso/liberación de stock.
  **El M6 NO realiza reservas aún.**
- M2 Logística gestiona repartidores y despacho; M3 Finanzas/Pagos gestiona
  Stripe, wallet, conciliación y liquidaciones; M4 Usuarios gestiona
  autenticación real y M5 Notificaciones gestiona canales de aviso.
- M6 solo declara capacidad de recoger/entregar como característica de la
  sucursal, no calcula rutas, envíos, tarifas ni tiempos de entrega.

## Puertas de integración y producción que permanecen cerradas

1. Autenticación real de empleados, invitaciones y baja de acceso mediante
   M4 y gateway, revisión de permisos de múltiples comercios.
2. Validación documental y aprobación administrativa de comercios;
   `ready` en LAB **no** equivale a un comercio comercialmente aprobado.
3. Carga real y segura de fotos: verificación de bytes, decodificación,
   tamaño/dimensiones, aislamiento de almacenamiento, ACL, CDN y purga.
4. Contrato transaccional de disponibilidad/reserva con M1, sin introducir
   lógica de pedidos en M6; pruebas de sobreventa y recuperación.
5. Operación comercial de capacidad/tiempos de cocina, horarios divididos,
   facturación (en módulo financiero), monitoreo y recuperación.
6. Seguridad de infraestructura: credenciales, roles DB mínimos, protección
   antiabuso, logs/alertas, backup/restore, E2E reales Flutter/PWA,
   pruebas de carga bajo condiciones de despliegue y revisión legal.

**Regla de cierre:** mantener #8 Draft, sin fusionar a `main` ni
desplegar a Kali. No presentar el M6 como listo al 100% para atender
clientes hasta cerrar puertas de integración y producción. Las mejoras
futuras requieren una solicitud concreta y nueva CI; el siguiente
módulo puede iniciarse desde `main` en otra rama independiente.
