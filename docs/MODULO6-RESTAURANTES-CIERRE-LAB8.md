# Tala Eats Core v2 — Acta de cierre técnico M6 Restaurantes y Comercios

**Fecha:** 4 de noviembre de 2026  
**Hito:** LAB8 — cierre autónomo de M6.  
**Decisión:** **GO para iniciar el siguiente módulo independiente**; **NO-GO para merge, despliegue Kali o comercio LIVE**.  
**Rama:** `feat/core-v2-restaurantes-foundation`.  
**PR:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8) — mantener **Draft, abierto y sin merge**.  
**Ubicación de código:** `modules/restaurants/`.  
**Esquema:** `tala_restaurants_v2`, únicamente en `tala_restaurants_v2_test` / `tala_restaurants_v2_lab`.

## Alcance terminado y verificado en laboratorio

1. **Comercios:** registro idempotente, perfiles, tipos de negocio, estado operativo de LAB, propietario y colaboradores con RBAC propietario / gerente / editor; versiones y auditoría.
2. **Sucursales:** alta, municipio, información comercial, modos de recogida/entrega, control de activación y lectura administrativa.
3. **Horarios:** programación semanal por sucursal, cierres extraordinarios, hasta cuatro ventanas por día, turnos que cruzan medianoche y protección ante solapamientos de toda la semana, incluido sábado→domingo.
4. **Disponibilidad coherente:** `getBranchAvailability`, `readBranchStorefront`, `readOfferSnapshot` y `discoverReadyBranches` usan la misma fuente de horarios y respetan cierres/pausas. La búsqueda consulta inventario de la sucursal correcta (LAB7).
5. **Preparación:** minutos configurables (5–240) y puestos paralelos (1–100) por sucursal, con versiones, permisos y auditoría; **sin inferir ocupación real de pedidos**.
6. **Catálogo:** productos, categorías, variantes fijas por peso (500 g / 1 kg, etc.), precio en centavos MXN, archivo, switches de visibilidad por sucursal, escaparate paginado sin PII.
7. **Fotos:** metadatos y validación de estado por verificador inyectado de LAB, foto principal y retiro lógico. **No incluye almacenamiento ni subida de archivos reales**.
8. **Inventario:** saldo general antiguo o inventario físico por sede (migración voluntaria previa conciliación global a cero), ajustes, reposiciones, mermas, auditoría inmutable, historial privado, transferencias atómicas y conteos físicos con prevención de carreras.
9. **API de laboratorio:** adaptador HTTP en loopback con identidad inyectada, validaciones, separación por comercio, RBAC y rutas de administración; bloqueada en `NODE_ENV=production`.

## Evidencia de calidad y alcance de la decisión

- **Ejecución última de código LAB8:** [GitHub Actions #41871070563](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/actions/runs/41871070563) — **PASS**, incluida la batería añadida de horarios, madrugada, medianoche y frontera semanal.
- CI de M6 verifica TypeScript estricto en Node 24, PostgreSQL 16, migraciones SQL 001–007, pruebas unitarias, DB/HTTP, permisos y aislamiento; rechaza migraciones a bases ajenas.
- Controles de stock y transferencias revisados con pruebas de idempotencia, concurrencia, rollback y ledger inmutable.
- Esta evidencia **no es una certificación de producción**, seguridad de despliegue o disponibilidad comercial.
- Los commits posteriores que solo actualicen documentación no cambian la evidencia funcional; si cambia el código, debe obtenerse una nueva CI PASS antes de conservar este cierre.

## Frontera estricta de propiedad

M6 **solo** gobierna comercios, sucursales, catálogo, condiciones de disponibilidad, inventario y configuración estática de preparación. Mantener contratos explícitos sin importaciones ni FK hacia otros módulos.

| Propietario externo | Fuera de M6 |
| --- | --- |
| M1 Pedidos | Ciclo de pedido, aceptación/cancelación y reserva/compromiso/liberación de stock. M6 solo ofrece snapshot; reserva transaccional pendiente de contrato. |
| M2 Logística | Despacho, repartidores, rutas y cálculo de envío/ETA. |
| M3 Finanzas | Cobros, reembolsos, comisiones, facturación, wallet, saldos y Stripe. |
| M4 Usuarios | Autenticación real, registro de usuarios, sesiones e invitaciones verificadas de empleados. M6 solo guarda roles internos referidos a identidades inyectadas. |
| M5 Notificaciones | Mensajería, avisos push, correo y canales externos. |
| M7 Ubicaciones | Geocodificación, GPS, mapas y validación espacial. M6 guarda únicamente datos declarativos de la sucursal. |

## Pendientes externos bloqueantes para GO LIVE

1. Gateway autenticado e identidades confiables; altas de colaboradores y aprobación documental/comercial (con integración a M4/administración).
2. Subida real de fotografías con validación de bytes, dimensión, hash, almacenamiento privado, ACL, CDN y borrado.
3. Contrato transaccional de reserva y liberación de stock con M1, anti-sobreventa, rollback y pruebas intermodulares; M6 no implementa el flujo de pedido.
4. Pruebas E2E de PWA y Flutter sobre API real de integración, compatibilidad de clientes con horarios divididos, errores y reconexión.
5. Observabilidad, métricas, alertas, mínimos privilegios de DB, gestión de secretos, backup y recuperación probada, carga y pentest.
6. Capacidad dinámica y saturación comercial solo tras contrato con M1; no incluir lógica de pedidos en M6.

## Congelación y siguiente etapa

- **M6 CERRADO EN LAB8.** No agregar funcionalidades ajenas ni mezclar código de otros módulos en esta rama.
- **No** fusionar PR #8 a `main`, cerrar el PR ni realizar deploy en Kali por este cierre; mantener revisión de integración pendiente.
- Para el siguiente módulo, crear una rama **desde `main`** independiente, sin basarla en la rama de M6.
- Reabrir M6 únicamente ante una regresión concreta, cambio aprobado del contrato propio o las futuras puertas de integración; exigir sus pruebas y nuevo gate.
- Referencias: [README M6](../modules/restaurants/README.md) y [LAB8 horarios/preparación](MODULO6-RESTAURANTES-LAB8-HORARIOS-PREPARACION.md).
