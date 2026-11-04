# TALA EATS CORE v2 — Módulo 7: Ubicaciones

**Estado:** LAB2 en rama independiente. **NO-GO comercial / LIVE.**  
**Rama:** `feat/core-v2-ubicaciones-foundation` desde `main`.  
**Esquema aislado:** `tala_locations_v2` en la base `tala_locations_v2_test` o
`tala_locations_v2_lab`.

## Responsabilidad exclusiva

M7 gestiona **coordenadas, puntos guardados, snapshots GPS temporales y zonas
geográficas de cobertura**. Su catálogo de municipios piloto es
Tala, Ameca, Ahualulco, Tequila, Cuisillos y Amatitán. Las zonas deben
configurarse con coordenadas verificadas por un operador autorizado: **no hay
semillas con coordenadas inventadas** ni supuestos de cobertura por municipio.

El módulo NO contiene código de Pedidos, Logística, Pagos, Usuarios,
Restaurantes ni Notificaciones. No tiene importaciones o claves ajenas y
no interactúa con Kali, Stripe, Firebase, Cloudflared ni mapas externos.

### LAB2 — geometría poligonal opcional

Se incorporan polígonos independientes de las zonas circulares mediante la
migración `002_polygon_geofences.sql`, con validación de vértices, ausencia de
autointersecciones, área mínima, compatibilidad de cobertura `v2`, RBAC
por operador, versiones CAS e idempotencia. No existen zonas precargadas,
municipios geolocalizados automáticamente ni garantía comercial.

El endpoint original `/coverage` conserva su formato circular; el nuevo
`/coverage/v2` devuelve coincidencias de círculos o polígonos y deja
`operationallyVerified=false` hasta contar con verificaciones externas.

[Contrato y pruebas LAB2](MODULO7-UBICACIONES-LAB2-POLIGONOS.md).

## Funciones de LAB

- **Coordenadas:** decimales finitos, latitud entre -90 y 90, longitud entre
  -180 y 180, 6 decimales de precisión; distancia de círculo máximo (Haversine).
- **Zonas:** operador autenticado inyecta `canManageZones=true`, crea zonas
  `draft`, activa/desactiva con CAS y controla radio de 100 m a 50 km.
  `checkCoverage` compara un punto en una ciudad explícita contra zonas activas,
  sin deducir municipio ni prometer entrega comercial.
- **Direcciones guardadas:** máximo 15 por identidad, predeterminada única,
  datos personales cifrados con AES-256-GCM (etiqueta, domicilio, municipio,
  coordenadas, código postal y referencia). El AAD liga identidad y registro.
  Operaciones protegidas por usuario, idempotencia de creación, CAS al modificar,
  retiro lógico con **redacción de los bytes cifrados**.
- **GPS temporal:** `foreground` o `active_delivery`; requiere consentimiento
  explícito, autenticación del host y precisión declarada entre 0 y 2.000 m.
  Una sola posición cifrada por identidad y propósito, caduca a los 120 segundos
  y se elimina mediante borrado explícito o limpieza programada por el host.
  No se guarda historial de rutas.
- **Auditoría:** acciones mínimas sin direcciones, coordenadas, claves ni
  contenido personal; historial SQL append-only.
- **HTTP LAB:** autenticación inyectada, solo loopback, desactivado en
  `NODE_ENV=production`, cuerpo limitado, sin CORS público y errores
  estables. Prohibido ponerlo detrás de un gateway LIVE.

## Contrato de integración futuro

- La identidad `actorId` y los permisos de administración llegan de un host
  **confiable**; no deben aceptarse declarados por el frontend.
- La publicación de puntos GPS exige permiso explícito del usuario, verificado
  por la aplicación/host, y una política de retención aprobada.
- M7 puede devolver `covered` y las zonas configuradas, pero **no decide**
  costo de envío, elegibilidad real de repartidores, pedidos, asignaciones
  ni tiempos estimados; estas decisiones pertenecen a módulos externos.
- La exactitud de los radios circulares no sustituye polígonos geográficos
  verificados ni datos viales. No hacer promesas de servicio basadas solo
  en `approximate_circle_v1`.
- Cifrado requiere clave de 32 bytes provista por gestor seguro de secretos;
  ni claves ni direcciones deben aparecer en logs, analítica o telemetría.

## Verificación

La CI propia ejecuta Node.js 24, TypeScript estricto, PostgreSQL 16, migraciones
001–002 protegidas, pruebas unitarias, protección de datos, aislamiento por dueño,
idempotencia y controles negativos en otra base PostgreSQL. El envío de correo,
las rutas y los pagos no forman parte de este módulo.

## Pendientes antes de producción

Proveedor real de geocodificación (si se decide usarlo), validación de zonas
operativas y límites poligonales, precisiones/consentimiento en Android/iOS/PWA,
TLS y autenticación de host, rotación de claves de cifrado, políticas legales
de ubicación, jobs de limpieza y alertas, prevención de abuso, backups y
restore, E2E reales y auditoría de seguridad.

Ninguna migración, integración o habilitación LIVE queda autorizada por
la CI de laboratorio.
