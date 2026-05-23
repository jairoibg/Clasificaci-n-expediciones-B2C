# Bitácora de problemas y soluciones

> Registro cronológico de TODOS los bugs reportados y sus correcciones.
> Cada entrada incluye: síntoma, causa raíz, solución, archivos afectados
> y commit. El objetivo es **no volver a tropezar dos veces con la misma piedra**.

---

## Convenciones

- **Síntoma**: lo que el usuario reportó / vio
- **Causa raíz**: por qué pasaba realmente
- **Solución**: qué se cambió
- **Archivos**: ficheros modificados
- **Commit**: hash y mensaje
- **Lección**: qué aprender para no repetirlo

---

## 2026-05-20 a 2026-05-22 · Sesión completa

### #001 · Informe de cobertura: filtro de carrier solo muestra CORREOS

**Síntoma**
El selector "Todos los transportistas" del informe solo ofrece "CORREOS",
los demás transportistas no aparecen. Trackings claramente GLS, SPRING o
INPOST aparecen marcados como CORREOS.

**Causa raíz**
En `/api/odoo-outs`, la detección de carrier corría en este orden:
1. `detectCarrierFromOdooName(odooCarrierName)` ← primero
2. Índice
3. Prefijos

Casi todos los envíos en Odoo tienen carrier "Correos - SC - Gold"
(genérico de la integración Sendcloud), así que el paso 1 devolvía
'CORREOS' para casi todo y los demás pasos nunca se ejecutaban.

**Solución**
Reordenar prioridad: prefijos primero (O(1) regex), luego índice exacto
(O(1) hash), y nombre Odoo solo como último fallback.

**Archivos**: `server.js` (función `/api/odoo-outs`)
**Commit**: `e4fa163`
**Lección**: cuando varios métodos de detección compiten, el más
específico/preciso debe ir primero. Los nombres genéricos en Odoo no
son confiables.

---

### #002 · DESCONOCIDO bloquea adición manual desde búsqueda por cliente

**Síntoma**
Tras buscar un pedido por cliente y seleccionarlo, sale modal de error:
"Este paquete es de DESCONOCIDO, no de SPRING". Caso reportado:
DF121267SF (tracking `6C16371739852`).

**Causa raíz**
El índice clasificaba `6C16371739852` como `DESCONOCIDO` (prefijo `6C16`
no estaba mapeado). En `/api/add-tracking`, la condición
`if (det.carrier && det.carrier !== carrierUpper)` consideraba
`'DESCONOCIDO'` como un carrier real y bloqueaba.

**Solución**
Añadir excepción para DESCONOCIDO en las comparaciones:
```javascript
if (det.carrier && det.carrier !== 'DESCONOCIDO' && det.carrier !== carrierUpper)
```
Cuando el operario ya buscó manualmente, DESCONOCIDO no debe bloquear.

**Archivos**: `server.js` (`/api/scan`, `/api/add-tracking`)
**Commit**: `1417bd9`
**Lección**: cualquier validación de carrier debe excluir explícitamente
DESCONOCIDO, que es nuestro marcador interno de "no sé qué es".

---

### #003 · Tracking en índice como DESCONOCIDO corta cadena de detección

**Síntoma**
Pedido CO524490 (SPRING, tracking `00373165001905160005`) no se reconoce
automáticamente al escanear. Sale modal NO_VERIFICADO.

**Causa raíz**
`getCarrierFromTracking` encontraba el tracking en el índice como
DESCONOCIDO y se paraba ahí — no consultaba Sendcloud que SÍ sabía que
era SPRING.

**Solución**
Si el índice devuelve DESCONOCIDO, reutilizar los datos del picking
pero continuar la cadena de detección (Sendcloud cache → API).

```javascript
if (indexResult && indexResult.carrier !== 'DESCONOCIDO') {
  return ...; // Trust the index
}
// Si era DESCONOCIDO o no estaba, continuar con Sendcloud
```

**Archivos**: `server.js` (`getCarrierFromTracking`)
**Commit**: `c253ac4`
**Lección**: DESCONOCIDO en el índice no es información válida, es la
ausencia de información — siempre intentar más fuentes.

---

### #004 · H10* trackings clasificados como SPRING cuando son ASENDIA

**Síntoma**
Pedido DF1278396EU (tracking `H1031240024484601051`) es ASENDIA pero el
sistema lo detecta como SPRING y bloquea el escaneo al palet de ASENDIA.

**Causa raíz**
Sendcloud clasifica los trackings que empiezan por `H10` como SPRING
porque ASENDIA usa SPRING como sub-transportista en algunas rutas.
Pero físicamente son envíos ASENDIA.

