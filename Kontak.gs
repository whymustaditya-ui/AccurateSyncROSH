/**
 * ROSH × Accurate — 📇 Kontak Customer (directory semua customer).
 *
 * Tab master-only: Nama Customer | No WA | No Bisnis, diambil dari customer master
 * Accurate. customer/list.do cuma balikin {id} (lihat CLAUDE.md) → data kontak wajib
 * via customer/detail.do per customer, jadi harvest-nya TIME-BUDGETED (pola layer-3
 * attachCustomerContacts + harvestSkuSales): yang belum kejangkau menyusul sync berikut.
 * Hasil detail.do disimpan di _ContactCache (Sync.gs, 7 kolom) — writer tab murni baca
 * cache, nol call API. Scope OAuth: customer_view (sudah ada).
 *
 * Depends on Sync.gs (_loadContactCache/_saveContactCache/fetchCustomerDetail/accApi/SYNC_START)
 * + Style.gs (uiSheet/uiBanner/uiHeaderRow/uiFootnote/UI).
 */

var KONTAK_TIME_BUDGET_MS = 180000;  // stop harvest ±3 menit setelah SYNC_START — sisakan ruang writer
var KONTAK_MAX_DETAIL     = 300;     // hard cap detail.do per run (drain bertahap, jaga kuota trigger)

var KONTAK_HEADERS = ['Nama Customer', 'No WA', 'No Bisnis'];
var KONTAK_SPAN = KONTAK_HEADERS.length; // 3
var KONTAK_HROW = 3;  // header row (banner=1, subtitle=2)
var KONTAK_DROW = 4;  // first data row

// ─────────────────────────────────────────────────────────────────────────────
// HARVEST — page customer/list.do untuk SEMUA id, lalu detail.do untuk id yang
// belum di cache atau belum punya nama (entry lama pra-migrasi / bulk phone-only).
// ─────────────────────────────────────────────────────────────────────────────
function harvestAllCustomerContacts() {
  const cache = _loadContactCache();
  const start = SYNC_START || Date.now();

  // Semua id customer master (list.do murah — cuma id per row).
  const ids = [];
  let page = 1;
  while (true) {
    const res = accApi('/accurate/api/customer/list.do', { 'sp.page': page, 'sp.pageSize': 100 });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) { if (r.id != null) ids.push(r.id); });
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (page >= pc || rows.length === 0) break;
    page++;
    if (page > 50) break;  // safety
  }

  let pulls = 0, fails = 0, skipped = 0;
  ids.forEach(function(id) {
    const have = cache[id];
    if (have && have.nama) return;                  // sudah lengkap dari detail.do — done
    if (pulls >= KONTAK_MAX_DETAIL ||
        (Date.now() - start) > KONTAK_TIME_BUDGET_MS) { skipped++; return; }
    try {
      const d = fetchCustomerDetail(id);
      if (d) cache[id] = { nama:     d.nama     || (have && have.nama)     || '',
                           alamat:   d.alamat   || (have && have.alamat)   || '',
                           noTlp:    d.noTlp    || (have && have.noTlp)    || '',
                           noWa:     d.noWa     || (have && have.noWa)     || '',
                           noBisnis: d.noBisnis || (have && have.noBisnis) || '',
                           noVa:     d.noVa     || (have && have.noVa)     || '' };
    } catch (e) { fails++; }                        // leave as-is → retried next sync
    pulls++;
    if (pulls % 25 === 0) Utilities.sleep(150);
  });

  _saveContactCache(cache);
  Logger.log('Kontak Customer: ' + ids.length + ' di master · ' + pulls + ' detail.do' +
             (fails ? (' · ' + fails + ' gagal') : '') +
             (skipped ? (' · ' + skipped + ' belum (lanjut sync berikut)') : ' · lengkap'));
  return { total: ids.length, skipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab 📇 Kontak Customer. Master-only, semua 🔴 generated (baca cache saja).
// ─────────────────────────────────────────────────────────────────────────────
function writeKontakTab() {
  const cache = _loadContactCache();
  const sh = uiSheet(CONFIG.TABS.KONTAK);
  const SPAN = KONTAK_SPAN;

  // Hanya entry hasil detail.do (punya nama). Entry blank/phone-only nyusul sync berikut.
  const list = Object.keys(cache)
    .map(function(id) { return cache[id]; })
    .filter(function(c) { return c.nama; })
    .sort(function(a, b) { return a.nama.localeCompare(b.nama); });
  const pending = Object.keys(cache).length - list.length;

  uiBanner(sh, 1, SPAN,
    '📇 Kontak Customer',
    'Directory semua customer dari Accurate: nama, No WA (HP), No Bisnis (telepon kantor/toko). ' +
    'Otomatis diperbarui tiap sync — customer yang belum terisi menyusul sync berikutnya.',
    UI.INK, UI.BAND);

  uiHeaderRow(sh, KONTAK_HROW, KONTAK_HEADERS);
  sh.setFrozenRows(KONTAK_HROW);

  if (!list.length) {
    sh.getRange(KONTAK_DROW, 1, 1, SPAN).merge()
      .setValue('⏳ Belum ada kontak di cache — jalankan menu "Refresh Kontak Customer" atau tunggu sync berikutnya.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    sh.setColumnWidth(1, 260);
    return sh;
  }

  const matrix = list.map(function(c) {
    return [c.nama, c.noWa || '', c.noBisnis || ''];
  });
  sh.getRange(KONTAK_DROW, 1, matrix.length, SPAN)
    .setValues(matrix).setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  // Nomor telp as plain text biar leading 0 / +62 tidak dirusak format angka.
  sh.getRange(KONTAK_DROW, 2, matrix.length, 2).setNumberFormat('@');

  const totRow = KONTAK_DROW + matrix.length;
  sh.getRange(totRow, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(totRow, 1).setValue('TOTAL — ' + list.length + ' customer' +
    (pending > 0 ? (' · ' + pending + ' belum lengkap (menyusul sync berikut)') : ''));

  uiFootnote(sh, totRow + 1, SPAN,
    '◆ No WA = nomor HP/seluler di customer master Accurate · No Bisnis = telepon kantor/toko. ' +
    'Kosong = belum diisi di Accurate. Data di-refresh dari customer/detail.do, bertahap kalau customer banyak.');

  sh.setColumnWidth(1, 280); sh.setColumnWidth(2, 160); sh.setColumnWidth(3, 160);
  return sh;
}

// Menu entry — drain kontak tanpa nunggu sync 05:00, lalu render tab-nya.
function refreshKontakNow() {
  SYNC_START = Date.now();
  TARGET_SS = null;  // master
  const r = harvestAllCustomerContacts();
  writeKontakTab();
  try {
    SpreadsheetApp.getUi().alert('Kontak Customer di-refresh: ' + r.total + ' customer di master' +
      (r.skipped ? (' · ' + r.skipped + ' belum kejangkau (jalankan lagi / tunggu sync).') : ' · lengkap.'));
  } catch (e) { /* dipanggil dari editor (tanpa UI) — abaikan */ }
}
