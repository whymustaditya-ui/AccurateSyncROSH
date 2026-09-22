/**
 * Info.gs — ℹ️ INFO TUKAR FAKTUR (tab buatan tangan di file ROSH AR)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tab ini TIDAK dibangun dari Accurate: isinya referensi lapangan yang diketik manual —
 * per customer corporate: jadwal tukar faktur (TUFAK), alamat tukar faktur, lalu deretan
 * checkbox syarat berkas (Hardcopy / TTD Basah / Stempel / Materai / Surat Jalan / dst).
 *
 * Yang dilakukan file ini HANYA FORMAT, bukan isi:
 *   · baris 1-2 jadi pita header gelap yang nyambung (grup "Invoice" di baris 1 tetap di tempat),
 *   · kolom A/B/C dilebarkan + wrap supaya alamat tidak terpotong,
 *   · kolom checkbox dipersempit + rata tengah, TRUE hijau / FALSE merah muda → satu lirik
 *     sudah kelihatan customer mana yang minta materai atau TTD basah,
 *   · baris data dikasih garis + selang-seling warna, nama customer dibekukan saat scroll,
 *   · lautan checkbox kosong di bawah data dibuang, disisakan INFO_SPARE_ROWS baris untuk
 *     customer baru.
 *
 * Satu-satunya nilai yang pernah DITULIS = label header kolom A ("CUSTOMER"), itu pun hanya
 * kalau selnya masih kosong. Sisanya tak pernah disentuh, jadi aman dijalankan berulang dan
 * aman dipanggil dari fullSync (fail-soft).
 *
 * Nama tab dicocokkan pakai regex (INFO_TAB_RE) supaya rename kecil (emoji, huruf besar-kecil)
 * tidak membuat formatter ini diam-diam tidak jalan.
 */

var INFO_TAB_RE      = /tukar\s*faktur/i;
var INFO_HEADER_ROWS = 2;   // baris 1 = grup ("Invoice"), baris 2 = nama kolom
var INFO_FIRST_DATA  = 3;
var INFO_SPARE_ROWS  = 5;   // baris kosong (berikut checkbox-nya) yang disisakan di bawah data

function _infoSheet(ss) {
  const sheets = (ss || _ss()).getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (INFO_TAB_RE.test(sheets[i].getName())) return sheets[i];
  }
  return null;
}

/** Kolom checkbox = kolom yang isinya mayoritas boolean di baris data. Dideteksi, bukan
 *  di-hardcode, supaya nambah/geser kolom syarat tidak perlu ubah kode. */
function _infoCheckboxCols(sh, firstRow, nRows, lastCol) {
  const vals = sh.getRange(firstRow, 1, nRows, lastCol).getValues();
  const cols = {};
  for (var c = 0; c < lastCol; c++) {
    var bool = 0, filled = 0;
    for (var r = 0; r < nRows; r++) {
      const v = vals[r][c];
      if (v === '' || v == null) continue;
      filled++;
      if (typeof v === 'boolean') bool++;
    }
    if (filled && bool >= filled / 2) cols[c + 1] = 1;
  }
  return cols;
}

/** Baris data terakhir = baris terakhir yang kolom A-nya terisi. getLastRow() bohong di tab ini:
 *  dia ikut menghitung baris ber-checkbox meski tanpa nama customer. */
function _infoLastDataRow(sh) {
  const last = sh.getLastRow();
  if (last < INFO_FIRST_DATA) return INFO_HEADER_ROWS;
  const names = sh.getRange(INFO_FIRST_DATA, 1, last - INFO_HEADER_ROWS, 1).getValues();
  for (var i = names.length - 1; i >= 0; i--) {
    if (String(names[i][0] || '').trim()) return INFO_FIRST_DATA + i;
  }
  return INFO_HEADER_ROWS;
}

