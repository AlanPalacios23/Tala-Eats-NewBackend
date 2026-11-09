# Programa comercial — Fundadores Tala Eats + Tala Eats Crece

**Inicio propuesto:** piloto de hasta 10 comercios en Tala, Jalisco.  
**Estado al 8/nov/2026:** propuesta comercial y LAB interno **no publicado**, sin aprobación de plazas, campañas, descuentos ni acciones LIVE. Core v2 mantiene NO-GO comercial (issue #20).  
**Arquitectura:** sigue siendo el **mismo monolito modular Node/PM2**; no se crea otro backend, servicio o clon en Kali.

## Propuesta de valor

> Tú te encargas de tu negocio. Tala Eats te ayuda a conseguir clientes, recibir pedidos, administrar tus ventas y entregar tus productos.

**Tala Eats Crece** es el quinto pilar del programa de beneficios: acompañamiento comercial, asesoría, mejores prácticas y recomendaciones sustentadas en datos verificables; no implica promesa de resultados. Complementa 1) identidad profesional, 2) difusión local, 3) operación digital, 4) finanzas transparentes.

La plataforma **no exige exclusividad**, no cobra alta ni mensualidad fija en el plan inicial propuesto, y los comercios pueden usar otros canales de venta. Se necesita aceptación de condiciones, términos de servicios, privacidad, reparto y conciliación antes del alta.

## Política económica sin sorpresas

| Concepto | Propuesta piloto |
| --- | --- |
| Alta de negocio | $0 MXN |
| Cuota mensual fija | $0 MXN |
| Comisión estándar a comercio | **17 %** sobre productos según versión de política en el pedido |
| Tarifa de servicio a cliente | **7 %** de productos, sin tope fijo, mostrada en checkout |
| Comisión sobre propinas | **0 %** |
| Envío | Según tarifa real aprobada y cotización del backend |
| Exclusividad | No obligatoria |
| Ventas garantizadas | **Ninguna** |

**No editar M1, M3 ni M8 para conceder descuentos** desde el panel Crece. Una promoción futura exige política por versión, aceptación del negocio, cálculo reproducible de centavos, auditoría, reintegro y reconciliación. Las políticas de pedidos anteriores no deben cambiar.

## Programa Fundadores — hasta 10 negocios

Propuesta sujeta a recursos del piloto:
1. Alta y configuración asistida del catálogo y horarios.
2. Hasta 10 fotografías originales de productos por negocio, con autorización para su publicación.
3. Hasta 30 días de presencia destacada de lanzamiento: reglas y cupos publicados, sin fabricar posición ni alcance.
4. Material QR y enlace público a tienda, solo cuando la URL oficial de clientes y publicación estén verificadas.
5. Capacitación práctica con pedidos, cancelaciones, inventario y wallet de lectura.
6. Orientación sobre promociones y mejora del menú durante el piloto.
7. Atención local por canal oficial y trazabilidad de incidencias.

Una **solicitud de interés NO reserva plaza**. La promoción destacada depende de capacidad, aceptación y aprobación. No activar créditos publicitarios ni regalos sin presupuesto/cuentas autorizadas.

## 27 beneficios — clasificación honesta

Los beneficios con estado **Disponible** son prestaciones de la PWA existentes, sujetas a rol y backend. **Asistido** requiere trabajo humano y confirmación de cobertura. **Planeado** no se debe presentar como habilitado.

| Pilar | Disponible en app (sujeto a verificación) | Asistido | Planeado |
| --- | --- | --- | --- |
| Identidad profesional | Perfil público, QR y enlace condicionado | Alta/catálogo, fotos, kit | — |
| Visibilidad local | Compartir por WhatsApp/Instagram usando enlace | Destacado Fundadores, redes | Cupones, campañas de temporada |
| Operación | Pedidos, menú/inventario, abrir/cerrar, preparación | — | Pedidos programados, combos, múltiples sucursales |
| Finanzas | Rendimiento histórico, exportación de pedidos, wallet de solo lectura | Política transparente | — |
| Tala Eats Crece | Recomendaciones con métricas válidas | Acompañamiento local | Fidelidad, pedidos de empresas/eventos, reconocimientos |

Total: 27 entradas de catálogo, versionadas en la PWA. Los reportes no son dinero retirable; solo M3/M8 y el proveedor pueden acreditar saldos.

## Camino real del restaurante

