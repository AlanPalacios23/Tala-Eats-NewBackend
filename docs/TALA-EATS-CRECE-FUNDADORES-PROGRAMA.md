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
