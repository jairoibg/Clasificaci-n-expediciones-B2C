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

## 2026-05-25 · Spring guard

### #024 · Falsos positivos SPRING → INPOST por sliding window de 8 dígitos

**Síntoma**
Operarios reportan que pedidos SPRING se detectan como INPOST. Casos
concretos: `DF1289908EU` y `DF1290868EU` (ambos SPRING) la app dice
"es de INPOST".

**Causa raíz**
El sliding window de 8 dígitos consecutivos que usamos para detectar
INPOST embebido en barcodes largos numéricos es muy permisivo. Los
barcodes físicos de SPRING también son largos numéricos (GS1-128 con
tracking embebido tras prefijos `0626` o `0008`). Si dentro del
barcode SPRING aparecen 8 dígitos consecutivos que casualmente coinciden
con un tracking INPOST del índice → falso match.

Esto ocurría tanto en:
1. `localLookup` del cliente (sliding INPOST en frontend)
2. `extractInpostTracking` del servidor
3. `overrideCarrier` del servidor (sliding de 8 dígitos como override)

**Solución**
Nuevo helper `looksLikeSpringBarcode(clean)` que detecta barcodes con
patrón `0626\d{8,}` o `0008\d{8,}` (al menos 18 chars). Como guard
ANTES de cualquier sliding INPOST:

- `localLookup` (frontend): añade paso "SPRING sliding window" ANTES
  de INPOST. Prueba substrings de longitud 12-16 desde `0626`/`0008`.
- `extractInpostTracking` (server): si parece SPRING, no hace sliding.
- `overrideCarrier` (server): el override INPOST por sliding ya no se
  dispara si parece SPRING.

**Archivos**: `server.js`, `public/index.html`, `public/sw.js`

**Commit**: pendiente

**Lección**:
- Cuando varias reglas heurísticas compiten sobre el mismo formato
  (largo numérico), añadir guards específicos por carrier ANTES de la
  regla más permisiva (la de menos dígitos).
- El sliding INPOST de 8 dígitos es la regla más débil → debe ir
  siempre al final del cascade.

---

## 2026-05-25 · Diagnóstico CRX y sync pendientes

### #025 · CRX (CORREOS EXPRESS / MIKA) no se reconoce: pickings en Odoo sin tracking

**Síntoma**
Operario reporta que pedidos como `DF122521SF` (CRX) no se reconocen
al escanear la etiqueta física `9300500...`. La app dice "no existe
en Odoo" pese a que la detección de carrier por prefijo es correcta.

**Diagnóstico exhaustivo** (vía nuevo endpoint `/api/diag-tracking`)

1. La detección de carrier funciona: `9300500...` → CRX vía prefijo.
2. El tracking físico **no está en Odoo** (`carrier_tracking_ref` no
   coincide con ninguno).
3. **CRX no usa Sendcloud** para generar etiquetas (integración MIKA
   directa Odoo↔CRX). Sendcloud devuelve `parcels: []` incluso para
   trackings CRX que sí están en Odoo desde hace días.
4. Los pickings CRX se crean en Odoo en `state: waiting` con
   `carrier_tracking_ref: false`. MIKA actualiza el tracking con
   retraso (horas).
5. Nuestro sync filtraba `carrier_tracking_ref != false` → los CRX
   pendientes quedaban FUERA del índice.
6. Resultado: solo 17 CRX en el índice (vs 5682 CORREOS, 9818 SPRING)
   porque solo entraban los que ya tenían tracking sincronizado.

**Solución**
- `sync-full.js`:
  - Domain Odoo: `OR carrier_id.name ilike 'mika'` (incluir CRX
    aunque no tengan tracking todavía).
  - Procesamiento: pickings CRX sin tracking → array
    `trackingIndex.pendingCrx` (no entran en `byTracking` pero sí
    en `byOrderRef` y `byClientName` vía paso 3.5).
- `server.js`:
  - `/api/scan`: si el tracking matchea `^9300500\d` y no se encuentra
    en Odoo, devolver `error: 'CRX_NO_SINCRONIZADO'` con mensaje
    específico explicando el delay de MIKA y sugiriendo buscar por
    nº de pedido.
- `public/index.html`: nuevo handler para `CRX_NO_SINCRONIZADO`
  mostrando el modal con info útil (en vez de búsqueda por cliente).
- Endpoint `/api/diag-tracking/:tracking` para diagnóstico futuro
  (con flags `?live=1`, `?sendcloud=1`, `?scTrack=1`, `?scOrder=…`,
  `?odooOrigin=…`, `?listCrx=1`).

**Vínculo encontrado** (actualización tras imagen de etiqueta)
La etiqueta CRX imprime el "ID del pedido" (13 dígitos, ej.
`8954434852216`) junto al barcode. Ese mismo ID se guarda en el campo
`note` del picking de Odoo (formato `<p>NUMERO</p>`).

Aprovechando esto:
- `sync-full.js` extrae `crxOrderId` del `note` para TODOS los pickings
  (no solo carrier MIKA — el caso DF122521SF tenía `carrier_id="Correos"`
  en Odoo pero etiqueta física CRX, un mismatch que solo se resuelve
  por el ID en `note`).
- Se quita el filtro `carrier_tracking_ref != false` del dominio Odoo
  para incluir pickings sin tracking todavía.
- Nuevo índice `trackingIndex.byCrxOrderId` para lookup O(1) por ID
  externo.
- `/api/search-client/:name` detecta inputs de 10-15 dígitos y consulta
  `byCrxOrderId` antes de Odoo (instantáneo).
- Frontend: cuando el operario escanea un CRX no encontrado, el modal
  CRX le pide el "ID del pedido" (no el nº de pedido ni el cliente).
  Al seleccionar el resultado, se usa el tracking físico que escaneó
  para asociarlo con el picking encontrado.

**Flujo final del operario**:
1. Selecciona palet CRX
2. Escanea barcode `9300500...`
3. Si la app no lo encuentra (MIKA aún no ha actualizado), aparece
   modal "CRX: busca el ID del pedido"
4. Operario lee de la etiqueta el ID (`8954434852216`) y lo tipea
5. Aparece `DF122521SF | CORREOS EXPRESS | ⏳ Tracking pendiente`
6. Lo selecciona → entra al palet CRX con el tracking físico

**Archivos**:
- `server.js` (endpoint diag + manejo CRX_NO_SINCRONIZADO en /api/scan)
- `sync-full.js` (dominio Odoo ampliado + procesamiento CRX pendientes)
- `public/index.html` (handler nuevo error)
- `public/sw.js` (cache bump)
- `FIXES-LOG.md` (esta entrada)

**Lección**:
- No todas las "no encontrado" son bugs de detección: pueden ser
  problemas de SINCRONIZACIÓN aguas arriba.
- Tener un endpoint de diagnóstico (`/api/diag-tracking`) que muestre
  TODO lo que el sistema sabe sobre un input es invaluable para
  diagnosticar este tipo de casos sin desplegar versiones nuevas.
- Cuando una integración tiene formato/flujo distinto al estándar
  (CRX vs Sendcloud), documentarlo en el código y en este log.

---

## 2026-05-26 · Fast-fail para evitar "Application failed to respond"

### #026 · Scans tardan 4-5s y proxy Railway devuelve 502

**Síntoma**
Operarios reportan modal recurrente "Error · Application failed to
respond" (mensaje genérico del proxy de Railway). No ocurre con un
pedido concreto, es aleatorio.

**Diagnóstico**
Test directo confirmó que `/api/scan` con un tracking inexistente
(NOEXISTETEST123) tardaba **4.7 segundos** en responder. Causa:

- Si el tracking no está en el índice, `findPickingByTracking` hace
  hasta 5 búsquedas en Odoo (exact + ilike + 3 patterns) sin timeout.