**Solución (v1)**
Función `overrideCarrier(carrier, tracking)`: si tracking empieza por
`H10` y Sendcloud dice SPRING, forzar a ASENDIA. Aplicado en 3 puntos
de `getCarrierFromTracking` (índice, cache, API) y en sync-full.js.

**Commit**: `d35a428`

**REGRESIÓN inmediata #004b**
Pedidos `H1023311...` que ERAN SPRING ahora salían como ASENDIA. El
override era demasiado amplio.

**Solución (v2 - definitiva)**
Restringir el override a `^H103` (no `^H10`):
- `H102*` = SPRING ✓
- `H103*` = ASENDIA ✓

**Archivos**: `server.js` + `sync-full.js` (función `overrideCarrier`,
prefix patterns en 4 sitios)
**Commit**: `9865371`
**Lección**: nunca generalizar un override a partir de un solo caso.
Mirar siempre TODOS los formatos de tracking que comparten prefijo
antes de decidir.

---

### #005 · INPOST detectado como CORREOS por colisión accidental

**Síntoma**
Pedido CO523805 (INPOST, tracking `83261670`) y otros muchos INPOST se
detectan como CORREOS. Operario ve "Es de CORREOS, no de INPOST".

**Causa raíz (en cascada)**
1. Los barcodes físicos INPOST encriptan el tracking de 8 dígitos
   embebido en cadenas largas (ej: `13083299791010104013`).
2. `extractInpostTracking` extraía SIEMPRE posiciones 2-10 → obtenía
   `08329979` en lugar del real `83299791`.
3. Ese tracking inventado no se encontraba en el índice INPOST.
4. El sistema caía al lookup de Odoo con el barcode completo.
5. Odoo devolvía un picking CORREOS distinto que casualmente tenía un
   tracking similar.
6. Resultado: "Es de CORREOS".

**Solución**
**Sliding window** en `extractInpostTracking`: probar TODAS las posiciones
posibles de 8 dígitos consecutivos y devolver la primera que coincida
con un INPOST conocido del índice.

```javascript
for (let i = 0; i <= scannedClean.length - 8; i++) {
  const candidate = scannedClean.substring(i, i + 8);
  if (inpostIndex[candidate]) {
    return { extracted: candidate, position: i, source: 'index-inpost' };
  }
}
```

Además, `overrideCarrier` también escanea ventanas de 8 dígitos en
barcodes largos numéricos para forzar INPOST si alguna ventana coincide.
También añadido `83` a los prefijos INPOST (antes solo `04`/`81`).

**Archivos**: `server.js` (`extractInpostTracking`, `overrideCarrier`,
`getCarrierFromTracking`)
**Commit**: `bf2d72e`
**Lección**: NUNCA asumir que un tracking embebido está en una posición
fija dentro de un barcode largo. Usar sliding window + matching contra
índice real.

---

### #006 · Búsqueda por pedido CO*/KA* no encuentra resultados

**Síntoma**
`/api/search-client/CO523805` devuelve 0 resultados aunque el pedido
existe. Lo busca como nombre de cliente en lugar de como número de
pedido.

**Causa raíz**
El regex `isOrderRef` solo reconocía `DF|SO|PO|WH|S` como prefijos
de pedido. Faltaban `CO` (Coruña) y `KA` (Madrid).

**Solución**
```javascript
const isOrderRef = /^(DF|SO|PO|WH|S|CO|KA)\d/i.test(searchTerm);
```

**Archivos**: `server.js` (`/api/search-client`)
**Commit**: `614dd46`
**Lección**: cuando se añadan códigos de pedido nuevos a la operativa
(ej: nuevo almacén o división), actualizar TODAS las regex de detección.

---

### #007 · GLS no reconoce barcodes con Z89 embebido (formato SSCC)

**Síntoma**
Pedido CO525588 (GLS, tracking `Z89TJVNX`) no se reconoce si el operario
escanea el barcode SSCC completo (`00340014240000Z89TJVNX`).

**Causa raíz**
La detección GLS solo entendía:
1. Tracking directo `Z89XXXXX`
2. QR estándar `ESxxxxxxxxCCE`

No reconocía barcodes con `Z89XXXXX` embebido en cualquier posición.

**Solución**
Sliding window en `extractSpecialPatterns`: si el barcode contiene `Z89`
seguido de 5 caracteres alfanuméricos en cualquier posición, validar
formato y buscar en el índice GLS.

