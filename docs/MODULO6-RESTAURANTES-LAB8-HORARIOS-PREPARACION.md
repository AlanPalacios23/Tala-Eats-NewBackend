# Tala Eats Core v2 — M6 LAB8: horarios y preparación por sucursal

**Estado:** laboratorio independiente de Restaurantes/Comercios. PR #8 Draft. NO-GO LIVE.
**Única base autorizada:** `tala_restaurants_v2_test` o `tala_restaurants_v2_lab`.
**Migración:** `modules/restaurants/migrations/007_branch_schedule_preparation.sql`.
**Sin cambios de tablas ni imports de M1 Pedidos, M2 Logística, M3 Finanzas, M4 Usuarios, M5 Notificaciones o M7 Ubicaciones.**

## Horarios comerciales

- Horario local fijo `America/Mexico_City`; nunca se infiere de la zona del dispositivo.
- Hasta cuatro intervalos por día, sin cruces ni solapamientos, incluido el cruce del sábado hacia domingo.
- `closeMinute <= openMinute` representa cierre al día siguiente; `openMinute===closeMinute` se rechaza.
- Compatibilidad con `PUT /hours`: la configuración anterior de intervalo único actualiza el mismo esquema canónico.
- `hours` legado se conserva para clientes anteriores; si el horario avanzado no cabe en ese modelo, se marca conservadoramente como cerrado. **Clientes nuevos deben leer `/schedule` o `scheduleSlots`; no usar `hours` para determinar apertura.**
- La función PostgreSQL `is_branch_scheduled_open(branch_id,at)` unifica cuatro consumidores: `getBranchAvailability`, `readBranchStorefront`, `readOfferSnapshot` y `discoverReadyBranches`. El cierre excepcional y la pausa de tienda/sucursal continúan aplicándose.
- `ready` de LAB requiere al menos un slot programado en una sucursal activa y oferta con inventario; no es aprobación comercial.
- Se usa `expectedVersion`, bloqueo por tienda, auditoría y rollback transaccional ante conflicto o solapamiento.
- El contrato acepta días parciales (sin modificar los demás días).

### Ejemplo de horarios

```json
{
  "expectedVersion": 1,
  "days": [
    {
      "weekday": 1,
      "closed": false,
      "intervals": [
        { "openMinute": 540, "closeMinute": 720 },
        { "openMinute": 840, "closeMinute": 1140 }
      ]
    },
    {
      "weekday": 2,
      "closed": false,
      "intervals": [{ "openMinute": 1200, "closeMinute": 120 }]
    }
  ]
}
```

Lunes: 09:00–12:00 y 14:00–19:00. Martes: 20:00–miércoles 02:00.
Los intervalos son semiabiertos: el instante exacto de cierre ya está cerrado.

## Preparación / capacidad estática

Configuración propia de M6 por sucursal:
- `prepMinutes`: 5–240 (default 25).
- `parallelPrepSlots`: 1–100 (default 5).
- Solo propietario/gerente puede modificar; editor puede leer si tiene permisos de la tienda.
- Concurrencia mediante `branches.version` compartida entre horarios, estado y configuración.
- La lectura del escaparate expone únicamente `prepMinutes` como estimación, no cantidades de slots.
- **No implementa saturación automática, conteo de órdenes en curso, ETA de repartidor, ni confirmación de pedidos.** Esos datos requerirían contratos con M1/M2.

## API HTTP LAB (identidad inyectada desde host)

- `GET /v1/restaurants/:storeId/branches/:branchId/schedule`
- `PUT /v1/restaurants/:storeId/branches/:branchId/schedule`
- `GET /v1/restaurants/:storeId/branches/:branchId/preparation`
- `PUT /v1/restaurants/:storeId/branches/:branchId/preparation`

Payload de preparación: `{"expectedVersion":2,"prepMinutes":35,"parallelPrepSlots":8}`.
La API actual está restringida a loopback, bloqueada en `NODE_ENV=production`. No exponer al tráfico público.

## Pruebas y condición de cierre

`tests/schedule-preparation-db.test.ts`: contrato de horarios divididos, madrugada, final de intervalo exacto, concordancia entre cuatro lecturas, rechazo de traslapes, rollback, permisos entre tiendas, control de versión, preparación y endpoints HTTP inyectados.

CI independiente: Node 24, TypeScript estricto, PostgreSQL 16, migraciones 001–007, rechazo de migración fuera de DB autorizadas, suites y fronteras.

**Puertas NO-GO LIVE que siguen fuera de este incremento:** sesión real/gateway M4, aprobación de comerciantes, proveedor seguro de fotos reales, integración de inventario con M1 para reservas, observabilidad/backup restore, seguridad E2E del cliente PWA/Flutter y pruebas bajo tráfico real. No se cambió el backend LIVE de Kali ni se fusionó a `main`.