**1. Descubrimiento** → el negocio ve página de Fundadores/Crece pública sin requerir iniciar sesión.  
**2. Interés** → asesor explica tarifa y alcance, verifica que el negocio quiere participar. La página pública NO recibe ni almacena solicitudes porque aún no hay endpoint consentido/seguro.  
**3. Identidad y contrato** → ADMIN autenticado en M4, permiso M9 específico, acuerdo/privacidad y verificación de tienda por M6. **Pendiente.**  
**4. Alta M6** → tienda, horarios, menú, fotos con permiso y validación de disponibilidad. **Funciones existentes; falta certificar el flujo de afiliación completo.**  
**5. Configuración** → el comercio confirma su disponibilidad y permisos de pedidos.  
**6. Acompañamiento** → capacitación y kit de difusión; QR solo si dominio y página realmente funcionan.  
**7. Primer pedido** → cliente confirma, backend valida pago/cash, restaurante prepara, repartidor recoge, entrega con PIN, finanzas concilia. **Bloqueado en Core v2 hasta G3–G9.**  
**8. Seguimiento** → métricas reales por comercio; recomendaciones sin inventar top-products, periodos o tasas.

## Código añadido al monolito

- `modules/integration/migrations/008_crece_founders_lab.sql` crea una cola de **interés interno** de Fundadores en la base `tala_integration_v2_test`; rechaza DBs LIVE o nombres ajenos.
- `modules/integration/adapters/crece-founders-lab.ts` verifica pertenencia actual del personal a tienda mediante **M6 real**, valida UUID y guarda una solicitud idempotente y su evento auditable; no expone HTTP, no otorga plaza, no altera comisión ni publica datos personales.
- `modules/integration/tests/crece-founders-lab.test.ts` prueba interacción con M6/M11 SQL real, replay sin duplicar, suplantación de staff, negativa de producción y ausencia de asignaciones automáticas.
- **La verificación definitiva de la identidad del usuario M4 y autorización ADMIN M9 todavía falta; el actor nunca debe provenir de una entrada directa del cliente.** El adaptador no es el gateway comercial.

Las bases de staging no deben acceder a Postgres18 LIVE ni a wallets; PM2 permanece en un único checkout y no requiere Docker.

## Requisitos para habilitar inscripción real

1. Auth de M4 con vinculación de identidad M4↔M6 y sesión real, no solo actorId.
2. M9 autoriza acciones exactas: `crece.interest.submit`, `crece.founder.approve`, `crece.benefit.activate`; la autorización debe verificar el recurso M6 en cada operación.
3. M6 verifica RFC/propietario cuando aplique, dirección, producto y consentimiento; recopila datos mínimos bajo política de privacidad.
4. Base duradera con capacidad de diez puestos y lock transaccional; único ADMIN aprobado podrá asignar cupo; condiciones contractuales y fecha de inicio/caducidad.
5. Campañas destacadas realmente publicadas en clientes antes de prometer el beneficio; pruebas de visibilidad justas y trazabilidad.
6. Cifras de M10 para consejos: solo métricas verificadas, ventana indicada y aislamiento por merchant. No inferir ganancias ni inventar indicadores.
7. M3/M8 para pagos y descuentos versionados; sin cambios silenciosos de comisiones ni propinas.
8. E2E con apps y staging aislado, respaldo/rollback y sign-off G1–G9.

## Indicadores del piloto (recopilación real)

Comercios invitados, conversaciones, interesados, negocios con consentimiento y alta aprobada, comercios publicados, pedidos recibidos/entregados, cancelaciones, incidentes, tiempos de preparación, recompras agregadas cuando haya consentimiento, margen de contribución real descontando repartidor, pasarela, soporte, publicidad y reembolsos. No inferir resultados en negocios sin pedidos.

## Protocolo comercial

No afirmar **«ventas garantizadas», «retiros automáticos», «publicidad ilimitada», «todo habilitado»** ni publicar logos/fotos ajenas sin autorización. El programa es voluntario, sus límites y condiciones se documentan; no añadir un comercio sin acreditar participación y consentimiento.

### Repositorio PWA

