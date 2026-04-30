-- =====================================================
-- SISTEMA DE PERMISOS - PROAGRO
-- Schema PostgreSQL
-- =====================================================

-- =====================================================
-- 1. USUARIOS
-- =====================================================
CREATE TABLE IF NOT EXISTS usuarios (
    id              SERIAL       PRIMARY KEY,
    username        VARCHAR(50)  UNIQUE NOT NULL,
    password        VARCHAR(255) NOT NULL,
    rol             VARCHAR(30)  NOT NULL CHECK (rol IN ('area', 'seguridad_fisica', 'contratista')),
    nombre_completo VARCHAR(100),
    activo          BOOLEAN      DEFAULT true,
    creado_en       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 2. PERMISOS (encabezado principal)
--
-- Flujo de estatus:
--   borrador
--     → en_espera_area     (contratista envía)
--     → aprobado_area      (Área aprueba)
--     → en_espera_seguridad(pasa a Seguridad Física)
--     → activo             (Seguridad valida)
--     → rechazado          (cualquier rol rechaza — fin)
--     → vencido            (fecha_fin superada — automático)
-- =====================================================
CREATE TABLE IF NOT EXISTS permisos (
    id                   SERIAL       PRIMARY KEY,
    folio                VARCHAR(20)  UNIQUE NOT NULL,
    empresa              VARCHAR(150) NOT NULL,
    contrato             VARCHAR(100) NOT NULL,
    responsable_contrato VARCHAR(100) NOT NULL DEFAULT 'PROAGRO',
    fecha_inicio         DATE         NOT NULL,
    fecha_fin            DATE         NOT NULL,

    -- Estatus del flujo de aprobación
    estado               VARCHAR(30)  NOT NULL DEFAULT 'borrador'
                            CHECK (estado IN (
                                'borrador',
                                'en_espera_area',
                                'aprobado_area',
                                'en_espera_seguridad',
                                'activo',
                                'rechazado',
                                'vencido'
                            )),

    -- Control de quién hizo qué
    creado_por              INT  REFERENCES usuarios(id),
    aprobado_por_area       INT  REFERENCES usuarios(id),
    aprobado_por_seguridad  INT  REFERENCES usuarios(id),
    rechazado_por           INT  REFERENCES usuarios(id),

    -- Fechas de cada acción
    fecha_envio             TIMESTAMP,
    fecha_aprobacion_area   TIMESTAMP,
    fecha_aprobacion_seg    TIMESTAMP,
    fecha_rechazo           TIMESTAMP,

    -- Motivo de rechazo (opcional)
    motivo_rechazo          TEXT,

    creado_en               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado_en          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_fechas        CHECK (fecha_fin >= fecha_inicio),
    CONSTRAINT chk_max_30_dias   CHECK ((fecha_fin - fecha_inicio) <= 30)
);

-- =====================================================
-- 3. HISTORIAL DE CAMBIOS DE ESTATUS
--    Registro completo de cada movimiento del permiso
-- =====================================================
CREATE TABLE IF NOT EXISTS permiso_historial (
    id             SERIAL      PRIMARY KEY,
    permiso_id     INT         NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    estado_anterior VARCHAR(30),
    estado_nuevo    VARCHAR(30) NOT NULL,
    cambiado_por    INT         REFERENCES usuarios(id),
    comentario      TEXT,
    creado_en       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 4. PERSONAL DEL PERMISO (filas repetibles)
-- =====================================================
CREATE TABLE IF NOT EXISTS permiso_personal (
    id             SERIAL       PRIMARY KEY,
    permiso_id     INT          NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    num_credencial VARCHAR(50),
    nombre         VARCHAR(150) NOT NULL,
    categoria      VARCHAR(100),
    observaciones  TEXT,
    nss            VARCHAR(20),
    trabajador_id  INTEGER,
    liberado       BOOLEAN      NOT NULL DEFAULT FALSE,
    creado_en      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 5. VEHÍCULOS DEL PERMISO (filas repetibles)
-- =====================================================
CREATE TABLE IF NOT EXISTS permiso_vehiculos (
    id          SERIAL       PRIMARY KEY,
    permiso_id  INT          NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    marca       VARCHAR(80)  NOT NULL,
    modelo      VARCHAR(80)  NOT NULL,
    placas      VARCHAR(20)  NOT NULL,
    seguro      VARCHAR(255),   -- nombre del archivo adjunto
    licencia    VARCHAR(255),   -- nombre del archivo adjunto
    creado_en   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 6. EQUIPOS Y HERRAMIENTAS DEL PERMISO (filas repetibles)
-- =====================================================
CREATE TABLE IF NOT EXISTS permiso_equipos (
    id            SERIAL       PRIMARY KEY,
    permiso_id    INT          NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    cantidad      INT          NOT NULL DEFAULT 1,
    descripcion   VARCHAR(255) NOT NULL,
    marca         VARCHAR(100),
    modulo        VARCHAR(100),
    sucursal      VARCHAR(100),
    observaciones TEXT,
    creado_en     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- ÍNDICES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_permisos_estado      ON permisos(estado);
CREATE INDEX IF NOT EXISTS idx_permisos_empresa     ON permisos(empresa);
CREATE INDEX IF NOT EXISTS idx_permisos_fechas      ON permisos(fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_permisos_creado_por  ON permisos(creado_por);
CREATE INDEX IF NOT EXISTS idx_historial_permiso    ON permiso_historial(permiso_id);
CREATE INDEX IF NOT EXISTS idx_personal_permiso     ON permiso_personal(permiso_id);
CREATE INDEX IF NOT EXISTS idx_vehiculos_permiso    ON permiso_vehiculos(permiso_id);
CREATE INDEX IF NOT EXISTS idx_equipos_permiso      ON permiso_equipos(permiso_id);

-- =====================================================
-- FUNCIÓN: actualizar timestamp automáticamente
-- =====================================================
CREATE OR REPLACE FUNCTION actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizado_en = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_permisos_updated
    BEFORE UPDATE ON permisos
    FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();

-- =====================================================
-- FUNCIÓN: registrar historial automáticamente
--          cuando cambia el estado de un permiso
-- =====================================================
CREATE OR REPLACE FUNCTION registrar_historial_estado()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.estado IS DISTINCT FROM NEW.estado THEN
        INSERT INTO permiso_historial (
            permiso_id,
            estado_anterior,
            estado_nuevo,
            cambiado_por,
            comentario
        ) VALUES (
            NEW.id,
            OLD.estado,
            NEW.estado,
            NEW.creado_por,  -- se sobreescribe desde la app si se pasa el usuario real
            CASE
                WHEN NEW.estado = 'rechazado' THEN NEW.motivo_rechazo
                ELSE NULL
            END
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_historial_estado
    AFTER UPDATE ON permisos
    FOR EACH ROW EXECUTE FUNCTION registrar_historial_estado();

-- =====================================================
-- USUARIOS POR DEFECTO
-- (contraseñas en texto plano solo para setup inicial,
--  en producción usar bcrypt desde la app)
-- =====================================================
INSERT INTO usuarios (username, password, rol, nombre_completo) VALUES
    ('ricardo', 'ricardo123', 'area',            'Ricardo - Área'),
    ('jiadan',  '123',        'seguridad_fisica', 'Jiadan - Seguridad Física'),
    ('inxite',  '123',        'contratista',      'Inxite - Contratista')
ON CONFLICT (username) DO NOTHING;

-- =====================================================
-- VISTA: resumen de permisos con estatus legible
-- =====================================================
CREATE OR REPLACE VIEW vista_permisos AS
SELECT
    p.id,
    p.folio,
    p.empresa,
    p.contrato,
    p.responsable_contrato,
    p.fecha_inicio,
    p.fecha_fin,
    (p.fecha_fin - p.fecha_inicio) AS dias_duracion,
    p.estado,
    CASE p.estado
        WHEN 'borrador'              THEN 'Borrador'
        WHEN 'en_espera_area'        THEN 'En espera del Área'
        WHEN 'aprobado_area'         THEN 'Aprobado por Área'
        WHEN 'en_espera_seguridad'   THEN 'En espera de Seguridad'
        WHEN 'activo'                THEN 'Activo'
        WHEN 'rechazado'             THEN 'Rechazado'
        WHEN 'vencido'               THEN 'Vencido'
    END AS estado_legible,
    uc.nombre_completo  AS creado_por_nombre,
    ua.nombre_completo  AS aprobado_area_nombre,
    us.nombre_completo  AS aprobado_seg_nombre,
    ur.nombre_completo  AS rechazado_por_nombre,
    p.motivo_rechazo,
    p.fecha_envio,
    p.fecha_aprobacion_area,
    p.fecha_aprobacion_seg,
    p.fecha_rechazo,
    p.creado_en,
    p.actualizado_en
FROM permisos p
LEFT JOIN usuarios uc ON p.creado_por             = uc.id
LEFT JOIN usuarios ua ON p.aprobado_por_area      = ua.id
LEFT JOIN usuarios us ON p.aprobado_por_seguridad = us.id
LEFT JOIN usuarios ur ON p.rechazado_por          = ur.id;

