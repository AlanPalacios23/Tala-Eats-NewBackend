# Tala Eats Core v2 — RC5, **un solo checkout + PM2**, sin Docker

**Infraestructura esperada Kali:** backend actual LIVE gestionado por PM2; PostgreSQL 18 existente; Node 24 para el nuevo Core v2. **No se cambia** ningún proceso PM2 actual, puerto público, Nginx, Cloudflare, Redis ni base LIVE.

## Corrección del procedimiento

El RC4 usaba contenedores Docker; **no utilizar RC4 en Kali**. La rama RC5 elimina el script, las workflows y la guía Docker heredadas. En Kali mantendremos **una sola carpeta** de código Core v2, actualizable con Git; los tags y PR históricos quedan en GitHub, no requieren clones separados.

| Componente | Disposición RC5 |
| --- | --- |
| Backend actual LIVE | PM2 existente y PostgreSQL 18 actuales: **intactos** |
| Core v2 | Un único Git checkout reutilizable: `~/tala-core-v2-stage` |
| PM2 de staging | App `tala-core-v2-stage`, `PM2_HOME=~/.pm2-tala-core-v2-stage` aislado del daemon LIVE |
| Endpoint staging | `http://127.0.0.1:18286/v2/health` (únicamente loopback) |
| PostgreSQL de prueba | **Instancia temporal nueva** de los binarios PostgreSQL 18 existentes, puerto local 18432, databases `*_test`; se cierra y borra tras los tests |
| Contenedores Docker | **Ninguno** |
| Stripe LIVE/TEST remoto | **Deshabilitado/no probado** |
| Prueba de cliente real o app pública | **No habilitada todavía** |

La instancia temporal PostgreSQL **no copia** ni lee los datos de LIVE: se inicializa vacía con `initdb` en `~/.cache/tala-corev2-pg18.XXXXXXXX`, contraseña aleatoria, SCRAM, red `127.0.0.1` solamente y se destruye al finalizar la suite. Esta instancia usa disco y recursos durante las pruebas, pero **no agrega otra instalación o copia del backend**. Por seguridad, no reutilizamos la base de producción para hacer migraciones.

## Requisitos y verificación

- Trabajar con usuario Linux normal (no root), propietario de la carpeta Git y con permiso de ejecutar binarios PG18 locales.
- Node.js **24**, npm, Git, PM2 y PostgreSQL **18 binaries** en `/usr/lib/postgresql/18/bin`. Si el Node de Kali aún no es 24 o esos binarios no están, el script **aborta**, sin instalar ni cambiar el runtime LIVE.
- Disponer de recursos para la suite temporal. No ejecutar en hora punta sin revisar CPU/RAM/disco; la suite puede consumir recursos de la misma máquina.
- `--plan` solamente informa; no modifica la infraestructura.
- Cada operación mutante requiere SHA exacto del Git checkout y token `I_APPROVE_CORE_V2_PM2_ISOLATED_STAGE_ONLY`.
- No usar `sudo` para arrancar el script, ni cargar las variables/archivos `.env` del servicio actual.

## Un solo checkout — mantener si ya existe

Si **ya tienes una carpeta Core v2 de staging**, no clones otra. Inspecciona su remoto y estado, reutilízala y cambia a RC5 allí cuando no contenga modificaciones sin guardar:

```bash
cd "$HOME/tala-core-v2-stage"       # Usa TU carpeta actual de staging, si ya existe
git remote -v
git status --short
git fetch origin
git switch release/core-v2-rc5-pm2-single-stage || \
  git switch --track origin/release/core-v2-rc5-pm2-single-stage
git pull --ff-only
```

**Solo si no tienes ningún checkout Core v2**, clona **una vez** en esa carpeta:

```bash
git clone --branch release/core-v2-rc5-pm2-single-stage --single-branch \
  https://github.com/AlanPalacios23/Tala-Eats-NewBackend.git \
  "$HOME/tala-core-v2-stage"
cd "$HOME/tala-core-v2-stage"
```

## Inspección sin cambios

```bash
node --version
pm2 --version
/usr/lib/postgresql/18/bin/postgres --version
bash deploy/kali-core-v2-pm2-stage.sh --plan
```

## Pruebas integradas M1–M11 (sin Docker)

```bash
cd "$HOME/tala-core-v2-stage"
bash deploy/kali-core-v2-pm2-stage.sh \
  --test "$(git rev-parse HEAD)" \
  I_APPROVE_CORE_V2_PM2_ISOLATED_STAGE_ONLY
```

- Revisa SHA, rama, remoto y `.env`.
- Instala dependencias npm **en la misma carpeta**; no genera instalaciones adicionales del backend.
- Crea PostgreSQL 18 temporal local en el puerto **18432** con bases `*_test`; aplica migraciones de los dominios.
- Ejecuta pruebas M1/M2, M3–M10, M11 y validación financiera sin datos reales.
- Al finalizar, incluso ante errores ordinarios, detiene el PostgreSQL temporal y limpia esa carpeta de prueba. Conserva el **log** en `~/tala-core-v2-evidence/`. Si una limpieza falla, el script lo indica: no borrar manualmente datos antes de confirmar que el proceso está detenido.

**Esto no afecta ni crea bases dentro del PostgreSQL LIVE.** Si alguna prueba falla, se considera FAIL y no se inicia el proceso de staging.

## Encender el gateway de diagnóstico bajo PM2

Una vez pasen las pruebas:

```bash
bash deploy/kali-core-v2-pm2-stage.sh \
  --start "$(git rev-parse HEAD)" \
  I_APPROVE_CORE_V2_PM2_ISOLATED_STAGE_ONLY

bash deploy/kali-core-v2-pm2-stage.sh --status
curl --noproxy '*' http://127.0.0.1:18286/v2/health
curl --noproxy '*' -i http://127.0.0.1:18286/v2/ready
```

**Esperado:** health HTTP 200 con 10 módulos cargados; ready **HTTP 503**; pedidos, login, pagos y endpoints comerciales **HTTP 503**. El servidor carga los factories reales de los módulos pero utiliza un pool PostgreSQL deliberadamente inerte. No hay clave Stripe ni secreto de producción.

**Nunca añadir proxy Nginx, túnel Cloudflare o firewall público para 18286.** No usar PM2 `save`/startup del sistema para la instancia de pruebas.

Detener solo la app de diagnóstico RC5:

```bash
bash deploy/kali-core-v2-pm2-stage.sh \
  --stop I_APPROVE_CORE_V2_PM2_ISOLATED_STAGE_ONLY
```

Los procesos PM2 LIVE no se modifican porque RC5 usa `PM2_HOME` propio; **no** utiliza `pm2 delete all`, `pm2 restart all` ni `pm2 kill` global. Los resultados de la suite no eliminan la única copia Git; podrás actualizarla para el siguiente RC.

## Qué pruebas siguen abiertas

RC5 es para **verificar integración y salud dentro de Kali**; no declara que una app haga pedidos reales. Los siguientes cambios de código seguirán siendo necesarios: gateway autenticado M4/M9 con acceso por recurso, checkout y holds M1/M6, prueba Stripe TEST **remota**, entrega M2/M7, contabilidad M3/M8 y apps completas en staging. Los gates G1–G9 siguen abiertos en [issue #20](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/issues/20).

**No se ha ejecutado Kali desde esta conversación**, ya que la conexión disponible a GitHub no provee acceso SSH; los pasos deben ejecutarse desde el terminal del servidor y devolverse los resultados.
