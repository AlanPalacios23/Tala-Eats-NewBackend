# Tala Eats Core v2 — M7 LAB3: consentimiento GPS y borrado de datos propios

**Estado:** M7 aislado en laboratorio, **NO-GO LIVE**. El módulo no implementa sesiones, órdenes, despacho, mapas, tarifas ni pagos. No existe integración con el backend anterior ni con Kali.

## Publicación GPS: dos pruebas independientes

Para `putLocationSnapshot`, además de `consent:true` suministrado en la solicitud, el host debe aportar un `Actor` confiable con `locationConsentPurposes`, según el tipo de ubicación:

| Propósito | Condición del host | Retención |
| --- | --- | --- |
| `foreground` | Consentimiento específico para compartir la posición en primer plano | 120 segundos |
| `active_delivery` | Autorización del host para ubicación durante una entrega activa, **sin comprobar pedidos dentro de M7** | 120 segundos |

- `locationConsentPurposes` **no es aceptado del cuerpo HTTP**: solo lo asigna el mecanismo externo `authenticate(request)` del host.
- Ausencia de permiso o propósito diferente: **`M7_LOCATION_GRANT_REQUIRED`**, sin escribir a la base.
- Ausencia de `consent:true`: **`M7_CONSENT_REQUIRED`**.
- M7 no emite ni valida tokens de identidad ni confirma entregas. Antes de LIVE un gateway de confianza debe gestionar el permiso explícito y su revocación, con contratos ajenos separados.
- Las escrituras GPS adquieren el mismo bloqueo por propietario que el CRUD de direcciones para serializar borrados de privacidad.
- La posición se cifra con AES-256-GCM asociando dueño y propósito, sin historial persistido; la lectura compara `expires_at` con el reloj de DB.
- La limpieza física de snapshots caducados requiere que un host externo programe `pruneExpiredSnapshots()`; **no hay tarea programada dentro de M7**.

## Borrado de la información geográfica propia

La operación `eraseMyLocationData(pool,actor)` y su endpoint de LAB:

```http
DELETE /v1/locations/privacy/data
Content-Type: application/json
Authorization: Bearer <credencial suministrada por host>

{}
```

En **una sola transacción**, bloqueada por el propietario autenticado:
1. Elimina sus filas de `saved_places`, incluyendo direcciones eliminadas previamente.
2. Elimina sus snapshots GPS activos/caducados.
3. Elimina recibos de idempotencia `place.create` (hashes de contenido privado).
4. Registra auditoría mínima `location.erase_all`, **sin** direcciones, coordenadas ni nombre de calle.

No recibe `actorId` del cuerpo ni permite borrar datos de otra cuenta. La respuesta contiene solo contadores de filas eliminadas. Es idempotente en el estado de los datos (segunda llamada no tiene elementos que eliminar).

**Límite importante:** la eliminación de filas no garantiza purga inmediata de WAL, réplicas o copias de respaldo, y la auditoría pseudónima se retiene hasta que exista política de conservación. Se requiere un procedimiento de retención y eliminación verificable antes de producción. Si un cliente reenvía la misma creación de dirección después del borrado, puede crear una nueva dirección porque el recibo de idempotencia se eliminó deliberadamente.

## Validación LAB3

`tests/privacy-lab3-db.test.ts` prueba permisos por propósito, rechazo ante consentimiento insuficiente, borrado completo, independencia de otro usuario, ausencia de registros en tablas M7, purga de recibos privados, auditoría mínima y API HTTP de loopback con rechazos 401/400/415.

El pipeline M7 mantiene Node 24, PostgreSQL 16, TypeScript estricto, migraciones LAB SQL 001–002, privacidad/cifrado, geofences circulares y poligonales, control de bases ajenas e independencia de importaciones.

## NO-GO LIVE (integraciones externas)

El host aún debe proporcionar identidad real y autorizaciones/revocación confiables; gestión persistente y rotación de claves; permisos Android/iOS/PWA y consentimientos legales verificables; eliminación de backups/WAL según política, limpieza GPS programada, métricas/alertas, cuota/antiabuso, seguridad TLS, precisión/validación de polígonos y pruebas E2E con dispositivos. Los contratos con otros módulos no están implementados y **no se incluirán dentro de M7**.
