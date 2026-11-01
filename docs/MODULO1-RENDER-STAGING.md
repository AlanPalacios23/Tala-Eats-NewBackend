# TALA EATS CORE v2 — Render Staging · Fase 1 segura

**Objetivo:** verificar despliegue continuo manual desde GitHub a Render Free sin tocar Kali ni datos de producción.

## Modalidad actualmente habilitada
- Fuente: rama `feat/core-v2-pedidos-foundation`, PR #1 permanece DRAFT.
- Tipo: Render Web Service (Node.js 24, plan **Free**, región Oregon).
- Build configurado en Blueprint: `npm install --include=dev --ignore-scripts --no-audit --no-fund && npm run build`.
- Start luego de aplicar Blueprint: `node scripts/render-staging-init.mjs && npm start` (migraciones 001–007 idempotentes en DB exclusiva de pruebas).
- Variables: `NODE_ENV=production`, `CORE_V2_RUNTIME=render-staging`,
  `CORE_V2_WRITES_ENABLED=false`, `CORE_V2_HOST=0.0.0.0`.
- `PORT`: proporcionado por Render; no configurar un puerto fijo ni `CORE_V2_PORT`.
- Auto-deploy **OFF**: promover solamente SHA probado y de forma manual.
- PostgreSQL Free existente: `tala-eats-core-staging-db`, base lógica `tala_eats_core_staging_db`, Oregon, acceso externo cerrado.
- `CORE_V2_DATABASE_URL` solo desde `fromDatabase.connectionString` de Render; nunca copiar contraseñas a GitHub.
- **No se aplica automáticamente:** el usuario debe revisar y aplicar `render.yaml` en Render > New > Blueprint, escogiendo la rama indicada.
- El inicializador exige ID exacto de servicio, DB y región privada por hostname; registro de checksums, ejecuta exclusivamente 001–007 y rechaza esquemas ajenos o parcialmente migrados.

## Superficie publicada

| Ruta | Esperado | Motivo |
|---|---|---|
| `GET /health` | `200`, `commercialReady:false` | proceso vivo |
| `GET /ready` | Antes de aplicar: `503` sin DB; después de conectar y migrar: `200` y `commercialReady:false` | esquema operativo sin autorización comercial |
| `GET /api/v2/orders/mine` | `404` | rutas comerciales no montadas |
| `POST /api/v2/orders` | `404` | no se puede crear pedidos reales |
| Otras rutas `/api/v2/*` | `404` | no exponer LAB público |

**No es una instalación funcional del flujo completo Pedidos.** Sirve para
verificar conexión de GitHub, compilación, arranque, puertos, logs y salud de servicio.
El diseño actual no permite escribir pedidos desde internet: esa restricción no se
debe eliminar ni cambiar a `isolated-lab` en Render.

## Antes de implementar staging funcional con datos sintéticos
1. Diseñar autenticación específica y protección de un entorno compartido de QA,
   sin credenciales embebidas en apps móviles ni clientes del público.
2. PostgreSQL Free de pruebas ya fue creado y aislado. Aplicar el Blueprint de Render para conectar y ejecutar el inicializador por red privada; nunca reutilizar `tala_node_live` o Stripe LIVE.
3. Validar los checksums e integridad de las siete migraciones; Render Free no incluye el comando pre-deploy de web services pagos, así que el arranque de staging tiene un inicializador separado y restringido.
4. Confirmar que `/ready` devuelve `200` tras la inicialización y que `commercialReady` continúa `false`; revisar alertas de uso de Render.
5. Habilitar solo después las rutas del Módulo Pedidos bajo el gate de staging,
   ejecutando pruebas E2E en los tres roles.
6. Asegurar que todas las capacidades comerciales y financieras continúen en
   NO-GO. No publicar nunca esta versión como backend de producción.

## Límites económicos y operativos
Los servicios gratuitos se suspenden por inactividad. Las horas y minutos de
compilación se comparten a nivel de workspace. La DB Render Postgres Free se creó el 2026-11-01 y expira el 2026-12-01
(sin respaldos gestionados). Nunca guardar datos de clientes.

## Comprobaciones manuales
Después de que Render marque una versión como Live, revisar:
- Que el SHA de GitHub desplegado sea el SHA aprobado.
- Que `GET /health` retorne HTTP 200 y `commercialReady:false`.
- Que `GET /ready` retorne 503 antes de aplicar la conexión y 200 tras ejecutar las migraciones de staging.
- Que `/api/v2/orders` y `/api/v2/orders/mine` sigan inaccesibles (404).
- Que no se hayan creado servicios pagos ni se hayan desplegado otros repositorios.
