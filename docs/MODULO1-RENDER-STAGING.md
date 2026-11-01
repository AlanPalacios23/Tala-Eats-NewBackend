# TALA EATS CORE v2 — Render Staging · Fase 1 segura

**Objetivo:** verificar despliegue continuo manual desde GitHub a Render Free sin tocar Kali ni datos de producción.

## Modalidad actualmente habilitada
- Fuente: rama `feat/core-v2-pedidos-foundation`, PR #1 permanece DRAFT.
- Tipo: Render Web Service (Node.js 24, plan **Free**, región Oregon).
- Build: `npm install --ignore-scripts --no-audit --no-fund && npm run build`.
- Start: `npm start`.
- Variables: `NODE_ENV=production`, `CORE_V2_RUNTIME=render-staging`,
  `CORE_V2_WRITES_ENABLED=false`, `CORE_V2_HOST=0.0.0.0`.
- `PORT`: proporcionado por Render; no configurar un puerto fijo ni `CORE_V2_PORT`.
- Auto-deploy **OFF**: promover solamente SHA probado y de forma manual.
- No introducir `CORE_V2_DATABASE_URL` ni credenciales hasta completar control de acceso,
  aprovisionamiento de PostgreSQL de pruebas y migraciones seguras.

## Superficie publicada

| Ruta | Esperado | Motivo |
|---|---|---|
| `GET /health` | `200`, `commercialReady:false` | proceso vivo |
| `GET /ready` | `503`, razón de DB no configurada | no anunciar listo el módulo |
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
2. Aprovisionar PostgreSQL exclusivo de pruebas, con migraciones versionadas y
   datos ficticios; jamás reutilizar `tala_node_live` o Stripe LIVE.
3. Preparar prueba de migraciones y scripts con límites de espera, idempotencia y
   rollback. Render Free no admite shell interactivo ni comando pre-deploy de pago.
4. Configurar conexión a PostgreSQL en la misma región, secretos en Render y
   alertas de límite de uso. Verificar respuesta `/ready` de la API real.
5. Habilitar solo después las rutas del Módulo Pedidos bajo el gate de staging,
   ejecutando pruebas E2E en los tres roles.
6. Asegurar que todas las capacidades comerciales y financieras continúen en
   NO-GO. No publicar nunca esta versión como backend de producción.

## Límites económicos y operativos
Los servicios gratuitos se suspenden por inactividad. Las horas y minutos de
compilación se comparten a nivel de workspace. Render Postgres Free tiene un
plazo de 30 días, sin copias de seguridad, por lo que la base se aprovisionará
solo cuando se pueda comenzar a probar su flujo real; nunca guardar datos de clientes.

## Comprobaciones manuales
Después de que Render marque una versión como Live, revisar:
- Que el SHA de GitHub desplegado sea el SHA aprobado.
- Que `GET /health` retorne HTTP 200 y `commercialReady:false`.
- Que `GET /ready` retorne 503 antes de aprovisionar DB.
- Que `/api/v2/orders` y `/api/v2/orders/mine` sigan inaccesibles (404).
- Que no se hayan creado servicios pagos ni se hayan desplegado otros repositorios.
