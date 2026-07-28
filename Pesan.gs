/**
 * ROSH × Accurate — Pesan Penagihan (ready-to-send WhatsApp collection messages).
 *
 * Group-by-CUSTOMER: 1 pesan per pelanggan menggabungkan semua faktur-nya yang ada di
 * window penagihan H-1 → H+CONFIG.PENAGIHAN_WINDOW_MAX (14) — mendukung 4-touch flow
 * Deden (H-1 / H+3 / H+7 / H+14, nada sopan naik bertahap). Nathan/Deden tinggal COPY teks atau TAP
 * link wa.me yang pesannya sudah terisi (manual Send — BUKAN auto-send; lihat catatan
 * Reminders.gs yang dihapus 2026-05-31).
 *
 * Scope = WINDOW-ONLY: hanya faktur dengan daysPastDue ∈ [-1,14] yang masuk pesan & total.
 * Faktur yang belum jatuh tempo (jauh dari H-1) TIDAK disebut — dapat giliran sendiri saat
 * mendekati JT. "Gabung" hanya terjadi bila ≥2 faktur customer sama-sama di window.
 *
 * Pure projection — no Accurate call, no new OAuth scope. Master-only. Depends on Sync.gs
 * (fields, _ss, fmtDate) + Style.gs (UI helpers) + Kpi.gs (rupiah) + Faktur.gs (FAKTUR const).
 */

var PESAN_HEADERS = [
  'Customer', 'No. Telp (62…)', 'Sales', 'Jml Invoice', 'Total Outstanding',
  'Reminder', 'Tier (4bln)', '📲 Kirim WA', 'Pesan'
];
var PESAN_SPAN = PESAN_HEADERS.length; // 9
var PESAN_HROW = 3;  // column-header row (banner=1, subtitle=2)
var PESAN_DROW = 4;  // first data row

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — group faktur belum lunas (daysPastDue ∈ [-1, WINDOW_MAX]) per customer.
// ─────────────────────────────────────────────────────────────────────────────
function buildPenagihanBatch(invoices, today) {
  const lo = -1, hi = CONFIG.PENAGIHAN_WINDOW_MAX;
  const byCust = {};
  invoices.forEach(function(i) {
    if (i.isPaid || !(i.outstanding > 0)) return;
    const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : null;
    if (dpd == null || dpd < lo || dpd > hi) return;       // window-only
    const name = String(i.customer || '').trim();
    if (!name) return;
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, noTlp: '', noVa: '', tierText: '', salesman: '',
                                 invoices: [], totalOutstanding: 0, maxDaysPastDue: -Infinity };
    c.invoices.push({ number: i.number, outstanding: i.outstanding, dueDate: i.dueDate, daysPastDue: dpd });
    c.totalOutstanding += i.outstanding;
    if (!c.noTlp && i.noTlp) c.noTlp = i.noTlp;
    if (!c.noVa  && i.noVa)  c.noVa  = i.noVa;          // VA milik customer (sama per customer)
    if (i.custTierText) c.tierText = i.custTierText;
    if (dpd > c.maxDaysPastDue) { c.maxDaysPastDue = dpd; c.salesman = i.salesman || c.salesman; }
  });

  return Object.keys(byCust).map(function(k) {
    const c = byCust[k];
    c.bucket = _penagihanBucket(c.maxDaysPastDue);
    c.invoices.sort(function(a, b) { return b.daysPastDue - a.daysPastDue; }); // paling overdue dulu
    return c;
  }).sort(function(a, b) { return b.maxDaysPastDue - a.maxDaysPastDue; });
}

// Bucket 4-touch flow (H-1 / H+3 / H+7 / H+14). Dipakai bersama oleh tab Pesan Penagihan
// DAN To-Do section Penagihan (lewat buildDueReminders) — biar segmennya konsisten.
function _penagihanBucket(dpd) {
  if (dpd <= 0) return 'H-1 · Jatuh tempo';
  if (dpd <= 3) return 'H+3 · Nudge';
  if (dpd <= 7) return 'H+7 · Stop-supply';
  return 'H+14 · Terakhir';
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE — normalise to digit-only international (62…) for wa.me. Handles ROSH's
// messy stored formats: "085…", "8…", "+62 822-9853-6306", "(POS / online)" → blank.
// ─────────────────────────────────────────────────────────────────────────────
function _waPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('62') === 0)      d = d;                 // already international
  else if (d.charAt(0) === '0')   d = '62' + d.slice(1); // local 0-prefix
  else if (d.charAt(0) === '8')   d = '62' + d;          // bare mobile
  else                            d = '62' + d;          // fallback
  return d.length >= 9 ? d : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE — natural Bahasa, group-by-customer. Semua copy customer-facing terkumpul di