**Archivos**: `server.js` (`extractSpecialPatterns`)
**Commit**: `fe33a72`
**Lección**: cada transportista tiene N formatos de barcode físico. El
operario escanea CUALQUIERA de ellos. Soportar el tracking embebido en
cualquier formato.

---

### #008 · Sendcloud sync limitado a 10.000 envíos (cap silencioso)

**Síntoma**
Cobertura del índice solo del 38%. Muchos envíos sin match.

**Causa raíz**
La API de Sendcloud **ignora silenciosamente** el parámetro `limit=500` y
devuelve solo **100 envíos por página**. El sync paginaba hasta 100
páginas máximo → cap real de 10.000 envíos. Con ~3.000 envíos/día * 7
días = ~21.000 envíos, perdíamos más de la mitad.

**Solución**
Aumentar `MAX_PAGES` de 100 a 500 en `fetchSendcloudParcels`. Con 100
envíos/página × 500 páginas = hasta 50.000 envíos. Tiempo de sync sube
~50 segundos pero solo corre cada 4-6 horas.

Cobertura del índice subió de **38% a 99.9%**.

**Archivos**: `sync-full.js` (`fetchSendcloudParcels`)
**Commit**: `ed9f854`
**Lección**: nunca confiar que los parámetros de API (especialmente
`limit`) se respetan. Verificar empíricamente. Documentar caps reales.

---

### #009 · Índice sin datos de validación cruzada

**Síntoma**
Difícil hacer búsquedas avanzadas, no se puede verificar peso/destino al
escanear, no se detectan duplicados.

**Solución**
Enriquecer cada entrada del índice con:
- **Odoo**: partnerId, saleId, saleName, weight, dateDone, odooCarrierName
- **Sendcloud**: country (ISO-2), postalCode, city, weight, shipmentName

Construir índices auxiliares post-sync:
- `byOrderRef`: O(1) lookup por número de pedido
- `byClientName`: O(1) lookup por primer nombre del cliente
- `duplicateTrackings`: detecta trackings duplicados en >1 picking

**Archivos**: `sync-full.js` (sección PASO 3.5)
**Commit**: `ed9f854`
**Lección**: el índice debe contener todo lo necesario para hacer la
mayoría de operaciones SIN consultar Odoo. Cada lookup adicional cuesta
~500-1500ms.

---

### #010 · Búsqueda por cliente lentísima (2-3 segundos)

**Síntoma**
`/api/search-client` tarda 2-3s por cada búsqueda porque siempre consulta
Odoo via XML-RPC.

**Solución**
Buscar primero en `byOrderRef` y `byClientName` (índices auxiliares O(1))
antes de caer a Odoo. Pasó de 2.388ms a **1ms** para búsquedas en índice
(2400× más rápido).

**Archivos**: `server.js` (`/api/search-client`)
**Commit**: `ed9f854`
**Lección**: cualquier endpoint que se usa frecuentemente debe tener
una ruta rápida en memoria.

---

### #011 · Informe de cobertura · filtros faltantes

**Síntoma**
Operadores piden filtrar por compañía (Black/Gold/White) y por
presencia/ausencia de tracking.

**Solución**
Dos nuevos filtros en `informe-cobertura.html`:

1. **Compañía/División**:
   - `CLABD/...` → Black Division
   - `CLAGD/...` → Gold Division
   - `CLAWD/...` → White Division

2. **Tracking**:
   - Con tracking (tienen `carrier_tracking_ref`)
   - Sin tracking (los que aparecen con `—`)

**Archivos**: `public/informe-cobertura.html`, `public/cobertura.js`
**Commits**: `b68301a` (división), `ff53d34` (tracking)
**Lección**: documentar siempre los prefijos de albarán nuevos en
`MATCHING-RULES.md`.

---

### #012 · Informe de cobertura no se autorefresca

**Síntoma**
Operario escanea un paquete pero el informe sigue mostrando "sin escanear"
hasta que pulse "Cargar informe" manualmente.

**Solución**
Función `silentRefresh()` que cada **45 segundos** hace un GET en background
sin spinner ni interrupción. Status bar muestra "OK · auto HH:MM:SS"
indicando datos en vivo.

**Archivos**: `public/cobertura.js`
**Commit**: `241e1a4`
**Lección**: cualquier dashboard operativo necesita refresh silencioso.

---

### #013 · /api/odoo-outs lento (8-15 segundos)

**Síntoma**
El informe tarda 8-15 segundos en cargar, especialmente con rangos
amplios o con el auto-refresh activo.

