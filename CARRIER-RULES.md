# Reglas y modificaciones por transportista

> **Documento vivo**. Por cada transportista: reglas de detección y matching
> vigentes + historial cronológico de cambios. Complementa a `FIXES-LOG.md`
> (cronológico general).

---

## ⚠️ Instrucción permanente para el agente

**Cada vez que se modifique una regla de detección, matching, override,
fast-path, sliding window, integración Sendcloud/Odoo o flujo de un
transportista, hay que:**

1. Actualizar la sección "Reglas vigentes" del transportista afectado
   (o las que cambien — pueden ser varias).
2. Añadir una entrada nueva en "Historial" del transportista con:
   - Fecha
   - Síntoma / motivo del cambio
   - Qué se modificó (regla nueva, regla eliminada, prioridad cambiada…)
   - Commit hash (corto)
   - Referencia al fix correspondiente en FIXES-LOG.md
3. **Informar explícitamente al usuario** en la respuesta: "He actualizado
   CARRIER-RULES.md con el cambio en \<transportista\>".

Esto NO sustituye a FIXES-LOG.md, lo complementa. FIXES-LOG es cronológico
de bugs y fixes; CARRIER-RULES es vista por carrier para entender el estado
actual y la evolución de cada uno.

---

## Índice

- [AMAZON](#amazon)
- [ASENDIA](#asendia)
- [CORREOS](#correos)
- [CORREOS EXPRESS (MIKA)](#correos-express-mika)
- [CTT](#ctt)
- [GLS](#gls)
- [INPOST](#inpost)
- [SPRING](#spring)

---

## AMAZON

### Identificadores y formatos

- **Prefijos directos**: `^ES\d{10}$` (ej. `ES2527229735` = "ES" + 10 dígitos, total 12 chars)
- **Carrier Sendcloud**: `amazon` (confirmado en producción), aliases mapeados: `amazon_shipping`, `amazon_logistics`, `amazon_es`
- **Carrier Odoo (nombre)**: aparece como `Correos - SC - Gold` (genérico Sendcloud), el carrier real se identifica por `carrier.code` del parcel Sendcloud y por el prefijo `ES\d{10}` del tracking
- **Formato barcode físico**: barcode y Data Matrix QR con el tracking directo (`ES2527229735`). La etiqueta también muestra como texto: Order ID del pedido (`DF1302508EU`), centro origen (`MAD4`), ruta (`DCT9 / CYCLE_1`), centro destino (`MAD8 / A 133`).
- **Sin colisión con GLS QR**: el patrón GLS QR es `ES[A-Z]\d{2}[A-Z0-9]{5}[A-Z]{2,3}` (letra+dígitos+alfanuméricos+letras). AMAZON es `ES\d{10}` (solo dígitos). Son mutuamente excluyentes.

### Reglas vigentes (detección)

1. **Prefijo directo**: `^ES\d{10}$` → AMAZON (en `/api/odoo-outs`, `findInTrackingIndex`, sync `if (!foundMatch)`)
2. **Mapping Sendcloud**: `carrier.code === 'amazon'` → AMAZON
3. **Detección por nombre Odoo**: `carrier_id.name.includes('AMAZON')` → AMAZON
4. **Shape check (fast-fail)**: `^ES\d{10}$` pasa el guard (regla dedicada antes del fallback de barcode numérico largo)
5. **Match exacto** en índice por `byCarrier['AMAZON']`
6. **Frontend `localLookup` sliding**: si el escáner devuelve datos extra alrededor del QR (caso poco probable pero defensivo), extrae el patrón `ES\d{10}` con `match()` y busca en el índice cliente

### Matching Sendcloud↔Odoo

- **Match exacto** del `tracking_number` Sendcloud con `carrier_tracking_ref` Odoo. Confirmado en producción: el pedido `DF1302508EU` tiene `carrier_tracking_ref = 'ES2527229735'` en Odoo y el mismo `tracking_number` en Sendcloud (`carrier.code = 'amazon'`).
- Sendcloud SÍ es la fuente de etiquetas Amazon (a diferencia de CRX/MIKA que usa integración directa). El sync normal funciona.

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-05-26 | **Nuevo carrier AMAZON añadido al sistema**. Mapping Sendcloud (`amazon` y aliases), array `CARRIERS`, `detectCarrierFromOdooName`, `hasKnownCarrierShape`, prefijo en `/api/odoo-outs` y `sync-full.js`, `byCarrier.AMAZON`, color frontend (negro+naranja Amazon `#232f3e`+`#ff9900`), sliding `ES\d{10}` en `localLookup`. Verificado con `DF1302508EU` (tracking `ES2527229735`) | _pendiente commit_ | #028 |

---

## ASENDIA

### Identificadores y formatos

- **Prefijos directos**: `6C20`, `6C16`, `H103` (variante nueva), `LS\d{9}[A-Z]{2}` (subset específico)
- **Carrier Sendcloud**: `asendia`
- **Carrier Odoo (nombre)**: `Asendia` (genérico) / suele venir como `Correos - SC - Gold`
- **Formato barcode físico**: 13 chars (`6C20XXXXXXXXX`) o GS1-128 largo con `6C20`
  embebido (típicamente `%xxxxx6C20XXXXXXXXX xxxxx` con prefijos AI GS1).

### Reglas vigentes (detección)

1. **Prefijo directo**: `^6C20`, `^6C16`, `^H103` (todos → ASENDIA en `/api/odoo-outs` y `findInTrackingIndex`)
2. **Prefijo `^LS\d{9}[A-Z]{2}$`**: variante específica que es ASENDIA (no SPRING)
3. **Patrón embebido en GS1**: `extractAsendiaTracking` extrae substring `6C20\d{9}` o `6C16\d{9}` de barcodes largos (`extractSpecialPatterns` lo invoca)
4. **Match exacto en índice** por `byCarrier['ASENDIA']`
5. **Override**: `^H103` matchea a ASENDIA aunque venga como SPRING (los `H103*` largos son ASENDIA)
6. **Shape check (fast-fail)**: `(6C20|6C16|H103\d{4})` embebido en string ≥12 chars → pasa el guard y NO se rechaza como `no_shape`

### Matching Sendcloud↔Odoo

- **Solo match exacto**. ASENDIA tiene mismatch sistemático entre tracking
  Sendcloud y barcode físico (identificadores distintos). Substring matching
  causaba falsos positivos.
- Si está en Odoo con `carrier_tracking_ref = 6C20…` y Sendcloud tiene el
  mismo string, match. Si no, queda en `byOdooTracking` por el prefijo.

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-04-15 | Matching ASENDIA via tracking-index (Odoo→Sendcloud cruzado en el sync) | `8a72788` | — |
| 2026-04-22 | Prefix matching para barcodes con último dígito mismatch (escáneres a veces fallan en el último carácter) | `ca4cf2b` | — |
| 2026-04-28 | Eliminado substring matching ASENDIA en el sync (falsos positivos: el tracking Sendcloud y el barcode físico son IDs distintos) | (fix cascade) | — |
| 2026-05-22 | Override `^H103` → ASENDIA (los pedidos `H103*` se clasificaban como SPRING por error) | `e43f7bb` | #004b |
| 2026-05-22 | `extractAsendiaTracking` añadido al cascade de `extractSpecialPatterns` para barcodes GS1 largos | — | — |
| 2026-05-26 | **#027**: shape check del fast-fail (#026) rechazaba barcodes ASENDIA GS1 (`%…6C20…`). Añadida regla `(6C20\|6C16\|H103\d{4})` en `hasKnownCarrierShape` para barcodes ≥12 chars con patrón embebido | `dd613dc` | #027 |
| 2026-07-13 | **#036 — nuevo prefijo `6C21`** (2.977 en índice, sustituye a 6C20) **+ etiqueta SIN check digit**: el barcode (`%0094140116C2105250900802250`) y el QR llevan el tracking en 12 chars (sin dígito de control) seguido del código de ruta `802…`. Generalizado TODO a familia `6C**`: extractor `/6C\d{10,11}/`, shape `^6C\d{2}` + embebido `/6C\d{10}/`, prefijo-12 en P2.3 (`^6C\d\d`), sliding frontend con fallback prefijo-12 client-side. Prefijo→ASENDIA: `^6C2[01]` (6C16 queda fuera: Sendcloud la da como SPRING). Caso real verificado: DF1441749EU (`6C21052509006`). | _pendiente_ | #036 |

---

## CORREOS

### Identificadores y formatos

- **Prefijos directos**: `PK` (estándar), `C0` (variante antigua)
- **Carrier Sendcloud**: `correos`
- **Carrier Odoo (nombre)**: `Correos`
- **Formato típico**: `PK7L7Hxxxxxxxxxxxxxxxxx` (23 chars) o `PK7L7Fxxxxxxxxxxxxxxxxx`

### Reglas vigentes (detección)

1. **Prefijo directo**: `^PK` y `^C0` → CORREOS
2. **Detección por carrier_id Odoo**: nombre contiene "Correos" u "Ordinario" → CORREOS
3. **Match exacto en índice** por `byCarrier['CORREOS']`
4. **NO usar** "Correos genérico" del campo `carrier_id` para clasificación
   prioritaria; los prefijos van primero (porque Odoo etiqueta muchos envíos
   con "Correos - SC - Gold" que en realidad son de Sendcloud para varios
   carriers, no necesariamente CORREOS).

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-05-20 | Reordenar prioridad en `/api/odoo-outs`: prefijos primero, luego índice, luego nombre Odoo (antes el nombre Odoo se evaluaba primero y casi todo daba "CORREOS" por el genérico Sendcloud) | `e4fa163` | #001 |
| 2026-05-22 | Match exacto en índice usando `byCarrier['CORREOS']` | — | — |

---

## CORREOS EXPRESS (MIKA)

### Identificadores y formatos

- **Prefijos directos**: `MI` (etiquetas antiguas), `9300500` (23 dígitos, barcode CRX moderno)
- **Carrier Sendcloud**: `correos_express` o `correos_express_es` (genérico, casi nunca presente porque CRX **no usa Sendcloud** para etiquetas)
- **Carrier Odoo (nombre)**: `MIKA` (integración directa Odoo↔CRX, NO vía Sendcloud)
- **Formato barcode físico**: `93005001313XXXXXXXXXXXXXXX` (23 dígitos)
- **Campo `note` del picking**: contiene el "ID del pedido" (10-16 dígitos, típico Shopify order id, e.j. `8954434852216`) — IMPRESO en la etiqueta junto al barcode

### Reglas vigentes (detección)

1. **Prefijo directo**: `^MI` y `^9300500` → CORREOS EXPRESS (override fuerte en `overrideCarrier`)
2. **Detección por carrier_id Odoo**: `carrier_id` empieza por `MI` (MIKA) → CORREOS EXPRESS
3. **Sliding INPOST tiene guard**: si el barcode tiene prefijo `9300500` (cubierto por `hasNonInpostNumericPattern`), NO se aplica el sliding INPOST de 8 dígitos. Sin este guard, ventanas de 8 dígitos del barcode CRX (23 dígitos) coincidían por casualidad con trackings INPOST conocidos (casos DF126073SF, DF125921SF en #030).
4. **Sync indexa pickings sin tracking**: pickings con `carrier_id MIKA` y `carrier_tracking_ref` vacío entran en `trackingIndex.pendingCrx` para ser buscables por nº de pedido
5. **Índice nuevo `byCrxOrderId`**: el campo `note` se parsea (regex `\d{10,16}`) y se indexa. Permite buscar el pedido por el "ID del pedido" impreso en la etiqueta cuando MIKA aún no ha registrado el tracking físico en Odoo
6. **Endpoint `/api/scan` con CRX no encontrado**: si el barcode matchea `^9300500\d` y no se encuentra en Odoo, devuelve `error: 'CRX_NO_SINCRONIZADO'` (no `NO_ENCONTRADO`), con mensaje específico que invita a tipear el ID del pedido

### Matching Sendcloud↔Odoo

- **NO hay matching con Sendcloud** porque CRX no genera etiquetas vía Sendcloud. La integración es directa Odoo↔CRX vía módulo MIKA.
- MIKA actualiza `carrier_tracking_ref` en Odoo con delay (horas tras imprimir la etiqueta), de ahí los `pendingCrx`.

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-05-22 | Añadido prefijo `^9300500` (23 dígitos) además de `^MI`. Antes solo `MI` y los CRX modernos no se detectaban | `e43f7bb` | #004b |
| 2026-05-25 | Sync incluye pickings MIKA `waiting` sin tracking → `trackingIndex.pendingCrx` (para buscar por nº pedido / cliente) | `b09b048` | #025 |
| 2026-05-25 | Endpoint `/api/scan` devuelve `CRX_NO_SINCRONIZADO` cuando matchea `^9300500\d` y no hay picking, con mensaje útil | `b09b048` | #025 |
| 2026-05-25 | **Vínculo via `note` (ID del pedido)**: nueva regla `extractCrxOrderId(note)` extrae `\d{10,16}` del campo HTML, y `byCrxOrderId` lo indexa O(1). `/api/search-client` detecta inputs numéricos 10-15 dígitos y los busca aquí | `e7a63dc` | #025 |
| 2026-05-25 | Indexación extendida: también pickings con `carrier_id="Correos"` (no MIKA) si su `note` contiene el ID externo CRX (caso DF122521SF donde la etiqueta era CRX pero Odoo decía "Correos") | `3e65bf1` | #025 |
| 2026-06-09 | Guard CRX integrado en `hasNonInpostNumericPattern` (junto a SPRING y CTT). Casos DF126073SF / DF125921SF (CRX 23 dígitos `9300500...`) que se clasificaban como INPOST por colisión en sliding de 8 dígitos. | _pendiente_ | #030 |

---

## CTT

### Identificadores y formatos

- **Prefijos directos**: `CTT`, `EA`
- **Carrier Sendcloud**: `ctt` / `ctt_express`
- **Formato típico**: Odoo guarda solo los últimos dígitos (`4347080`), Sendcloud tiene el barcode completo (`00030100030197014347080`)

### Reglas vigentes (detección)

1. **Prefijo directo**: `^CTT` y `^EA` → CTT
2. **Match en sync**: tracking Sendcloud `endsWith` tracking Odoo, o `includes` (≥7 chars)
3. **Substring matching ELIMINADO** del scan en tiempo real (causaba falsos positivos: barcode CTT corto matcheaba muchos otros)

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-04-10 | Match por substring (sendcloud completo contiene odoo corto) | `4cb3f7f` (rev) | — |
| 2026-04-12 | Eliminado partial substring matching CTT que causaba falsos positivos en cobertura | `4cb3f7f` | — |
| 2026-04-15 | Match solo en el sync (`endsWith` o `includes` con `length ≥ 7`), no en scan tiempo real | — | — |
| 2026-06-09 | CTT añadido al guard universal `hasNonInpostNumericPattern`: trackings con `^0003\d{15,}` (formato `0003010003019701...`) ya no son capturados por el sliding INPOST. Caso DF1339988EU (tracking `0003010003019701983513`). | _pendiente_ | #030 |

---

## GLS

### Identificadores y formatos

- **Prefijos directos**: `Z89`
- **Carrier Sendcloud**: `gls` / `gls_es`
- **Formato típico**:
  - Tracking limpio: `Z89XXXXX` (8 chars, ej. `Z89TJVNX`)
  - QR escaneable contiene: `ESxxxxxxxxxxxxCCExxxx` con tracking embebido
  - SSCC barcode contiene: `00340014240000Z89TJVNX` (Z89 embebido tras prefijo numérico)

### Reglas vigentes (detección)

1. **Prefijo directo**: `^Z89` → GLS
2. **Patrón QR**: `extractSpecialPatterns` matchea `ES([A-Z][0-9]{2}[A-Z0-9]{5})[A-Z]{2,3}` → carrier GLS + patrón extraído
3. **Sliding `Z89` en SSCC/barcodes largos**: busca `Z89` en cualquier posición; si encuentra y los siguientes 5 chars son alfanuméricos, extrae el `Z89XXXXX` como candidato
4. **Shape check (fast-fail)**: `Z89[A-Z0-9]{5}` embebido en string ≥12 chars → pasa el guard
5. **Match exacto** en índice por `byCarrier['GLS']`
6. **Frontend `localLookup`** tiene sliding GLS específico (cliente 0ms)

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-05-22 | Sliding window `Z89` en SSCC: GLS embebido tras prefijo numérico se detectaba mal. Añadido sliding que busca `Z89` en cualquier posición | `c199644` | #017 |
| 2026-05-22 | Frontend `localLookup` con sliding GLS para match 0ms en cliente | `c199644` | #017 |
| 2026-05-26 | Shape check incluye `Z89[A-Z0-9]{5}` embebido para no rechazar SSCC en fast-fail | `dd613dc` | #027 |

---

## INPOST

### Identificadores y formatos

- **Prefijos directos**: 8 dígitos exactos (`\d{8}`), o subset con prefijos posicionales `04|81|83 + 6 dígitos`
- **Carrier Sendcloud**: `inpost` / `inpost_es` / `inpost_spain`
- **Formato típico**:
  - Tracking corto: 8 dígitos (ej. `83299791`)
  - Barcode largo: contiene los 8 dígitos embebidos en posición variable (ej. `130486133001010401330148898` → tracking `04861330` en pos 2-10)

### Reglas vigentes (detección)

1. **Match directo**: `^\d{8}$` → INPOST (override fuerte)
2. **Formato Odoo con prefijo `E1`**: Odoo guarda los trackings INPOST como `E1xxxxxxxx` (10 chars, ej. `E183954005`). El barcode físico solo tiene los 8 dígitos. El sync indexa AMBAS formas (la original `E1+8` y los 8 dígitos solos) en `byCarrier.INPOST`. `findInTrackingIndex` busca primero los 8 dígitos directos, luego prueba `E1+8`. Sin esta dualidad, todo scan caía a Odoo por mismatch.
3. **Sliding window 8 dígitos**: `extractInpostTracking` prueba todas las ventanas de 8 dígitos consecutivos del barcode y verifica si alguna existe en el índice INPOST (O(1) hash lookup, ambas formas)
4. **GUARD UNIVERSAL `hasNonInpostNumericPattern`**: si el barcode tiene patrón de OTRO carrier numérico (CRX `^9300500`, SPRING `(0626|0008|0621)\d{8,}`, CTT `^0003\d{15,}`), NO aplicar sliding INPOST. Sustituye al guard anterior solo SPRING. Cubre los casos DF126073SF/DF125921SF (CRX), DF1333089EU (SPRING 0621), DF1339988EU (CTT 0003).
4. **GUARD SPRING histórico**: `looksLikeSpringBarcode` (`/0626\d{8,}/` o `/0008\d{8,}/` o `/0621\d{8,}/`) — ahora se usa en el sliding SPRING del frontend
4. **Override en `overrideCarrier`**: si barcode largo contiene una subcadena que matchea un INPOST conocido, fuerza INPOST (también con guard SPRING)
5. **Fallback posicional**: si no hay match en índice, verifica `^(04|81|83)\d{6}$` como heurística
6. **Eliminado el fallback legacy** de `substring(2,10)` (causaba falsos positivos en CRX 23 dígitos)
7. **Frontend `localLookup`** tiene sliding INPOST 8 dígitos (cliente 0ms) **CON GUARD SPRING también aplicado**

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-05-20 | Sliding window de 8 dígitos para INPOST embebido en barcodes largos | — | — |
| 2026-05-22 | Eliminado fallback legacy `substring(2,10)` que provocaba falsos positivos en CRX 23 dígitos (`93005001313132701335831` → `00500131` causaba búsquedas Odoo 10s) | `e43f7bb` | #020 |
| 2026-05-25 | **GUARD SPRING**: si barcode tiene patrón SPRING (`0626…` o `0008…` ≥18 chars), NO hacer sliding INPOST. Casos `DF1289908EU` y `DF1290868EU` se clasificaban como INPOST por colisión accidental de 8 dígitos | `5b73ee0` | #024 |
| 2026-05-25 | Frontend `localLookup`: mismo guard SPRING + sliding SPRING añadido ANTES del sliding INPOST | `5b73ee0` | #024 |
| 2026-06-09 | **Atajo crítico**: si `extractInpostTracking` ya encontró match en el índice (`source: index-*`), usar los datos del índice DIRECTAMENTE sin llamar a `findInTrackingIndex` (que devolvía null para 8-dígitos en byCarrier pero no en byTracking) ni a Odoo. Antes cada scan INPOST hacía un lookup Odoo redundante de 1-3s que provocaba que ~5+ INPOST concurrentes saturasen Odoo y alguno fallase (bug "cada 5 INPOST seguidos el 5to no se reconoce"). | `e0f8c06` | #030 |
| 2026-06-09 | `findInTrackingIndex` PASO 2.6 también procesa `isDirectMatch=true` (antes solo `!isDirectMatch`). Trackings INPOST de 8 dígitos puros (`^\d{8}$`) ya no caen a `findPickingByTracking` Odoo. | `57c6edb` | #030 |
| 2026-06-09 | **Descubierto formato INPOST con prefijo `E1`**: Odoo guarda trackings INPOST como `E1xxxxxxxx` (10 chars, ej. `E183954005`) pero el barcode físico solo tiene 8 dígitos (`83954005`). El sync ahora indexa AMBAS formas en `byCarrier.INPOST` (la original con E1 + los 8 últimos dígitos). `findInTrackingIndex` también prueba `E1` + tracking al buscar. Sin esto, todo scan INPOST de barcode físico caía a Odoo (4-5s) porque el sliding extrae 8 dígitos pero el índice solo tenía la forma E1+8. | `4779f0d` | #030 |
| 2026-06-09 | **Guard universal `hasNonInpostNumericPattern`**: bloquea el sliding INPOST cuando el barcode tiene patrón de OTRO carrier (CRX `^9300500`, SPRING `0626/0008/0621`, CTT `^0003\d{15,}`). Antes solo había `looksLikeSpringBarcode` (solo SPRING 0626/0008). Casos resueltos: DF126073SF, DF125921SF (CRX), DF1333089EU (SPRING 0621), DF1339988EU (CTT 0003). Aplicado en `extractInpostTracking`, `overrideCarrier` y `localLookup` del frontend. | _pendiente_ | #030 |
| 2026-07-12 | **Guard EAN-13 (`^84` + 13 dígitos = producto)** en `hasNonInpostNumericPattern` (server + frontend): los EAN españoles contienen ventanas 04/81/83+6 que colisionaban con trackings INPOST reales (verificado `8477128076710`→`84771280`). **Validación del candidato heurístico→Odoo**: solo aceptar si el tracking del picking ES el candidato o `E1`+candidato. **`findPickingByTracking` con 8 dígitos puros = solo match exacto** (o E1+8), nunca ilike (8 dígitos aleatorios matcheaban por contención cualquier tracking largo ajeno). Batería 4.849 tests → 0 falsos aceptados. | _pendiente_ | #033 |
| 2026-07-13 | **Prefijos heurísticos actualizados a `^(04\|81\|83\|84\|85)\d{6}$`**: la numeración INPOST actual empieza por 84/85 (9.840/9.840 trackings del índice de producción son 84xx/85xx). Sin esto, etiquetas recién impresas (aún no en índice) no tenían fallback → "buscar por el nombre". Riesgo de ilike contenido por la validación exacto/E1 de #033. | _pendiente_ | #035 |

---

## SPRING

### Identificadores y formatos

- **Prefijos directos**: `6A`, `LS` (general), `LX`, `LV`, `LT`, `3[A-Z]`, `CP`, `Z96`, `XSMT`, `0008`, `0626` (en sufijo numérico de barcode)
- **Carrier Sendcloud**: `spring` / `spring_gds`
- **Formato típico**:
  - Tracking corto: `LX012345678NL`, `LS236513775CH`, `6A05138202272`, `3UW1VTI174109`, `H1023311157599001018`, `CP456787465IE`, etc.
  - Barcode GS1-128 largo: contiene `0626` o `0008` seguido de tracking embebido de 12-16 chars
  - Ejemplo: `%000542106265024593998328040` → extraer `06265024593998` (14 chars desde `0626`)

### Reglas vigentes (detección)

1. **Prefijos directos**: `^LS|^LX|^LV|^LT|^3[A-Z]|^CP|^Z96|^XSMT|^0008|^0626|^0621` y `^6A` → SPRING (`0621` añadido en #030)
2. **EXCEPCIÓN `^LS\d{9}[A-Z]{2}$`**: este patrón específico es **ASENDIA**, no SPRING (regla evaluada ANTES del patrón general LS)
3. **EXCEPCIÓN `^H103`**: aunque a veces llega como SPRING en Odoo, el `overrideCarrier` lo fuerza a ASENDIA
4. **`looksLikeSpringBarcode(clean)`**: helper compartido (server + frontend). Detecta `\d+` length ≥14 que contiene `0626\d{8,}`, `0008\d{8,}` o `0621\d{8,}`. Se usa como guard ANTES del sliding INPOST y en el sliding SPRING del frontend.
5. **`extractSpecialPatterns`** extrae substrings 12-16 chars desde la posición de `0626`/`0008`/`0621` en barcodes largos numéricos
6. **Sliding SPRING en frontend `localLookup`**: añadido en #024. Prueba substrings 12-16 chars desde `0626`/`0008`/`0621` ANTES de intentar sliding INPOST
7. **Sync match patterns**: SPRING usa `endsWith` o `includes` para match Sendcloud↔Odoo (los IDs Sendcloud y Odoo a veces son distintos)
8. **NO partial substring matching** en el sync para SPRING corto (eliminado en `fb67a20`, causaba falsos positivos donde sufijos cortos pillaban muchos pedidos)
9. **Shape check (fast-fail)**: `0626\d{8}` u `0008\d{8}` embebido en string ≥12 chars → pasa el guard

### Historial de cambios

| Fecha | Cambio | Commit | Fix |
|---|---|---|---|
| 2026-04-20 | Eliminado partial substring matching SPRING en sync (causaba falsos positivos en pedidos cortos) | `fb67a20` | — |
| 2026-05-22 | Añadido `^H103` como override SPRING→ASENDIA (los H103 largos son ASENDIA, no SPRING) | `e43f7bb` | #004b |
| 2026-05-25 | **`looksLikeSpringBarcode`** helper (`/0626\d{8,}/` o `/0008\d{8,}/`, length ≥18). Usado como GUARD en sliding INPOST de `extractInpostTracking` y `overrideCarrier` | `5b73ee0` | #024 |
| 2026-05-25 | Frontend `localLookup`: nuevo sliding SPRING (substrings 12-16 chars desde `0626`/`0008`) que corre ANTES del sliding INPOST, para match exacto en cliente 0ms | `5b73ee0` | #024 |
| 2026-05-26 | Shape check del fast-fail acepta `(0626\|0008)\d{8}` embebido en strings ≥12 chars (no descarta barcodes SPRING como `no_shape`) | `dd613dc` | #027 |
| 2026-06-09 | **Nuevo prefijo SPRING `0621`**: caso DF1333089EU (tracking `06215292478046`). Añadido a `looksLikeSpringBarcode`, sliding SPRING del frontend, `hasNonInpostNumericPattern`. Length mínima del guard bajada de 18 a 14 (tracking SPRING corto puede ser 14 dígitos). | `e0f8c06` | #030 |
| 2026-06-10 | **`0621` añadido a `extractSpecialPatterns` del server** (en #030 se añadió al guard pero NO al extractor — caso DF1341430EU seguía sin extraerse del barcode GS1). Además: `idx > 0` → `idx >= 0` (prefijo en posición 0 válido), umbral `length > 20` → `>= 16`, y el extractor itera **TODAS las ocurrencias** del prefijo (antes solo `indexOf` primero: un `0626`/`0621` falso anterior al real rompía la extracción). Mismo fix de todas-las-ocurrencias en el sliding SPRING del frontend. | _pendiente_ | #031 |
| 2026-07-12 | **FAST PATH 3 (match exacto pre-extracción) + validación del patrón→Odoo**. La familia de trackings `00828000828088860...` contiene `0008` en posición interior → el extractor GS1 corría ANTES del match exacto, extraía el prefijo común de la familia (`000828088860`) y el ilike de Odoo asignaba TODOS los escaneos al mismo picking ajeno (10/400 en batería). Ahora: (1) match exacto byTracking/byOdooTracking va ANTES de cualquier extracción; (2) el match Odoo de un patrón SPRING extraído solo se acepta si el tracking del picking está alineado por prefijo con el patrón. | _pendiente_ | #033 |
| 2026-07-13 | **3 familias numéricas NUEVAS de SPRING** sin regla previa: `^181\d{15}$` (18 díg., 138 en índice — su ventana `81xxxxxx` colisionaba con la heurística INPOST: casos CO531753, KA305576, DF1351565EU, DF1356793EU, KA306338), `^65480525\d{16}$` (24 díg., 75) y `^00373165\d{12}$` (20 díg.). Añadidas a `hasNonInpostNumericPattern` (server+frontend), prefijos de `/api/odoo-outs` y fallback del sync. | _pendiente_ | #035 |

---

## Reglas transversales (no específicas de un carrier)

### `findInTrackingIndex` (server)
Cascade de búsqueda al detectar carrier de un tracking:
1. Match exacto en `byTracking` y `byOdooTracking`
2. INPOST extraído (con guard SPRING) — PASO 2.6
3. CTT/SPRING formato largo (con guard cross-contamination)
4. Búsqueda exacta por carrier
5. Búsqueda inversa SPRING (`endsWith`)
6. ASENDIA prefijo (substring)

### `overrideCarrier`
Aplicado a TODO carrier detectado para forzar correcciones:
1. `^9300500` → CORREOS EXPRESS
2. `^H103 && carrier==='SPRING'` → ASENDIA
3. `^\d{8}$` → INPOST
4. Barcode largo numérico con INPOST en índice → INPOST (con guard universal `hasNonInpostNumericPattern`)

### `hasNonInpostNumericPattern` (#030, guard universal)
Detecta si un barcode numérico pertenece a OTRO carrier (no INPOST) ANTES del sliding INPOST. Sustituye a `looksLikeSpringBarcode` como guard principal:
- `length ≥ 18` Y `^9300500\d` → CORREOS EXPRESS (23 dígitos típicos)
- `length ≥ 14` Y contiene `(0626|0008|0621)\d{8,}` → SPRING
- `length ≥ 18` Y `^0003\d{15,}` → CTT (22 dígitos típicos)

Aplicado en `extractInpostTracking`, `overrideCarrier` (server) y `localLookup` (frontend). Sin este guard, el sliding INPOST de 8 dígitos genera falsos positivos cuando alguna ventana del barcode coincide por casualidad con un tracking INPOST conocido.

### `hasKnownCarrierShape` (fast-fail #026 + #027)
Decide si un input vale la pena buscar en Odoo:
- Prefijos directos: `^(PK|MI|Z89|6C20|6C16|H103|6A|LS|LX|LV|LT|3[A-Z]|CP|Z96|XSMT|0008|0626|CTT|EA|C0|9300500)`
- 8 dígitos exactos: `^\d{8}$`
- Barcode numérico largo: `length≥10 && /^\d+$/`
- GLS QR: `ES[A-Z]\d{2}[A-Z0-9]{5}[A-Z]{2,3}`
- Letras+dígitos típicos: `^[A-Z]{1,3}\d{8,}`
- **Patrón embebido**: `length≥12 && /(6C20|6C16|Z89[A-Z0-9]{5}|H103\d{4}|0626\d{8}|0008\d{8})/`

### `negativeLookupCache`
TTL 5 min, max 10k entries. Trackings que ya buscamos en Odoo sin encontrar
nada se cachean para no repetir la búsqueda costosa.
**IMPORTANTE (#031)**: solo se cachea como negativo cuando Odoo respondió
DEFINITIVAMENTE "no existe". Si la búsqueda falló por **timeout**, NO se
cachea (el tracking puede ser válido) y `/api/scan` devuelve
`error: 'SISTEMA_LENTO'` pidiendo al operario re-escanear, en vez de
mandarle a buscar por cliente. `findPickingByTracking(tracking, meta)`
expone `meta.timedOut` para distinguir ambos casos.

### Fallback cache Sendcloud (#031)
Cuando un tracking NO está en el índice y Odoo no lo devuelve (timeout o
picking >14 días), si el **cache Sendcloud** tiene el parcel con carrier y
orderId, se devuelve ese carrier con un picking sintético
(`pickingId: null`, orderRef y cliente del cache). El escaneo funciona
aunque Odoo esté caído. Caso real: KA297687 (picking de 14 días,
tracking `LX071833722NL`).

### Ventana del sync
- **Odoo pickings: 14 días** con `limit: 60000` y `order: scheduled_date desc`.
  OJO: el cap de 60k se alcanza → la ventana EFECTIVA del índice es ~12-13
  días. Los pickings de la cola (13-14 días) no entran al índice pero el
  **fallback Sendcloud-cache** los cubre al escanear (verificado con
  KA297687 / `LX071833722NL` → SPRING vía `cache-fallback-timeout`).
- **Sendcloud parcels: 7 días** con `updated_after` (los parcels viejos con
  actualizaciones de estado recientes siguen entrando; el límite real es el
  cap de 50k parcels / 500 páginas).
- **Pattern-matching del sync**: solo para pickings ≤8 días (los más viejos
  no tienen parcels en la ventana Sendcloud y recorrer el bucle cuadrático
  era inútil y carísimo — sync >10 min). Los viejos van directo a
  indexación por prefijo.

### Timeouts Odoo (`executeWithTimeout`)
- Exact match: 3s
- ilike: 2s
- Pattern matching: 2s × 2 patterns
- Total máximo por scan que cae a Odoo: ~9s
