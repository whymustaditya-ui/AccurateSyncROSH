/**
 * Rekap.gs — 🏢 REKAP TAGIHAN CORPORATE (seksi di bawah tabel 🧾 Tagihan Non-Sales, master-only)
 * ─────────────────────────────────────────────────────────────────────────────
 * Beberapa customer (grup Sinar Rasa, The Akara, Legenda Kuliner, LB Foods, BWC) bayar
 * berdasarkan rekap tagihan yang harus mencantumkan NOMOR SURAT JALAN per faktur. Seksi ini
 * menarik SEMUA faktur belum lunas customer tsb (tanpa batas umur)
 * dan melampirkan No. Surat Jalan (Pengiriman Pesanan) dari `sales-invoice/detail.do`.
 *
 * Daftar customer = CONFIG.REKAP_CUSTOMERS (match "contains" setelah normalisasi nama,
 * jadi "PT Sinar Rasa Abadi" vs "SINAR RASA ABADI" tetap ketemu).
 *
 * Surat jalan TIDAK ada di list.do, hanya di detail.do → dicache di sheet tersembunyi
 * `_SjCache` (invoiceId | number | suratJalan | fetchedAt | salesOrder). SJ + No. Pesanan (SO)
 * statis per faktur, jadi satu kali tarik (SO ditambah 2026-09-23). Per run dibatasi REKAP_SJ_MAX / REKAP_SJ_BUDGET_MS
 * (drain bertahap, pola attachCustomerContacts). Scope: sales_invoice_view (sudah ada).
 *
 * Field SJ CONFIRMED via diagSuratJalan 2026-09-13: `detailItem[].deliveryOrder.number`
 * (header `deliveryOrder` cuma boolean, diabaikan). Kalau build Accurate berubah, jalankan
 * menu "Diag surat jalan fields", sesuaikan `_sjFromDetail`, lalu "Rebuild cache Surat Jalan".
 *
 * Reuse globals: accApi, num, fmtDate, stripTime, _ss, SYNC_START, fakturLinkFormula, UI.
 */

var SJ_CACHE_SHEET   = '_SjCache';
var SJ_CACHE_HEADERS = ['invoiceId', 'number', 'suratJalan', 'fetchedAt', 'salesOrder'];
var SJ_NONE          = '(tanpa SJ)';   // sentinel: sudah dicek, faktur tidak punya surat jalan
var SO_NONE          = '(tanpa SO)';   // sentinel: sudah dicek, faktur tidak dari pesanan penjualan
var REKAP_SJ_MAX       = 60;           // maks detail.do per run
var REKAP_SJ_BUDGET_MS = 60 * 1000;    // waktu maks untuk tarik SJ per run
var REKAP_SO_RE = /^SO\.\d{4}\./i;    // SO.2026.09.00129