- Cada búsqueda Odoo es ~1-2s vía XML-RPC.
- Total acumulado: 3-7s por scan no-encontrado.
- Cuando varios operarios escanean a la vez trackings que caen a
  Odoo, las peticiones se acumulan y el proxy Railway timeout.
- El sync programado (cada 30 min) tarda 6 minutos y carga 27K+50K
  registros en memoria, lo que añade GC pauses durante ese rato.

**Solución**

1. **Fast path en `getCarrierFromTracking`**:
   - Si el tracking no tiene ningún prefijo/formato conocido +
     no está en índice + no está en cache Sendcloud → devolver
     `not_found` inmediatamente sin tocar Odoo.
   - Helper `hasKnownCarrierShape(clean)` reconoce PK/MI/Z89/6C20/
     H103/6A/LS/LX/0008/0626/9300500/CTT/EA + barcodes numéricos
     largos + formato ES…CCE (GLS QR).

2. **Negative-lookup cache** (`negativeLookupCache` Map):
   - Cuando una búsqueda Odoo termina sin encontrar nada, el
     tracking se guarda con timestamp.
   - Próximas búsquedas del mismo tracking devuelven `not_found`
     en ~0ms durante 5 min (TTL).
   - Auto-limpieza al superar 10k entradas.

3. **Timeouts en Odoo XML-RPC** (`executeWithTimeout`):
   - `Promise.race` con timeout 3s (exact), 2s (ilike), 2s (patterns).
   - Si timeout → log warning + devolver vacío. La búsqueda continúa
     con el siguiente intento o termina.
   - Reduce hasta 5 búsquedas × 2s = 10s máximo (antes ilimitado).

4. **Top 2 patterns en vez de 3** en `findPickingByTracking` para
   recortar tiempo en el peor caso.

**Resultado esperado**
- Scans inválidos: ~0ms (antes 3-5s).
- Scans válidos en índice: 0ms (sin cambios).
- Scans válidos que caen a Odoo: 1-3s máximo (antes 3-7s).
- Concurrencia: el event loop ya no se satura porque las búsquedas
  no acumulan tiempo. El proxy Railway deja de dar 502.

**Archivos**:
- `server.js` (findPickingByTracking, executeWithTimeout, fast path,
  negative cache)
- `public/sw.js` (cache bump a fast-fail)
- `FIXES-LOG.md` (esta entrada)

**Lección**:
- Toda búsqueda externa (Odoo XML-RPC, Sendcloud API, etc.) debe
  tener timeout corto. Sin timeout → bloqueo del event loop bajo
  carga concurrente.
- Negative-lookup cache es valiosísimo en flujos donde se escanean
  muchos códigos basura (ej. operario escanea el código de la
  factura en lugar del tracking).
- Antes de ir a Odoo, gastar 0ms verificando shape básico del input
  evita gastar 3-5s en un input que claramente no es válido.

---

### #027 · Regresión #026: shape check bloqueaba barcodes ASENDIA/GLS embebidos

**Síntoma**
Operario reporta `DF1299628EU` (ASENDIA, tracking `6C20883422942`)
no se reconoce. El pedido SÍ está en el índice — el problema es
que al escanear el barcode GS1-128 completo (tipo
`%00077184116C20883422942328040`), la app responde `no_shape`.

**Causa raíz**
Mi `hasKnownCarrierShape` del fix #026 era demasiado estricta para
barcodes con patrón EMBEBIDO:
- No empieza con prefijo conocido (empieza con `00077`)
- No es 8 dígitos exactos
- No es 100% numérico (tiene `6C`)
- No matchea ES…CCE ni `^[A-Z]{1,3}\d{8,}`

→ Fast-path lo descartaba antes de que `extractAsendiaTracking`
pudiera extraer el `6C20883422942` y matchear en índice.

Mismo problema con GLS (Z89 embebido en SSCC) y ASENDIA H103.

**Solución**
Añadir 5ª regla al shape check para detectar patrones embebidos
en barcodes ≥12 chars:
```js
if (clean.length >= 12 && /(6C20|6C16|Z89[A-Z0-9]{5}|H103\d{4}|0626\d{8}|0008\d{8})/.test(clean)) return true;
```

**Verificado**: scans con barcode GS1 ASENDIA y SSCC GLS vuelven
a detectar el carrier correctamente. Basura genérica (`NUEVABASURA…`)
sigue bloqueada por fast-fail.

**Archivos**: `server.js`
**Commit**: `dd613dc`

**Lección**:
- Cuando se añaden guards/fast-paths, hay que cubrir TODAS las formas
  válidas. El #026 cubría prefijos pero no embebidos.
- Tests con barcodes reales (no solo strings cortos) son críticos
  antes de desplegar fast-fails.

---

### #028 · Nuevo carrier AMAZON (Amazon Logistics ES vía Sendcloud)

**Síntoma / Necesidad**
Operaciones añade Amazon como nuevo transportista en Sendcloud.
Necesario: que la app reconozca etiquetas Amazon, las clasifique
como carrier `AMAZON` propio (no `OTHER`), y que el sync indexe
los pedidos correctamente para que los operarios puedan leerlos
desde la app.

**Datos verificados en producción** (vía `/api/diag-tracking`)
Pedido ejemplo: `DF1302508EU` (Arnau Trujols, Barcelona).
- `carrier_tracking_ref` Odoo: `ES2527229735`
- `carrier_id` Odoo: `Correos - SC - Gold` (genérico Sendcloud)
- Sendcloud `carrier.code`: `"amazon"`
- Sendcloud `shipment.name`: `"Amazon ES Shipping One-Day Tracked (Off Amazon) 0-15kg"`
- Etiqueta física: barcode + QR principal con `ES2527229735` (12 chars: `ES` + 10 dígitos), Order ID en texto `DF1302508EU`, centro `MAD4`, ruta `DCT9/CYCLE_1`, destino `MAD8/A 133`.

**Cambios desplegados**

`server.js`:
- `SENDCLOUD_CARRIER_MAP`: añadidas claves `amazon`, `amazon_shipping`, `amazon_logistics`, `amazon_es` → `'AMAZON'`
- `CARRIERS = ['AMAZON', 'ASENDIA', 'CORREOS', 'CORREOS EXPRESS', 'CTT', 'GLS', 'INPOST', 'SPRING']`
- `detectCarrierFromOdooName`: añadido `n.includes('AMAZON') → 'AMAZON'`
- `hasKnownCarrierShape`: nueva regla `^ES\d{10}$ → true` (antes que el barcode numérico largo)
- `/api/odoo-outs` listado de prefijos: `else if (/^ES\d{10}$/.test(t)) carrier = 'AMAZON'`
- `/api/diag-tracking` etiquetas de prefix: añadida `AMAZON (ES + 10 dígitos)`

`sync-full.js`:
- `CARRIER_MAP`: añadidos aliases Amazon
- `sendcloudByCarrier.AMAZON = []`
- `trackingIndex.byCarrier.AMAZON = {}`
- Detector de prefijos fallback: `else if (/^ES\d{10}$/.test(t)) detectedCarrier = 'AMAZON'`

`public/index.html`:
- `CARRIERS` array añade `'AMAZON'` (alfabético al principio)
- `CARRIER_COLOR.AMAZON`: gradient `linear-gradient(135deg, #232f3e, #ff9900)` (negro+naranja brand Amazon)
- `localLookup`: nuevo paso 6 con sliding `clean.match(/ES\d{10}/)` que busca el patrón en cualquier posición del barcode escaneado (defensivo por si el QR devuelve datos extra) y solo confirma si `carrier === 'AMAZON'`

`public/sw.js`: cache bumpeado a `expediciones-v3-2026-05-26-amazon`

`CARRIER-RULES.md`: nueva sección dedicada AMAZON con identificadores, reglas, matching y tabla histórica.

