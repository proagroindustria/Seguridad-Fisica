# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Producción — node server.js (puerto 3010)
npm run dev      # Desarrollo — nodemon server.js (recarga automática)
```

No hay suite de tests ni linter configurado.

## Bases de datos

El sistema usa **tres bases de datos PostgreSQL** simultáneas:

| Variable `.env`     | Default            | Contenido                                          |
|---------------------|--------------------|----------------------------------------------------|
| `DB_NAME`           | `seguridad_fisica` | Permisos, permiso_personal, retiros, historial     |
| `FACIAL_DB_NAME`    | `reconocimiento_db`| Trabajadores, descriptores biométricos, accesos    |
| `BD_PRINCIPAL_NAME` | `bd_principal`     | Usuarios internos, empleados, proveedores, roles   |

`db/connection.js` exporta el pool de `seguridad_fisica`. Los demás pools se instancian directamente dentro de cada route.

### Inicializar desde cero

```bash
psql -U postgres -d seguridad_fisica -f db/schema.sql
```

Las migraciones incrementales (columnas nuevas) se aplican automáticamente al arrancar el servidor con `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. No ejecutes estas queries manualmente.

## Variables de entorno (`.env`)

```env
PORT=3010
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=...
DB_NAME=seguridad_fisica
FACIAL_DB_NAME=reconocimiento_db
BD_PRINCIPAL_NAME=bd_principal
SESSION_SECRET=...
OFFLINE_MODE=false         # true = sin BD, datos en memoria

# Webhooks n8n para OCR de documentos
N8N_SEGURO_URL=...
N8N_LICENCIA_URL=...
N8N_TARJETA_URL=...
N8N_WEBHOOK_VERIFICACION=...

DIAS_GRACIA_LIMPIEZA=7     # días antes de borrar trabajadores sin permiso
```

## Arquitectura

### Roles y flujo de permisos

Tres roles: **contratista**, **area**, **seguridad_fisica**.

El estado de un permiso sigue este flujo unidireccional:

```
borrador → en_espera_area → aprobado_area → en_espera_seguridad → activo → vencido
                                                                 ↘ rechazado
```

`vista_permisos` (view SQL) une la tabla `permisos` con los usuarios que aprobaron/rechazaron cada etapa. Siempre consulta a través de esta vista para mostrar nombres legibles.

### Rutas

- `/` `auth.js` — login, logout, registro de proveedores con verificación OTP por correo (n8n), extracción de RFC desde PDF
- `/dashboard` `dashboard.js` — vista principal diferenciada por rol
- `/solicitudes` `permisos.js` — CRUD completo de permisos + generación de PDF + QR + notificaciones por correo
- `/facial` `facial.js` — enrolamiento facial (face-api.js en el browser, descriptores enviados al server), verificación QR, control de accesos
- `/documentos` `documentos.js` — carga y OCR de documentos de identidad vía n8n/GPT-4o
- `/retiros` `retiros.js` — módulo de retiro de herramientas (PDF)
- `/verificar` — módulo de asistencia con su propio login (`req.session.asistencia_user`, credenciales hardcodeadas `admin/123`)

### Dos sesiones paralelas

El sistema mantiene dos objetos de sesión independientes:
- `req.session.user` — usuarios del sistema principal
- `req.session.asistencia_user` — módulo de verificación de accesos (`/verificar`)

Cualquier middleware de autenticación debe comprobar el objeto correcto según el contexto.

### Auto-vencimiento de permisos (server.js)

Al arrancar y cada día a las 00:02 h se ejecutan tres funciones:
1. `vencerPermisosExpirados()` — marca como `vencido` los permisos con `fecha_fin < hoy` (solo si nadie del permiso sigue adentro según `reconocimiento_db.accesos`)
2. `limpiarTrabajadoresSinPermiso()` — borra biometría y documentos de trabajadores sin permiso activo tras `DIAS_GRACIA_LIMPIEZA` días
3. `limpiarDocumentosVisitas()` — anula `documento` en `permiso_personal` de pases de visita vencidos

Antes de borrar un trabajador, se preservan `nombre_snapshot`, `area_snapshot` y `empresa_snapshot` en la tabla `accesos` para trazabilidad.

### Compresión de imágenes para OCR (`documentos.js:comprimirBase64`)

- Redimensiona a máx 2000×2000 px, JPEG 4:4:4
- Calidad mínima: **80** (por debajo, GPT-4o alucina al leer texto)
- Tamaño máximo: 2.5 MB
- HEIC (iPhone) se rechaza con mensaje al usuario
- **nginx** del bloque de accesos debe tener `client_max_body_size ≥ 25m`; el endpoint `/api/debug-config` muestra la configuración en tiempo de ejecución

### Tokens temporales de documentos

Cuando un documento es demasiado grande para re-enviarlo en el body, se guarda en `reconocimiento_db.documentos_temp` con un token UUID. El cliente envía `{ token }` en lugar de `{ base64File }`. `resolverBodyN8N()` en `server.js` recupera el base64 antes de llamar a n8n.

### Reconocimiento facial

Los modelos de face-api.js están en `public/models/` y se cargan en el browser. El server recibe solo el descriptor numérico (128 floats) y lo guarda en `reconocimiento_db.trabajadores`.

## Nginx

El error `413 / "error de red"` en móvil indica que el `server_block` de **accesos.proagroindustria.com** (no el de n8n) tiene `client_max_body_size` insuficiente. Visita `/api/debug-config` autenticado para diagnosticar.
