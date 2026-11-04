# TALA EATS CORE v2 — Módulo 7: Ubicaciones

**Independiente · LAB1 · NO-GO comercial.** 
No importa ni consulta módulos Pedidos, Logística, Finanzas, Usuarios,
Notificaciones, Restaurantes o el backend anterior.

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
- `POST /v1/locations/snapshot` — posición propia, consentimiento true.
- `GET/DELETE /v1/locations/snapshot/:purpose` — lectura o revocación propia.

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
`tala_locations_v2_test` con migración 001 aplicada. CI prepara y
descarta PostgreSQL 16, verifica TypeScript, aislamiento de imports,
propiedad de datos, encriptación, vencimientos, idempotencia y que una
migración a una base ajena falle.

[Arquitectura y límites comerciales](../../docs/MODULO7-UBICACIONES-ARQUITECTURA.md)
