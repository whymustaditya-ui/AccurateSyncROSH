/**
 * ROSH × Accurate — Rute Penagihan (route planner for Ade's field collection).
 *
 * Turns Ade's open AR (Pool A + Pool B, outstanding > 0) into a weekly drive list:
 *   1) Aggregate open invoices BY CUSTOMER (one visit = one location, all their
 *      invoices collected together).
 *   2) Group customers by Zona/Kecamatan. Ade assigns it (🟡 Zona); if she hasn't,
 *      fall back to a GEOCODED guess of the freeform address (🔴 Zona (auto)).
 *   3) Rank zonas by priority = total outstanding × (1 + umur_tertua × AGING_WEIGHT)
 *      → a zona with five small-but-old tunggakan still floats up on accumulation.
 *   4) Within a zona, order stops by nearest-neighbour. Coords come from Ade's
 *      Maps pin (🟡 Pin Maps) if pasted, else the geocode of the address — so the
 *      route is ordered even before any pin is entered. Ade just follows top-to-bottom.
 *
 * Single tab `🗺️ Rute Penagihan` (master + Ade's file; NOT Deden's). Mixes
 * 🔴 script-owned columns (rebuilt every sync) and 🟡 human columns
 * (Zona / Pin Maps / Status Kunjungan / Tgl Kunjungan / Hasil) — UPSERTED by
 * CUSTOMER NAME so Ade's entries survive each sync, exactly like the Pool tabs
 * upsert by invoice number. Ade edits in her file → master picks it up next sync.
 *
 * Geocoding uses the BUILT-IN Apps Script Maps service (Maps.newGeocoder()) — no
 * API key, no extra OAuth scope. Results cached in hidden `_GeoCache`; clear that
 * tab to force a full re-geocode. Display/ops only — does NOT touch komisi/penalty/
 * handover (Kpi.gs). Depends on Sync.gs (invoice fields, _ss, SYNC_START, DAY_MS)
 * + Style.gs (UI helpers) + Kpi.gs (rupiah).
 */

var ROUTE_UNZONED = '(Belum dizonakan)';

