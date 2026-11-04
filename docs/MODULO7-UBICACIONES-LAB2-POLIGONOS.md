# Tala Eats Core v2 — M7 Ubicaciones, LAB2: polígonos y cobertura segura

**Estado:** laboratorio independiente. **NO-GO LIVE**; PR #9 Draft, sin merge/despliegue.
**Código exclusivo:** `modules/locations`; SQL 001 + 002 solo para `tala_locations_v2_test` / `tala_locations_v2_lab`.

## Propiedad del módulo

M7 posee validación de puntos, cálculo geográfico, zonas, direcciones privadas y snapshots GPS temporales; no posee identidad, pedidos, rutas, ETA, pagos, repartidores ni catálogo comercial. Tampoco se realizan integraciones, FKs o imports de otros módulos.

## LAB2: zonas poligonales independientes

La nueva migración `002_polygon_geofences.sql` introduce `tala_locations_v2.polygon_zones` con `id`, `slug`, `name`, `city`, `vertices` JSONB, estado `draft/active/disabled` y versión CAS. Es distinta de `coverage_zones` circulares: nunca modifica las zonas existentes.

- Solo operador autenticado **por el host**, con `canManageZones=true`, administra polígonos y cambia su estado.
- Creación idempotente con `operationId`, auditoría sin ubicaciones personales, control de versión, activación explícita y rechazo de permisos ajenos.
- Los vértices se suministran como `[{latitude,longitude},...]`, sin repetir el primero al final.
- Entre 3 y 64 vértices, área mínima aproximada 100 m², sin puntos duplicados ni intersecciones de lados no adyacentes.
- Lat/lon finitos, redondeados a 6 decimales. Un polígono no puede exceder 1° de latitud ni longitud; no soporta el antimeridiano ni agujeros. El borde se considera incluido.
- Cálculo plano local para geocerca, no geodesia ni validación oficial de límites municipales. **La asociación `city` la proporciona el operador** y no certifica que todos los vértices estén realmente en el municipio.
- No se incluyen seeds de cobertura, coordenadas inventadas, geocodificación ni resultados de mapas externos.

### Contrato API HTTP en LAB (loopback; inhabilitado en producción)

```http
POST  /v1/locations/polygons
GET   /v1/locations/polygons
PATCH /v1/locations/polygons/:zoneId
GET   /v1/locations/coverage/v2?city=tala&latitude=20.0&longitude=-103.0
```

Ejemplo **sintético**, no ubicación municipal verificada:

```json
{
  "operationId": "<UUID>",
  "slug": "area-operativa-ejemplo",
  "name": "Zona de laboratorio",
  "city": "tala",
  "vertices": [
    {"latitude":20.000,"longitude":-103.000},
    {"latitude":20.000,"longitude":-102.999},
    {"latitude":20.001,"longitude":-102.999},
    {"latitude":20.001,"longitude":-103.000}
  ]
}
```

La creación siempre queda `draft`. Su publicación requiere un cambio `PATCH` por operador con `expectedVersion` y `status: "active"`. Esto no autoriza servicio comercial.

La consulta v2 combina polígonos y círculos de esa misma ciudad en el esquema aislado. Devuelve `covered`, coincidencias de zonas, `model: "operator_defined_geofences_v2"` y `operationallyVerified: false`. La consulta antigua `GET /coverage` conserva su contrato únicamente circular y su modelo `approximate_circle_v1` para compatibilidad.

## Garantías de laboratorio

- Aislamiento PostgreSQL: ninguna tabla o clave foránea de otros módulos, DB guard en migración 002 y transacciones `tx` contra DB autorizada.
- Identidad y privilegios aportados por el host, no aceptados del cuerpo HTTP; limitación de bytes, sin CORS público, cache `private, no-store`, API solo loopback y prohibida con `NODE_ENV=production`.
- La cobertura es **geometría estática declarada por operador**. No calcula ETA, transportabilidad, acceso vial, precio de envío, consentimiento GPS ni elegibilidad real de repartidores.
- Tests: unidad para bordes, orientación, área y polígonos inválidos; PostgreSQL para permisos, versiones, idempotencia, auditoría y círculos+polígonos; HTTP E2E con identidad inyectada y solicitudes maliciosas.

## Bloqueantes LIVE

Revisión documental por operador de geometrías reales y límites de municipios; autenticación/gateway real, cuotas/antifraude, aprobaciones, precisión móvil/consentimiento, rotación de secretos AES-256-GCM para datos privados, expiración programada, protección de datos, observabilidad/alertas, backup/restauración, pruebas de carga y E2E de aplicaciones. M7 no debe absorber las responsabilidades de Pedidos, Logística, Finanzas, Usuarios ni Restaurantes.
