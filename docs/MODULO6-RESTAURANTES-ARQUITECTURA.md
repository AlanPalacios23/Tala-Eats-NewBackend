# TALA EATS CORE v2 — M6 Restaurantes y Comercios

**Inicio de M6:** 2026-11-03.  
**Rama:** `feat/core-v2-restaurantes-foundation` (desde `main`).  
**PR:** [#8](https://github.com/AlanPalacios23/Tala-Eats-NewBackend/pull/8), Draft.  
**Estado:** LAB2, **NO-GO comercial ni despliegue**.

## Separación por dominios

```text
        Cliente/App Comercios (futuro)
                       |
            Gateway con identidad M4
                 (NO integrado)
                       |
        M6 Restaurantes y Comercios
          ├─ Comercio y permisos
          ├─ Sucursales y horarios
          ├─ Productos y variantes
          ├─ Stock y auditoría
          └─ Fotos (metadata, sin blobs)
                       |
           PostgreSQL M6 aislado
                       |
          Contratos de SOLO LECTURA
        (sin importar otros módulos)
              /                \
         M1 Pedidos         M2 Logística
        (futuro)             (futuro)
```

## Modelo comercial

Tala, Jalisco, es la primera ciudad del piloto. La base de datos permite
registrar ubicación en Ameca, Ahualulco, Tequila, Cuisillos y Amatitán
para expansiones futuras **sin anunciar cobertura activa**.

Las tiendas incluyen restaurantes, comercios de abarrotes, carnicerías,
verdulerías, papelerías, ferreterías, florerías y otros.

Una tienda se registra en `draft`; el propietario añade sucursal, horario
y catálogo, y puede marcar `ready` tras las validaciones internas.
`ready` significa únicamente que el onboarding de LAB está completo,
**no** que la tienda fue verificada comercialmente o se puede vender
en producción. `paused` detiene disponibilidad de lectura.

## Contratos con otros módulos

- **Identidad M4:** debe suministrar un UUID de usuario autenticado,
  y verificar invitaciones y el perfil autorizado antes de crear un
  colaborador. M6 conserva roles `owner/manager/editor` por tienda.
- **Pedidos M1:** `readOfferSnapshot(pool,{storeId,branchId,variantId})`
  devuelve la variante, precio en **centavos MXN**, peso fijo opcional,
  disponibilidad y versión. Es una lectura: no constituye reserva ni
  compra. Una transacción comercial deberá validar el precio y la
  disponibilidad al confirmar el pedido, implementando una política
  de reserva/concurrencia entre módulos. Debe consultar también
  `getBranchAvailability` para verificar horario y modo de entrega.
- **Logística M2:** `getBranchAvailability` indica apertura, pickup y
  delivery configurados. **No** calcula distancia, costo, despacho ni
  llegada de repartidor; eso compete a Logística y a su coordinación.
- **Notificaciones M5:** después de integrar productores autenticados,
  eventos de menú y estado pueden emitirse con contrato de eventos;
  M6 no importa el código de Notificaciones.
- **Finanzas M3:** M6 nunca calcula comisiones ni manipula pagos o wallets.

Los contratos se mantienen en el módulo porque el árbol principal aún
contiene solamente su README; no se crea ningún import al código de
otros PR en borrador.

## Garantías técnicas de LAB

- **Multi-tenant:** toda modificación exige miembro del establecimiento,
  con permiso correspondiente. Los IDs de terceros no pueden utilizarse
  para mutar catálogo, staff, horarios o stock.
- **Idempotencia:** `actorId+operationId` evita duplicados de creación,
  y compara huella del contenido para rechazar un replay con otro payload.
- **Concurrencia:** versión CAS para perfil, horario y precio, y sumas de
  inventario atómicas bajo bloqueo de PostgreSQL.
- **Stock:** tabla de ajustes con motivo y cantidades antes/después,
  bloqueo de saldos negativos y auditoría inmutable. La migración 002
  impide UPDATE/DELETE del historial y rechaza signos inconsistentes.
- **Dinero:** números enteros en centavos MXN. No floats ni cálculos
  de precio por kilogramo en tiempo real.
- **Fotos:** metadatos y claves generadas, SHA-256 y tipos MIME
  autorizados. No se afirma carga real: falta integrar almacenamiento
  y verificar bytes con un adaptador seguro.
- **Horas:** zona `America/Mexico_City`, semana local y pausa por
  sucursal, sin calcular días festivos, capacidad ni pedidos en cola.
- **CI:** Node 24, TypeScript estricto y PostgreSQL 16 de prueba,
  migraciones 001–002 y rechazo de nombres de bases no permitidos,
  tests de RBAC, onboarding, HTTP, inventario, imágenes y disponibilidad.

## Próxima fase del M6, antes de declarar cierre

1. Endurecer invitaciones y verificaciones comerciales con integración
   de M4, identidad de negocios, sucursales y documentos comerciales.
2. Almacenamiento real de fotografías con subida, validación por tamaño,
   hash, formato y ACL; miniaturas y CDN.
3. Disponibilidad avanzada: cierres festivos, operaciones del restaurante,
   franjas múltiples, preparación, agotados y tiempo de cambio de menú.
4. Contrato de inventario/reserva frente a Pedidos M1, evitando ventas
   duplicadas y definiciones inconsistentes de stock.
5. Pruebas ampliadas de carga, regresión, seguridad, recuperación,
   backups, monitoreo y E2E PWA Restaurante + Usuarios.

**Este documento no autoriza desplegar a Kali ni activar cobros,
transferencias, wallets o pedidos reales.**
