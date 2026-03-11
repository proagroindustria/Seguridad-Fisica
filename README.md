# 🌱 PROAGRO — Sistema de Permisos

Sistema web de gestión de permisos para contratistas con 3 roles de usuario.

---

## 🚀 Instalación Rápida

```bash
# 1. Instalar dependencias
npm install

# 2. Ejecutar en modo OFFLINE (sin base de datos)
npm start
```

Abre tu navegador en: **http://localhost:3000**

---

## 👤 Usuarios por Defecto

| Usuario   | Contraseña  | Rol              |
|-----------|-------------|------------------|
| `ricardo` | `ricardo123`| Área             |
| `jiadan`  | `123`       | Seguridad Física |
| `inxite`  | `123`       | Contratista      |

---

## 🗄️ Configuración con PostgreSQL

### 1. Crear la base de datos

```sql
CREATE DATABASE permisos_db;
```

### 2. Ejecutar el schema

```bash
psql -U postgres -d permisos_db -f db/schema.sql
```

### 3. Configurar el archivo `.env`

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=permisos_db
DB_USER=postgres
DB_PASSWORD=tu_password_aqui
SESSION_SECRET=proagro_secret_2024
OFFLINE_MODE=false   # <-- Cambiar a false para usar PostgreSQL
```

### 4. Iniciar el servidor

```bash
npm start
# o en desarrollo:
npm run dev
```

---

## 📋 Funcionalidades

### Rol: Contratista (`inxite`)
- Ver tabla de permisos
- **Crear nuevo permiso** con formulario:
  - Empresa
  - Contrato
  - Responsable (siempre "PROAGRO", automático)
  - Fecha de inicio / Fecha fin (máximo 30 días)

### Rol: Área (`ricardo`)
- Ver tabla de todos los permisos
- Aprobar / Rechazar permisos

### Rol: Seguridad Física (`jiadan`)
- Ver tabla de todos los permisos
- Aprobar / Rechazar permisos

---

## 📁 Estructura del Proyecto

```
permisos-app/
├── server.js              # Servidor principal Express
├── package.json
├── .env                   # Variables de entorno
├── db/
│   ├── schema.sql         # Tablas PostgreSQL
│   └── connection.js      # Conexión al pool de BD
├── routes/
│   ├── auth.js            # Login / Logout
│   ├── dashboard.js       # Vista principal
│   └── permisos.js        # CRUD de permisos
├── views/
│   ├── login.ejs          # Página de inicio de sesión
│   └── dashboard.ejs      # Panel principal
└── public/
    ├── css/
    │   ├── login.css
    │   └── dashboard.css
    └── js/
        └── dashboard.js
```

---

## 🔄 Cambiar entre modo offline y PostgreSQL

En el archivo `.env`:
- `OFFLINE_MODE=true` → Usa usuarios y datos en memoria (sin BD)
- `OFFLINE_MODE=false` → Usa PostgreSQL

---

## 🛠️ Próximas Funciones (sugeridas)

- [ ] Exportar permisos a PDF/Excel
- [ ] Notificaciones por correo al aprobar/rechazar
- [ ] Historial de cambios por permiso
- [ ] Dashboard con gráficas de permisos por mes
- [ ] Autenticación con tokens JWT