// 13-column schema. Key = Customer (col 4, the only stable value readable back).
//   1 Zona🟡 2 Zona(auto)🔴 3 Urutan🔴 4 Customer🔴(KEY) 5 Alamat🔴 6 Pin Maps🟡
//   7 Outstanding🔴 8 Umur Tertua🔴 9 No. Telp🔴
//   10 Status Kunjungan🟡 11 Tgl Kunjungan🟡 12 Hasil🟡 13 Loyalitas (4bln)🔴
var ROUTE_HEADERS = [
  'Zona / Kecamatan', 'Zona (auto)', 'Urutan', 'Customer', 'Alamat', 'Pin Maps (link)',
  'Outstanding', 'Umur Tertua (hari)', 'No. Telp',
  'Status Kunjungan', 'Tgl Kunjungan', 'Hasil', 'Loyalitas (4bln)'
];
var ROUTE_SPAN        = ROUTE_HEADERS.length; // 13
var ROUTE_HROW        = 3;   // column-header row (banner=1, subtitle=2)
var ROUTE_DROW        = 4;   // first data row
var ROUTE_YELLOW_COLS = [1, 6, 10, 11, 12];   // human-filled, preserved across syncs
var ROUTE_KEY_COL     = 4;                    // Customer
var ROUTE_STATUS_OPTS = ['Belum dikunjungi', 'Sudah ditagih', 'Janji bayar', 'Gagal / tutup', 'Reschedule'];
var ROUTE_GEO_BUDGET_MS = 300000;             // stop geocoding ~5 min in (shares the 6-min sync limit)

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — aggregate by customer, attach 🟡 zona/pin + geocode seed, group, order.
// Pure projection of Pass-1 invoices (no Accurate calls). Network use: cached/capped
// resolution of shortened Maps pins + cached/capped geocoding of freeform addresses.
// ─────────────────────────────────────────────────────────────────────────────
function buildRoutePlan(invoices, today, yMap) {
  // 1) Aggregate Ade's open AR by customer name.
  const byCust = {};
  invoices.forEach(function(i) {
    if (i.pool !== 'A' && i.pool !== 'B') return;   // only Ade's pools
    if (!(i.outstanding > 0)) return;               // still owed
    const name = String(i.customer || '').trim();
    if (!name) return;
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, alamat: '', noTlp: '', tierText: '',
                                 outstanding: 0, count: 0, oldestAging: 0 };
    c.outstanding += i.outstanding;
    c.count += 1;
    if (!c.alamat && i.alamat) c.alamat = i.alamat;
    if (!c.noTlp  && i.noTlp)  c.noTlp  = i.noTlp;
    if (i.custTierText) c.tierText = i.custTierText;   // same per customer (loyalty tier, 4bln)
    const aging = i.handoverDate ? Math.max(0, Math.floor((today - i.handoverDate) / DAY_MS)) : 0;
    if (aging > c.oldestAging) c.oldestAging = aging;
  });

  const pinCache = _loadPinCache();
  const geoCache = _loadGeoCache();
  let resolves = 0, geocodes = 0;

  const list = Object.keys(byCust).map(function(name) {
    const c = byCust[name];
    const y = yMap[name] || {};
    c.zonaRaw  = String(y.zona || '').trim();  // Ade's confirmed zona (🟡)
    c.pin      = String(y.pin || '').trim();
    c.coords   = null;
    c.autoZona = '';

    // (a) Pin → coords: explicit lat/lng first, then cached/short-link resolve.
    if (c.pin) {
      const direct = _parsePinCoords(c.pin);
      if (direct) c.coords = direct;
      else if (pinCache[c.pin]) c.coords = pinCache[c.pin];
      else if (resolves < CONFIG.ROUTE.MAX_PIN_RESOLVE) {
        const r = _resolveShortPin(c.pin); resolves++;
        if (r) { c.coords = r; pinCache[c.pin] = r; }
      }
    }

    // (b) Auto zona: parse "Kecamatan X" straight from the freeform address first
    //     (free + instant + reliable for ROSH's detailed addresses). Geocode only as a
    //     zona fallback AND for coordinates (regex can't give lat/lng) — cached + capped.
    if (c.alamat) {
      c.autoZona = _zonaFromAddress(c.alamat);
      const needZona = !c.autoZona, needCoords = !c.coords;
      if (needZona || needCoords) {
        let g = geoCache[c.alamat];
        if (g === undefined &&
            geocodes < CONFIG.ROUTE.MAX_GEOCODE &&
            (!SYNC_START || (Date.now() - SYNC_START) < ROUTE_GEO_BUDGET_MS)) {
          g = _geocodeAddress(c.alamat); geocodes++;
          if (g) geoCache[c.alamat] = g;     // cache hits only; misses retried (capped) next sync
        }
        if (g) {
          if (!c.autoZona && g.zona) c.autoZona = g.zona;
          if (!c.coords && g.lat != null && g.lng != null) c.coords = { lat: g.lat, lng: g.lng };
        }
      }
    }

    // Effective zona for grouping: Ade > auto (regex/geocode) > unzoned.
    c.zona = c.zonaRaw || c.autoZona || ROUTE_UNZONED;
    return c;
  });
  _savePinCache(pinCache);
  _saveGeoCache(geoCache);

  // 2) Group by zona → summary + priority score + ordered stops.
  const groups = {};
  list.forEach(function(c) { (groups[c.zona] || (groups[c.zona] = [])).push(c); });

  const plan = Object.keys(groups).map(function(z) {
    const members  = groups[z];
    const totalOut = members.reduce(function(s, c) { return s + c.outstanding; }, 0);
    const oldest   = members.reduce(function(m, c) { return Math.max(m, c.oldestAging); }, 0);
    const ordered  = _orderRoute(members);
    ordered.forEach(function(c, idx) { c.urutan = idx + 1; });
    return { zona: z, members: ordered, totalOut: totalOut, oldest: oldest,
             count: members.length,
             score: totalOut * (1 + oldest * CONFIG.ROUTE.AGING_WEIGHT) };
  });

  // 3) Highest-priority zona first; unzoned always parked at the bottom.
  plan.sort(function(a, b) {
    const au = a.zona === ROUTE_UNZONED, bu = b.zona === ROUTE_UNZONED;
    if (au !== bu) return au ? 1 : -1;
    return b.score - a.score;
  });
  return plan;
}

