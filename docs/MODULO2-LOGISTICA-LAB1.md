# Módulo 2 · LOGÍSTICA LAB1 — capacidad, presencia y GPS

Estado: **LAB inicial, NO-GO comercial**, dependiente del PR de Pedidos. No se desplegó en Kali ni se activó en Render.

## Contratos implementados

- `GET /api/v2/driver/logistics`: presencia, versión, entregas activas, capacidad=1 y frescura del último GPS. Solo identidad de conductor autenticada.
- `POST /api/v2/driver/presence`: JSON `{online:boolean, expectedVersion:string, commandKey:string}`, versión optimista, clave durable de idempotencia, evento outbox sin datos sensibles; rechaza pasar a offline con una entrega en estados `assigned`, `picked_up` o `on_the_way`. Al desconectar, elimina el último GPS.
- `POST /api/v2/driver/location`: `{latitude:number,longitude:number,accuracyMeters:integer,sequence:string,observedAt:ISO-offset}`. Solo conductor aprobado, online y con entrega activa. Retiene **un último punto** por conductor, no un recorrido ni IP. Secuencias monótonas, ventana de edad ±120/15 segundos, exactitud máxima 100m, repetición segura, throttling SQL/por perfil y velocidad groseramente implausible. Esto **NO** constituye GPS antifraude certificado.
- `POST /api/v2/driver/orders/:id/claim` (Pedidos): ahora bloquea también el perfil del repartidor para serializar reclamaciones de pedidos distintos. Solo **una entrega activa** por repartidor. Reintentos originales siguen siendo idempotentes aun si el repartidor pasó a offline.
- `GET /api/v2/driver/available`: oculta ofertas mientras ese repartidor tiene otra entrega activa; la mutación sigue haciendo el control definitivo bajo transacción.

## Aislamiento y dependencia

La migración **008_logistics_lab.sql** debe aplicarse después de 001–007 a **PostgreSQL descartable** de laboratorio. CI lo hace sobre `tala_core_v2_test`. Un servidor local con escrituras exige esta migración y falla al arrancar si falta.

Se conserva el `CORE_V2_RUNTIME=isolated-lab`, `CORE_V2_WRITES_ENABLED=true`, `NODE_ENV!=production`, localhost y base explícitamente autorizada. El ambiente Render continúa con `CORE_V2_WRITES_ENABLED=false` y únicamente las rutas públicas de health; no conectar ni migrar Render para Logística en esta entrega. `render-staging-init.mjs` sigue fijado deliberadamente en migraciones 001–007 para el plan pendiente del módulo Pedidos.

Las aplicaciones PWA, Stripe, wallets, pagos reales y Kali **no se modificaron**.

## Pruebas

`tests/logistics-lab.test.mjs`: dos órdenes listas reclamadas concurrentemente por el mismo conductor, límite de capacidad 1, aislamiento de roles, GPS antes/durante/después del trabajo, validación de secuencias, replay, rechazo a offline con entrega activa, entrega real del flujo LAB con PIN y dos comprobantes de efectivo, idempotencia de presencia y eventos outbox.

## Siguiente fase, NO implementada

1. Asignación administrada y recuperación de conductor desconectado con comprobación de custodia; no liberar automáticamente un pedido ya recogido.
2. Coordenadas del comercio y de entrega con consentimiento/base legal, control de precisión y retención; GPS de la PWA contra dispositivos reales.
3. ETA sobre motor de rutas y tráfico real **sin inventar tiempos**; cálculo de cercanía y despacho con reglas de zona.
4. Tratamiento de emergencias, carreras de cancelación vs asignación y recuperación de pedido; telemetría, cola de eventos y observabilidad.
5. Staging E2E independiente con conexión privada y pruebas de seguridad antes de cualquier candidato LIVE.

**GO** solo para pruebas locales y revisión en draft. **NO-GO** comercial hasta comprobar integridad de Pedidos/Logística/Finanzas, seguridad de GPS, protección de datos, rollout reversible y compatibilidad real de las PWAs.
