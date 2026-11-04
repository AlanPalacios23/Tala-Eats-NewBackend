# TALA EATS CORE v2 — Módulo 7: Ubicaciones

**Independiente · LAB3 · NO-GO comercial.** 
No importa ni consulta módulos Pedidos, Logística, Finanzas, Usuarios,
Notificaciones, Restaurantes o el backend anterior.

## LAB3: permisos GPS y privacidad propia

- La publicación de un snapshot exige `consent:true` **y** el permiso
  `locationConsentPurposes` aportado por el host autenticado. Los propósitos
  `foreground` y `active_delivery` tienen permisos distintos; el cuerpo
  HTTP no puede asignarse esos permisos.
- `DELETE /v1/locations/privacy/data` borra transaccionalmente las direcciones
  personales, snapshots GPS y recibos `place.create` de la misma identidad,
  conservando exclusivamente una auditoría mínima sin coordenadas.
- Los snapshots GPS quedan sincronizados con el borrado por usuario para no
  publicar datos concurrentemente durante la eliminación.
- Retención en WAL/backups, rotación de claves, baja de permisos del host,
  purga automática y consentimiento real de las apps son **gates externos**.

[Seguridad y contrato de privacidad LAB3](../../docs/MODULO7-UBICACIONES-LAB3-PRIVACIDAD.md).

## LAB2: zonas poligonales independientes

La migración `002_polygon_geofences.sql` agrega polígonos definidos por un
operador confiable, con 3–64 vértices, límites de tamaño, rechazo de
autointersecciones, pertenencia con borde incluido, control de versiones,
idempotencia y auditoría. Solo se habilitan mediante activación explícita.

La consulta **nueva** `GET /v1/locations/coverage/v2` combina zonas activas
circulares y poligonales con el mismo municipio declarado, devolviendo
`model=operator_defined_geofences_v2` y
`operationallyVerified=false`. No valida calles, cobertura realmente operativa,
repartidores ni tarifas. La consulta antigua `GET /coverage` sigue siendo
solo circular por compatibilidad.

Gestión privada del operador, API LAB loopback:
`POST/GET /v1/locations/polygons` y
`PATCH /v1/locations/polygons/:zoneId`.

[Documentación y límites de LAB2](../../docs/MODULO7-UBICACIONES-LAB2-POLIGONOS.md).

## Lo que resuelve este módulo

| Dominio M7 | Contrato aislado |
| --- | --- |
| Geometría | Validación de latitud/longitud y distancia Haversine en metros |
| Cobertura | Zonas circulares configuradas por operador; estados draft/active/disabled; control optimista de versiones |
| Direcciones personales | Máximo 15 lugares por cuenta; AES-256-GCM por registro con AAD; predeterminada única; redacción al borrar |
| Ubicación temporal | Snapshot GPS foreground/active_delivery cifrado; consentimiento obligatorio; caducidad a los 120 s |
| Privacidad | Solo identidad autenticada puede leer sus datos; sin historial de tracking, tokens ni direcciones en auditoría |
| Resiliencia | Idempotencia, serialización de cambios por usuario, transacciones y base PostgreSQL descartable exclusiva |
| API | Servidor HTTP solo loopback de LAB con identidad y privilegios inyectados por host |

**Precisión:** una zona circular es solo una aproximación cartográfica,
NO prueba una calle transitable, elegibilidad real de repartidores,
costo de envío, disponibilidad operativa ni promesa de entrega.

**Municipios permitidos:** Tala, Ameca, Ahualulco, Tequila, Cuisillos,
Amatitán. Las zonas y sus puntos se registran manualmente con datos
verificados; no hay una precarga de geocodificaciones inventadas.

## Uso interno

```ts
import {randomBytes} from 'node:crypto';
import {PrivateLocationCipher} from './src/crypto.js';
import {checkCoverage} from './src/zones.js';
import {createPlace} from './src/places.js';

// El host aporta pool con la base aislada y clave desde el gestor de secretos.
const cipher = new PrivateLocationCipher(randomBytes(32)); // SOLO ejemplo LAB.
const actor = {actorId: '<UUID autenticado por host>'};
const coverage = await checkCoverage(pool, {
  city: 'tala',
  point: {latitude: 20.65, longitude: -103.70}
});
// En producción usar una clave persistente rotada mediante un plan formal.
```

No almacenar el secreto en el repositorio ni generar claves nuevas por
proceso al conectarse a la misma base: se perdería el descifrado.

## API de laboratorio

El servidor de `src/http-lab.ts` exige host-injected `authenticate(request)`,
solo responde en loopback y se bloquea con `NODE_ENV=production`.

- `GET /v1/locations/health`
- `GET /v1/locations/coverage?city=tala&latitude=...&longitude=...`
- `POST/GET /v1/locations/zones` — solo operador verificado.
- `PATCH /v1/locations/zones/:zoneId` — solo operador, versión CAS.
- `POST/GET /v1/locations/places` — cuenta autenticada.
- `PATCH /v1/locations/places/:placeId` — versión CAS.
- `PUT /v1/locations/places/:placeId/default` — predeterminada única.
- `DELETE /v1/locations/places/:placeId` — redacción y soft delete.
- `POST /v1/locations/snapshot` — posición propia, consentimiento true **y permiso concedido por host para ese propósito**.
- `GET/DELETE /v1/locations/snapshot/:purpose` — lectura o revocación propia.
- `DELETE /v1/locations/privacy/data` — eliminación de todos los datos personales de localización del propio usuario (body `{}`).

La limpieza automática se realiza cuando el host llama a 
`pruneExpiredSnapshots(pool)` con ejecución controlada; **no existe worker
programado todavía**. Esto es indispensable antes de integrar ubicaciones GPS reales.

## Pruebas

```bash
cd modules/locations
npm install --ignore-scripts
npm run check
```

Los tests PostgreSQL requieren `LOCATIONS_CI_URL` apuntando a
`tala_locations_v2_test` con migraciones 001 y 002 aplicadas. CI prepara y
descarta PostgreSQL 16, verifica TypeScript, aislamiento de imports,
propiedad de datos, encriptación, vencimientos, idempotencia y que una
migración a una base ajena falle.

[Arquitectura y límites comerciales](../../docs/MODULO7-UBICACIONES-ARQUITECTURA.md)