// fungsi ini biar Bro gampang tune. Tier A/B di-soften; daftar semua faktur in-window +
// total; CTA bukti transfer (set up window Qontak).
//
// ⚠ Copy DIREVISI 2026-07-28 setelah komplain partner: nada lama terlalu keras (H+7 ancam
// "order baru kami tahan sampai pelunasan", H+14 "sebelum kami tindak lanjuti lebih jauh")
// sampai beberapa toko plastik MEMBLOKIR nomor WA ROSH. Nada baru semi-formal: sapaan WA
// tetap hangat, badan pesan gaya korespondensi sopan. Stop-supply masih disinggung di H+7
// tapi diframing sebagai enabler ("agar order berikutnya dapat langsung kami proses"),
// bukan sanksi. Leverage sebenarnya tetap di tab ⛔ Stop Supply (HOLD) + hold manual Nathan.
// ─────────────────────────────────────────────────────────────────────────────
function _penagihanMessageBatch(c) {
  const cust = c.customer || 'Bapak/Ibu';
  const tier = String(c.tierText || '').charAt(0); // 'A'|'B'|'C'|'D'|''
  const dpd  = c.maxDaysPastDue;

  let msg = 'Halo Bapak/Ibu ' + cust + ', ';
  if (tier === 'A' || tier === 'B') msg += 'terima kasih atas kepercayaan dan kerja samanya selama ini. ';

  if (dpd <= 0) {
    // window lo = -1 → bucket ini isinya dpd -1 (besok) & 0 (hari ini); jangan bilang "besok" untuk keduanya.
    msg += 'mohon izin mengingatkan, tagihan berikut ' + (dpd < 0 ? 'akan jatuh tempo besok' : 'jatuh tempo hari ini') +
           '. Apabila pembayaran sudah dijadwalkan, kami ucapkan terima kasih.';
  } else if (dpd <= 3) {
    msg += 'mohon izin melakukan follow up untuk tagihan berikut yang telah melewati tanggal jatuh tempo. Apabila pembayaran masih dalam proses, kami akan sangat terbantu bila Bapak/Ibu berkenan menginformasikan estimasi waktu pembayarannya.';
  } else if (dpd <= 7) {
    msg += 'mohon izin kembali menindaklanjuti tagihan berikut yang masih tercatat belum terselesaikan. Kami akan sangat menghargai bila Bapak/Ibu dapat menginformasikan estimasi waktu pembayarannya, agar order berikutnya dapat langsung kami proses.';
  } else {
    msg += 'mohon izin menindaklanjuti kembali tagihan berikut yang hingga saat ini masih tercatat belum terselesaikan. Kami akan sangat menghargai bila Bapak/Ibu dapat memberikan konfirmasi jadwal pembayarannya. Apabila ada hal yang ingin didiskusikan terkait pembayaran, kami dengan senang hati siap membantu.';
  }

  msg += '\n';
  c.invoices.forEach(function(iv) {
    msg += '\n• ' + iv.number + ' : ' + rupiah(iv.outstanding) + ' (jatuh tempo ' + fmtDate(iv.dueDate) + ')';
  });
  if (c.invoices.length > 1) msg += '\n\nTotal tagihan: ' + rupiah(c.totalOutstanding);

  // VA DULU baru rekening biasa: transfer ke VA otomatis terekonsiliasi ke customer ini,
  // rekening biasa harus dicocokkan manual. Customer tanpa VA langsung lihat BCA.
  msg += '\n\nPembayaran dapat dilakukan melalui rekening berikut:';
  if (c.noVa) msg += '\nVirtual Account BCA ' + _fullVaBca(c.noVa) + ' (khusus ' + cust + ')';
  msg += '\n' + (c.noVa ? 'atau BCA ' : 'BCA ') + FAKTUR.REK_BCA + ' a.n. ' + FAKTUR.ACC_NAME;
  msg += '\n\nSetelah pembayaran dilakukan, mohon berkenan mengirimkan bukti transfer agar dapat segera kami verifikasi.';
  msg += '\nTerima kasih atas perhatian dan kerja sama Bapak/Ibu.\n-TIM ROSH PLASTIC';
  return msg;
}

