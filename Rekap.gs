/**
 * Rekap.gs — 🏢 REKAP TAGIHAN CORPORATE (seksi di bawah tabel 🧾 Tagihan Non-Sales, master-only)
 * ─────────────────────────────────────────────────────────────────────────────
 * Beberapa customer (grup Sinar Rasa, The Akara, Legenda Kuliner, LB Foods, BWC) bayar
 * berdasarkan rekap tagihan yang harus mencantumkan NOMOR SURAT JALAN per faktur. Seksi ini
 * menarik SEMUA faktur belum lunas customer tsb (tanpa batas umur, termasuk yang sudah di Ade)
 * dan melampirkan No. Surat Jalan (Pengiriman Pesanan) dari `sales-invoice/detail.do`.
 *
 * Daftar customer = CONFIG.REKAP_CUSTOMERS (match "contains" setelah normalisasi nama,
 * jadi "PT Sinar Rasa Abadi" vs "SINAR RASA ABADI" tetap ketemu).
 *
 * Surat jalan TIDAK ada di list.do, hanya di detail.do → dicache di sheet tersembunyi
 * `_SjCache` (invoiceId | number | suratJalan | fetchedAt). Faktur sudah terbit ⇒ SJ statis,
 * jadi satu kali tarik per faktur. Per run dibatasi REKAP_SJ_MAX / REKAP_SJ_BUDGET_MS
 * (drain bertahap, pola attachCustomerContacts). Scope: sales_invoice_view (sudah ada).
 *
 * Field SJ CONFIRMED via diagSuratJalan 2026-09-13: `detailItem[].deliveryOrder.number`
 * (header `deliveryOrder` cuma boolean, diabaikan). Kalau build Accurate berubah, jalankan
 * menu "Diag surat jalan fields", sesuaikan `_sjFromDetail`, lalu "Rebuild cache Surat Jalan".
 *
 * Reuse globals: accApi, num, fmtDate, stripTime, _ss, SYNC_START, fakturLinkFormula, UI.
 */

var SJ_CACHE_SHEET   = '_SjCache';
var SJ_CACHE_HEADERS = ['invoiceId', 'number', 'suratJalan', 'fetchedAt'];
var SJ_NONE          = '(tanpa SJ)';   // sentinel: sudah dicek, faktur tidak punya surat jalan
var REKAP_SJ_MAX       = 60;           // maks detail.do per run
var REKAP_SJ_BUDGET_MS = 60 * 1000;    // waktu maks untuk tarik SJ per run

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
function _loadSjCache() {
  const sh = _sjCacheSheet();
  const n = sh.getLastRow();
  const map = {};
  if (n < 2) return map;
  sh.getRange(2, 1, n - 1, SJ_CACHE_HEADERS.length).getValues().forEach(function(r) {
    if (r[0] !== '' && r[0] != null) map[String(r[0])] = _sjClean(r[2]) || (String(r[2] || '') ? SJ_NONE : '');
  });
  return map;
}
function _appendSjCache(rows) {
  if (!rows.length) return;
  const sh = _sjCacheSheet();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, SJ_CACHE_HEADERS.length).setValues(rows);
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