// Greedy nearest-neighbour order within a zona. Anchor = biggest outstanding (start
// with the heaviest stop), then always hop to the closest remaining point. Customers
// without any coords (no pin + no geocode) are appended, sorted by outstanding desc.
function _orderRoute(members) {
  const withCoord = members.filter(function(c) { return c.coords; });
  const noCoord   = members.filter(function(c) { return !c.coords; })
                           .sort(function(a, b) { return b.outstanding - a.outstanding; });
  if (withCoord.length <= 1) return withCoord.concat(noCoord);

  const remaining = withCoord.slice().sort(function(a, b) { return b.outstanding - a.outstanding; });
  const route = [remaining.shift()];
  while (remaining.length) {
    const last = route[route.length - 1];
    let bi = 0, bd = Infinity;
    for (var i = 0; i < remaining.length; i++) {
      const d = _haversineKm(last.coords, remaining[i].coords);
      if (d < bd) { bd = d; bi = i; }
    }
    route.push(remaining.splice(bi, 1)[0]);
  }
  return route.concat(noCoord);
}

function _haversineKm(a, b) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const la1 = a.lat * toRad, la2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ─────────────────────────────────────────────────────────────────────────────
// ZONA FROM ADDRESS TEXT — ROSH's Accurate addresses embed "Kecamatan X" (and often
// the DKI city), so pull the kecamatan straight out of the freeform string. Free,
// instant, and more reliable than geocoding for the zona LABEL. Falls back to the
// "Jakarta <Selatan/Barat/...>" city if no kecamatan token is present.
// ─────────────────────────────────────────────────────────────────────────────
function _zonaFromAddress(addr) {
  if (!addr) return '';
  const s = String(addr).replace(/\s+/g, ' ');
  // Stop the kecamatan capture at a regency/city keyword, comma, digit, or end.
  const STOP = /(?:,|\d|Jakarta|Jakbar|Jaksel|Jaktim|Jakut|Jakpus|Kota|Kab\.?|Kabupaten|Tangerang|Tangsel|Bekasi|Bogor|Depok|Banten|Jawa)/i;
  let m = s.match(/Kec(?:amatan)?\.?\s+(.+)/i);
  if (m) {
    let rest = m[1];
    const stop = rest.search(STOP);
    if (stop > 0) rest = rest.slice(0, stop);
    rest = rest.trim().replace(/[.,]+$/, '');
    if (rest && rest.length <= 30) return _titleCaseZona(rest);
  }
  m = s.match(/Jakarta\s+(Selatan|Barat|Timur|Utara|Pusat)/i);
  if (m) return 'Jakarta ' + _titleCaseZona(m[1]);
  return '';
}