**Solución**
Caché del servidor TTL=30s con `Map`. Respuesta idéntica se devuelve
instantáneamente durante los próximos 30 segundos.

```javascript
const odooOutsCache = new Map();
const cached = odooOutsCache.get(cacheKey);
if (cached && (Date.now() - cached.timestamp) < 30000) {
  return res.json(cached.data); // instant
}
```

**Archivos**: `server.js` (`/api/odoo-outs`)
**Commit**: `241e1a4`
**Lección**: caché de 30s con auto-refresh de 45s es ideal — el operario
siempre ve datos frescos pero el servidor no se sobrecarga.

---

### #014 · Escaneo lento (3-10 segundos)

**Síntoma**
Algunos escaneos tardan 3, 5, hasta 10+ segundos en responder.

**Causa raíz**
1. `findInSendcloudCache` iteraba 50.000 entradas con `toUpperCase()` para
   match case-insensitive — O(n).
2. `findPickingByTracking` hacía hasta 10+ llamadas XML-RPC en cascada
   probando patrones (cada call ~500-1500ms = 10s total).
3. Sin timeout en Sendcloud API → podía colgarse.
4. Cuando tracking estaba en Sendcloud cache pero no en índice, el flujo
   pasaba por Odoo (lento) antes de llegar al cache (rápido).

**Solución (varias)**
1. **`findInSendcloudCache` O(1)**: construir índice `sendcloudCacheUpper`
   al cargar el cache, lookup case-insensitive instantáneo.
2. **Limitar patrones Odoo** a 3 máximo (en vez de 10+).
3. **Timeout 2.5s** en Sendcloud API con AbortController.
4. **🆕 Atajo cache+orderRef**: si Sendcloud cache tiene el tracking +
   orderId existe en `byOrderRef`, devolver inmediatamente sin Odoo.

```javascript
const directCache = findInSendcloudCache(clean);
if (directCache && directCache.orderId) {
  const byOrder = trackingIndex.byOrderRef[directCache.orderId.toUpperCase()];
  if (byOrder?.length) {
    return { carrier: directCache.carrier, picking: {...byOrder[0]}, source: 'cache+order' };
  }
}
```

**Archivos**: `server.js` (varios)
**Commits**: `241e1a4`, `0080ea2`
**Lección**: los lookups O(n) sobre 50k entradas son inaceptables. Cada
sub-función debe ser O(1) o tener fallback rápido.

---

### #015 · Operarios percibían scans como lentos aunque server respondía en <30ms

**Síntoma**
Server respondía en 5-26ms pero operarios sentían los scans lentos.

**Causa raíz**
- Latencia red España → Railway Singapur = ~250-400ms ida-vuelta
- Aunque server fuera rápido, total percibido era ~400-600ms
- UI esperaba la respuesta antes de dar feedback

**Solución**
**UI optimista**: incrementar contador, reproducir beep y añadir paquete
visualmente ANTES de la respuesta del servidor. Si servidor rechaza,
rollback automático.

```javascript
// 1. Añadir paquete optimista (pending=true, opacity 55%, check naranja)
state.packages.push(optimisticEntry);
playSound('success'); // beep inmediato
// 2. Servidor responde en background
const r = await apiCall('/scan', ...);
if (r.success) replace; else rollback();
```

**Archivos**: `public/index.html`
**Commit**: `e8d8bc0`
**Lección**: latencia de red no se puede evitar pero se puede ocultar
con UI optimista. El operario solo nota la respuesta del servidor si
hay un error.

---

### #016 · Match debe ser instantáneo, 0ms

**Síntoma**
Aun con UI optimista, el feedback no era literalmente instantáneo
porque dependía de la respuesta del servidor para los datos del paquete
(orderRef, clientName).

**Solución**
**Índice cliente**: descargar todo el índice (~20k trackings) al cargar
la app, en memoria como `Map<string, {pickingId, orderRef, clientName, carrier}>`.

Endpoint nuevo: `/api/scanning-index` devuelve array compacto
`[tracking, pickingId, orderRef, clientName, carrier]` por entrada con
ETag para revalidación 304.

Flujo nuevo:
```
Scan → localLookup(tracking) [0ms]
  ├─ Hash directo
  ├─ INPOST sliding window
  ├─ GLS sliding (Z89)
  └─ ASENDIA sliding (6C20)
  ↓
MATCH → mostrar pkg con datos REALES + beep + counter (0ms)
  ↓ background: POST /api/scan (persistir sesión)
```

