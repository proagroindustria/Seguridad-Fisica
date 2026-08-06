# Spec — Foto del vehículo en el permiso

**Objetivo:** que al crear un permiso, en la sección **Vehículos**, se pueda adjuntar o **tomar** una foto del vehículo, se guarde en la base de datos junto con el resto de la fila, y se muestre como miniatura en la consulta del permiso igual que hoy se muestran Seguro / Tarjeta de circulación / Licencia.

**Decisiones tomadas:**

| Punto | Decisión |
|---|---|
| Obligatoriedad | **La foto es obligatoria.** Un vehículo sin foto no deja guardar el permiso (bloqueo en cliente **y** en servidor). |
| Flujos | Aplica igual a **permiso normal** y a **pase de visita**. |
| Formas de captura | **Tres:** archivo del equipo, galería del móvil, cámara dentro de la app. |
| Dónde se muestra | **Solo en la tabla de detalle del permiso.** Sin miniatura en el formulario, sin cambios al PDF del pase. |
| Compresión | Más agresiva que los documentos (no pasa por OCR). |

---

## 1. Estado actual (de dónde partimos)

El campo se monta sobre la tubería que ya existe para los documentos de vehículo:

| Paso | Dónde vive hoy |
|---|---|
| Definición de columnas de la tabla | [dashboard.js:550-557](../public/js/dashboard.js#L550-L557) → `SECTION_COLS.vehiculo` |
| Render de la celda de archivo | [dashboard.js:877-935](../public/js/dashboard.js#L877-L935) → `buildRowHTML`, rama `c.type === 'file'` |
| Subida + compresión + stash | [dashboard.js:1372-1484](../public/js/dashboard.js#L1372-L1484) → `onFileChange` |
| Cámara trasera con marco guía | [camara.js:126-270](../public/js/camara.js#L126-L270) → `DocScanner` (hoy solo lo usa el enrolamiento de credenciales) |
| Cálculo de validez de la fila | [dashboard.js:1534-1568](../public/js/dashboard.js#L1534-L1568) → `verificarDocumentosVehiculo` |
| Aviso y bloqueo del botón | [dashboard.js:1253-1290](../public/js/dashboard.js#L1253-L1290) → `actualizarAlertaVehiculos`; [dashboard.js:764-765](../public/js/dashboard.js#L764-L765) → `verificarBotonSubmit` |
| Bloqueo final al enviar | [dashboard.js:1646-1663](../public/js/dashboard.js#L1646-L1663) |
| Token → base64 al guardar | [permisos.js:491](../routes/permisos.js#L491) → `camposDoc.vehiculo` |
| INSERT de la fila | [permisos.js:549-551](../routes/permisos.js#L549-L551) |
| Tabla del detalle | [dashboard.js:2137-2170](../public/js/dashboard.js#L2137-L2170) |

Las imágenes se guardan como **base64 en columnas TEXT** de `permiso_vehiculos` (`seguro`, `licencia`, `tarjeta`) y se pintan con `<img src="data:image/jpeg;base64,…" onclick="verImgDoc(...)">`. La foto sigue ese patrón — no hay almacenamiento nuevo.

### 1.1 Los dos flujos son el mismo código (verificado)

Pase de Visita **no es un formulario aparte**: es un toggle dentro del mismo modal ([dashboard.ejs:288](../views/dashboard.ejs#L288)) que solo reconstruye la sección `personal` ([dashboard.js:52-59](../public/js/dashboard.js#L52-L59)); la sección de vehículos queda idéntica en ambos modos. Los dos postean a `POST /solicitudes` con la bandera `es_pase_visita`, y los dos se consultan con el mismo modal de detalle.

**Consecuencia:** no hay que duplicar nada. Cada cambio de esta spec aplica automáticamente a los dos flujos. Lo único que se exige es **no condicionar** ninguna de las validaciones nuevas a `isPaseVisitaActive()` — a diferencia de lo que sí hace hoy el personal ([dashboard.js:536](../public/js/dashboard.js#L536), [dashboard.js:768-773](../public/js/dashboard.js#L768-L773)).

---

## 2. Cambios

### 2.1 Base de datos

```sql
ALTER TABLE permiso_vehiculos ADD COLUMN IF NOT EXISTS foto TEXT;
```

- Se agrega junto a las migraciones idempotentes de arranque en [server.js:605-615](../server.js#L605-L615), con el mismo `.catch(e => console.warn('[migration] permiso_vehiculos.foto:', e.message))`.
- También en [db/schema.sql:110-119](../db/schema.sql#L110-L119) para instalaciones nuevas. Ojo: ese archivo ya está desfasado (no tiene `tarjeta`, `seguro_poliza`, `seguro_serie`…); se agrega `foto` sin pretender sincronizar el resto.
- **La columna se deja `NULL`-able** aunque el campo sea obligatorio: los permisos ya existentes no tienen foto y un `NOT NULL` rompería la migración. La obligatoriedad se impone en la aplicación (§2.5), no en el esquema.

### 2.2 Captura — las tres formas

**a) Nueva columna en la sección.** En `SECTION_COLS.vehiculo` ([dashboard.js:550](../public/js/dashboard.js#L550)), después de `placas`:

```js
{ id: 'foto', label: 'FOTO DEL VEHÍCULO', placeholder: '', type: 'file',
  accept: 'image/*', required: true, camera: true, ligera: true }
```

`required: true` hace que el encabezado pinte el asterisco rojo que ya maneja `buildTableHTML` ([dashboard.js:828](../public/js/dashboard.js#L828)).

**b) Las tres vías de captura.** Con dos controles en la celda se cubren las tres:

| # | Forma | Cómo se logra |
|---|---|---|
| 1 | **Archivo del equipo** | Botón "Adjuntar" existente (`<input type="file">`) |
| 2 | **Galería / fototeca del móvil** | El mismo input: `accept="image/*"` **sin** el atributo `capture` hace que iOS/Android ofrezcan "Tomar foto / Fototeca / Explorar archivos" |
| 3 | **Cámara dentro de la app** | Botón `📷` nuevo → `DocScanner` con marco guía; funciona también en escritorio con webcam |

> **Importante:** no usar `capture="environment"` en el input. Ese atributo fuerza la cámara y **elimina** la opción de galería en móvil, dejando dos formas en vez de tres.

**c) Botón de cámara.** En `buildRowHTML`, la celda de archivo gana un botón cuando `c.camera === true`, entre "Adjuntar" y la `×`:

```html
<button type="button" onclick="abrirCamaraCampo('vehiculo','<rowId>','foto')" title="Tomar foto">📷</button>
```

**d) Reutilizar `DocScanner`.** Función nueva en `camara.js`:

```js
function abrirCamaraCampo(tipo, rowId, fieldId) {
  DocScanner.abrir(file => onFileChange(tipo, rowId, fieldId, { files: [file] }),
                   { titulo: 'VEHÍCULO', aspecto: '4/3' });
}
```

`DocScanner.abrir` acepta un segundo parámetro `opciones` (`titulo`, `aspecto`, `archivo`) **con los valores actuales como default**, para que el marco no diga "CREDENCIAL / PASAPORTE / LICENCIA" ni use proporción de tarjeta (85.6/54) al fotografiar un vehículo, y para que el enrolamiento existente no cambie ([camara.js:136](../public/js/camara.js#L136), [camara.js:171-201](../public/js/camara.js#L171-L201)).

La foto capturada entra por la **misma** tubería que un archivo adjunto (`onFileChange` solo necesita un objeto con `.files[0]`): compresión → `/documentos/stash` → token `tmp:` en la fila.

**e) Compresión más agresiva.** `comprimirImagenVehiculo` ([dashboard.js:1494](../public/js/dashboard.js#L1494)) usa `MAX = 1800px` / calidad `0.88` porque esas imágenes van a OCR con IA. La foto **no pasa por IA**, así que se comprime más: `MAX = 1280`, calidad `0.75` (≈120-200 KB en base64 vs. 400-700 KB). Se implementa con parámetro opcional:

```js
comprimirImagenVehiculo(file, { max: 1280, calidad: 0.75 })  // cuando col.ligera === true
```

manteniendo `1800 / 0.88` por default. Importa por el `client_max_body_size` de nginx: con la foto son **cuatro** imágenes por vehículo.

**f) Sin validación con IA.** `fieldId === 'foto'` no entra en la rama `webhookUrl` ([dashboard.js:1419-1420](../public/js/dashboard.js#L1419-L1420)) ni en la de documentos de personal ([dashboard.js:1425](../public/js/dashboard.js#L1425)): cae en el `else` final, que muestra `✅ nombre-archivo` y el botón `×`. No requiere código nuevo, solo **no** agregarla a esos `if`.

### 2.3 Guardado (backend)

En [routes/permisos.js](../routes/permisos.js):

1. **Resolver el token** — línea 491:
   ```js
   vehiculo: ['seguro', 'licencia', 'tarjeta_circulacion', 'tarjeta', 'foto']
   ```
   Sin esto se guardaría literalmente el string `tmp:abc123` en la columna.

2. **INSERT** — líneas 549-551: agregar `foto` a las columnas, `$23` a los `VALUES` y `v.foto||null` a los parámetros.

3. **Validación de obligatoriedad** (§2.5.5).

El `SELECT * FROM permiso_vehiculos` del detalle ([permisos.js:765](../routes/permisos.js#L765)) ya devuelve la columna nueva; el endpoint de consulta no cambia.

### 2.4 Visualización en la consulta del permiso

Único lugar donde se muestra. En la tabla de vehículos del detalle ([dashboard.js:2147-2167](../public/js/dashboard.js#L2147-L2167)):

- `<th>` nuevo **FOTO**, después de `PLACAS` y antes de `SERIE` (identifica el vehículo antes de la documentación).
- Celda con el mismo patrón que `seguro`:

```js
`<td>${v.foto ? `<img src="data:image/jpeg;base64,${v.foto}" onclick="verImgDoc(this.src)"
   style="height:36px;cursor:pointer;border:1px solid var(--border);object-fit:cover"
   title="Ver foto del vehículo">` : '—'}</td>`
```

Click → `verImgDoc` ([dashboard.js:3365](../public/js/dashboard.js#L3365)) abre el overlay a pantalla completa, igual que los demás documentos. Se conserva el guard `startsWith('/9j'|'iVB'|'data:')` de las otras celdas para tolerar valores que no sean imagen.

**Fuera de alcance por decisión explícita:** miniatura de vista previa en el formulario de captura (se queda el texto `✅ nombre-archivo`) y foto en el PDF de "DESCARGAR PASE" (ese PDF hoy ni siquiera incluye vehículos).

**Permisos anteriores al cambio:** `foto` en `NULL` → la celda muestra `—`. El detalle debe seguir abriendo sin error; esto se prueba explícitamente (§5).

### 2.5 Obligatoriedad — cinco puntos de bloqueo

La foto se exige en la misma cadena por la que hoy pasan seguro y licencia, para que el usuario se entere **antes** de intentar enviar y no después.

**1. Cálculo de validez de la fila** — `verificarDocumentosVehiculo` ([dashboard.js:1534](../public/js/dashboard.js#L1534)):

```js
const tieneFoto = !!row.foto;
row.validacion_foto = tieneFoto;
row.validacion_ok   = segVigente && licVigente && tieneFoto;   // antes: segVigente && licVigente
...
if (!row.seguro || !row.licencia || !row.foto) {               // "⏳ Falta doc."
```

Y una línea más en la celda `VALIDACIÓN DOC.`: `✅ Foto del vehículo` / `❌ Falta foto`.

**2. Recalcular al cargar la foto.** Hoy `verificarDocumentosVehiculo` solo se llama dentro de la rama de IA ([dashboard.js:1462](../public/js/dashboard.js#L1462)). Como la foto no pasa por IA, hay que llamarla también desde la rama `else` de `onFileChange` ([dashboard.js:1472-1477](../public/js/dashboard.js#L1472-L1477)) cuando `tipo === 'vehiculo'`, seguida de `actualizarAlertaVehiculos()`.

**3. Recalcular al quitar la foto.** `clearDocumento` ([dashboard.js:1335-1370](../public/js/dashboard.js#L1335-L1370)) borra el campo y llama a `verificarBotonSubmit()`, pero **no recalcula `validacion_ok`**. Hay que agregar, para `tipo === 'vehiculo'`, la llamada a `verificarDocumentosVehiculo` + `actualizarAlertaVehiculos`.

> Esto corrige de paso un **hueco que ya existe hoy**: al quitar el seguro o la licencia con la `×`, la fila conserva `validacion_ok === true` y el botón de envío sigue habilitado. Con la foto obligatoria el hueco sería más visible, así que se arregla para los tres campos a la vez.

**4. Aviso visible de por qué está bloqueado** — `actualizarAlertaVehiculos`. El bucle de `problemas` (rojo) calla cuando falta un documento: `if (!fila.seguro || !fila.licencia) return;`. Sin aviso, el botón queda deshabilitado (por el punto 1, vía `verificarBotonSubmit`) **sin decir por qué**, que es la peor combinación posible.

Se agrega una lista `pendientes` que alimenta el aviso **ámbar**, con número de fila y qué falta:

```js
const faltan = [];
if (!fila.foto)     faltan.push('foto');
if (!fila.seguro)   faltan.push('seguro');
if (!fila.licencia) faltan.push('licencia');
if (faltan.length) pendientes.push(`Fila ${idx + 1}: falta ${faltan.join(', ')}`);
```

> **Cambio respecto al plan inicial:** la foto faltante iba a `problemas` (rojo, "No puedes crear la solicitud"). Se movió al aviso ámbar de *pendiente* porque una fila de vehículo recién agregada nace vacía, y marcarla en rojo de inmediato es gritar antes de tiempo. El bloqueo es el mismo; solo cambia el tono del mensaje.

**4-bis. Refrescar el aviso al agregar/quitar filas.** `addRow` y `deleteRow` ([dashboard.js:1218-1241](../public/js/dashboard.js#L1218-L1241)) no llamaban a `actualizarAlertaVehiculos` ni a `verificarBotonSubmit`. Con la foto obligatoria eso significa que al pulsar "AÑADIR VEHÍCULO" la fila nueva nace incompleta pero el botón sigue habilitado por las filas anteriores. Se agregan ambas llamadas para `tipo === 'vehiculo'` (y `deleteRow` limpia además su entrada en `vehicValidaciones`).

**5. Bloqueo al enviar** — [dashboard.js:1648-1662](../public/js/dashboard.js#L1648-L1662), backstop con mensaje propio:

```js
if (!v.foto) {
  alertEl.innerHTML = `❌ <strong>Vehículo "${placa}"</strong>: debe adjuntar la foto del vehículo.`;
  ...
}
```

**6. Validación en servidor** — `POST /solicitudes`, después de resolver los tokens ([permisos.js:512](../routes/permisos.js#L512)) y antes del INSERT del permiso:

```js
const sinFoto = (secciones?.vehiculo || [])
  .filter(v => (v.marca || v.placas) && !v.foto)
  .map(v => v.placas || v.marca);
if (sinFoto.length) {
  return res.status(400).json({ success: false,
    error: `Falta la foto del vehículo: ${sinFoto.join(', ')}.` });
}
```

El filtro `(v.marca || v.placas)` replica el criterio de "fila con datos" que ya usa el INSERT ([permisos.js:549](../routes/permisos.js#L549)), para no rechazar filas vacías que de todos modos se descartan. **Es lo que hace real el requisito "si no, no se guarda el permiso"**: la validación de cliente se puede saltar, la de servidor no.

### 2.6 Lo que NO cambia

- La foto **no** afecta el cálculo de vigencias: `validacion_seguro_vigente` y `validacion_licencia_vigente` siguen igual. Solo entra en el `&&` final de `validacion_ok`.
- Ninguna de las validaciones nuevas se condiciona a `isPaseVisitaActive()` (§1.1).
- El flujo de aprobación, el PDF de pases y el enrolamiento de credenciales no se tocan.

### 2.7 Webhook n8n (nota de riesgo)

`enviarWebhookPermiso` ([permisos.js:129-141](../routes/permisos.js#L129-L141)) hace `SELECT *` y manda **todas** las columnas de vehículos. Con la foto, cada vehículo suma ~150 KB a un POST que ya carga seguro + tarjeta + licencia. Recomendación:

```js
vehiculos: rVeh.rows.map(({ foto, ...v }) => v)
```

Si n8n sí necesita la foto, se deja como está y se documenta el crecimiento del payload.

---

## 3. Archivos tocados

| Archivo | Cambio |
|---|---|
| `server.js` | +1 migración `ALTER TABLE permiso_vehiculos ADD COLUMN IF NOT EXISTS foto TEXT` |
| `db/schema.sql` | +1 columna en `permiso_vehiculos` (documentación) |
| `public/js/camara.js` | `DocScanner.abrir(cb, opciones)` + `abrirCamaraCampo()` |
| `public/js/dashboard.js` | columna `foto` en `SECTION_COLS`; botón 📷 en `buildRowHTML`; parámetros de compresión; obligatoriedad en `verificarDocumentosVehiculo`, `onFileChange`, `clearDocumento`, `actualizarAlertaVehiculos` y el submit; `<th>/<td>` FOTO en el detalle |
| `routes/permisos.js` | `camposDoc.vehiculo`; columna en el INSERT; validación 400 (+ opcional: filtrar foto del webhook) |

**Sin dependencias nuevas. Sin cambios de contrato en la API** (el detalle solo devuelve un campo más; `POST /solicitudes` gana un caso de 400).

---

## 4. Criterios de aceptación

**Captura**
1. En **Vehículos**, cada fila muestra "FOTO DEL VEHÍCULO *" con **Adjuntar** y **📷**.
2. Las tres formas cargan la foto: archivo del equipo, galería del móvil, y cámara in-app.
3. En móvil, el botón "Adjuntar" sigue ofreciendo **cámara y galería** (no se forzó `capture`).
4. **📷** abre la cámara trasera con el marco de vehículo y la foto queda cargada sin recargar la página.
5. La `×` limpia la foto y se puede cargar otra.

**Obligatoriedad (en permiso normal y en pase de visita)**

6. Vehículo con seguro y licencia vigentes pero **sin foto** → botón de envío **deshabilitado** y aviso visible "Fila N: FALTA FOTO DEL VEHÍCULO".
7. Al cargar la foto, el aviso desaparece y el botón se habilita.
8. Al quitar la foto con la `×`, el botón se **vuelve a deshabilitar** (y lo mismo al quitar seguro o licencia).
9. Un `POST /solicitudes` con un vehículo sin foto responde **400** y **no crea el permiso** (verificable con la petición directa, saltándose la UI).
10. Un permiso **sin sección de vehículos** se sigue creando normal.

**Visualización**

11. En el detalle del permiso, la columna **FOTO** muestra la miniatura; al hacer click se abre a pantalla completa.
12. Permisos creados **antes** del cambio se abren sin error y muestran `—` en FOTO.
13. La validación de vigencias de seguro/licencia se comporta exactamente igual que antes.

## 5. Pruebas manuales

- **Los dos flujos:** repetir el alta completa con el toggle de Pase de Visita apagado y encendido.
- Escritorio: adjuntar JPG y PNG grandes (>5 MB) → comprimen y suben sin 413.
- Móvil Android/iOS: las tres vías (archivos, galería, 📷).
- iPhone con HEIC: debe salir el mensaje de formato no compatible que ya existe, no un error genérico.
- **Peor caso de tamaño:** permiso con 3 vehículos, cada uno con foto + seguro + tarjeta + licencia. Ojo: cada imagen sube por separado a `/documentos/stash` y el POST final a `/solicitudes` solo lleva los tokens, así que el límite de nginx aplica **por imagen**, no por permiso; la foto es la más ligera de las cuatro. Lo que sí crece es la fila en la BD.
- Abrir un permiso viejo (columna en `NULL`) y uno nuevo, comparar la tabla de vehículos.

---

## 6. Hallazgo aparte (no bloquea)

`public/js/permisos.js` es una copia de código **de servidor** (contiene `pool.query`, SQL e INSERTs) que vive dentro de `public/` y por lo tanto se sirve públicamente en `/js/permisos.js`. Ninguna vista lo carga — es un archivo muerto que expone el esquema y las consultas de la base. Conviene borrarlo o moverlo fuera de `public/`, independiente de esta funcionalidad.
