/**
 * ROSH × Accurate — ⛔ Stop Supply (HOLD Order).
 *
 * Leverage utama flow penagihan: begitu customer punya invoice belum bayar yang sudah lewat
 * jatuh tempo (≥ H+CONFIG.STOP_SUPPLY_DAYS, kini 1 hari), dia masuk daftar HOLD → Nathan tidak
 * proses SO baru sampai lunas. Untuk pelanggan repeat-order ini menekan jauh lebih efektif
 * daripada reminder ke-10.
 *
 * Sejak 2026-09-05 mengikuti Lampiran B Panduan Sales v1.0: tiap baris membawa KODE ALASAN,
 * SEJAK kapan ditahan, dan TINDAKAN BERIKUTNYA dari jadwal tagih (CONFIG.STOP_SUPPLY_STEPS).
 * Kode yang bisa dihitung otomatis dari data Accurate:
 *   OVD  ada faktur lewat jatuh tempo dengan sisa > Rp0
 *   LIM  outstanding melewati limit kredit (limit dari Rapor Customer: Limit Disetujui Nathan
 *        kalau diisi, kalau tidak Jatah Plafon bulan ini)
 * Kode lain di SOP (SKK, COD, HP, GIRO, LOST, BL) butuh input manusia dan belum ada sumbernya
 * di sheet; kalau nanti dibutuhkan, tambahkan sebagai kolom 🟡 di Rapor Customer, bukan di sini.
 *
 * MASTER-ONLY sejak 2026-09-05. File Deden memakai 🚦 Status Customer (Status.gs), yang memuat
 * SEMUA customer dia dengan kolom Boleh Supply?, bukan cuma yang ditahan.
 *
 * Pure projection of Pass-1 invoices + rapor (no Accurate call, no write — OAuth read-only;
 * hold-nya dilakukan manual di Accurate).
 * Depends on Sync.gs (fields, _ss, fmtDate, DAY_MS, num) + Style.gs (UI helpers) + Kpi.gs (rupiah)
 * + Restock.gs (_mblock).
 */

var STOPSUP_HEADERS = [
  'Customer', 'Alasan', 'Total Outstanding', 'Umur Tertua (hari)', 'Jml Invoice', 'Sejak',
  'Limit Berlaku', 'Tindakan Berikutnya', 'Sales', 'No. Telp', 'Loyalitas (4bln)'
];
var STOPSUP_SPAN = STOPSUP_HEADERS.length; // 11
var STOPSUP_COL = {};                       // nama header → nomor kolom (1-based)
STOPSUP_HEADERS.forEach(function(h, i) { STOPSUP_COL[h] = i + 1; });
var STOPSUP_HROW = 5;  // header row (banner=1, subtitle=2, ringkas=3, spasi=4)
var STOPSUP_DROW = 6;  // first data row

// Teks tindakan dari jadwal tagih SOP: ambang terbesar yang ≤ hari telat.
function _stopSupplyStep(dpd) {
  const steps = CONFIG.STOP_SUPPLY_STEPS || [];
  let out = '';
  steps.forEach(function(s) { if (dpd >= s[0]) out = s[1]; });
  return out;
}

// Limit yang BERLAKU untuk satu customer menurut Rapor Customer: ketikan Nathan menang, kalau
// kosong pakai Jatah Plafon bulan ini. Dipakai bersama oleh Stop Supply (kode LIM) dan Status
// Customer (Sisa Limit) supaya dua tab tidak pernah menyebut angka limit yang berbeda.
function _limitBerlaku(r) {
  if (!r) return 0;
  // Kolom kuning bisa berisi angka ATAU teks "Rp10.000.000" (num() = parseFloat → 0 untuk teks
  // ber-"Rp"). Baca digitnya saja, pola _readCreditBudget, supaya ketikan Nathan tidak diabaikan diam-diam.
  let manual = 0;
  const v = r.limitDisetujui;
  if (typeof v === 'number') manual = v;
  else if (v != null && v !== '') { const d = String(v).replace(/[^0-9]/g, ''); manual = d ? Number(d) : 0; }
  if (manual > 0) return manual;
  return r.jatah > 0 ? r.jatah : 0;
}