**Archivos**: `server.js` (`/api/scanning-index`), `public/index.html`
(`loadClientIndex`, `localLookup`, `scanPackage`)
**Commit**: `c199644`
**Lección**: si tienes todos los datos en el servidor, también puedes
tenerlos en el cliente. El matcheo verdaderamente instantáneo solo es
posible con índice local.

---

### #017 · Pedido DF122214SF (Correos Express) bloqueado como DESCONOCIDO

**Síntoma**
Pedido DF122214SF muestra modal: "No se pudo verificar el transportista.
Busca por nombre de cliente."

**Causa raíz**
- Tracking `93005001313132701335831` (prefijo `93005` no mapeado)
- Carrier en Odoo dice solo "Correos" (no "Correos Express")
- El sistema bloqueaba aunque el operario sabía que era CRX

**Solución**
Si el operario YA seleccionó un transportista específico y el picking
existe en Odoo pero no se puede verificar el carrier, **confiar en el
operario** y permitir añadir al palet.

```javascript
if (!det.carrier || det.carrier === 'DESCONOCIDO') {
  console.log('⚠️ Carrier no verificado, confiando en selección del operario');
  // Continuar (no bloquear)
}
```

Si el carrier SÍ se determina y es diferente, sigue bloqueando.

**Archivos**: `server.js` (`/api/scan`)
**Commit**: `05246cf`
**Lección**: la verificación automática nunca será 100%. Cuando falle,
el operario es la mejor fuente de verdad — confiar en su decisión.

---

### #018 · Carga inicial de app lenta (6 segundos)

**Síntoma**
"Me dicen los support que el programa para leer les tarda mucho."

**Causa raíz**
- `/api/scanning-index` tardaba **6 segundos** en descargar (1.6 MB
  sin comprimir).
- Sin compresión HTTP habilitada en Express.
- Sin caché del navegador (`Cache-Control: no-cache`).
- Durante esos 6s los scans usaban la ruta lenta del servidor.

**Solución**
1. Instalar middleware `compression` en Express (gzip nivel 6).
2. Cambiar `Cache-Control` a `public, max-age=300, must-revalidate`.
3. Mantener ETag para revalidación 304.

Resultado esperado:
- Descarga: **1.6 MB → ~300-400 KB** (4-5x más pequeño)
- Tiempo: **6s → ~1-2s** (gzip)
- Refresh dentro de 5 min: caché del navegador (0ms)
- Refresh > 5 min: ETag check (~300ms)

**Archivos**: `server.js`, `package.json`
**Commit**: `6338382`
**Lección**: **siempre habilitar gzip** en servidores Express. Es una
línea de código y multiplica por 4-5 la velocidad de respuestas
grandes.

---

### #019 · Operarios reportan que la app sigue muy lenta

**Síntoma**
A pesar de las optimizaciones #014-#018, los operarios siguen sintiendo
la app lenta. "Sigue yendo muy lento."

**Diagnóstico**
1. **Bug en cache-control**: en la rama de cache-hit del endpoint
   `/api/scanning-index` quedó `no-cache` en lugar de `max-age=300`.
   El navegador descargaba el índice cada vez.
2. **Service Worker servía HTML/JS viejo**: la versión cacheada del SW
   no se invalidaba, los operarios usaban código antiguo.
3. **Cold starts de Railway**: el servidor en Singapore se "duerme" y
   tarda 5-15s en responder la primera petición tras inactividad.
4. **Input bloqueado por `await`**: el handler de Enter hacía
   `await scanPackage(t); e.target.value = ''` → el input no se
   limpiaba hasta que la petición al servidor terminaba (250-500ms+).
   Si el operario escaneaba rápido, sentía que cada scan tardaba.

**Solución (múltiple)**

1. **Fix cache-control en cache-hit branch**:
   ```javascript
   res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
   ```
   (antes: `'no-cache'`)

2. **Bump cache version del Service Worker** + estrategia
   "network-first sin caché" para HTML/JS/CSS. Los operarios siempre
   obtienen la última versión. CACHE_NAME ahora incluye fecha
   (`expediciones-v2-2026-05-22`).

3. **Keep-alive ping** cada 30 segundos desde el cliente al
   `/api/health` para evitar que Railway duerma el container.

4. **🔥 Input NO bloquea**: cambiar `await scanPackage(t)` a llamada
   síncrona sin await. El input se limpia INMEDIATAMENTE.
   ```javascript
   if (e.key === 'Enter') {
     const t = e.target.value.trim();
     if (t) {
       e.target.value = '';     // ← limpia YA
       scanPackage(t);          // ← background, no espera
     }
   }
   ```
   Aplicado en scanInput y pickupScanInput.