// ── Nama customer ────────────────────────────────────────────────────────────
function _rekapNorm(name) {
  return String(name || '').toLowerCase()
    .replace(/\b(pt|cv|ud|tb|toko)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function _rekapMatch(invCustomer, target) {
  const a = _rekapNorm(invCustomer), b = _rekapNorm(target);
  if (!a || !b) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

// Entri CONFIG.REKAP_CUSTOMERS boleh string ('The Akara') atau objek
// { label: 'Yakiniku Futago Senayan (PT LBfoods Rasa Prima)', match: 'LBFoods' }.
// label = yang dibaca manusia di sheet, match = kata kunci yang dicocokkan ke nama di Accurate.
function _rekapTarget(t) {
  if (t && typeof t === 'object') return { label: String(t.label || t.match || ''), match: String(t.match || t.label || '') };
  return { label: String(t || ''), match: String(t || '') };
}

function _rekapRp(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

// ── Cache ────────────────────────────────────────────────────────────────────
function _sjCacheSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);   // selalu master, seperti _ThpHistory
  const W = SJ_CACHE_HEADERS.length;
  let sh = ss.getSheetByName(SJ_CACHE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SJ_CACHE_SHEET);
    sh.getRange(1, 1, 1, W).setValues([SJ_CACHE_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}
// → { invoiceId: {number, sj, at, so} }. Baris lama (skema 4 kolom, pra 2026-09-23) punya
//   so '' → ditarik ulang sekali untuk mengisi SO.
function _loadSjCache() {
  const sh = _sjCacheSheet();
  const n = sh.getLastRow();
  const W = SJ_CACHE_HEADERS.length;
  const map = {};
  if (n < 2) return map;
  sh.getRange(2, 1, n - 1, W).getValues().forEach(function(r) {
    if (r[0] === '' || r[0] == null) return;
    map[String(r[0])] = {
      number: String(r[1] || ''),
      sj: _sjClean(r[2]) || (String(r[2] || '') ? SJ_NONE : ''),
      at: r[3] instanceof Date ? Utilities.formatDate(r[3], 'GMT+7', 'yyyy-MM-dd HH:mm') : String(r[3] || ''),
      so: String(r[4] || '')
    };
  });
  return map;
}
// Tulis ulang seluruh cache (upsert di memori; cache kecil, cuma faktur customer corporate).
function _saveSjCache(map) {
  const sh = _sjCacheSheet();
  const W = SJ_CACHE_HEADERS.length;
  sh.clearContents();
  sh.getRange(1, 1, 1, W).setValues([SJ_CACHE_HEADERS]);
  const rows = Object.keys(map).map(function(id) {
    const c = map[id];
    return [id, c.number, c.sj, c.at, c.so];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, W).setNumberFormat('@').setValues(rows);
}

// Ambil nomor surat jalan dari JSON detail.do. CONFIRMED diag 2026-09-13: nomor SJ ada di
// `detailItem[].deliveryOrder.number` (mis. DO.2026.09.00055); header `deliveryOrder` cuma
// boolean (false) → wajib diabaikan, kalau tidak ikut tercetak "false". Faktur dari beberapa
// SJ → nomor digabung ', ' (unik).
function _sjFromDetail(d) {
  const seen = {};
  function add(v) {
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return;
    if (typeof v === 'object') v = v.number || v.no || v.transNumber || '';
    v = String(v).trim();
    if (v && v !== 'false' && v !== 'true') seen[v] = 1;
  }
  (d.detailItem || d.detailItems || []).forEach(function(it) {
    if (!it || typeof it !== 'object') return;
    add(it.deliveryOrder);          // ← sumber utama (confirmed)
    add(it.deliveryOrderNumber);    // jaga-jaga build lain
  });
  return Object.keys(seen).join(', ');
}

// Bersihkan token "false"/"true" dari nilai cache lama (bug ekstraktor sebelum diag 2026-09-13).
function _sjClean(v) {
  const parts = String(v || '').split(',').map(function(x) { return x.trim(); })
    .filter(function(x) { return x && x !== 'false' && x !== 'true'; });
  return parts.join(', ');
}

// Nomor Pesanan Penjualan (SO) dari JSON detail.do: objek di bawah key salesOrder yang punya
// `number`, atau string apa pun berpola SO.yyyy. (terisi benar di sync 2026-09-23).
function _soFromDetail(d) {
  const so = {};
  function walk(v, key, depth) {
    if (v == null || depth > 6) return;
    if (typeof v === 'string') { if (REKAP_SO_RE.test(v.trim())) so[v.trim()] = 1; return; }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(function(x) { walk(x, key, depth + 1); }); return; }
    if (/salesorder/i.test(key) && typeof v.number === 'string' && /^[A-Z]{2,5}\.\d{4}\./i.test(v.number)) so[v.number.trim()] = 1;
    Object.keys(v).forEach(function(k) { walk(v[k], k, depth + 1); });
  }
  walk(d, '', 0);
  return Object.keys(so).join(', ');
}

// Isi `inv.suratJalan` / `inv.salesOrder`; tarik detail.do hanya bila perlu:
//   P0 belum pernah ditarik · P1 baris cache lama tanpa SO. SJ + SO statis, tak dicek ulang.
function attachSuratJalan(list) {
  const cache = _loadSjCache();
  const queue = [];
  list.forEach(function(i) {
    const c = cache[String(i.id)];
    i.suratJalan  = c ? c.sj : '';
    i.salesOrder  = c ? c.so : '';
    let p = -1;
    if (!c || !c.sj) p = 0;
    else if (!c.so) p = 1;
    if (p >= 0) queue.push({ inv: i, p: p });
  });
  queue.sort(function(a, b) { return a.p - b.p; });

  const t0 = Date.now();
  let pulls = 0, skipped = 0;
  queue.forEach(function(q) {
    const i = q.inv;
    if (pulls >= REKAP_SJ_MAX || (Date.now() - t0) > REKAP_SJ_BUDGET_MS) { skipped++; return; }
    pulls++;
    try {
      const det = accApi('/accurate/api/sales-invoice/detail.do', { id: i.id });
      const d = (det && det.d) || {};
      i.suratJalan  = _sjFromDetail(d) || SJ_NONE;
      i.salesOrder  = _soFromDetail(d) || SO_NONE;
      cache[String(i.id)] = { number: i.number, sj: i.suratJalan, so: i.salesOrder,
                              at: Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm') };
    } catch (e) {
      Logger.log('Detail rekap gagal ' + i.number + ': ' + e.message);
    }
  });
  if (pulls) _saveSjCache(cache);
  if (pulls || skipped) Logger.log('Surat jalan/SO: ' + pulls + ' ditarik, ' + skipped + ' ditunda ke sync berikut.');
  return list;
}

// ── Build ────────────────────────────────────────────────────────────────────
// → [{ name, rows:[…], total, paid, outstanding, oldest }] urut CONFIG.REKAP_CUSTOMERS.
//   Customer tanpa faktur terbuka tetap muncul (rows kosong) supaya salah nama kelihatan.
function buildRekapCorporate(invoices, today) {
  const targets = CONFIG.REKAP_CUSTOMERS || [];
  const open = invoices.filter(function(i) { return !i.isPaid && i.outstanding > 0; });
  const groups = targets.map(function(t) {
    const tg = _rekapTarget(t);
    const list = open.filter(function(i) { return _rekapMatch(i.customer, tg.match); })
      .sort(function(a, b) { return (a.transDate || 0) - (b.transDate || 0); });
    return { name: tg.label, match: tg.match, rows: list, total: 0, paid: 0, outstanding: 0, oldest: null, names: {} };
  });
  const need = [];
  groups.forEach(function(g) { g.rows.forEach(function(i) { need.push(i); }); });
  try { attachSuratJalan(need); } catch (e) { Logger.log('Surat jalan dilewati: ' + e.message); }

  groups.forEach(function(g) {
    g.rows.forEach(function(i) {
      g.total += i.total; g.paid += i.paid; g.outstanding += i.outstanding;
      if (i.daysPastDue != null && (g.oldest == null || i.daysPastDue > g.oldest)) g.oldest = i.daysPastDue;
      g.names[i.customer] = 1;
    });
  });
  return groups;
}

function _rekapStatus(i, today) {
  if (i.daysPastDue == null || i.daysPastDue < 0) return 'Belum jatuh tempo';
  if (i.daysPastDue === 0) return 'Jatuh tempo hari ini';
  return 'Lewat ' + i.daysPastDue + ' hari';
}

// ── Writer: seksi di bawah tabel Tagihan Non-Sales ───────────────────────────
// startRow = baris kosong pertama setelah tabel utama. Lebar 14 kolom (kolom 11-14 menumpang
// kolom spacer + side panel di baris 1-25; seksi ini mulai jauh di bawahnya, tidak bertabrakan).
function writeRekapSection(sh, startRow, groups, today) {
  const SPAN = 14;
  let row = startRow + 2;
  sh.getRange(row, 1, 1, SPAN).merge()
    .setValue('🏢 REKAP TAGIHAN CORPORATE + NO. PESANAN & SURAT JALAN')
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold').setFontSize(13)
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 36);
  row++;
  sh.getRange(row, 1, 1, SPAN).merge()
    .setValue('Semua faktur BELUM LUNAS customer di daftar (tanpa batas umur). Untuk lampiran rekap ke finance customer. ' +
              'No. Surat Jalan = Pengiriman Pesanan di Accurate; kosong = belum tertarik (nyusul sync berikut), "' +
              SJ_NONE + '" = faktur tidak punya SJ. ' +
              'Daftar customer: CONFIG.REKAP_CUSTOMERS.')
    .setBackground(UI.BAND).setFontColor(UI.NOTE).setFontStyle('italic').setFontSize(10).setWrap(true)
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 40);
  row += 2;

  const headers = ['No. Invoice', 'Tgl Terbit', 'No. Pesanan (SO)', 'No. Surat Jalan',
                   'Jatuh Tempo', 'Hari Lewat JT', 'Nilai Faktur', 'Sudah Bayar', 'Outstanding', 'Status',
                   '📄 Invoice', 'Sales / Sumber', 'No. Telp', 'Loyalitas (4bln)'];
  const cf = { days: [], tier: [] };

  groups.forEach(function(g) {
    const names = Object.keys(g.names);
    const label = g.name.toUpperCase() +
      (names.length && _rekapNorm(names[0]) !== _rekapNorm(g.match || g.name) ? '  (di Accurate: ' + names.join(' / ') + ')' : '');
    sh.getRange(row, 1, 1, SPAN).merge()
      .setValue(label + '  ·  ' + g.rows.length + ' faktur  ·  Outstanding Rp' + _rekapRp(g.outstanding) +
                (g.oldest != null && g.oldest > 0 ? '  ·  tertua lewat ' + g.oldest + ' hari' : ''))
      .setBackground(UI.BLUE).setFontColor(UI.WHITE).setFontWeight('bold').setVerticalAlignment('middle');
    sh.setRowHeight(row, 28);
    row++;

    if (!g.rows.length) {
      sh.getRange(row, 1, 1, SPAN).merge()
        .setValue('Tidak ada faktur terbuka. Kalau seharusnya ada, nama di CONFIG.REKAP_CUSTOMERS tidak cocok dengan nama customer di Accurate.')
        .setFontColor(UI.NOTE).setFontStyle('italic');
      row += 2;
      return;
    }

    sh.getRange(row, 1, 1, SPAN).setValues([headers])
      .setFontWeight('bold').setBackground(UI.BAND).setBorder(false, false, true, false, false, false);
    row++;

    const rows = g.rows.map(function(i) {
      return [i.number, fmtDate(i.transDate), i.salesOrder || '', i.suratJalan || '',
              fmtDate(i.dueDate), i.daysPastDue == null ? '' : i.daysPastDue, i.total, i.paid, i.outstanding,
              _rekapStatus(i, today), fakturLinkFormula(i.id, i.number, i.customerId),
              i.salesman || '(POS / online)', i.noTlp || '', i.custTierText || ''];
    });
    sh.getRange(row, 1, rows.length, SPAN).setValues(rows);
    sh.getRange(row, 7, rows.length, 3).setNumberFormat('"Rp"#,##0');
    sh.getRange(row, 6, rows.length, 1).setNumberFormat('0');
    sh.getRange(row, 3, rows.length, 2).setWrap(true);
    cf.days.push(sh.getRange(row, 6, rows.length, 1));
    cf.tier.push(sh.getRange(row, 14, rows.length, 1));
    row += rows.length;

    sh.getRange(row, 1, 1, SPAN).setValues([
      ['SUBTOTAL', '', g.rows.length + ' faktur', '', '', '', g.total, g.paid, g.outstanding, '', '', '', '', '']
    ]).setFontWeight('bold').setBackground(UI.BLUE_SOFT);
    sh.getRange(row, 7, 1, 3).setNumberFormat('"Rp"#,##0');
    row += 2;
  });

  // Total semua customer di daftar
  const T = groups.reduce(function(s, g) { s.n += g.rows.length; s.t += g.total; s.p += g.paid; s.o += g.outstanding; return s; },
                          { n: 0, t: 0, p: 0, o: 0 });
  sh.getRange(row, 1, 1, SPAN).setValues([
    ['TOTAL CORPORATE', '', T.n + ' faktur', '', '', '', T.t, T.p, T.o, '', '', '', '', '']
  ]).setFontWeight('bold').setBackground(UI.INK).setFontColor(UI.WHITE);
  sh.getRange(row, 7, 1, 3).setNumberFormat('"Rp"#,##0');

  // Kolom 3-4 = nomor dokumen (tabel atas: Sales / Sumber, Jatuh Tempo ikut melebar, tak apa)
  sh.setColumnWidth(3, 175);
  sh.setColumnWidth(4, 175);
  sh.setColumnWidth(10, 150);  // Status
  sh.setColumnWidth(12, 130);  // Sales / Sumber (side panel kolom label)
  sh.setColumnWidth(14, 190);  // Loyalitas
  return cf;                   // {days, tier}: digabung ke rules warna tab oleh pemanggil
}

// ── Writer: TAB berdiri sendiri (file ROSH AR) ───────────────────────────────
// Isi sama dengan seksi di master, tapi jadi tab sendiri + satu kolom 🟡 📝 Catatan yang
// boleh diisi tangan. Catatan di-UPSERT per NOMOR FAKTUR (pola 🟡 Pool A/B), jadi sync
// harian tidak menghapus tulisan Ade. Nol call Accurate tambahan — groups-nya sudah dibangun
// sekali di fullSync (surat jalan ikut cache _SjCache di master).
var REKAP_TAB_SPAN  = 13;
var REKAP_NOTE_COL  = 13;   // 📝 Catatan (🟡, satu-satunya kolom yang boleh diisi tangan)
var REKAP_NOTE_HDR  = '📝 Catatan';

// Kumpulkan catatan yang sudah ada dari file-file yang diberikan, dikunci nomor faktur.
// Nilai non-kosong dari file BELAKANGAN menang (sama seperti collectPoolYellow).
function collectRekapYellow(ssList) {
  const map = {};
  (ssList || []).forEach(function(ss) {
    if (!ss) return;
    const sh = ss.getSheetByName(CONFIG.TABS.REKAP);
    if (!sh || sh.getLastRow() < 2) return;
    // Kolom catatan dicari dari baris header, bukan indeks tetap: tab lama (12 kolom, catatan di
    // kolom 12) tetap terbaca waktu pertama kali ditulis ulang ke skema 13 kolom.
    let noteIdx = REKAP_NOTE_COL - 1;
    const W = Math.max(sh.getLastColumn(), REKAP_TAB_SPAN);
    sh.getRange(1, 1, sh.getLastRow(), W).getValues().forEach(function(r) {
      const key = String(r[0] || '').trim();
      if (/^No\. Invoice/i.test(key)) { const h = r.indexOf(REKAP_NOTE_HDR); if (h >= 0) noteIdx = h; return; }
      if (!key || /^(SUBTOTAL|TOTAL)/i.test(key)) return;
      const note = r[noteIdx];
      if (note !== '' && note != null) map[key] = note;
    });
  });
  return map;
}

function writeRekapTab(groups, today, notes) {
  notes = notes || {};
  today = today || stripTime(new Date());
  const SPAN = REKAP_TAB_SPAN;
  const sh = uiSheet(CONFIG.TABS.REKAP);
  sh.setFrozenColumns(0);   // banner ter-merge selebar tab → freeze kolom ditolak Sheets
  sh.setFrozenRows(0);

  let r = uiBanner(sh, 1, SPAN,
    '🏢 REKAP TAGIHAN CORPORATE + NO. PESANAN & SURAT JALAN',
    'Customer yang bayarnya lewat rekap tagihan: semua faktur BELUM LUNAS, tanpa batas umur. ' +
    'Pakai ini untuk lampiran rekap ke finance customer. No. Surat Jalan = Pengiriman Pesanan di ' +
    'Accurate; kosong = belum tertarik (nyusul sync berikutnya), "' + SJ_NONE + '" = faktur memang tanpa SJ. ' +
    'Kolom 📝 Catatan (kuning) boleh kamu isi — tidak akan terhapus sync harian.',
    UI.INK, UI.BAND);
  r += 1;

  const headers = ['No. Invoice', 'Tgl Terbit', 'No. Pesanan (SO)', 'No. Surat Jalan',
                   'Jatuh Tempo', 'Hari Lewat JT', 'Nilai Faktur', 'Sudah Bayar', 'Outstanding', 'Status',
                   '📄 Invoice', 'Loyalitas (4bln)', REKAP_NOTE_HDR];
  const cfDays = [], cfTier = [], noteRanges = [];

  (groups || []).forEach(function(g) {
    const names = Object.keys(g.names || {});
    const label = String(g.name || '').toUpperCase() +
      (names.length && _rekapNorm(names[0]) !== _rekapNorm(g.match || g.name)
        ? '  (di Accurate: ' + names.join(' / ') + ')' : '');
    r = uiSection(sh, r, SPAN,
      label + '  ·  ' + g.rows.length + ' faktur  ·  Outstanding Rp' + _rekapRp(g.outstanding) +
      (g.oldest != null && g.oldest > 0 ? '  ·  tertua lewat ' + g.oldest + ' hari' : ''),
      UI.BLUE);

    if (!g.rows.length) {
      sh.getRange(r, 1, 1, SPAN).merge()
        .setValue('Tidak ada faktur terbuka.')
        .setFontColor(UI.NOTE).setFontStyle('italic');
      r += 2;
      return;
    }

    uiHeaderRow(sh, r, headers);
    r++;

    const rows = g.rows.map(function(i) {
      return [i.number, fmtDate(i.transDate), i.salesOrder || '', i.suratJalan || '',
              fmtDate(i.dueDate), i.daysPastDue == null ? '' : i.daysPastDue, i.total, i.paid, i.outstanding,
              _rekapStatus(i, today), fakturLinkFormula(i.id, i.number, i.customerId),
              i.custTierText || '', notes[String(i.number)] || ''];
    });
    sh.getRange(r, 1, rows.length, SPAN).setValues(rows).setVerticalAlignment('middle');
    sh.getRange(r, 7, rows.length, 3).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 6, rows.length, 1).setNumberFormat('0').setHorizontalAlignment('center');
    sh.getRange(r, 3, rows.length, 2).setWrap(true);
    sh.getRange(r, REKAP_NOTE_COL, rows.length, 1)
      .setBackground(UI.AMBER_BODY).setFontColor(UI.AMBER).setWrap(true);
    cfDays.push(sh.getRange(r, 6, rows.length, 1));
    cfTier.push(sh.getRange(r, 12, rows.length, 1));
    noteRanges.push(sh.getRange(r, REKAP_NOTE_COL, rows.length, 1));
    r += rows.length;

    sh.getRange(r, 1, 1, SPAN).setValues([
      ['SUBTOTAL', '', g.rows.length + ' faktur', '', '', '', g.total, g.paid, g.outstanding, '', '', '', '']
    ]).setFontWeight('bold').setBackground(UI.BLUE_SOFT);
    sh.getRange(r, 7, 1, 3).setNumberFormat('"Rp"#,##0');
    r += 2;
  });

  const T = (groups || []).reduce(function(s, g) {
    s.n += g.rows.length; s.t += g.total; s.p += g.paid; s.o += g.outstanding; return s;
  }, { n: 0, t: 0, p: 0, o: 0 });
  sh.getRange(r, 1, 1, SPAN).setValues([
    ['TOTAL CORPORATE', '', T.n + ' faktur', '', '', '', T.t, T.p, T.o, '', '', '', '']
  ]).setFontWeight('bold').setBackground(UI.INK).setFontColor(UI.WHITE);
  sh.getRange(r, 7, 1, 3).setNumberFormat('"Rp"#,##0');
  r += 2;
  r = uiFootnote(sh, r, SPAN,
    'Angka 🔴 ditulis ulang tiap sync pagi — jangan diedit, tulisanmu akan hilang. ' +
    'Yang kamu isi cuma kolom 📝 Catatan; isinya dikunci ke nomor faktur, jadi tetap menempel ' +
    'selama faktur itu belum lunas. Faktur lunas otomatis hilang dari daftar (catatannya ikut hilang).');

  if (cfDays.length) {
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
        .setBackground('#fef9c3').setRanges(cfDays).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0, 6)
        .setBackground('#fed7aa').setRanges(cfDays).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(7)
        .setBackground('#fecaca').setRanges(cfDays).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges(cfTier).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges(cfTier).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges(cfTier).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges(cfTier).build()
    ]);
  }

  [[1, 150], [2, 95], [3, 170], [4, 175], [5, 95], [6, 95], [7, 120], [8, 110], [9, 120],
   [10, 150], [11, 90], [12, 170], [13, 260]].forEach(function(w) { sh.setColumnWidth(w[0], w[1]); });
}