// Peta nama customer → baris Rapor Customer. rapor boleh null (Rapor gagal/di-skip).
function _raporByName(rapor) {
  const map = {};
  if (rapor && rapor.list) rapor.list.forEach(function(r) { map[r.customer] = r; });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — customer-level. Masuk daftar kalau OVD (≥1 faktur lewat jatuh tempo) ATAU LIM
// (outstanding > limit berlaku). `rapor` opsional: tanpa itu LIM tidak pernah menyala.
// ─────────────────────────────────────────────────────────────────────────────
function buildStopSupply(invoices, today, rapor) {
  const byCust = {};
  invoices.forEach(function(i) {
    if (i.isPaid || !(i.outstanding > 0)) return;
    const name = String(i.customer || '').trim();
    if (!name) return;
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, noTlp: '', tierText: '', salesman: '',
                                 outstanding: 0, count: 0, maxDpd: null, oldestDue: null };
    c.outstanding += i.outstanding;
    c.count += 1;
    if (!c.noTlp && i.noTlp) c.noTlp = i.noTlp;
    if (i.custTierText) c.tierText = i.custTierText;
    const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : null;
    if (dpd == null) return;                         // tanpa jatuh tempo → tak ikut umur
    if (c.maxDpd == null || dpd > c.maxDpd) {
      c.maxDpd = dpd; c.oldestDue = i.dueDate || null;
      c.salesman = i.salesman || c.salesman;         // attribusi dari faktur tertua
    }
  });

  const rmap = _raporByName(rapor);
  const out = [];
  Object.keys(byCust).forEach(function(k) {
    const c = byCust[k];
    const r = rmap[c.customer];
    const limit = _limitBerlaku(r);
    const kode = [];
    if (c.maxDpd != null && c.maxDpd >= CONFIG.STOP_SUPPLY_DAYS) kode.push('OVD');
    if (limit > 0 && c.outstanding > limit) kode.push('LIM');
    if (!kode.length) return;

    if (!c.salesman && r && r.salesman) c.salesman = r.salesman;
    c.kode = kode;
    c.limit = limit;
    c.sejak = (kode.indexOf('OVD') >= 0 && c.oldestDue)
      ? new Date(c.oldestDue.getTime() + CONFIG.STOP_SUPPLY_DAYS * DAY_MS) : null;
    c.tindakan = kode.indexOf('OVD') >= 0
      ? _stopSupplyStep(c.maxDpd)
      : 'Bayar sampai outstanding di bawah ' + rupiah(limit) + ', atau owner naikkan limit tertulis';
    out.push(c);
  });

  // Yang paling lama telat di atas; LIM-saja (tanpa umur) di bawah, urut rupiah.
  return out.sort(function(a, b) {
    const da = a.maxDpd == null ? -1 : a.maxDpd, db = b.maxDpd == null ? -1 : b.maxDpd;
    if (db !== da) return db - da;
    return b.outstanding - a.outstanding;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab ⛔ Stop Supply (HOLD). Semua 🔴 generated. Master-only.
// ─────────────────────────────────────────────────────────────────────────────
function writeStopSupplyTab(list) {
  const sh = uiSheet(CONFIG.TABS.STOP_SUPPLY);
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  const SPAN = STOPSUP_SPAN;
  const C = STOPSUP_COL;

  uiBanner(sh, 1, SPAN, '⛔ Stop Supply — HOLD Order Baru',
    'Nathan: JANGAN proses SO / order baru untuk customer di daftar ini sampai sisa tagihannya Rp0. ' +
    'Masuk daftar kalau ada faktur lewat jatuh tempo (OVD, ≥ H+' + CONFIG.STOP_SUPPLY_DAYS +
    ') atau outstanding melewati limit (LIM). Cicilan tidak membuka kiriman. ' +
    'Dibuat ulang otomatis tiap jam 5 pagi.',
    UI.RED, UI.RED_SOFT);

  // ── strip ringkas: 4 angka yang dibaca sebelum tabel ──
  const nOvd = list.filter(function(c) { return c.kode.indexOf('OVD') >= 0; }).length;
  const nLim = list.filter(function(c) { return c.kode.indexOf('LIM') >= 0; }).length;
  const totOut = list.reduce(function(s, c) { return s + c.outstanding; }, 0);
  const tua = list.reduce(function(m, c) { return c.maxDpd != null && c.maxDpd > m ? c.maxDpd : m; }, 0);
  const strip = [
    ['⛔ Ditahan', list.length + ' customer'],
    ['💰 Outstanding tertahan', rupiah(totOut)],
    ['OVD / LIM', nOvd + ' / ' + nLim],
    ['⏳ Telat terlama', tua + ' hari']
  ];
  const w = Math.floor(SPAN / strip.length);
  strip.forEach(function(kv, i) {
    const c1 = i * w + 1, c2 = (i === strip.length - 1) ? SPAN : c1 + w - 1;
    _mblock(sh, 3, c1, c2, kv[0] + '   ' + kv[1])
      .setBackground(UI.BAND).setFontWeight('bold').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, false, false, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.setRowHeight(3, 30);
  sh.setRowHeight(4, 8);

  uiHeaderRow(sh, STOPSUP_HROW, STOPSUP_HEADERS);

  if (!list.length) {
    sh.getRange(STOPSUP_DROW, 1, 1, SPAN).merge()
      .setValue('✅ Tidak ada customer yang perlu di-HOLD.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    _stopSupplyWidths(sh);
    return sh;
  }

  const matrix = list.map(function(c) {
    return [c.customer, c.kode.join(' + '), c.outstanding,
            c.maxDpd == null ? '' : c.maxDpd, c.count, c.sejak || '',
            c.limit > 0 ? c.limit : '', c.tindakan,
            c.salesman || '(POS / online)', c.noTlp || '', c.tierText || ''];
  });
  const n = matrix.length;
  sh.getRange(STOPSUP_DROW, 1, n, SPAN).setValues(matrix).setVerticalAlignment('middle');
  sh.getRange(STOPSUP_DROW, 1, n, SPAN)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(STOPSUP_DROW, C['Alasan'], n, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange(STOPSUP_DROW, C['Total Outstanding'], n, 1).setNumberFormat('"Rp"#,##0');
  sh.getRange(STOPSUP_DROW, C['Limit Berlaku'], n, 1).setNumberFormat('"Rp"#,##0');
  sh.getRange(STOPSUP_DROW, C['Umur Tertua (hari)'], n, 1).setHorizontalAlignment('center');
  sh.getRange(STOPSUP_DROW, C['Jml Invoice'], n, 1).setHorizontalAlignment('center');
  sh.getRange(STOPSUP_DROW, C['Sejak'], n, 1).setNumberFormat('dd/MM/yyyy').setHorizontalAlignment('center');
  sh.getRange(STOPSUP_DROW, C['Tindakan Berikutnya'], n, 1).setWrap(true);

  // in-table TOTAL band
  const totRow = STOPSUP_DROW + n;
  sh.getRange(totRow, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(totRow, 1).setValue('TOTAL — ' + list.length + ' customer di-HOLD');
  sh.getRange(totRow, C['Total Outstanding']).setValue(totOut).setNumberFormat('"Rp"#,##0');

  // conditional formats: Alasan · Umur Tertua merah makin tua · Loyalitas per huruf
  const R = SpreadsheetApp.newConditionalFormatRule;
  const alasan = sh.getRange(STOPSUP_DROW, C['Alasan'], n, 1);
  const umur = sh.getRange(STOPSUP_DROW, C['Umur Tertua (hari)'], n, 1);
  const tier = sh.getRange(STOPSUP_DROW, C['Loyalitas (4bln)'], n, 1);
  sh.setConditionalFormatRules([
    R().whenTextContains('OVD').setBackground(UI.T_RED).setRanges([alasan]).build(),
    R().whenTextContains('LIM').setBackground('#fed7aa').setRanges([alasan]).build(),
    R().whenNumberGreaterThanOrEqualTo(30).setBackground(UI.T_RED).setRanges([umur]).build(),
    R().whenNumberBetween(7, 29).setBackground('#fed7aa').setRanges([umur]).build(),
    R().whenNumberBetween(CONFIG.STOP_SUPPLY_DAYS, 6).setBackground(UI.T_AMBER).setRanges([umur]).build(),
    R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tier]).build(),
    R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tier]).build(),
    R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tier]).build(),
    R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tier]).build()
  ]);

  uiFootnote(sh, totRow + 1, SPAN,
    '◆ Alasan: OVD = ada faktur lewat jatuh tempo (sisa > Rp0) · LIM = outstanding melewati Limit Berlaku. ' +
    'Sejak = hari pertama masuk HOLD (jatuh tempo faktur tertua + ' + CONFIG.STOP_SUPPLY_DAYS + '); kosong untuk LIM saja. ' +
    'Limit Berlaku = Limit Disetujui di Rapor Customer kalau diisi, kalau tidak Jatah Plafon bulan ini. ' +
    'Tindakan Berikutnya mengikuti jadwal tagih Panduan Sales (H+1 / H+3 / H+7 / H+14 / H+30). ' +
    'Keluar dari daftar otomatis begitu sisa Rp0 (OVD) atau outstanding turun di bawah limit (LIM). ' +
    'Kode SKK / COD / HP / GIRO / LOST / BL dari SOP belum otomatis; catat di kolom Catatan Nathan (Rapor Customer).');

  _stopSupplyWidths(sh);
  return sh;
}

function _stopSupplyWidths(sh) {
  const w = [220, 95, 140, 100, 80, 100, 130, 300, 120, 130, 190];
  w.forEach(function(px, i) { sh.setColumnWidth(i + 1, px); });
}