**Sin colisión con otros carriers**
- GLS QR: `ES[A-Z]\d{2}[A-Z0-9]{5}[A-Z]{2,3}` — exige letra después de ES, AMAZON es solo dígitos.
- Otros prefijos: `PK`, `MI`, `Z89`, `6C20`, `6A`, `LS`, `LX`, etc. — ninguno empieza por `ES`.

**Verificación pendiente**
Tras deploy + sync, comprobar que `ES2527229735` aparece como `AMAZON` en `/api/detect-carrier/ES2527229735` y que `DF1302508EU` se puede buscar/escanear desde el palet AMAZON.

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`, `public/sw.js`, `CARRIER-RULES.md`, `FIXES-LOG.md`
**Commit**: _pendiente_

**Lección**:
- Añadir un carrier nuevo toca **6 ficheros** mínimo. La checklist de
  carrier-rules.md sirve como guía para no olvidar ningún sitio.
- Antes de codificar, verificar el `carrier.code` REAL que Sendcloud
  envía (mapeo asumido `amazon_shipping` resultó ser `amazon` a secas).
  Usar `/api/diag-tracking/:track?scTrack=1` para confirmar.
- Verificar también NO colisión de prefijos con carriers existentes
  (caso GLS QR vs AMAZON: ambos empiezan por `ES`, pero el detalle del
  patrón los hace mutuamente excluyentes).

---

### #029 · "Application failed to respond" intermitente: serialización del índice bloqueaba el event loop

**Síntoma**
Operarios reportan error recurrente "Application failed to respond"
(página de error de Railway) al leer pedidos, sobre todo por la
mañana. No es con un pedido concreto. Casos: KA296911, KA296372,
KA296361 (los 3 SÍ están en el índice, 0-2ms).

**Diagnóstico** (vía token Railway + curl a producción)
- Health check `/api/health`: 0.5s (servidor vivo).
- Deployment: SUCCESS, sin reinicios → NO es crash ni OOM.
- Logs: muchos `Odoo exact timeout` pero la app no muere.
- **`/api/scanning-index`: 2.4 MB, 1.57s.** ← clave.
- El endpoint cacheaba el OBJETO pero `res.json()` **re-serializaba
  los 2.4 MB en CADA request**. `JSON.stringify` de un objeto grande
  es SÍNCRONO y **bloquea el event loop** de Node.
- Por la mañana 8-10 operarios abren la app a la vez → 8-10
  serializaciones bloqueantes seguidas + gzip de cada una → el event
  loop se queda sin atender los `/api/scan` → Railway devuelve
  "Application failed to respond" mientras el upstream no contesta.
- Agravante: el cliente refrescaba el índice **cada 2 min** (×30
  operarios = mucha carga), cuando el índice solo cambia cada 30 min.

**Solución**
1. **Pre-serializar el índice UNA vez** (no por request):
   - `buildScanningIndexJson()` genera el STRING JSON y el BUFFER gzip
     y los cachea (`scanningIndexJsonCache`, `scanningIndexGzipCache`).
   - Se llama tras cada sync (`runSync` close) y al arrancar el server.
   - El endpoint sirve el string/buffer directamente con `res.end()`,
     **cero CPU de serialización o compresión por request**.
   - Si el cliente acepta gzip, se sirve el buffer pre-comprimido
     (bypass del middleware compression).
2. **Cache-Control 5min → 30min** (`max-age=1800`): el navegador no
   re-descarga durante 30 min; tras expirar, revalida con ETag (304).
3. **Refresco cliente 2min → 15min** + keep-alive 30s → 60s.

**Impacto**: el coste por request del índice pasa de "serializar +
gzipear 2.4 MB" (bloqueante, ~150-400ms CPU) a "enviar un buffer ya
hecho" (no bloqueante, I/O). El event loop queda libre para atender
los escaneos aunque 10 operarios abran la app a la vez.

**Archivos**: `server.js` (buildScanningIndexJson + endpoint + hooks
sync/arranque), `public/index.html` (intervalos), `public/sw.js` (bump)
**Commit**: _pendiente_

**Lección**:
- `res.json()` / `JSON.stringify` de objetos grandes (>1MB) en
  endpoints de alto tráfico BLOQUEA el event loop. Pre-serializar y
  cachear el string/buffer es obligatorio.
- "Application failed to respond" de Railway = upstream (Node) no
  contesta a tiempo. Casi siempre es event loop bloqueado, no crash.
  Revisar primero operaciones síncronas pesadas (JSON, gzip, loops
  grandes), no solo memoria/CPU.
- Refrescos periódicos del cliente deben alinearse con la frecuencia
  real de cambio del dato (sync 30 min ≠ refrescar cada 2 min).

---

### #030 · Reporte múltiple operarios (4 problemas relacionados con INPOST)

**Síntoma** (reportados juntos)
1. Al clickar INPOST se abre palet vacío; tienen varios palets con 0 envíos
2. Pedidos CRX se clasifican como INPOST (ej. `DF126073SF`, `DF125921SF`)
3. Pedidos SPRING se clasifican como INPOST (ej. `DF1333089EU`)
4. Cada ~5 pedidos INPOST seguidos, el último no se reconoce y hay que añadirlo manualmente
5. Pedidos CTT se clasifican como INPOST (ej. `DF1339988EU`)

**Diagnóstico** (vía token Railway + `/api/diag-tracking` + logs deploymentLogs)

Trackings físicos reales obtenidos de Odoo:
| Pedido | Carrier real | Tracking físico |
|---|---|---|
| DF126073SF | CRX | `93005001321898101106806` (23 dígitos) |
| DF125921SF | CRX | `93005001321783401036901` (23 dígitos) |
| DF1333089EU | SPRING | `06215292478046` (14 dígitos, prefijo **`0621`**) |
| DF1339988EU | CTT | `0003010003019701983513` (22 dígitos, prefijo **`0003`**) |

**Causa raíz #2/#3/#5**: el guard `looksLikeSpringBarcode` solo cubría
prefijos SPRING `0626` y `0008`. CRX (`9300500…`), SPRING (`0621…`) y
CTT (`0003…`) caían al sliding INPOST de 8 dígitos. Como prueba todas
las ventanas de 8 dígitos consecutivos del barcode, una de ellas
coincidía por casualidad con un tracking INPOST conocido → falso
positivo INPOST.

**Causa raíz #4** (descubierta leyendo logs):
```
SCAN: 13839570290101007433331782 → INPOST (sess 6-y0309h)
   🔍 Buscando INPOST en Odoo: 83957029
