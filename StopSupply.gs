/**
 * ROSH × Accurate — ⛔ Stop Supply (HOLD Order).
 *
 * Leverage utama flow penagihan: begitu customer punya invoice belum bayar yang sudah lewat
 * jatuh tempo (≥ H+CONFIG.STOP_SUPPLY_DAYS, kini 1 hari), dia masuk daftar HOLD → Nathan tidak
 * proses SO baru sampai lunas. Untuk pelanggan repeat-order ini menekan jauh lebih efektif
 * daripada reminder ke-10.
 *
 * Pure projection of Pass-1 invoices (no Accurate call, no write — OAuth read-only; hold-nya
 * dilakukan manual di Accurate). Ditulis di master (semua customer) DAN di file Deden
 * (di-scope ke faktur atas nama dia via _bySalesman — lihat blok Deden di fullSync).
 * Depends on Sync.gs (fields, _ss, fmtDate, DAY_MS) + Style.gs (UI helpers) + Kpi.gs (rupiah).
 */

var STOPSUP_HEADERS = [
  'Customer', 'No. Telp', 'Sales', 'Jml Invoice', 'Total Outstanding', 'Umur Tertua (hari)', 'Tier (4bln)'
];
var STOPSUP_SPAN = STOPSUP_HEADERS.length; // 7
var STOPSUP_HROW = 3;  // header row (banner=1, subtitle=2)
var STOPSUP_DROW = 4;  // first data row

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — customer-level: punya ≥1 invoice belum bayar yang sudah lewat jatuh tempo.
// `invoices` boleh sudah di-scope ke satu salesman (file Deden) — builder tak peduli.
// ─────────────────────────────────────────────────────────────────────────────
function buildStopSupply(invoices, today) {
  const byCust = {};
  invoices.forEach(function(i) {
    if (i.isPaid || !(i.outstanding > 0)) return;
    const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : null;
    if (dpd == null) return;                         // tanpa jatuh tempo → lewati
    const name = String(i.customer || '').trim();
    if (!name) return;
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, noTlp: '', tierText: '', salesman: '',
                                 outstanding: 0, count: 0, maxDpd: -Infinity };
    c.outstanding += i.outstanding;
    c.count += 1;
    if (!c.noTlp && i.noTlp) c.noTlp = i.noTlp;
    if (i.custTierText) c.tierText = i.custTierText;
    if (dpd > c.maxDpd) { c.maxDpd = dpd; c.salesman = i.salesman || c.salesman; } // attribusi dari faktur tertua
  });

  return Object.keys(byCust)
    .map(function(k) { return byCust[k]; })
    .filter(function(c) { return c.maxDpd >= CONFIG.STOP_SUPPLY_DAYS; })
    .sort(function(a, b) { return b.outstanding - a.outstanding; });
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab ⛔ Stop Supply (HOLD). Semua 🔴 generated.
// ─────────────────────────────────────────────────────────────────────────────
function writeStopSupplyTab(list, role) {
  const sh = uiSheet(CONFIG.TABS.STOP_SUPPLY);
  const SPAN = STOPSUP_SPAN;

  const isDeden = (role === 'deden');
  uiBanner(sh, 1, SPAN,
    isDeden ? '⛔ Customer Ditahan — Order Baru di-HOLD' : '⛔ Stop Supply — HOLD Order Baru',
    'Customer dengan invoice belum bayar yang sudah lewat jatuh tempo (≥ H+' +
    CONFIG.STOP_SUPPLY_DAYS + '). ' +
    (isDeden
      ? 'Ini customer ATAS NAMA KAMU saja. Order baru mereka ditahan sampai tagihan lunas — ' +
        'kejar pelunasannya kalau mau order mereka jalan lagi. Tampilan saja, tidak perlu diisi.'
      : 'Nathan: JANGAN proses SO / order baru untuk customer di daftar ini sampai lunas.') + ' ' +
    'Otomatis dibuat ulang tiap jam 5 pagi.',
    UI.RED, UI.RED_SOFT);

  uiHeaderRow(sh, STOPSUP_HROW, STOPSUP_HEADERS);
  sh.setFrozenRows(STOPSUP_HROW);

  if (!list.length) {
    sh.getRange(STOPSUP_DROW, 1, 1, SPAN).merge()
      .setValue('✅ Tidak ada customer yang perlu di-HOLD (tak ada invoice lewat jatuh tempo).')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    sh.setColumnWidth(1, 220);
    return sh;
  }

  const matrix = list.map(function(c) {
    return [c.customer, c.noTlp || '', c.salesman || '(POS / online)',
            c.count, c.outstanding, c.maxDpd, c.tierText || ''];
  });
  sh.getRange(STOPSUP_DROW, 1, matrix.length, SPAN).setValues(matrix).setVerticalAlignment('middle');
  sh.getRange(STOPSUP_DROW, 1, matrix.length, SPAN)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(STOPSUP_DROW, 4, matrix.length, 1).setHorizontalAlignment('center'); // Jml Invoice
  sh.getRange(STOPSUP_DROW, 5, matrix.length, 1).setNumberFormat('"Rp"#,##0');     // Total Outstanding
  sh.getRange(STOPSUP_DROW, 6, matrix.length, 1).setHorizontalAlignment('center'); // Umur Tertua

  // in-table TOTAL band
  const totRow = STOPSUP_DROW + matrix.length;
  const totOut = list.reduce(function(s, c) { return s + c.outstanding; }, 0);
  sh.getRange(totRow, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(totRow, 1).setValue('TOTAL — ' + list.length + ' customer di-HOLD');
  sh.getRange(totRow, 5).setValue(totOut).setNumberFormat('"Rp"#,##0');

  // conditional formats: Umur Tertua (col 6) merah makin tua · Tier (col 7) per huruf
  const umurRange = sh.getRange(STOPSUP_DROW, 6, matrix.length, 1);
  const tierRange = sh.getRange(STOPSUP_DROW, 7, matrix.length, 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(76).setBackground(UI.T_RED).setRanges([umurRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(31, 75).setBackground('#fed7aa').setRanges([umurRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(CONFIG.STOP_SUPPLY_DAYS, 30).setBackground(UI.T_AMBER).setRanges([umurRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRange]).build()
  ]);

  uiFootnote(sh, totRow + 1, SPAN,
    '◆ Cara pakai: customer di sini punya minimal 1 invoice yang sudah lewat jatuh tempo (≥ H+' +
    CONFIG.STOP_SUPPLY_DAYS + '). ' +
    (isDeden
      ? 'Daftar ini sudah disaring ke faktur atas nama kamu; Total Outstanding = seluruh faktur kamu yang belum lunas di customer itu. '
      : 'Nathan tahan order baru sampai lunas — ') +
    'Keluar dari daftar otomatis begitu semua invoice-nya lunas. ' +
    'Umur Tertua = hari lewat jatuh tempo invoice paling lama.');

  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 130);
  sh.setColumnWidth(4, 90);  sh.setColumnWidth(5, 140); sh.setColumnWidth(6, 120); sh.setColumnWidth(7, 190);
  return sh;
}