// HYPERLINK to wa.me with the message pre-filled. Blank phone → blank cell.
function _waLinkFormula(phone, msg) {
  if (!phone) return '';
  const url = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(msg);
  return '=HYPERLINK("' + url + '","📲 Kirim WA")';
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — one tab, one row per customer. All 🔴 generated (no human columns).
// ─────────────────────────────────────────────────────────────────────────────
function writePesanTab(batch) {
  const sh = uiSheet(CONFIG.TABS.PESAN);
  const SPAN = PESAN_SPAN;

  uiBanner(sh, 1, SPAN,
    '✉️ Pesan Penagihan — Siap Kirim (per customer)',
    'Satu pesan per pelanggan menggabungkan semua faktur dalam window H-1 → H+' + CONFIG.PENAGIHAN_WINDOW_MAX +
    '. COPY kolom Pesan, atau TAP 📲 Kirim WA → WhatsApp kebuka dengan pesan sudah terisi, tinggal Send. ' +
    'Dibuat ulang otomatis tiap jam 5 pagi — jangan edit manual.',
    UI.GREEN, UI.GREEN_SOFT);

  uiHeaderRow(sh, PESAN_HROW, PESAN_HEADERS);
  sh.setFrozenRows(PESAN_HROW);

  if (!batch.length) {
    sh.getRange(PESAN_DROW, 1, 1, SPAN).merge()
      .setValue('✅ Tidak ada tagihan di window H-1 → H+' + CONFIG.PENAGIHAN_WINDOW_MAX + '.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    sh.setColumnWidth(1, 200);
    return sh;
  }

  const matrix = batch.map(function(c) {
    const phone = _waPhone(c.noTlp);
    const msg   = _penagihanMessageBatch(c);
    return [
      c.customer, phone, c.salesman || '(POS / online)', c.invoices.length, c.totalOutstanding,
      c.bucket, c.tierText || '', _waLinkFormula(phone, msg), msg
    ];
  });
  sh.getRange(PESAN_DROW, 1, matrix.length, SPAN).setValues(matrix).setVerticalAlignment('top');
  sh.getRange(PESAN_DROW, 1, matrix.length, SPAN)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(PESAN_DROW, 4, matrix.length, 1).setHorizontalAlignment('center'); // Jml Invoice
  sh.getRange(PESAN_DROW, 5, matrix.length, 1).setNumberFormat('"Rp"#,##0');     // Total Outstanding
  sh.getRange(PESAN_DROW, 9, matrix.length, 1).setWrap(true);                     // Pesan — wrap for copy

  // conditional formats: Reminder bucket (col 6) + Tier (col 7, per huruf)
  const remRange  = sh.getRange(PESAN_DROW, 6, matrix.length, 1);
  const tierRange = sh.getRange(PESAN_DROW, 7, matrix.length, 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H-1').setBackground(UI.T_AMBER).setRanges([remRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+3').setBackground('#fed7aa').setRanges([remRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+7').setBackground(UI.T_RED).setRanges([remRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+14').setBackground('#fecaca').setRanges([remRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRange]).build()
  ]);

  uiFootnote(sh, PESAN_DROW + matrix.length + 1, SPAN,
    '◆ Cara pakai: 1 baris = 1 pelanggan (faktur digabung). COPY kolom Pesan atau tap 📲 Kirim WA (pesan auto-terisi, ' +
    'tinggal Send — tidak terkirim otomatis). Bucket H+7 = pengingat sopan + isyarat halus order berikutnya menunggu pelunasan. Faktur yang ' +
    'BELUM jatuh tempo (jauh dari H-1) tidak disebut. Tier A/B nada lebih hangat. Baris tanpa No. Telp (POS/online) tak punya link.');

  sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 130);
  sh.setColumnWidth(4, 90);  sh.setColumnWidth(5, 140); sh.setColumnWidth(6, 150);
  sh.setColumnWidth(7, 190); sh.setColumnWidth(8, 110); sh.setColumnWidth(9, 540);
  return sh;
}