```
En `getCarrierFromTracking`, cuando `extractInpostTracking` devolvía
match con `source: 'index-inpost'`, se llamaba a
`findInTrackingIndex(ipTracking)` que para un tracking de 8 dígitos
presente solo en `byCarrier.INPOST` (pero no en `byTracking` ni
`byOdooTracking`) **devolvía null** (no procesa direct matches en su
PASO 2.6) → el código caía al fallback `findPickingByTracking` en
Odoo (3-9s). Cada scan INPOST hacía esa llamada redundante. Con 5+
operarios escaneando INPOST en paralelo, Odoo se saturaba y algún
scan caía en timeout → el operario lo veía como "no se reconoce".

**Causa raíz #1**: el botón **+ Nuevo** del scanner (y `Abrir nuevo
palet` del selector) crean sesión vacía inmediatamente. Si el
operario pulsa por error o cancela, queda palet con 0 envíos.

**Solución**

`server.js`:
- **Nueva función `hasNonInpostNumericPattern(clean)`** (guard
  universal): detecta CRX (`^9300500`), SPRING (`(0626|0008|0621)`)
  y CTT (`^0003\d{15,}`). Sustituye al guard `looksLikeSpringBarcode`
  en `extractInpostTracking` y `overrideCarrier`. Cubre los 3 casos
  reportados y deja abierto añadir más prefijos.
- **Atajo crítico en `getCarrierFromTracking` INPOST**: si
  `extractInpostTracking` devolvió `source: 'index-*'`, usar los
  datos del índice **directamente** (lookup O(1) en byCarrier.INPOST
  / byOdooTracking / byTracking) sin llamar a `findInTrackingIndex`
  ni a Odoo. El último fallback a Odoo solo corre para candidatos
  heurísticos (prefijos `04/81/83`) cuando NO viene del índice.
- **Auto-prune de sesiones vacías** (`pruneEmptyStaleSessions`):
  llamado dentro de `getSessionsArray`. Elimina sesiones con
  `packages.length === 0` y `lastUpdate > 5 min`. Las sesiones
  recién creadas (<5 min) no se tocan para no romper el flujo del
  operario que recién abrió un palet.
- **Endpoint `POST /api/sessions/:carrier/prune-empty`**: limpieza
  inmediata invocada por el frontend.
- **`looksLikeSpringBarcode` extendido**: ahora cubre también `0621`,
  length mínima bajada de 18 → 14 (los SPRING cortos son 14 dígitos).

`public/index.html`:
- **`hasNonInpostNumericPattern` paridad client-side**: misma lógica
  en `localLookup` para que el matching 0ms del navegador no caiga
  en falso positivo INPOST con barcodes CRX/SPRING-0621/CTT-0003.
- **`looksLikeSpringBarcode`**: añadido `0621` y prefijos al sliding
  SPRING (`['0626', '0008', '0621']`).
- **Modal selector de palet filtra vacíos**: si todos los palets
  están vacíos entra directo al primero; si solo 1 con envíos,
  bypass del modal. Evita confundir al operario con palets de 0.
- **`loadSessions`** invoca `prune-empty` en background para los
  carriers con palets vacíos detectados.

**Archivos**: `server.js`, `public/index.html`, `public/sw.js`,
`CARRIER-RULES.md` (4 actualizaciones por carrier), `FIXES-LOG.md`
**Commit**: _pendiente_

**Verificación esperada**
- `DF126073SF`, `DF125921SF` → CORREOS EXPRESS (no INPOST)
- `DF1333089EU` → SPRING (no INPOST)
- `DF1339988EU` → CTT (no INPOST)
- 10 scans INPOST consecutivos → todos en <1s, sin llamada a Odoo
- Modal INPOST → no aparece "palet vacío" en lista

**Lección**:
- Guards ad-hoc por carrier (`looksLikeSpringBarcode`) se quedan
  cortos. Un guard universal extensible (`hasNonInpostNumericPattern`)
  es más mantenible.
- El sliding INPOST genérico es PELIGROSO: prueba muchas ventanas
  contra un índice grande y siempre hay colisiones por probabilidad.
  Idealmente se usaría solo cuando el barcode tiene shape INPOST
  clara (8 dígitos exactos, o prefijos `04/81/83`). El guard universal
  achicó el ámbito.
- "Llamar a Odoo por si acaso" es seductor pero produce timeouts en
  concurrencia. Si el índice ya tiene la respuesta, no hacer la
  llamada extra.
- Botones que crean estado deben tener consecuencias acotadas:
  auto-prune + filtrar UI evita "basura" generada por pulsaciones
  accidentales sin molestar con confirmaciones.

---

### #031 · Auditoría completa: timeouts envenenaban negative cache + sync 7d corto + extractor SPRING incompleto

**Síntoma** (reporte operarios, 4 problemas)
1. Error constante "No se pudo verificar el transportista. Busca por
   nombre de cliente"
2. SPRING `KA297687` no reconocido (hay que buscar por nombre)
3. SPRING `DF1341430EU` sigue sin reconocerse al escanear
4. Lecturas rápidas → "no los reconoce" → añadir manualmente

**Diagnóstico** (auditoría completa del cascade contra producción)

*Caso KA297687*: picking `CLAWD/OUT/102578` con `scheduled_date`
de hace **14 días**. El sync solo cubría **7 días** → nunca entró al
índice. El tracking `LX071833722NL` SÍ estaba en cache Sendcloud.
Flujo del fallo: no en índice → shortcut cache+order falla (orderRef
tampoco indexado) → Odoo exact match con timeout 3s → si Odoo lento,
`findPickingByTracking` devuelve null → **NO_ENCONTRADO + negative
cache 5 min** → reintentos fallan al instante.

*Caso DF1341430EU*: tracking `06215292484946` (prefijo `0621`) SÍ
en índice como SPRING. Pero en #030 añadí `0621` al guard
(`hasNonInpostNumericPattern`) y NO al **extractor**
(`extractSpecialPatterns`, que seguía con `['0626','0008']`). El
guard bloqueaba correctamente el sliding INPOST, pero después nada
extraía el tracking SPRING del barcode → caía a Odoo con el barcode
completo → ilike sin match → NO_ENCONTRADO. Bugs adicionales del
extractor: `idx > 0` excluía prefijo en posición 0; `length > 20`
dejaba fuera barcodes de 16-20 chars; solo se probaba la PRIMERA
ocurrencia del prefijo (`indexOf`).

*Causa raíz transversal (problemas 1 y 4)*:
`findPickingByTracking` **traga los timeouts** (`.catch → []`) — el
caller no distinguía "Odoo dijo NO existe" de "Odoo tardó >3s". Al
escanear rápido, los lookups Odoo se acumulan → timeouts → trackings
VÁLIDOS entraban al `negativeLookupCache` 5 min → todo reintento
fallaba al instante con el modal de buscar por cliente.

**Solución**

`sync-full.js`:
- Ventana Odoo **7 → 14 días** (`getRecentPickings(14)`). Sendcloud
  se queda en 7d (ya está en el cap de 50k parcels; `updated_after`
  captura los viejos con actividad reciente).

`server.js`:
- `findPickingByTracking(tracking, meta)`: nuevo out-param
  `meta.timedOut` → true si CUALQUIER paso (exact/ilike/pattern)
  falló por timeout.
- `getCarrierFromTracking`:
  - **NO cachear negativo si hubo timeout** (solo si Odoo respondió
    definitivamente). Nuevo source `'odoo_timeout'`.
  - **Fallback cache Sendcloud**: si Odoo falla pero el cache tiene
    carrier+orderId → devolver carrier con picking sintético
    (pickingId null, orderRef y cliente del cache). El escaneo
    funciona aunque el picking sea viejo o Odoo esté caído.
- `extractSpecialPatterns` SPRING: `+0621`, `idx >= 0`,
  `length >= 16`, TODAS las ocurrencias de cada prefijo.
- `/api/scan`: nuevo error `SISTEMA_LENTO` cuando
  `det.source === 'odoo_timeout'` — pide re-escanear en vez de
  mandar a buscar por cliente.

`public/index.html`:
- Sliding SPRING de `localLookup`: TODAS las ocurrencias del prefijo.
- Handler `SISTEMA_LENTO`: toast "⏱ Sistema lento — vuelve a escanear"
  (no modal de búsqueda).

**Hallazgos adicionales durante el deploy**
- El sync de 14 días supera el `limit` Odoo: 30k primero (cortaba los
  viejos con `order desc`), subido a 60k y el cap se alcanza igual.
  Ventana efectiva del índice: ~12-13 días. La cola de 13-14 días la
  cubre el fallback Sendcloud-cache (verificado abajo).
- El bucle de pattern-matching del sync es cuadrático; los pickings
  más viejos que la ventana Sendcloud (7d) no pueden matchear y lo
  recorrían entero → sync >10 min. Ahora se saltan (van directo a
  indexación por prefijo) → sync vuelve a ~3-4 min.
- `/api/reload-index` ahora responde al instante y corre el sync en
  background (antes el proxy cortaba la conexión a los 4 min).

**Verificación en producción (2026-06-10)**
- `06215292484946` → SPRING | index | 0 ms ✓
- Barcode GS1 `0005421062152924849463280` → SPRING (extraído
  `06215292484946`) | 15 ms ✓ (caso DF1341430EU resuelto)
- `LX071833722NL` (KA297687, picking 14 días, Odoo lento) →
  **SPRING | cache-fallback-timeout | 5.5 s** ✓ — el escaneo funciona
  con picking sintético del cache; antes: NO_ENCONTRADO + 5 min de
  negative cache envenenado.

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`,
`public/sw.js`, `CARRIER-RULES.md`, `FIXES-LOG.md`
**Commits**: `c40cbec`, `59c9622`, `e58e206`