5. **Refresh de índice cada 2 min** (antes 5 min) para que pickings
   recientes estén disponibles antes.

**Archivos**: `server.js`, `public/sw.js`, `public/index.html`,
`package.json`
**Commit**: pendiente
**Lección**:
- Cualquier `await` en un handler de input bloquea la UI.
- Los Service Workers DEBEN invalidar caché cuando hay cambios.
- Cold starts son reales en Railway, mitigar con pings periódicos.
- Cuando una optimización no se nota, verificar primero que se
  desplegó correctamente y que el navegador no está usando caché viejo.

---

### #020 · Fallback legacy de INPOST extraía substrings aleatorios

**Síntoma**
Operario escaneaba CRX `93005001313132701335831` y el sistema hacía
3+ búsquedas a Odoo de ~3.5s cada una, sin encontrar nada. Total:
10-15 segundos de espera por scan.

Logs en servidor:
```
INPOST extraído de barcode: 00500131 (pos ?, source: legacy)
Índice DESCONOCIDO, intentando Sendcloud...
Consultando Sendcloud API...
No se pudo verificar transportista
No en índice, buscando en Odoo...
Odoo not found: 3478ms (×3)
```

**Causa raíz**
En `extractInpostTracking` había un fallback histórico:
```javascript
const candidate = scannedClean.substring(2, 10);
if (/^\d{8}$/.test(candidate)) {
  return { extracted: candidate, source: 'legacy' };
}
```

Para barcodes CRX/CORREOS de 23 dígitos como `93005001313132701335831`,
esto extraía posiciones 2-10 = `00500131` (un 8-dígito aleatorio que
NO es un tracking INPOST real).

El código intentaba buscar en Odoo con ilike `00500131`, que devolvía
**10+ resultados falsos** (esa secuencia aparece en muchos trackings
PK/PQ/93005 distintos). Todo el proceso tardaba 10+ segundos sin
servir para nada.

**Solución**

1. **Eliminar el fallback legacy** de `extractInpostTracking`. Solo
   devolver extracciones cuando:
   - Hay match exacto en índice INPOST
   - O cumple `^(04|81|83)\d{6}$` (prefijos INPOST verificados)

2. **Añadir prefijo `9300500` → CORREOS EXPRESS** en:
   - Detección por prefijo en `/api/odoo-outs`
   - sync-full.js fallback prefix
   - `overrideCarrier` para forzar CRX aunque Sendcloud diga otra cosa

3. **Forzar resync** para reclasificar todos los CRX existentes con
   tracking `93005...` que estaban como DESCONOCIDO o CORREOS.

**Archivos**: `server.js`, `sync-full.js`
**Commit**: pendiente
**Lección**:
- **NUNCA usar substring posiciones fijas para extraer trackings** sin
  validar contra un índice real. Los "fallbacks legacy" introducen
  más problemas que los que resuelven.
- Cuando se añade un prefijo de transportista (ej. `93005`),
  documentarlo en `MATCHING-RULES.md` y actualizar `overrideCarrier`
  para que sea autoritativo aunque Sendcloud no lo reconozca.

---

### #021 · Database.json gigante y sync poco frecuente

**Síntoma**
Logs muestran constantes "No en índice, buscando en Odoo... → Odoo not
found: 3369ms" incluso cuando el usuario cree que nadie escanea. El
informe muestra `Trackings en app: 185486 | PickingIDs: 184603` —
acumulación de MESES de palets.

**Causa raíz (múltiple)**
1. **Sync infrecuente**: solo a las 0/6/10/12/14h. Entre sync y sync hay
   2-6 horas durante las cuales los pickings nuevos creados en Odoo no
   están en el índice. Los scans de esos pickings caen al path lento
   (3-5s por Odoo XML-RPC).

2. **`saveData()` síncrono y completo** en cada escaneo: serializa y
   escribe el `database.json` completo (~30MB con 185k packages) en
   disco en cada `/api/scan`. Esto bloquea el event loop.

3. **Pretty-print JSON**: `JSON.stringify(database, null, 2)` añade
   indentación que hace el fichero ~30% más grande.

4. **Sin limpieza**: palets de hace 6 meses siguen en memoria y disco.

**Solución**

1. **Sync cada 30 min** en horario laboral (6-22h) + 2 nocturnos (0h, 4h).
   Antes: 5 syncs al día. Ahora: 36 syncs/día. Pickings recién creados
   están en el índice en máximo 30 min (antes podía tardar hasta 6h).

