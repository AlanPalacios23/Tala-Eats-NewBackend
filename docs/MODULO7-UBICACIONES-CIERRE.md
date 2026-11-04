# Tala Eats Core v2 — Acta técnica del Módulo 7: Ubicaciones

**Fecha de preparación:** 4 de noviembre de 2026.
**Hito:** LAB3 (geometría, privacidad y contratos independientes).
**Decisión de publicación:** **NO-GO LIVE, NO-GO merge, NO-GO despliegue**.
**Condición de cierre autónomo:** aprobación de CI sobre el código LAB3 final;
mientras tanto, **CI PENDIENTE / cierre técnico condicionado**.
**Rama:** `feat/core-v2-ubicaciones-foundation`, nacida de `main`.
**PR:** [#9](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/9) — Draft.
**Código/esquema:** `modules/locations`; PostgreSQL `tala_locations_v2`, solo
`tala_locations_v2_test` o `tala_locations_v2_lab`.

## Funciones exclusivas de M7

1. Coordenadas finitas normalizadas y distancia geodésica Haversine, sin
   geocodificaciones ni rutas inventadas.
2. Zonas circulares administradas por operador autorizado por host, estado
   `draft/active/disabled`, control de versiones e idempotencia.
3. Zonas poligonales opcionales 3–64 vértices, rechazo de geometría inválida,
   pertenencia con borde incluido y auditoría, sin datos municipales supuestos.
4. Consulta `coverage/v2` que unifica coincidencias circulares/poligonales
   sin alterar el contrato original de círculos; siempre indica
   `operationallyVerified=false`.
5. Dirección privada por identidad (máximo 15) con AES-256-GCM, AAD por
   propietario/registro, default único, CRUD, CAS, límite y redacción al borrar.
6. GPS temporal cifrado por actor y propósito, duración 120 s, expiración
   en lectura, revocación y limpieza por lotes invocable por host.
7. Para publicar GPS, doble control: `consent:true` y permiso por propósito
   `Actor.locationConsentPurposes` aportado por el host confiable. M7 no
   autentica usuarios ni verifica pedidos.
8. Eliminación de datos geográficos propios con `eraseMyLocationData`:
   direcciones, snapshots y recibos personales en una transacción aislada,
   con auditoría mínima. No elimina datos de cuentas ajenas.
9. HTTP LAB solo en loopback y prohibido en `NODE_ENV=production`; limites
   de cuerpo, no CORS público, no-store, validación estricta y errores estables.

## Propiedad y fronteras

- **M7 sí:** validación geográfica, zonas, geocercas, direcciones cifradas,
  permisos de publicación GPS exigidos a la identidad inyectada, retención
  lógica, consulta y borrado geográfico.
- **M1 Pedidos:** creación/cancelación, direcciones vinculadas a pedidos,
  precios y reservas. M7 no las gestiona.
- **M2 Logística:** GPS de trabajo autorizado, reparto, rutas, asignación,
  ETAs y prueba de entrega. M7 no inventa el estado de entregas.
- **M3 Finanzas:** costo de envío, cobros, wallets y pagos.
- **M4 Usuarios:** identidad verificable, sesiones, consentimiento persistente,
  gestión de permisos y revocaciones.
- **M5 Notificaciones:** avisos push/correo y campañas.
- **M6 Restaurantes:** perfil y dirección declarativa de sucursal,
  su disponibilidad comercial y catálogo.
- No existen imports ni FK entre estos módulos, ni credenciales o tablas
  de producción, ni cambios al backend anterior.

## Evidencia y pruebas

- LAB1 ya validado: [CI #41790629412](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41790629412).
- LAB2 validado: [CI #41874757135](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41874757135).
- LAB3: requiere que GitHub Actions confirme TypeScript estricto, pruebas
  PostgreSQL/HTTP, consentimiento por propósito, eliminación propia,
  aislamiento por propietario, geometría, cifrado y protección de DB SQL.
  **No declarar PASS ni cierre autónomo hasta confirmar la última CI.**

## Puertas ajenas pendientes para operar realmente

1. Gateway de identidad y autorización externo, prueba/registro/revocación de
   consentimiento GPS por dispositivo y proceso; permiso de `active_delivery`
   otorgado únicamente ante una entrega real validada en M2.
2. Claves persistentes seguras, versionado y rotación/recuperación AES-256-GCM;
   si se pierde una clave, no se puede leer la información previa.
3. Purga GPS programada por host, monitorización/alertas, manejo de
   WAL/réplicas/backups y política verificable de borrado de datos personales.
4. Zonas verificadas con fuentes oficiales y su calidad, precisión geodésica,
   límites complejos, calles transitables, cobertura verdadera y prevención
   de abuso; cobertura de laboratorio no es promesa de entrega.
5. Validaciones E2E con apps Flutter/PWA, permisos en Android/iOS, pruebas de
   seguridad y carga, backups/restore y cumplimiento legal de privacidad.
6. Contratos intermodulares (sin trasladar funciones comerciales a M7).

## Norma para avanzar al siguiente módulo

Una vez que pase LAB3 y se actualice este estado a **CERRADO EN LAB3**:
- **GO exclusivamente para iniciar el siguiente módulo autónomo**, desde
  una rama **nueva creada desde `main`**, sin derivarla de M7.
- Mantener PR #9 abierto y Draft; **no fusionar ni desplegar M7** sin pruebas
  integradas y autorización específica.
- Reabrir M7 ante defectos del dominio o nuevos contratos aprobados, con una
  nueva ejecución de pruebas. Ningún resultado LAB garantiza producción.

## Documentos técnicos

[Arquitectura](MODULO7-UBICACIONES-ARQUITECTURA.md) ·
[LAB2 polígonos](MODULO7-UBICACIONES-LAB2-POLIGONOS.md) ·
[LAB3 privacidad](MODULO7-UBICACIONES-LAB3-PRIVACIDAD.md) ·
[README M7](../modules/locations/README.md).
