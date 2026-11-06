# Tala Eats Core v2 — RC4 Kali isolated staging LAB

**Estado:** ejecutor preparado, no se ha ejecutado en Kali desde ChatGPT. La rama RC4 se basa en RC3 y conserva las barreras de NO-GO LIVE.

## Objetivo y limitaciones

Ejecutar **en el equipo Kali** pruebas reales del código M1–M11 contra un PostgreSQL 16 **exclusivo del laboratorio**, utilizando una imagen de Node 24 para instalar dependencias y otra ejecución de Node 24 **sin salida de red** para las pruebas integradas.

Este procedimiento **NO** habilita el gateway comercial (actualmente responde 503 en /v2/ready), no prueba Stripe TEST remoto ni webhooks recibidos desde Internet, no conecta las aplicaciones móviles a un backend comercial, no valida wallets retirables, y no debe confundirse con producción lista.

## Aislamiento y precondiciones

- Ejecutar desde la cuenta normal de Kali con acceso a Docker. No usar sudo para ejecutar el script entero.
- Docker Engine, Git, OpenSSL, Bash y al menos 6 GiB libres. No se instala ni actualiza software del servidor.
- Repositorio fuente **separado del árbol vivo**; no situarlo dentro de directorios de `/srv`, PM2, Nginx o PostgreSQL LIVE.
- Docker exclusivo: `tala-corev2-rc4-pg16-lab` con label `com.talaeats.env=core-v2-rc4-lab`; volumen `tala_corev2_rc4_pgdata_lab` con el mismo label. NO utiliza volúmenes, red, usuarios, contraseñas ni bases de producción.
- PostgreSQL 16 corre con `--network none`, **sin -p**, por lo que no se conecta ni a Internet ni a los demás contenedores. La ejecución de Node para QA comparte **exclusivamente** su namespace de red para llegar a `127.0.0.1:5432`; tampoco tiene red externa. El paso anterior de instalación npm sí necesita red para dependencias, sin variables ni conexiones de bases de datos LIVE, y sin ejecutar scripts de ciclo de vida.
- Límites de recursos: PostgreSQL 1 CPU / 1 GiB; cada contenedor Node 2 CPU / 4 GiB. No detiene ni reinicia PM2, Redis, PostgreSQL 18, túneles Cloudflare, PWAs o Nginx.
- El `--apply` exige el SHA exacto del checkout, la rama RC4, árbol tracked limpio y token explícito. Si hay un contenedor/volumen con esos nombres, se rehúsa a sobrescribirlo.
- No cargar `.env` de producción. El script aborta si detecta `.env` en raíz o variables sensibles habituales exportadas.

## Primera ejecución en Kali

```bash
cd "$HOME"
git clone --branch release/core-v2-rc4-kali-isolated-stage --single-branch \
  https://github.com/AlanPalacios23/Tala-Eats-NewBackend.git \
  "$HOME/tala-core-v2-rc4-stage"
cd "$HOME/tala-core-v2-rc4-stage"

bash deploy/kali-core-v2-rc4-isolated-lab.sh --plan

bash deploy/kali-core-v2-rc4-isolated-lab.sh --apply \
  "$(git rev-parse HEAD)" \
  I_APPROVE_CORE_V2_RC4_ISOLATED_LAB_ONLY
```

`--plan` no crea recursos. `--apply` genera contenedores/volúmenes **solo de laboratorio**, realiza migraciones de bases `*_test`, lanza los tests de M1/M2, M3–M10 y M11, y registra el resultado. Los logs se guardan con permisos restringidos en:

`$HOME/tala-core-v2-rc4-evidence/rc4-<SHA>-<id>.log`

No adjuntes información privada o credenciales reales cuando compartas el log. Si una prueba falla, considera el resultado **FAIL** aunque otras hayan pasado.

## Observación y reversión del laboratorio

```bash
bash deploy/kali-core-v2-rc4-isolated-lab.sh --status

# Solo detiene el contenedor de base del laboratorio, no borra sus datos:
bash deploy/kali-core-v2-rc4-isolated-lab.sh --stop \
  I_APPROVE_CORE_V2_RC4_ISOLATED_LAB_ONLY

# SOLO cuando ya se hayan conservado los logs y no haga falta la BD
# de laboratorio: elimina exclusivamente contenedor/volumen etiquetados:
bash deploy/kali-core-v2-rc4-isolated-lab.sh --cleanup \
  I_APPROVE_CORE_V2_RC4_ISOLATED_LAB_ONLY
```

`--cleanup` elimina datos de pruebas, **no** un respaldo real ni un volumen de producción. El script rehúsa eliminar cualquier contenedor o volumen sin su etiqueta específica.

## Qué queda abierto después de PASS

1. Gateway real M4/M9 con permisos de Cliente, Negocio, Repartidor y ADMIN; sin un bypass de laboratorio, con autorización por recurso y sesión única.
2. Checkout definitivo M1/M6 con reserva duradera, compensación, cancelación, timeout y reinicio forzado.
3. Stripe **remoto TEST** en staging aislado con firma oficial verificada, flujo 3DS/webhook/reembolso e idempotencia, sin claves LIVE y sin transferencias.
4. E2E físico/controlado de entrega con apps de usuarios, restaurantes y repartidores y Finanzas M3, saldos retenidos, cash custody y conciliación.
5. Separado de este test LAB: respaldo real verificado y restauración **en una instancia aislada**, pruebas de carga, rollback, observabilidad y checklist para iniciar canary.

El resultado esperado de esta fase es **evidencia de pruebas ejecutadas dentro de Kali**, no un cambio del servicio comercial actual. El último paso GO LIVE debe ser otra release, explícitamente aprobada tras cerrar G1–G9 en [issue #20](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/issues/20).

## Evidencia GitHub

- [RC3 canónico PR #21](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/21)
- [Bloqueos G1–G9](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/issues/20)
- [Documentación arquitectónica](../docs/CORE-V2-RC3-CANONICAL.md)

No confundir un smoke/QA offline con la validación de Stripe TEST remoto, autenticación del gateway público o una sustitución completa del backend LIVE.