function _titleCaseZona(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/\b([a-z])/g, function(_, c) { return c.toUpperCase(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOCODING — built-in Maps service. Freeform Indonesian address → kecamatan-ish
// zona + lat/lng. Best-effort; vague addresses may miss or land imprecisely (it's a
// SEED Ade corrects, not ground truth). No API key / no extra OAuth scope.
// ─────────────────────────────────────────────────────────────────────────────
function _geocodeAddress(addr) {
  if (!addr) return null;
  try {
    const res = Maps.newGeocoder().setRegion('id').geocode(addr);
    if (!res || res.status !== 'OK' || !res.results || !res.results.length) return null;
    const top  = res.results[0];
    const comp = top.address_components || [];
    function pick(type) {
      for (var i = 0; i < comp.length; i++) {
        if (comp[i].types && comp[i].types.indexOf(type) >= 0) return comp[i].long_name;
      }
      return '';
    }
    // ID: kecamatan ≈ admin_level_3, kelurahan ≈ admin_level_4, kota ≈ admin_level_2.
    const zona = pick('administrative_area_level_3') || pick('administrative_area_level_4') ||
                 pick('locality') || pick('administrative_area_level_2') || '';
    const loc  = top.geometry && top.geometry.location;
    return { zona: String(zona).trim(),
             lat: loc ? loc.lat : null,
             lng: loc ? loc.lng : null };
  } catch (e) {
    return null;  // quota / transient — leave uncached, retried (capped) next sync
  }
}

// ── Persistent geocode cache (hidden sheet, master file). ─────────────────────
function _geoCacheSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName('_GeoCache');
  if (!sh) {
    sh = ss.insertSheet('_GeoCache');
    sh.getRange(1, 1, 1, 4).setValues([['alamat', 'zona', 'lat', 'lng']]);
    sh.hideSheet();
  }
  return sh;
}
function _loadGeoCache() {
  const sh = _geoCacheSheet();
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 4).getValues().forEach(function(r) {
      if (r[0] === '' || r[0] == null) return;
      map[r[0]] = { zona: r[1] || '',
                    lat: r[2] === '' ? null : Number(r[2]),
                    lng: r[3] === '' ? null : Number(r[3]) };
    });
  }
  return map;
}
function _saveGeoCache(map) {
  const sh = _geoCacheSheet();
  const rows = Object.keys(map).map(function(a) {
    const g = map[a];
    return [a, g.zona || '', g.lat == null ? '' : g.lat, g.lng == null ? '' : g.lng];
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// PIN PARSING + RESOLUTION
// Extract lat,lng from a Google Maps URL/string. Handles the common shapes:
//   .../@-6.12,106.81,17z      ?q=-6.12,106.81      &ll=...      !3d-6.12!4d106.81
//   geo:-6.12,106.81           bare "-6.12,106.81"
// Short share links (maps.app.goo.gl / goo.gl/maps) carry NO coords → _resolveShortPin
// follows the redirect once (cached) to recover them.
// ─────────────────────────────────────────────────────────────────────────────
function _parsePinCoords(url) {
  if (!url) return null;
  const s = String(url);
  const m = s.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/) ||
            s.match(/[?&](?:q|ll|sll|daddr|destination|center)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/) ||
            s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
            s.match(/(?:geo:)?(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat, lng: lng };
}

// Follow a shortened maps link to its real URL and pull coords from the redirect.
function _resolveShortPin(url) {
  if (!/goo\.gl|maps\.app/.test(url)) return null;
  try {
    const opt = { followRedirects: false, muteHttpExceptions: true };
    let resp = UrlFetchApp.fetch(url, opt);
    let loc  = resp.getHeaders()['Location'] || resp.getHeaders()['location'] || '';
    if (loc) {
      const c1 = _parsePinCoords(loc);
      if (c1) return c1;
      const resp2 = UrlFetchApp.fetch(loc, opt);             // occasional second hop
      const loc2  = resp2.getHeaders()['Location'] || resp2.getHeaders()['location'] || '';
      if (loc2) { const c2 = _parsePinCoords(loc2); if (c2) return c2; }
    }
    if (resp.getResponseCode() === 200) return _parsePinCoords(resp.getContentText('UTF-8').slice(0, 8000));
  } catch (e) { /* network / quota — leave unresolved, retried (capped) next sync */ }
  return null;
}

// ── Persistent pin→coords cache (hidden sheet, master file). Only successful
//    resolutions are stored; flaky links retried (capped). Clear `_PinCache` to reset.
function _pinCacheSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName('_PinCache');
  if (!sh) {
    sh = ss.insertSheet('_PinCache');
    sh.getRange(1, 1, 1, 3).setValues([['pin', 'lat', 'lng']]);
    sh.hideSheet();
  }
  return sh;
}
function _loadPinCache() {
  const sh = _pinCacheSheet();
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 3).getValues().forEach(function(r) {
      if (r[0] && r[1] !== '' && r[2] !== '') map[r[0]] = { lat: Number(r[1]), lng: Number(r[2]) };
    });
  }
  return map;
}
function _savePinCache(map) {
  const sh = _pinCacheSheet();
  const rows = Object.keys(map).filter(function(u) { return map[u]; })
    .map(function(u) { return [u, map[u].lat, map[u].lng]; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// YELLOW COLLECTOR — merge 🟡 (Zona/Pin/Status/Tgl/Hasil) across files by CUSTOMER.
// Pass [master, adeSS] so Ade's non-empty values win and flow back to master.
// ─────────────────────────────────────────────────────────────────────────────
function collectRouteYellow(ssList, tabName) {
  const map = {};
  ssList.forEach(function(ss) {
    if (!ss) return;
    const sh = ss.getSheetByName(tabName);
    if (!sh || sh.getLastRow() < ROUTE_DROW) return;
    const n = sh.getLastRow() - ROUTE_DROW + 1;
    sh.getRange(ROUTE_DROW, 1, n, ROUTE_SPAN).getValues().forEach(function(r) {
      const key = String(r[ROUTE_KEY_COL - 1] || '').trim();
      if (!key) return;
      const cur = map[key] || { zona: '', pin: '', status: '', tgl: '', hasil: '' };
      const inc = { zona: r[0], pin: r[5], status: r[9], tgl: r[10], hasil: r[11] };
      ['zona', 'pin', 'status', 'tgl', 'hasil'].forEach(function(f) {
        if (inc[f] !== '' && inc[f] != null) cur[f] = inc[f];
      });
      map[key] = cur;
    });
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — single tab, flat table sorted by zona-priority then route order.
// ─────────────────────────────────────────────────────────────────────────────
function writeRouteTab(plan, yMap) {
  const ss = _ss();
  let sh = ss.getSheetByName(CONFIG.TABS.RUTE);
  if (!sh) sh = ss.insertSheet(CONFIG.TABS.RUTE);
  sh.clear();
  if (sh.clearConditionalFormatRules) sh.clearConditionalFormatRules();
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  sh.getRange(1, 1, sh.getMaxRows(), ROUTE_SPAN).breakApart();
  sh.getRange(1, 1, sh.getMaxRows(), ROUTE_SPAN).clearDataValidations();
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(p) { if (p.canEdit()) p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(p) { if (p.canEdit()) p.remove(); });

  uiBanner(sh, 1, ROUTE_SPAN,
    '🗺️ Rute Penagihan — Daftar Jalan per Zona',
    'Piutang terbuka Ade dikelompokkan per zona, diurut prioritas (akumulasi Rp × umur), ' +
    'titik dalam zona diurut dari lokasi terdekat. Tinggal jalan dari Urutan 1 ke bawah. ' +
    'Zona (auto) = tebakan dari alamat — koreksi di kolom Zona; isi Pin Maps & Status/Tgl/Hasil. Rebuild tiap jam 5 pagi.',
    UI.GREEN, UI.GREEN_SOFT);

  uiHeaderRow(sh, ROUTE_HROW, ROUTE_HEADERS);
  ROUTE_YELLOW_COLS.forEach(function(col) {
    sh.getRange(ROUTE_HROW, col, 1, 1).setBackground(UI.AMBER).setFontColor(UI.WHITE);
  });
  sh.setFrozenRows(ROUTE_HROW);

  // Flatten plan → matrix; remember where each zona group starts (separator border).
  const matrix = [];
  const groupStartRows = [];
  let rowPtr = ROUTE_DROW;
  plan.forEach(function(g) {
    if (!g.members.length) return;
    groupStartRows.push(rowPtr);
    g.members.forEach(function(c) {
      const y = yMap[c.customer] || {};
      matrix.push([
        String(y.zona || ''), c.autoZona || '', c.urutan, c.customer, c.alamat || '',
        String(y.pin || ''), c.outstanding, c.oldestAging, c.noTlp || '',
        y.status || '', (y.tgl != null ? y.tgl : ''), y.hasil || '', c.tierText || ''
      ]);
      rowPtr++;
    });
  });

  if (!matrix.length) {
    sh.getRange(ROUTE_DROW, 1, 1, ROUTE_SPAN).merge()
      .setValue('✅ Tidak ada piutang terbuka untuk dirutekan saat ini.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
  } else {
    sh.getRange(ROUTE_DROW, 1, matrix.length, ROUTE_SPAN).setValues(matrix).setVerticalAlignment('middle');
    sh.getRange(ROUTE_DROW, 1, matrix.length, ROUTE_SPAN)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);

    // formats
    sh.getRange(ROUTE_DROW, 7, matrix.length, 1).setNumberFormat('"Rp"#,##0');           // Outstanding
    sh.getRange(ROUTE_DROW, 8, matrix.length, 1).setHorizontalAlignment('center');        // Umur
    sh.getRange(ROUTE_DROW, 3, matrix.length, 1).setHorizontalAlignment('center');        // Urutan
    sh.getRange(ROUTE_DROW, 11, matrix.length, 1).setNumberFormat('dd/MM/yyyy');          // Tgl Kunjungan

    // 🟡 tint + 🔴 Zona(auto) subtle grey (script-owned guess)
    ROUTE_YELLOW_COLS.forEach(function(col) {
      sh.getRange(ROUTE_DROW, col, matrix.length, 1).setBackground(UI.AMBER_BODY);
    });
    sh.getRange(ROUTE_DROW, 2, matrix.length, 1).setBackground(UI.BAND).setFontColor(UI.NOTE).setFontStyle('italic');

    // zona-group separators (medium top border on first row of each group)
    groupStartRows.forEach(function(gr) {
      sh.getRange(gr, 1, 1, ROUTE_SPAN)
        .setBorder(true, null, null, null, null, null, '#9ca3af', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    });

    // 🟡 dropdowns: Zona (existing + auto-guessed zonas, free entry) · Status (fixed list)
    const zonaSet = {};
    Object.keys(yMap).forEach(function(k) { const z = String(yMap[k].zona || '').trim(); if (z) zonaSet[z] = true; });
    matrix.forEach(function(row) { if (row[1]) zonaSet[row[1]] = true; });   // include auto guesses
    const zonaList = Object.keys(zonaSet).sort();
    if (zonaList.length) {
      const zr = SpreadsheetApp.newDataValidation().requireValueInList(zonaList, true).setAllowInvalid(true).build();
      sh.getRange(ROUTE_DROW, 1, matrix.length, 1).setDataValidation(zr);
    }
    const sr = SpreadsheetApp.newDataValidation().requireValueInList(ROUTE_STATUS_OPTS, true).setAllowInvalid(true).build();
    sh.getRange(ROUTE_DROW, 10, matrix.length, 1).setDataValidation(sr);

    // conditional formats: Status Kunjungan (col 10) + Umur Tertua (col 8) + Tier (col 13)
    const statusRange = sh.getRange(ROUTE_DROW, 10, matrix.length, 1);
    const umurRange   = sh.getRange(ROUTE_DROW, 8, matrix.length, 1);
    const tierRange   = sh.getRange(ROUTE_DROW, 13, matrix.length, 1);
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Sudah ditagih').setBackground(UI.T_GREEN).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Janji bayar').setBackground(UI.T_AMBER).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Gagal / tutup').setBackground(UI.T_RED).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Reschedule').setBackground(UI.T_GREY).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(76).setBackground(UI.T_RED).setRanges([umurRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(31, 75).setBackground('#fed7aa').setRanges([umurRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(7, 30).setBackground(UI.T_AMBER).setRanges([umurRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRange]).build()
    ]);

    // range protection — lock 🔴, leave only the five 🟡 columns editable (warning-only).
    const prot = sh.protect().setDescription(
      'ROSH Rute — kolom 🔴 dikunci. Edit hanya 🟡: Zona, Pin Maps, Status/Tgl/Hasil Kunjungan.');
    prot.setUnprotectedRanges(ROUTE_YELLOW_COLS.map(function(col) {
      return sh.getRange(ROUTE_DROW, col, matrix.length, 1);
    }));
    prot.setWarningOnly(true);
  }

  // side panel — zona priority ranking (to the right of the 13-col table, +1 spacer)
  _writeRoutePanel(sh, 15, plan);

  // footnote
  const fnRow = ROUTE_DROW + Math.max(matrix.length, 1) + 1;
  uiFootnote(sh, fnRow, ROUTE_SPAN,
    '◆ Cara pakai: Zona (auto) = kecamatan yang dibaca dari teks alamat (kata "Kecamatan"), fallback geocode — kalau benar biarkan, kalau salah isi ' +
    'kolom Zona di kirinya (input Ade menang). Tempel link Google Maps di Pin Maps untuk titik presisi (kalau kosong, ' +
    'koordinat geocode dipakai). Urutan zona = total Outstanding × (1 + umur tertua × ' + CONFIG.ROUTE.AGING_WEIGHT +
    '): banyak tunggakan kecil tapi tua tetap naik. Customer tanpa zona (Ade maupun auto) dikumpulkan paling bawah.');

  // widths
  sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 60);
  sh.setColumnWidth(4, 190); sh.setColumnWidth(5, 260); sh.setColumnWidth(6, 200);
  sh.setColumnWidth(7, 130); sh.setColumnWidth(8, 95);  sh.setColumnWidth(9, 130);
  sh.setColumnWidth(10, 150); sh.setColumnWidth(11, 110); sh.setColumnWidth(12, 220);
  sh.setColumnWidth(13, 190); // Loyalitas (4bln)
  return sh;
}

// Right-side panel (cols sc..sc+3): zona priority ranking so Ade sees the order at a glance.
function _writeRoutePanel(sh, sc, plan) {
  sh.getRange(1, sc, 1, 4).merge().setValue('📊 Prioritas Zona Minggu Ini')
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold').setVerticalAlignment('middle');
  sh.getRange(2, sc, 1, 4).setValues([['#', 'Zona', 'Total Outstanding', 'Umur · Titik']])
    .setBackground(UI.BAND).setFontWeight('bold');

  const ranked = plan.filter(function(g) { return g.zona !== ROUTE_UNZONED && g.members.length; });
  let r = 3, rank = 1;
  ranked.forEach(function(g) {
    sh.getRange(r, sc, 1, 4).setValues([[rank, g.zona, g.totalOut, g.oldest + ' hr · ' + g.count + ' titik']]);
    sh.getRange(r, sc + 2).setNumberFormat('"Rp"#,##0');
    r++; rank++;
  });
  const unz = plan.filter(function(g) { return g.zona === ROUTE_UNZONED && g.members.length; })[0];
  if (unz) {
    sh.getRange(r, sc, 1, 4).setValues([['–', ROUTE_UNZONED, unz.totalOut, unz.count + ' titik (isi zona!)']])
      .setBackground(UI.T_AMBER);
    sh.getRange(r, sc + 2).setNumberFormat('"Rp"#,##0');
    r++;
  }
  if (r === 3) {
    sh.getRange(r, sc, 1, 4).merge().setValue('(belum ada data)').setFontColor(UI.NOTE).setFontStyle('italic');
  }

  sh.setColumnWidth(sc, 36); sh.setColumnWidth(sc + 1, 150);
  sh.setColumnWidth(sc + 2, 140); sh.setColumnWidth(sc + 3, 130);
}