**Lección**:
- Un timeout NO es un "no existe". Cachear timeouts como negativos
  convierte lentitud puntual de Odoo en bloqueos de 5 min para
  trackings válidos. Distinguir SIEMPRE respuesta-definitiva de
  fallo-de-infraestructura.
- Al ampliar una ventana de datos, revisar TODOS los límites del
  pipeline (limit de query, bucles cuadráticos, timeouts de proxy,
  tamaño del payload) — no solo el filtro de fecha.
- Al añadir un prefijo nuevo de carrier, revisar TODOS los puntos:
  guard + extractor (server) + sliding (frontend) + sync + shape
  check. En #030 se añadió `0621` al guard pero no al extractor.
  La checklist de CARRIER-RULES.md existe para esto.
- `indexOf` (primera ocurrencia) es insuficiente para patrones
  embebidos: iterar todas las ocurrencias.
- La ventana del índice debe cubrir la realidad operativa (paquetes
  de hasta 2 semanas), no solo el caso típico.

---

## 2026-07-01 · Pérdida de histórico de palets (persistencia)

### #032 · Faltan palets de días laborables de los últimos 3 meses (mayo vacío)

**Síntoma**
Al abrir el tab Palets y elegir un día laborable de mayo (y de los últimos ~3
meses en general), aparece "No hay palets esta fecha", cuando ese registro
SÍ existía. Días dispersos sin palets a lo largo del periodo.

**Diagnóstico (auditoría de principio a fin)**
Descartado que sea un fallo de consulta o de UI:
- `GET /api/pallets?date=` filtra `p.date === dateFilter` (string `YYYY-MM-DD`,
  correcto). El frontend usa un `<input type=date>` que consulta ese endpoint.
  Si mayo sale vacío es porque `database.pallets` NO contiene esos palets.