2. **Throttled saveData**: agrupar múltiples escaneos en escrituras cada
   2 segundos. Si 20 operarios escanean a la vez, solo 1 write/2s en
   vez de 20 writes/segundo.

3. **JSON compacto** (sin `, null, 2`): 30% más pequeño y más rápido.

4. **Endpoint `/api/cleanup-old?days=60`**: elimina palets/recogidas
   anteriores a N días. Reduce el tamaño del database.json
   considerablemente (de 185k packages a sólo los últimos 60 días).

5. **Save síncrono al SIGTERM/SIGINT**: garantiza guardado en restart.

**Archivos**: `server.js` (saveData, setupScheduledSync, cleanup-old)
**Commit**: pendiente
**Lección**:
- En sistemas con almacenamiento en JSON file, **throttle writes** es
  esencial. fs.writeFileSync con archivos grandes bloquea el event loop.
- Datos históricos deben tener política de retención. No hay nada que
  ganar manteniendo palets de hace 6 meses en memoria.
- La frecuencia de sync debe coincidir con la velocidad de creación de
  datos. Si crean 100+ pickings/hora, sync cada 30 min mantiene el
  índice fresco.

---

### #022 · Mantener histórico íntegro pero sin penalizar rendimiento

**Síntoma**
Solicitud explícita del usuario: "No podemos borrar el histórico,
arreglalo. Tenemos que tener todos los paquetes y palets". Tras el
fix #021 que proponía cleanup, hay que mantener TODO sin perder
velocidad.

**Causa raíz**
`/api/odoo-outs` iteraba todos los 185k+ paquetes en CADA petición para
construir los Sets `scannedTrackings`, `scannedPickingIds` y
`extractedOdooTrackings`. Esto tarda ~500-1500ms y se repetía en cada
auto-refresh del informe.

**Solución: Sets precomputados globales**

Creamos 4 estructuras globales que se construyen UNA VEZ al cargar la
app y se actualizan INCREMENTALMENTE en cada escaneo:

```javascript
const globalScannedTrackings = new Set();      // Todos los trackings
const globalScannedPickingIds = new Set();     // Todos los pickingIds
const globalExtractedTrackings = new Set();    // Patrones ASENDIA/INPOST
const globalLongScannedBarcodes = [];          // Solo barcodes >=15 chars
```

**Inicialización (`rebuildGlobalScans()`):**
- Al arrancar la app, itera 185k paquetes UNA SOLA VEZ
- Tarda ~1-2 segundos al inicio
- Después de eso, todas las consultas son O(1)

**Actualización incremental (`_addPackageToGlobalSets()`):**
- En cada `addPackageToSession` se añade al Set global
- No se elimina nunca (coherente con histórico permanente)

**Resultado en `/api/odoo-outs`:**
- Antes: ~500-1500ms construyendo los Sets en cada petición
- Ahora: ~0ms (los Sets ya están construidos)
- El matching avanzado solo itera `globalLongScannedBarcodes` (~10k
  barcodes largos en lugar de 185k totales)

**Archivos**: `server.js` (rebuild + _add + endpoint stats)
**Eliminado**: endpoint `/api/cleanup-old` (a petición del usuario)
**Añadido**: endpoint `/api/history-stats` para ver tamaño del histórico
**Commit**: pendiente
**Lección**:
- Cuando el histórico crece sin límite, NO borrar — precomputar en
  estructuras eficientes.
- Las actualizaciones incrementales son siempre más baratas que
  reconstrucciones completas.
- Para datos que solo crecen (append-only), los Sets son ideales:
  añadir es O(1) y consultar es O(1).

---

## Problemas técnicos generales (no del código)

### #G1 · Railway deploy atascado / cola bloqueada

**Síntoma**
Deploy aparece como "DEPLOYING" o "QUEUED" durante 15+ minutos sin
avanzar.

**Solución**
1. Opción manual: en Railway dashboard, `...` → "Remove" o "Redeploy"
   del deploy atascado.
2. Opción automática: `git push --force-with-lease` con un squash que
   reemplace todos los commits pendientes.

**Lección**: Railway en Southeast Asia tiene picos de carga. Si hay
varios deploys en cola, force-push limpia la cola y procesa solo el
último.

---

### #G2 · Service Worker cachea versión vieja

**Síntoma**
Operarios siguen viendo la UI antigua incluso después de un deploy
exitoso.

**Solución**
Recargar con **Ctrl+Shift+R** (Windows/Linux) o **Cmd+Shift+R** (Mac).
Si no funciona: DevTools → Application → Service Workers → Unregister
→ Clear site data → Recargar.