La interfaz está en [tala-eats-version-web / rama Crece](https://github.com/AlanPalacios23/tala-eats-version-web/tree/feat/restaurantes-crece-fundadores-20261108), basada en la última rama del restaurante RC169, con vista pública y sección privada para comercios. Requiere revisión, CI, prueba del enlace público y despliegue estático aislado cuando se apruebe. **No está en Kali LIVE por este cambio.**

## Endurecimiento del piloto: propietario y reintentos concurrentes (8/nov/2026)

El adaptador LAB de interés exige ahora `owner_id` M6 idéntico al actor confirmado por M6, además de la sesión/contexto de confianza del host. Un **manager** o **editor** puede administrar determinadas funciones internas, pero no puede suscribir comercialmente al negocio ni registrar interés en Fundadores.

La transacción M11 toma un **advisory transaction lock por identificador de tienda** antes de consultar si existe el registro. Doce solicitudes de LAB concurrentes con la misma clave deben recuperar el mismo `applicationId` (una creación + once replays), sin errores de unicidad ni eventos duplicados. Cambiar la clave o el actor es rechazado. Los eventos son append-only y el campo `selected_for_founders` permanece permanentemente `false` en esta migración LAB: **nadie puede asignar plazas desde este código**.

[Línea M11 — CI PostgreSQL integrado](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/42511523068). No equivale a habilitar un alta por HTTP ni disponer de M4/M9 comercial. Hasta crear las autorizaciones de ADMIN y registrar aceptación contractual, los prospectos deben continuar con el flujo de contacto y revisión manual.

## RC6 — ciclo de afiliación comprobable en LAB (9/nov/2026)

Para que el programa no sea únicamente una presentación, se añadió el flujo interno **solicitud → revisión → aprobación/rechazo → estado** al mismo Core v2:

1. **Identidad M4**: `createCreceEnrollmentLab(config).submit(...)` recibe una **sesión M4**, sin aceptar identificadores de actor del navegador. Exige rol comerciante vigente. M6 confirma que ese usuario es el **propietario actual** de la tienda. M9 registra una decisión por acción/recurso con grant firmado y de un solo uso.
2. **Consentimiento explícito y separado**: la solicitud solo se graba cuando el propietario acepta `crece-founder-pilot-2026-11-v1`. La suscripción a publicidad es un booleano **opcional e independiente**, sin valor verdadero por omisión. La migración 009 no inventa consentimiento para solicitudes antiguas.
3. **Bandeja ADMIN**: `listForAdmin({sessionToken})` requiere M4 `staff/owner` (sesión MFA de acuerdo con las reglas M4) y M9 `crece.founder.list`. Devuelve únicamente UUID de solicitud/tienda, fecha y decisión: no correos, teléfonos ni secretos.
4. **Decisión ADMIN**: `review({sessionToken,applicationId,operationId,decision,reasonCode?})` exige M4 staff/owner y M9 `crece.founder.review`, con UUID de solicitud como recurso. La aprobación consume **una de 10 plazas por transacción SQL**. El rechazo requiere motivo codificado y no consume plazas. Una solicitud no puede revisarse dos veces; el replay idéntico retorna el mismo resultado.
5. **Estado propio**: `readMyStatus` exige sesión M4 de comerciante y propiedad M6 actual. Devuelve interesado, aprobado o rechazado únicamente al dueño; no revela solicitudes de otros comercios.
6. **Auditoría/consistencia**: PostgreSQL exige `capacity=10` y `approved_count BETWEEN 0 AND 10`; cada aprobación toma un lock transaccional sobre el contador. Los registros de consentimiento/revisión/eventos son inmutables y los IDs de operación son únicos.

### Puertas de seguridad

- Sigue restringido a base `tala_integration_v2_test`, `NODE_ENV!=production` y `CORE_V2_INTEGRATION_RUNTIME=isolated-lab`. No hay endpoints HTTP públicos de inscripción, decisión ni listado.
- Se extendió intencionalmente la superficie de acciones M9 LAB: `crece.interest.submit`, `crece.founder.list` y `crece.founder.review`. El **árbol del módulo M9 se repineó con SHA explícito** en `modules/integration/source-lock.json` versión 3; la verificación CI de los diez módulos sigue obligatoria. No se modifica ninguna clave LIVE.
- `approval=true` del programa Fundadores **no equivale a restaurante activado**, saldo pagado, campaña publicada, usuario verificado contractualmente ni GO del backend; siguen pendientes contrato legal real, fraude, soporte, publicidad, identidad cruzada entre el LIVE actual y M4/M6, G3–G9 y reconciliación financiera.
- Este conjunto de pruebas se ejecuta exclusivamente en **GitHub-hosted Linux con PostgreSQL temporal**. Que la CI use contenedores desechables en GitHub no significa introducir Docker a Kali: el servidor de usuario permanece con PM2 y PostgreSQL 18.
- El plan de desplegar Core v2 en Kali reutiliza la única carpeta staging ya prevista. No hay instrucciones para reiniciar/reemplazar LIVE.

## RC7 — endurecimiento de revisión y crecimiento de la bandeja ADMIN (9/nov/2026)

**Mejoras implementadas en el mismo monolito modular:**

- **Elegibilidad revalidada en la aprobación.** Antes de asignar una plaza, el proceso consulta de nuevo M4 (cuenta activa, email verificado y rol comerciante vigente) y M6 (propietario actual de la tienda). Si el interesado perdió su rol, cambió de propietario o su cuenta dejó de estar activa, rechaza `M11_CRECE_APPLICANT_NO_LONGER_ELIGIBLE`. Un consentimiento antiguo no da derecho perpetuo a recibir una plaza.
- **Bandeja paginada por cursor.** ADMIN puede consultar hasta 100 solicitudes por página, con filtros `interested`, `approved` o `declined`. El orden combina fecha e identificador UUID. Para evitar registros duplicados al pasar de página, el cursor usa la misma precisión de milisegundos que los objetos Date serializados por Node, aunque PostgreSQL registre microsegundos.
- **Errores de cursor estables.** Límites fuera de rango, marcas de tiempo o UUID inválidos se rechazan con errores tipados de M11; no se expone SQL o datos sensibles al cliente.
- **No hay relajación de cuota.** Permanecen la aprobación atómica de 10 plazas, consentimiento obligatorio, control MFA de ADMIN, grants M9 por acción y recurso, idempotencia y auditoría inmutable.
- **Pruebas integradas reales.** Incluyen tres páginas de solicitudes sin duplicados, resultados filtrados, cursor malformado, cambio del rol M4 del interesado tras solicitar, 11 aprobaciones concurrentes para 10 plazas y bloqueo fuera del entorno de laboratorio.

**Pendiente para producción:** validación del contexto LIVE de identidad y el convenio legal, endpoints autenticados, administración real en la app, campañas de publicidad, y finalización G3–G9 del backend. Estas funciones continúan en **LAB / NO-GO**, no se han desplegado al servidor Kali.

## RC8 — inmutabilidad, conciliación y control de privacidad (9/nov/2026)

**M11 LAB** agrega dos migraciones avanzadas de integridad:

- `010_crece_founder_ledger_integrity_lab.sql`: las solicitudes, las condiciones aceptadas y la titularidad registrada se vuelven **inmutables**. Dos triggers transaccionales diferidos verifican que `approved_count` sea exactamente igual al número de decisiones `approved`, incluso si alguien intenta modificar directamente el contador SQL. Una aprobación sigue exigiendo M4 activo/verificado, propiedad M6 actual y M9 por recurso.
- `011_crece_revocable_marketing_lab.sql`: la autorización para recibir mensajes promocionales puede **retirarse** sin revocar la solicitud ni sobrescribir la aceptación contractual. Cada cambio tiene `operation_id` único y queda como evento append-only en `crece_founder_marketing_events`. El valor vigente se obtiene del evento más reciente o, si no hay cambios, del consentimiento original.

**Interfaz interna, NO endpoint público:** `updateMarketingPreference({sessionToken,storeId,operationId,marketingOptIn})` exige sesión M4 de comerciante, propietario M6 y el permiso `crece.marketing.preference` de M9. Bloquea modificaciones de otros comercios, respuestas sin booleano, reutilizaciones incompatibles de operación y accesos fuera de LAB. `readMyStatus` consulta el estado publicitario vigente además del estatus Fundadores. La auditoría original sigue intacta.

**Pruebas PostgreSQL:** reintentos concurrentes de una misma operación, cambio de sí→no, lectura del valor efectivo, rechazo de otro propietario, unicidad de eventos y rechazo de modificaciones directas del contador de plazas. La CI también rechaza 010 y 011 cuando se ejecutan contra bases de datos con nombres ajenos al laboratorio.

**Pendientes antes de usarlo con comercios reales:** aviso de privacidad aprobado, mecanismo de consentimiento/retirada accesible en el frontend a través de un gateway comercial seguro, política de retención/supresión compatible con obligaciones fiscales, y conexión de las sesiones/IDs reales del sistema LIVE. No enviar campañas por este nuevo código; las migraciones de laboratorio **no** se aplican a LIVE y no se ha desplegado nada en Kali.