// Isi `inv.suratJalan` untuk daftar faktur; tarik detail.do hanya yang belum ada di cache.
function attachSuratJalan(list) {
  const cache = _loadSjCache();
  const t0 = Date.now();
  const fresh = [];
  let pulls = 0, skipped = 0;
  list.forEach(function(i) {
    const key = String(i.id);
    if (cache[key] != null && cache[key] !== '') { i.suratJalan = cache[key]; return; }
    if (pulls >= REKAP_SJ_MAX || (Date.now() - t0) > REKAP_SJ_BUDGET_MS) { skipped++; i.suratJalan = ''; return; }
    pulls++;
    try {
      const det = accApi('/accurate/api/sales-invoice/detail.do', { id: i.id });
      const sj = _sjFromDetail((det && det.d) || {}) || SJ_NONE;
      i.suratJalan = sj;
      fresh.push([i.id, i.number, sj, Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm')]);
    } catch (e) {
      i.suratJalan = '';
      Logger.log('SJ gagal ' + i.number + ': ' + e.message);
    }
  });
  _appendSjCache(fresh);
  if (pulls || skipped) Logger.log('Surat jalan: ' + pulls + ' ditarik, ' + skipped + ' ditunda ke sync berikut.');
  return list;
}

// ── Build ────────────────────────────────────────────────────────────────────
// → [{ name, rows:[…], total, paid, outstanding, oldest }] urut CONFIG.REKAP_CUSTOMERS.
//   Customer tanpa faktur terbuka tetap muncul (rows kosong) supaya salah nama kelihatan.
function buildRekapCorporate(invoices, today) {
  const targets = CONFIG.REKAP_CUSTOMERS || [];
  const open = invoices.filter(function(i) { return !i.isPaid && i.outstanding > 0; });
  const groups = targets.map(function(t) {
    const list = open.filter(function(i) { return _rekapMatch(i.customer, t); })
      .sort(function(a, b) { return (a.transDate || 0) - (b.transDate || 0); });
    return { name: t, rows: list, total: 0, paid: 0, outstanding: 0, oldest: null, names: {} };
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
  const atAde = i.handoverDate && i.handoverDate <= today;
  return 'Lewat ' + i.daysPastDue + ' hari' + (atAde ? ' (di ' + CONFIG.AR_OFFICER_NAME + ')' : '');
}

// ── Writer: seksi di bawah tabel Tagihan Non-Sales ───────────────────────────
// startRow = baris kosong pertama setelah tabel utama. Lebar 10 kolom (sama dengan tabel).
function writeRekapSection(sh, startRow, groups, today) {
  const SPAN = 10;
  let row = startRow + 2;
  sh.getRange(row, 1, 1, SPAN).merge()
    .setValue('🏢 REKAP TAGIHAN CORPORATE + NO. SURAT JALAN')
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold').setFontSize(13)
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 36);
  row++;
  sh.getRange(row, 1, 1, SPAN).merge()
    .setValue('Semua faktur BELUM LUNAS customer di daftar (tanpa batas umur, termasuk yang sudah di ' +
              CONFIG.AR_OFFICER_NAME + '). Untuk lampiran rekap ke finance customer. ' +
              'No. Surat Jalan = Pengiriman Pesanan di Accurate; kosong = belum tertarik (nyusul sync berikut), "' +
              SJ_NONE + '" = faktur tidak punya SJ. Daftar customer: CONFIG.REKAP_CUSTOMERS.')
    .setBackground(UI.BAND).setFontColor(UI.NOTE).setFontStyle('italic').setFontSize(10).setWrap(true)
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 40);
  row += 2;

  const headers = ['No. Invoice', 'Tgl Terbit', 'No. Surat Jalan', 'Jatuh Tempo', 'Hari Lewat JT',
                   'Nilai Faktur', 'Sudah Bayar', 'Outstanding', 'Status', '📄 Invoice'];
  const cfRanges = [];

  groups.forEach(function(g) {
    const names = Object.keys(g.names);
    const label = g.name.toUpperCase() +
      (names.length && _rekapNorm(names[0]) !== _rekapNorm(g.name) ? '  (di Accurate: ' + names.join(' / ') + ')' : '');
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
      return [i.number, fmtDate(i.transDate), i.suratJalan || '', fmtDate(i.dueDate),
              i.daysPastDue == null ? '' : i.daysPastDue, i.total, i.paid, i.outstanding,
              _rekapStatus(i, today), fakturLinkFormula(i.id, i.number, i.customerId)];
    });
    sh.getRange(row, 1, rows.length, SPAN).setValues(rows);
    sh.getRange(row, 6, rows.length, 3).setNumberFormat('"Rp"#,##0');
    sh.getRange(row, 5, rows.length, 1).setNumberFormat('0');
    sh.getRange(row, 3, rows.length, 1).setWrap(true);
    cfRanges.push(sh.getRange(row, 5, rows.length, 1));
    row += rows.length;

    sh.getRange(row, 1, 1, SPAN).setValues([
      ['SUBTOTAL', '', g.rows.length + ' faktur', '', '', g.total, g.paid, g.outstanding, '', '']
    ]).setFontWeight('bold').setBackground(UI.BLUE_SOFT);
    sh.getRange(row, 6, 1, 3).setNumberFormat('"Rp"#,##0');
    row += 2;
  });

  // Total semua customer di daftar
  const T = groups.reduce(function(s, g) { s.n += g.rows.length; s.t += g.total; s.p += g.paid; s.o += g.outstanding; return s; },
                          { n: 0, t: 0, p: 0, o: 0 });
  sh.getRange(row, 1, 1, SPAN).setValues([
    ['TOTAL CORPORATE', '', T.n + ' faktur', '', '', T.t, T.p, T.o, '', '']
  ]).setFontWeight('bold').setBackground(UI.INK).setFontColor(UI.WHITE);
  sh.getRange(row, 6, 1, 3).setNumberFormat('"Rp"#,##0');

  sh.setColumnWidth(3, 190);   // No. Surat Jalan (tabel atas: Sales / Sumber ikut melebar, tak apa)
  return cfRanges;             // warna Hari Lewat JT digabung ke rules tab oleh pemanggil
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
             (CONFIG.REKAP_CUSTOMERS || []).some(function(t) { return _rekapMatch(i.customer, t); });
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
}