**Lección**: cualquier cambio en `public/sw.js` debe incrementar
`CACHE_NAME` para forzar la invalidación.

---

## 2026-05-24 · Feature multi-palet + reabrir

### #023 · Soporte multi-palet simultáneo por transportista

**Síntoma / Necesidad**
Carriers de alto volumen (SPRING con 800+/día) saturaban un único palet
abierto. Los operarios necesitaban poder trabajar en varios palets a la
vez del mismo transportista (Palet A, B, C…) sin perder el control.

Además: si al final del día cerraban un palet por inactividad o para
imprimir etiqueta, al día siguiente al continuar añadiendo envíos había
que crear otro palet — fragmentando la operativa. Querían **reabrir**
el palet cerrado y seguir añadiendo paquetes ahí.

**Solución**
Refactorización del modelo de sesiones en `database.json`:

```diff
- activeSessions[carrier] = { packages: [...], lastUpdate }
+ activeSessions[carrier] = [
+   { id, letter:'A', packages:[...], createdAt, lastUpdate, fromPalletId:null },
+   { id, letter:'B', packages:[...], createdAt, lastUpdate, fromPalletId:null }
+ ]
```

Migración automática al boot: si encuentra el formato viejo lo convierte
a `[{ ..., letter:'A' }]` sin perder datos.

**Endpoints nuevos / actualizados**
- `GET  /api/sessions` → ahora devuelve `palletCount` y `sessions[]` por carrier
- `GET  /api/sessions/:carrier` → devuelve todas las sesiones del carrier
- `POST /api/sessions/:carrier/open` → abre una nueva sesión (siguiente letra)
- `DELETE /api/sessions/:carrier/:sessionId` → cierra una sesión concreta
- `POST /api/scan` y `POST /api/add-tracking` → aceptan `sessionId` opcional
- `POST /api/pallets` → acepta `sessionId` para cerrar solo esa sesión
- `DELETE /api/session/:carrier/package/:tracking?sessionId=…` → borra del palet correcto
- `POST /api/pallets/:id/reopen` → **NUEVO**: reabre palet cerrado como sesión activa

El endpoint de reabrir devuelve `{ carrier, sessionId, sessionLetter, packages }`
para que el frontend pueda navegar al Scan con todo cargado.

**Detección de duplicados**
`addPackageToSession` busca el tracking en TODAS las sesiones del carrier
(no solo la activa) para impedir doble escaneo en palets distintos.

**Frontend (`public/index.html`)**
- Estado nuevo: `selectedSessionId`, `sessionsDetail`
- Modal selector de palet cuando hay 2+ palets abiertos al seleccionar carrier
- Barra "Palet activo" en el scanner con botón "Cambiar" (solo si hay >1)
- Badge "N ABIERTOS" en la tarjeta del carrier
- Botón "↻ Reabrir" en cada palet pendiente del tab Palets
- Al reabrir: navega automáticamente al tab Clasificar con los envíos
  cargados en el carrier+sesión correspondiente
- Service worker bumpeado a `expediciones-v3-2026-05-24-multipalet`

**Archivos**:
- `server.js` (refactor sesiones, 6 endpoints nuevos/actualizados)
- `public/index.html` (estado, CSS, modal, JS handlers, render)
- `public/sw.js` (bump CACHE_NAME)
- `FIXES-LOG.md` (esta entrada)

**Commit**: pendiente

**Lección**:
- Cambios de modelo (objeto → array) siempre con migración silenciosa al boot
- Los duplicados deben revisarse a nivel agregado (todas las sesiones del
  carrier), no por sesión individual
- Status `reopened` permite mantener histórico sin contaminar las listas
  de palets pendientes / recogidos

---

## Pendientes / Mejoras futuras

- [ ] Webhook Sendcloud para sincronizar en tiempo real al crear envío
- [ ] Cambiar Railway region a EU (reducir latencia ~250ms → ~50ms)
- [ ] Versión offline-first con Service Worker para almacén sin red
- [ ] Auditoría diaria de tracks DESCONOCIDOs (alerta proactiva)
- [ ] Dashboard de operario (productividad personal)

---

## Plantilla para nuevas entradas

```markdown
### #XXX · [Título breve del problema]

**Síntoma**
Lo que el usuario vio / reportó.

**Causa raíz**
Por qué pasaba realmente. Si fue en cascada, listar paso a paso.

**Solución**
Qué se cambió en el código (con snippet si aplica).

**Archivos**: lista de archivos modificados
**Commit**: hash + mensaje
**Lección**: qué aprender para no volver a tropezar.
```