- No existe ninguna retención/borrado automático (el `/api/cleanup-old` se
  eliminó en #022). Los palets solo se borran por acción manual.
- El histórico de git de `data.json` solo tiene commits de enero 2026 → la
  data de producción nunca se commitea (vive solo en el volumen de Railway),
  así que no es recuperable desde git.
→ Es **pérdida de datos en la capa de persistencia**.

**Causa raíz (destructor de datos en cascada)**
1. `saveData()` hacía `fs.writeFileSync(DATA_FILE, ...)` de un `data.json` de
   30+ MB. **No es atómico**: si el proceso muere a mitad (redeploy de Railway,
   OOM/SIGKILL) deja el fichero **truncado/corrupto**.
2. Al reiniciar, `loadData()` hacía `JSON.parse(data)` → lanza excepción → el
   `catch` solo hacía `console.error` y nada más → `database` quedaba **VACÍO**.
3. El primer `saveData()` (cualquier escaneo) **sobrescribía el volumen con la
   BD vacía** → pérdida total. Con los redeploys frecuentes de mayo-junio, esto
   se repetía y explica los días desaparecidos.
Agravante: si `RAILWAY_VOLUME_MOUNT_PATH` no está definido, `VOLUME_PATH`
cae a `__dirname` (disco EFÍMERO del contenedor) → los datos se pierden en
cada redeploy y se re-siembra la semilla de git (enero).

**Solución (`server.js`)**
- **Escritura atómica** `atomicWriteFileSync` (temp + rename) → nunca deja
  `data.json` truncado.
- **Carga a prueba de corrupción** `loadData`: intenta volumen → `data.json.bak`
  → semilla de git; si el volumen no parsea, **preserva el corrupto** como
  `data.json.corrupt-<ts>` y NO arranca sobre él ni lo sobrescribe.
- **GUARD anti-wipe** en `writeDatabaseToDisk`: si la BD en memoria está vacía
  pero en disco hay datos, **aborta el guardado** (evita el borrado).
- **Backups diarios** `data.backup.YYYY-MM-DD.json` (retención 30 días) +
  `.bak` del último estado bueno cargado.
- **Diagnóstico al arranque**: avisa si el volumen NO está montado (datos
  efímeros) y loguea nº de palets y rango de fechas cargado.
- **Endpoint `GET /api/persistence-status`**: volumen montado sí/no, tamaño de
  `data.json`, backups, corruptos en cuarentena y palets por día.

**Verificación**: `node --check` OK + test aislado (atomic write válido sin
`.tmp` residual; guard bloquea vacío-sobre-datos; corrupto detectado y
preservado sin arrancar encima).

**Pendiente operativo (Railway)**
1. Confirmar que hay un **Volume montado** en el servicio y que
   `RAILWAY_VOLUME_MOUNT_PATH` apunta a él (si no, montarlo — es la causa
   primaria si los datos son efímeros).
2. Desplegar este fix (commit + push).
3. Recuperar mayo: revisar snapshots/backups del volumen en Railway; si no hay,
   reconstrucción parcial vía Odoo (`manual_expedition_date` de los pickings
   indica qué envíos se expidieron cada día) — pero la agrupación exacta en
   palets no es recuperable sin backup.

**Archivos**: `server.js` (loadData, saveData/atomic/guard/backups,
persistence-status), `FIXES-LOG.md`
**Commit**: _pendiente_
**Lección**:
- `fs.writeFileSync` de ficheros grandes NO es atómico: un corte a mitad
  corrompe el fichero. Escribir SIEMPRE a temporal + rename.
- Un `JSON.parse` que falla al cargar NUNCA debe degradar a "BD vacía" y luego
  permitir que un save la persista: eso convierte una corrupción recuperable en
  pérdida total. Preservar el fichero y no sobrescribir.
- Estado operativo crítico en un fichero JSON sobre volumen necesita: escritura
  atómica, backups rotados y un guard anti-borrado. Migrar a SQLite (como el
  dashboard) es la mejora de fondo.
- Verificar SIEMPRE que el volumen de Railway está montado; sin él la
  persistencia es una ilusión que se borra en cada deploy.

---

## 2026-07-12 · Auditoría masiva de cobertura y matching (#033)

### #033 · Cobertura 66-80%: diagnóstico integral + 6 fixes de matching y sync

**Síntoma**
Informe de cobertura en 66-80% en días laborables cerrados (objetivo ≥95%).
Sospecha de vinculación incorrecta de datos (pedidos reconocidos como otros).

**Metodología (auditoría empírica)**
- Forense de producción: 10 días laborables (29 jun-10 jul) de `/api/odoo-outs`
  (~65k pickings) cruzados contra el histórico COMPLETO de escaneos
  (101.381 paquetes en 211 palets, 9 jun-10 jul).
- Batería de reconocimiento: 4.849 escaneos simulados contra servidor local con
  índice fresco (trackings reales en todas las formas físicas: GS1, SSCC, QR,
  E1, embebidos + 400 negativos aleatorios/EAN13).
- Verificación de estados contra API Sendcloud (~9.040 missings + muestras).

**Diagnóstico — de qué se compone el hueco de cobertura**
1. **99,9% de los "no escaneados" JAMÁS pasaron por la app** (sin rastro por
   tracking, pickingId, pedido ni transformación). NO es un fallo de matching:
   el 99,8% de lo escaneado resuelve pickingId al escanear (47.334/47.434).
   ~95%+ de esos missing son envíos REALES (Delivered/en ruta verificado por
   API). 87% del missing es CLABD (Black). AMAZON = 100% bypass (51/51
   Delivered sin escanear). Inflación de denominador por reetiquetado: CERO.
2. **Caps del sync SATURADOS** (sí degradaban el índice):
   - Odoo: limit 60000 alcanzado (ventana 14d > 60k) → recortaba los ~2 días
     más viejos silenciosamente.
   - Sendcloud: 500 págs × 100 = 50k vs 60-100k parcels/7d en el stream
     `updated_after` → ~30% de la ventana no entraba al índice (verificado:
     parcels Delivered reales ausentes del cache).
3. **Falsos positivos de matching REALES encontrados** (baja frecuencia pero
   graves — "pedidos reconocidos como otros"):
   a. Familia SPRING `00828000828088860...` contiene `0008` interior → el
      extractor GS1 corría ANTES del match exacto → extraía el prefijo común
      de la familia → ilike de Odoo asignaba TODOS al mismo picking ajeno
      (10/400 en batería, verificado picking 7688034).
   b. EAN-13 españoles (prefijo 84) → ventanas 04/81/83+6 díg → sliding/
      heurística INPOST → ilike Odoo → enganche a pedido ajeno (2-4% de
      escaneos basura).
   c. 8 dígitos aleatorios → ilike Odoo matchea cualquier tracking que los
      contenga → picking ajeno (bloqueado por NO_VERIFICADO, pero contamina
      flujos manuales).

**Fixes desplegados**
- `server.js`:
  1. **FAST PATH 3 — match exacto pre-extracción**: byTracking/byOdooTracking
     exacto ANTES de extractSpecialPatterns (mata el bug de la familia SPRING;
     `source: 'index-exact'`).
  2. **Validación INPOST heurístico→Odoo**: solo aceptar si el tracking del
     picking ES el candidato o `E1`+candidato.
  3. **Validación SPRING patrón→Odoo**: solo aceptar si tracking del picking
     y patrón están alineados por prefijo.
  4. **Guard EAN-13** en `hasNonInpostNumericPattern`: 13 dígitos con prefijo
     84 = producto, nunca envío (también en `localLookup` del frontend).
  5. **findPickingByTracking 8 dígitos = solo exacto** (o E1+8): nunca ilike.
- `sync-full.js`:
  6. **Paginación Odoo por offset** (chunks 30k, cap seguridad 150k) — elimina
     el recorte silencioso del limit 60000.
  7. **Doble barrido Sendcloud**: `updated_after` + `announced_after` con dedup
     por parcel id — garantiza todos los anunciados de la ventana aunque el
     stream de updates se trunque.
- `public/index.html` guard EAN-13 + `public/sw.js` bump
  `expediciones-v3-2026-07-12-safematch`.

**Verificación**
- Batería completa post-fix: **4.849 tests → 0 WRONG_PICKING, 0 WRONG_CARRIER,
  0 FALSE_ACCEPT, 400/400 negativos rechazados**, 100% reconocimiento en todas
  las formas físicas por carrier (única excepción: sufijo corto CTT sintético,
  caso marginal documentado, CTT casi sin volumen).
- Sync end-to-end con paginación + doble barrido validado en local.

**Qué NO arregla el código (acción operativa)**
El grueso del hueco (20-30%/día) son envíos que salen del almacén SIN pasar
por la pistola, concentrados en CLABD: AMAZON (bypass total), ASENDIA/SPRING/
CORREOS parciales. Para llegar a ≥95% hay que capturar esos flujos en la
operativa (o segmentarlos explícitamente en el informe como "fuera de flujo
de clasificación" para que el % mida lo que de verdad se clasifica).

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`, `public/sw.js`,
`FIXES-LOG.md`, `CARRIER-RULES.md`
**Commit**: _pendiente_
**Lección**:
- Un match EXACTO del barcode completo siempre debe evaluarse ANTES que
  cualquier extracción de patrones: los extractores son heurísticos y pueden
  disparar con subcadenas accidentales (`0008` interior).
- Todo match vía `ilike` con un patrón extraído/corto debe VALIDARSE contra el
  tracking real del picking devuelto (alineación exacta o por prefijo). El
  ilike "contiene" es una red demasiado ancha.
- Los caps de descarga (páginas/limit) deben monitorizarse: si se alcanzan,
  hay truncamiento silencioso de datos. Loguear SIEMPRE cuando total==cap.
- Antes de culpar al matching, medir: el 99,9% del missing era operativa
  (flujos sin escanear), no software. El informe debe separar ambos mundos.

---

## 2026-07-13 · Informe de cobertura accionable (#034)

### #034 · Desglose del "sin escanear": pendiente en almacén vs salió sin escanear

**Necesidad**
El informe mostraba un único bucket "sin escanear" que mezclaba dos realidades
opuestas: paquetes AÚN en almacén (escaneables, sobre todo a mediodía con el
backlog del finde: verificado 13-jul con 173 muestras API → ~97% "Ready to
send"/"Announced" anunciados vie/sáb) y paquetes que YA salieron sin pasar por
la app (pérdida real de cobertura). Sin esa distinción, el % de un día en curso
es ininterpretable y el objetivo ≥95% no es accionable.

**Solución**
- `server.js /api/odoo-outs`: `classifyMissing()` — para cada no-escaneado,
  lookup O(1) del estado Sendcloud en el índice → `missingKind`:
  - `pendiente` (Ready to send / Announced / Being announced / Announcement
    failed) → aún en almacén, accionable hoy
  - `fugado` (en tránsito / entregado / etc.) → salió sin escanear
  - `sin_seguimiento` → ASENDIA con estado "pendiente" (no reporta estados a
    Sendcloud; su Ready to send es perpetuo → no fiable)
  - `sin_datos` → sin parcel en el índice
  Respuesta ampliada: `missingBreakdown` global, `missingKinds` por carrier,
  `scStatus`+`missingKind` por registro y **`effectiveCoverage`** =
  escaneados / (total − pendientes) — mide lo que de verdad salió sin escanear.
- `informe-cobertura.html` + `cobertura.js`: hero con "⏳ Aún en almacén",
  "🚚 Salieron sin escanear" y "Cobertura efectiva*"; filtro Estado con los 4
  tipos; pill por fila con tooltip del estado Sendcloud; export Excel con
  columnas Situación/Estado Sendcloud y desglose en Resumen.
- Preparación rotación de credenciales: `sync-full.js` lee env vars
  (antes SOLO hardcodeadas) y ambos procesos avisan al arrancar si están
  usando el fallback hardcodeado.

**Verificación**: local con rango 2026-01-28 → breakdown correcto
(604/298/163/30), ASENDIA→sin_seguimiento, effectiveCoverage coherente,
records con kind+status. Sintaxis OK en los 3 ficheros.

**Nota de uso**: la métrica de gestión diaria pasa a ser **cobertura
efectiva** (excluye pendientes). El bucket `fugado` es la lista de trabajo
para operativa Black; `pendiente` a última hora del día ≈ lo que quedará
fugado mañana si no se escanea.

**Archivos**: `server.js`, `sync-full.js`, `public/informe-cobertura.html`,
`public/cobertura.js`, `FIXES-LOG.md`
**Commit**: _pendiente_

---

## 2026-07-13 · Lista de operarios: familias SPRING nuevas + prefijos INPOST 84/85 (#035)

### #035 · SPRING numéricos nuevos reconocidos como INPOST + INPOST 84/85 fuera de la heurística

**Síntoma (lista de mejoras de operarios)**
- "Pedido de Spring que lo reconoce como Inpost": CO531753, CO532151,
  KA305576, DF1351565EU, DF1356793EU, KA306338.
- "Todos los pedidos de Inpost tienen que buscarlo por el nombre."

**Diagnóstico (verificación caso a caso contra producción)**
- Los pedidos SPRING afectados usan **familias de numeración NUEVAS** sin
  regla alguna en el sistema:
  - `181` + 15 dígitos (18 díg., ej. `181011473326568106`) — 138 en índice.
    ⚠️ Contienen ventana `81xxxxxx` en posición 1 → la heurística INPOST
    (`^(04|81|83)`) los mandaba a Odoo ilike → falso INPOST (mecanismo
    exacto de los casos reportados; pre-#033 era determinista).
  - `65480525` + 16 dígitos (24 díg., ej. `654805250004735000889455`) — 75.
  - `00373165` + 12 dígitos (20 díg.) — también sin regla.
  Tras #033 los 4 casos verificables ya detectaban SPRING pero por la VÍA
  LENTA (API Sendcloud live, ~2s) y seguían expuestos a colisión de sliding
  contra INPOST reales del índice (hoy 0 colisiones, pero probabilístico).
- INPOST: la numeración ACTUAL empieza por **84/85** (9.840/9.840 trackings
  del índice) pero la heurística solo conocía `04|81|83` → etiquetas recién
  impresas (aún no en índice) no tenían fallback → "buscar por nombre".
  Verificado hoy: 10/10 directos + 5/5 embebidos OK vía índice; el fix cubre
  el hueco entre syncs.

**Solución**
- `hasNonInpostNumericPattern` (server + frontend): + `^181\d{15}$`,
  `^65480525\d{16}$`, `^00373165\d{12}$` → SPRING (bloquean sliding INPOST).
- Prefijos SPRING en `/api/odoo-outs` y fallback de `sync-full.js`: mismas
  3 reglas (los pickings sin match Sendcloud ya no caen a DESCONOCIDO).
- Heurística INPOST: `^(04|81|83|84|85)\d{6}$` en `extractInpostTracking`
  (fallback posicional) y en `looksInpost` (validada por #033: solo match
  exacto/E1 en Odoo — sin riesgo de ilike).
- `public/sw.js` bump `expediciones-v3-2026-07-13-spring-familias`.

**Verificación**: test verbatim del guard 15/15 (6 trackings reales de las
familias nuevas + 5 regresiones #030/#033 + 4 negativos de borde).

**Estado del resto de la lista de operarios** (verificado 13-jul):
- ✅ Ya resueltos por #030: palets vacíos INPOST, CRX→INPOST, SPRING
  0621→INPOST, 5º INPOST no reconocido, CTT→INPOST.
- ✅ Ya resueltos por #031+#033: KA297687, DF1341430EU, "no se pudo
  verificar" masivo (negative cache envenenado), lecturas rápidas
  (índice completo tras quitar caps: matched 54%→75%).
- CO531753/CO532151: >14 días, ya fuera de ventana — mismo mecanismo 181
  que los verificados, cubiertos por esta regla.

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`,
`public/sw.js`, `FIXES-LOG.md`, `CARRIER-RULES.md`
**Commit**: _pendiente_
**Lección**:
- Los carriers CAMBIAN su numeración sin avisar (SPRING estrenó 3 familias
  numéricas; INPOST pasó de 04/81/83 a 84/85). Cualquier lista de prefijos
  envejece: monitorizar los buckets "otros"/DESCONOCIDO del índice cada
  pocas semanas es la alerta temprana.
- Un falso positivo entre carriers casi siempre nace de una familia NUEVA
  sin regla que cae en la heurística más permisiva (sliding 8 díg). La
  defensa es doble: regla positiva para la familia nueva + validación
  estricta del match (que #033 ya dejó puesta).

---

## 2026-07-13 · ASENDIA estrena prefijo 6C21 y etiqueta sin check digit (#036)

### #036 · Etiquetas ASENDIA 6C21 no reconocidas (barcode y QR)

**Síntoma**
Operarios (Karla): etiqueta ASENDIA "no la reconoce". Caso real DF1441749EU.
Lecturas reales aportadas:
- Barcode: `%0094140116C2105250900802250`
- QR (DataMatrix, dump completo con dirección/contacto): contiene
  `...802116C2105250900GEOP...`
- Odoo/Sendcloud: `6C21052509006` (13 chars)

**Causa raíz (triple)**
1. **ASENDIA estrenó el prefijo `6C21`** (2.977 en índice; `6C20` ya tiene 0).
   Todas las reglas (shape check, extractor, prefijo-12, sliding frontend,
   tablas de prefijos) solo conocían `6C20`/`6C16` → el barcode caía en
   `no_shape` (verificado en producción: rechazo instantáneo).
2. **La etiqueta lleva el tracking SIN el dígito de control** (12 chars
   `6C2105250900`) seguido del código de ruta `802...`: la extracción greedy
   de 13 chars coge un dígito de la ruta (`...9008` vs Odoo `...9006`), y el
   QR da los 12 justos (seguidos de letras).
3. En la misma etiqueta conviven 3 variantes del último dígito (num colis
   `...2`, texto grande `...3`, barcode `...8-de-ruta`) → el único ancla
   fiable son los primeros 12 chars.

**Solución**
- `extractAsendiaTracking`: `^6C\d{11}$` directo y extracción embebida
  `/6C\d{10,11}/` (acepta la forma de 12 sin check digit).
- `hasKnownCarrierShape`: prefijo `^6C\d{2}` + embebido `/6C\d{10}/`.
- `findInTrackingIndex` P2.3: prefijo-12 generalizado a `^6C\d\d`.
- Prefijos → ASENDIA: `^6C2[01]` en `/api/odoo-outs`, sync fallback y
  diag. **`6C16` NO se añade** (Sendcloud la clasifica SPRING — 258 en
  índice — y el lookup exacto del índice ya la resuelve bien).
- Frontend `localLookup`: sliding `/6C\d{10,11}/` + **fallback prefijo-12
  client-side** (`client-asendia-12`).
- SW bump `expediciones-v3-2026-07-13b-asendia-6c21`.

**Verificación**: 4/4 con las lecturas REALES (barcode Karla → prefijo-12 →
`6C21052509006`/DF1441749EU; QR completo → 12 chars → prefijo-12 OK;
etiqueta foto `0059494116C2105248929802250V` → `6C21052489292`; tracking
directo → exacto). Post-deploy verificado contra producción.

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`,
`public/sw.js`, `FIXES-LOG.md`, `CARRIER-RULES.md`
**Commit**: _pendiente_
**Lección**:
- Tercera familia nueva de carrier en 48h (SPRING 181/6548/00373165, INPOST
  84/85, ASENDIA 6C21): los prefijos hardcodeados envejecen rápido.
  Generalizar por FORMA (`6C+dígitos`) cuando el formato lo permita, y
  validar contra el índice para no abrir falsos positivos.
- Los identificadores impresos en una misma etiqueta pueden diferir en el
  último dígito según la zona (check digits de distintas simbologías). El
  ancla estable es el CUERPO del identificador (prefijo-12), nunca el
  último carácter.

---

## 2026-07-15 · "Application failed to respond" al leer rápido (#037)

### #037 · 502 de Railway en hora punta + flujo de escaneo bloqueante

**Síntoma (Karla + operarios)**
"Sigue saliendo este error por leer rápido los paquetes" — modal "Error ·
Application failed to respond" (página 502 de Railway). Volumen alto, el flujo
debe ser fluido sin perjudicar tiempo de lectura ni experiencia.

**Causa raíz (medida en producción)**
1. **Bloqueo del event loop tras cada sync**: el proceso padre hacía
   `JSON.parse(fs.readFileSync(...))` SÍNCRONO del `tracking-index.json`
   (~100-186MB) + caché Sendcloud (17MB) + `buildScanningIndexJson` en cada
   sync (cada 30 min en 6-22h). ~2-4s de event loop BLOQUEADO → todas las
   requests encoladas → Railway devuelve 502. El doble barrido de #033 agrandó
   el índice y alargó el bloqueo.
   Medido: index-hit p50=1.8s, ráfaga concurrente x20 → todas a ~4.8s.
2. **El cliente ESPERABA al servidor** en los paquetes fuera del índice local
   (await del POST /scan). Bajo carga, 4-5s de espera o error visible.
3. **El Service Worker dejaba pasar el 502**: para HTML/JS/CSS hacía
   `fetch().catch(...)` que SOLO captura fallo de red, no una respuesta 502
   (que es válida) → el operario veía la página de error de Railway.
4. **Pérdida silenciosa**: si el POST /scan fallaba (502), el paquete quedaba
   en el UI local pero NO en la sesión del servidor → al cerrar el palet se
   perdía (y contaminaba la cobertura).

**Solución (garantías cliente + reducción de causa servidor)**
`public/index.html`:
- **Cola de persistencia con reintentos** (`enqueueScanSync`): TODO scan (esté
  o no en el índice local) se añade al UI al instante y su POST va por una cola
  con backoff (6 intentos, ~40s). El operario NUNCA espera al servidor.
- **`apiCall` con timeout** (AbortController 9s) y detección de fallo
  transitorio (`err.transient` en timeout/5xx/red/non-JSON) vs respuesta
  definitiva del servidor.
- **Reconciliación async**: éxito → datos del servidor; error definitivo
  (TRANSPORTISTA_INCORRECTO/NO_ENCONTRADO/CRX/DUPLICADO) → rollback + UI de
  siempre; transitorio → reintento silencioso; agotado → paquete marcado
  "⚠ sin guardar" (borde ámbar, no bloqueante) para re-escanear.
- Indicadores por paquete: ✓ guardado · ↻ guardando · ⚠ sin guardar.
`public/sw.js`:
- **Fallback a caché también en 5xx** (`networkFirstWithCache`): el 502 de
  Railway ya no se muestra; la app sigue viva desde caché y el escaneo continúa
  (el matching local es 0ms). Cachea las respuestas buenas para tener fallback.
  Bump `expediciones-v4-2026-07-15-fluidez`.
`server.js` + `sync-full.js`:
- **Sync LIGERO de día** (solo `updated_after 7d`), **COMPLETO de noche**
  (`--full`, con backfill `announced_after 14d`): el sync diario vuelve a ser
  ~4min (vs ~10) → índice más pequeño, parse más corto, menos contención.
- **Carga de índice ASÍNCRONA** (`fs.promises.readFile`) + `setImmediate` para
  drenar requests en vuelo antes de reparsear + **medición del tiempo de
  recarga** (avisa si >1.5s) + **no pisar el índice en memoria si el parse
  falla** (fichero a medio escribir).

**Verificación**: server + sync + JS del cliente `--check` OK; cola de
reintentos 4/4 (éxito, transitorio→éxito, transitorio-siempre→unsynced sin
loop, carrier-incorrecto→rollback); SW válido; boot local con carga async OK.

**Nota de propagación**: el SW nuevo se activa en cada PDA en la siguiente
carga (skipWaiting+claim+bump de CACHE_NAME). Una recarga y listo.

**Pendiente (mejora de fondo)**: el `JSON.parse` del índice sigue siendo el
punto caliente; si reaparece bloqueo >1.5s en logs, siguiente paso = índice
de escaneo SLIM separado (solo campos de scan) o parse en worker_thread.

**Archivos**: `server.js`, `sync-full.js`, `public/index.html`, `public/sw.js`,
`FIXES-LOG.md`
**Commit**: _pendiente_
**Lección**:
- En un servidor Node monohilo, cualquier `JSON.parse`/`readFileSync` de un
  fichero grande en el hot path bloquea TODAS las requests. Ficheros de estado
  grandes se leen async y, si es posible, se parsean fuera del hilo o se
  parten en un formato más ligero.
- El SW debe tratar 5xx como "caído" (fallback a caché), no solo el fallo de
  red: si no, propaga la página de error del proxy a los operarios.
- Un scan de almacén no puede depender de un round-trip a Singapur: UI
  optimista + cola de reintentos = fluido y sin pérdida aunque el backend
  parpadee.

---

### #038 · Cierre de palet a prueba de pérdidas (reconciliación cliente→servidor)

**Síntoma (Karla)**
"Cuando les pasa el error se les borran pedidos y tienen que volver a leerlo."
Ideal: buen ritmo, tranquilos de no re-escanear.

**Causa**
`POST /api/pallets` construía el palet desde la SESIÓN del servidor. Si un scan
no llegó a persistir (502 en su POST /scan), no estaba en la sesión → se perdía
al cerrar aunque el operario lo veía en su pantalla. #037 evita que se borre del
UI, pero faltaba garantizar que llegue al palet.

**Solución**
- Cliente: al cerrar, `flushScanQueue()` fuerza la persistencia pendiente
  (backoff interrumpible) y luego envía la **lista local completa**
  (`clientPackages`) en el POST /pallets.
- Servidor: **reconciliación** — antes de crear el palet, añade a la sesión
  cualquier `clientPackage` que no esté ya (marca `reconciledAtClose`), actualiza
  los Sets globales, y solo entonces crea el palet. Si no había sesión, la crea.
- Botón "Cerrar palet" deshabilitado durante el proceso; error transitorio →
  toast "pulsa otra vez" (nada se pierde), no modal.

**Verificación (local)**: escenario de 3 escaneos con 2 sin persistir → cerrar
con `clientPackages` → palet creado con **los 3** (0 perdidos).

**Archivos**: `server.js` (POST /pallets), `public/index.html`, `FIXES-LOG.md`
**Commit**: _pendiente_
**Lección**: el estado autoritativo de un palet al cerrarse debe reconciliar lo
que el operario realmente escaneó (cliente) con lo que el servidor registró; no
fiarse solo del servidor cuando la red puede parpadear.

---

### #039 · Etiquetas CTT Portugal (DS…PT) — guía en vez de bloqueo

**Síntoma (Karla, con foto)**
Etiqueta CTT Express a Portugal (pedido CO537514) "no le deja leer". El
operario escanea el barcode de ARRIBA "Cod. Bulto CTT(PT): DS394097635PT".

**Diagnóstico (verificado en producción vía navegador)**
- `DS394097635PT` → `carrier:null` (no está en Odoo NI en Sendcloud: es el
  código de última milla de CTT Portugal, como los códigos griegos de GLS).
- `0003010003019702145683001` (barcode "Código Bulto", el grande) → **CTT,
  CO537514 ✓**. Sendcloud/Odoo tienen el nº español `0003…145683`.
→ El operario escanea el código equivocado. El `DS…PT` es INMATCHEABLE (no
existe vínculo en ningún sistema).

**Solución**
`/api/scan`: si el código es `^DS\d{6,}PT$` → error `ESCANEA_OTRO_CODIGO` con
mensaje CTT específico ("escanea el 'Código Bulto' que empieza por 0003…") en
vez de mandar a "buscar por cliente" a ciegas. Cliente: modal claro.

**Nota GLS Grecia** (DF1446622EU): igual patrón — los códigos griegos
(`615813…`, `396443…`) no están en el sistema; el que funciona es el GLS
`Z89TS4BU`. No se puede pattern-matchear con fiabilidad (numéricos genéricos);
guía operativa: escanear el código Z89 o buscar por pedido.

**Archivos**: `server.js`, `public/index.html`, `public/sw.js`, `FIXES-LOG.md`,
`CARRIER-RULES.md`
**Commit**: _pendiente_
**Lección**: en envíos internacionales, el barcode más prominente suele ser el
del PARTNER de última milla (CTT-PT `DS…PT`, GLS-GR griego), que no está en
nuestros sistemas. No se puede auto-resolver; lo útil es detectar el formato y
decirle al operario qué código escanear.

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