// ── Menu / diag ──────────────────────────────────────────────────────────────
/** Wipe cache SJ lalu tarik ulang lewat sync berikut (dipakai kalau mapping field diganti). */
function rebuildSjCacheNow() {
  const sh = _sjCacheSheet();
  sh.clearContents();
  sh.getRange(1, 1, 1, SJ_CACHE_HEADERS.length).setValues([SJ_CACHE_HEADERS]);
  SpreadsheetApp.getUi().alert('Cache surat jalan dikosongkan. Jalankan Run Full Sync now untuk menarik ulang.');
}

/** DIAG — dump field yang berbau surat jalan dari detail.do satu faktur (tanpa id → faktur pertama
 *  customer di CONFIG.REKAP_CUSTOMERS yang masih terbuka). Baca di View › Logs. */
function diagSuratJalan(invoiceId) {
  let id = invoiceId;
  if (!id) {
    const inv = fetchSalesInvoices().filter(function(i) {
      return !i.isPaid && i.outstanding > 0 &&
             (CONFIG.REKAP_CUSTOMERS || []).some(function(t) { return _rekapMatch(i.customer, _rekapTarget(t).match); });
    })[0];
    if (!inv) { Logger.log('Tidak ada faktur terbuka untuk customer di REKAP_CUSTOMERS.'); return; }
    id = inv.id;
    Logger.log('Pakai faktur ' + inv.number + ' (' + inv.customer + ')');
  }
  const det = accApi('/accurate/api/sales-invoice/detail.do', { id: id });
  const d = (det && det.d) || {};
  Logger.log('header keys: ' + Object.keys(d).join(', '));
  Object.keys(d).forEach(function(k) {
    if (/deliver|order|pengiriman|surat/i.test(k)) Logger.log('header.' + k + ' = ' + JSON.stringify(d[k]).slice(0, 300));
  });
  const items = d.detailItem || d.detailItems || [];
  if (items[0]) {
    Logger.log('detailItem[0] keys: ' + Object.keys(items[0]).join(', '));
    Object.keys(items[0]).forEach(function(k) {
      if (/deliver|order|pengiriman|surat/i.test(k)) Logger.log('detailItem[0].' + k + ' = ' + JSON.stringify(items[0][k]).slice(0, 300));
    });
  }
  Logger.log('_sjFromDetail → "' + _sjFromDetail(d) + '"');
  Logger.log('_soFromDetail → "' + _soFromDetail(d) + '"');
}
