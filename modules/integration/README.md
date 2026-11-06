# TALA EATS CORE v2 — M11 Integración del monolito

M11 es un **módulo independiente** que ensambla los diez dominios M1–M10 en un único proceso de **laboratorio** y verifica que los puntos de entrada reales existan. No edita ninguna de las ramas originales y no fusiona `main`.

**Branch:** `feat/core-v2-monolito-integracion`, desde `main`. Estado: desarrollo LAB1 con CI de ensamblaje, sin despliegue.

## Propiedad de M11

- **Manifiesto de procedencia:** `upstreams.json` fija nueve commits, que contienen diez módulos. M1 y M2 comparten el checkout M2, el cual es descendiente de M1.
- **Ensamblaje real:** `src/assembly.ts` importa las factorías HTTP reales de M1, M4–M10 y las funciones internas reales de M2 y M3; no son puertos simulados ni proxies HTTP entre procesos.
- **Un único gateway:** un solo servidor Node HTTP escucha exclusivamente en `127.0.0.1`. Las factorías originales permanecen sin abrir sus puertos.
- **Fail-closed:** solo ofrece health del integrador y health delegado (excepto M4, que requiere una DB de tasa aún no ensamblada). **No hay endpoint comercial activado**.
- **No se reutilizan credenciales:** el Pool es inaccesible intencionalmente y las claves constructoras son efímeras. Ningún evento real, wallet, Stripe o transferencia puede tocarse.
- **Verificación CI:** Node 24, TypeScript estricto, lectura exacta de nueve SHAs, ancestría M1/M2, pruebas E2E del gateway, aislamiento de escritura y prohibición de arranque de producción.

## Ejecución aislada

```bash
cd modules/integration
npm install --ignore-scripts --no-audit --no-fund
npm run check
```

Sin los nueve checkouts fijados, solo se ejecutan las pruebas estáticas y de cierre seguro. En GitHub Actions el gate `M11_REQUIRE_SOURCES=1` obliga a **importar y ejecutar el código real** de los diez módulos; no se permite pasar CI omitiendo el ensamblaje. No existe un comando de producción.

`src/assembly.ts` exporta `assembleLabMonolith(manifest, sourceRoot)`, `listenLocalOnly(assembly)` y `assembly.close()`. Para que funcionen se requiere `M11_RUNTIME=isolated-lab` y un `NODE_ENV` distinto de `production`.

## Rutas habilitadas

```text
GET /v2/health   -> 200, domainsLoaded=10, commercialReady=false
GET /v2/modules  -> 200, inventario 10/10
GET /v2/ready    -> 503 hasta que se complete integración comercial
GET /api/v2/health -> M1, delegación real
GET /v1/{notifications,restaurants,locations,payments,security,analytics}/health
                  -> delegación real desde mismo proceso Node
GET /v1/users/health -> 503; DB privada de cuotas todavía no ensamblada
* cualquier otra ruta -> 503 M11_BUSINESS_ROUTES_DISABLED
```

**Siguiente trabajo requerido:** acordar contratos de identidad M4/M9, unificar esquema y migraciones de staging sin eliminar guardas, ordenar eventos con outbox durable, conectar pagos verificados de M8 a finanzas M3, reproducir flujo M1→M2, y conectar M5/M10. Crear después CI de integración transaccional y pruebas E2E de las cuatro apps.

Ver [arquitectura y gates de M11](../../docs/MODULO11-INTEGRACION-MONOLITO.md) para separar pruebas de ensamblaje de pruebas comerciales.

**Importante:** la rama `main` y el backend Kali existente no se han modificado. No existe garantía de disponibilidad comercial del nuevo monolito por el simple hecho de importar 10 módulos.