function formatInfoTukarFaktur(ss) {
  const sh = _infoSheet(ss);
  if (!sh) return false;

  const lastCol  = Math.max(sh.getLastColumn(), 3);
  const lastData = _infoLastDataRow(sh);
  const nRows    = Math.max(lastData - INFO_HEADER_ROWS, 0);

  // ── Header (baris 1-2) ──────────────────────────────────────────────────────
  // Baris 1 cuma memayungi grup kolom ("Invoice"); sel kosong di baris 1 dibiarkan kosong,
  // cuma diberi warna sama supaya pita header terbaca satu blok.
  sh.getRange(1, 1, INFO_HEADER_ROWS, lastCol)
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold')
    .setFontSize(10).setWrap(true)
    .setVerticalAlignment('middle').setHorizontalAlignment('center');
  sh.getRange(1, 1, INFO_HEADER_ROWS, 3).setHorizontalAlignment('left');
  if (!String(sh.getRange(INFO_HEADER_ROWS, 1).getValue() || '').trim()) {
    sh.getRange(INFO_HEADER_ROWS, 1).setValue('CUSTOMER');   // kolom A tadinya tanpa judul
  }
  sh.setRowHeight(1, 24);
  sh.setRowHeight(INFO_HEADER_ROWS, 34);
  sh.setFrozenRows(INFO_HEADER_ROWS);
  sh.setFrozenColumns(1);            // nama customer ikut kelihatan saat scroll kolom syarat

  // ── Lebar kolom ─────────────────────────────────────────────────────────────
  sh.setColumnWidth(1, 230);   // Customer
  sh.setColumnWidth(2, 165);   // Jadwal TUFAK
  sh.setColumnWidth(3, 330);   // Alamat TUFAK

  if (!nRows) return true;

  const checkCols = _infoCheckboxCols(sh, INFO_FIRST_DATA, nRows, lastCol);
  for (var c = 4; c <= lastCol; c++) {
    sh.setColumnWidth(c, checkCols[c] ? 105 : 200);
  }

  // ── Badan tabel ─────────────────────────────────────────────────────────────
  const body = sh.getRange(INFO_FIRST_DATA, 1, nRows, lastCol);
  body.setVerticalAlignment('middle').setFontSize(10)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(INFO_FIRST_DATA, 1, nRows, 3).setWrap(true).setHorizontalAlignment('left');
  sh.getRange(INFO_FIRST_DATA, 1, nRows, 1).setFontWeight('bold');

  // Selang-seling warna baris, dipasang manual (bukan banding) supaya tidak bertabrakan
  // dengan aturan warna checkbox di bawah.
  const bg = [];
  for (var r = 0; r < nRows; r++) {
    const row = [];
    for (var c2 = 0; c2 < 3; c2++) row.push(r % 2 ? UI.BAND : UI.WHITE);
    bg.push(row);
  }
  sh.getRange(INFO_FIRST_DATA, 1, nRows, 3).setBackgrounds(bg);

  // Checkbox: rata tengah + warna. Dicentang hijau, kosong merah muda → "apa saja yang harus
  // dibawa" kebaca sekali lirik, tak perlu menyipitkan mata ke kotak kecil.
  const checkRanges = [];
  Object.keys(checkCols).forEach(function(c) {
    const rg = sh.getRange(INFO_FIRST_DATA, Number(c), nRows, 1);
    rg.setHorizontalAlignment('center');
    checkRanges.push(rg);
  });
  if (checkRanges.length) {
    const anchor = checkRanges[0].getA1Notation().split(':')[0];   // relatif → berlaku per sel
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=' + anchor + '=TRUE')
        .setBackground(UI.T_GREEN).setRanges(checkRanges).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=' + anchor + '=FALSE')
        .setBackground(UI.T_RED).setRanges(checkRanges).build()
    ]);
  }

  try { sh.autoResizeRows(INFO_FIRST_DATA, nRows); } catch (e) {}
  for (var rr = INFO_FIRST_DATA; rr <= lastData; rr++) {
    if (sh.getRowHeight(rr) < 34) sh.setRowHeight(rr, 34);
  }

  // ── Buang lautan checkbox kosong di bawah data ─────────────────────────────
  // Sisakan INFO_SPARE_ROWS baris siap-pakai, sisanya dibersihkan. Yang dibuang cuma checkbox
  // KOSONG (validasi + format), tidak ada isi yang hilang.
  const keepTo = lastData + INFO_SPARE_ROWS;
  const maxRow = sh.getMaxRows();
  if (maxRow > keepTo) {
    const tail = sh.getRange(keepTo + 1, 1, maxRow - keepTo, lastCol);
    tail.clearDataValidations();
    tail.clearFormat();
  }
  return true;
}

/** Menu: rapikan tab INFO TUKAR FAKTUR di file yang sedang dibuka. */
function formatInfoTukarFakturNow() {
  const ok = formatInfoTukarFaktur(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getUi().alert(ok
    ? 'Tab Info Tukar Faktur dirapikan (format saja, isi tidak diubah).'
    : 'Tidak ketemu tab yang namanya mengandung "Tukar Faktur" di file ini.');
}
