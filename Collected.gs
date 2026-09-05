/**
 * ROSH × Accurate — 💰 Faktur Collected (file Deden saja).
 *
 * Rincian per faktur di balik angka agregat "Collected". Tab lain di file Deden semuanya
 * berorientasi tagihan yang BELUM lunas (Tagihan Sales, Pool B); collected cuma muncul
 * sebagai satu skalar di KPI Matriks Sales + kolom Collected di Riwayat THP. Tab ini
 * memecah skalar itu jadi daftar faktur.
 *
 * Dua section, newest-first: bulan berjalan + bulan lalu. Pengelompokan = BULAN UANG MASUK
 * (tanggal receipt), bukan bulan faktur terbit. Keanggotaan section bulan M:
 *   ada receipt di bulan M  ATAU  transDate di bulan M (terbit bulan itu, belum ada uang
 *   masuk → tampil "⚪ Belum bayar").
 * Konsekuensi yang disengaja: faktur terbit Juli lalu cair Agustus muncul di DUA section —
 * di Juli sebagai belum bayar, di Agustus sebagai uang masuk. Dijelaskan di footnote tab.
 *
 * Proyeksi murni dari `invoices` yang sudah di-enrich (Sync.gs pass 2) — nol call Accurate,
 * nol scope baru. Butuh `inv.receipts` terisi untuk SEMUA faktur (lihat catatan di
 * enrichReceipts): tanpa itu section bulan lalu kosong.
 */

var COLLECTED_HEADERS = [
  'No. Invoice', 'Customer', 'Tgl Faktur', 'Tgl JT', 'Nilai Invoice',
  'Dibayar (bln ini)', 'Tgl Bayar Terakhir', 'Total Dibayar', 'Sisa', 'Status',
  '📄 Invoice', 'Loyalitas (4bln)'
];
var COLLECTED_SPAN = COLLECTED_HEADERS.length;   // 12
var COLLECTED_MONEY_COLS = [5, 6, 8, 9];

// Date → 'yyyy-MM' pakai komponen lokal (script timezone = Asia/Jakarta, dan semua Date
// di project ini dibangun lewat stripTime/new Date(y,m,d) → sudah lokal).
function _collMonthKey(d) {
  if (!d) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — dua bulan terakhir, faktur milik satu salesman
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param invoices  daftar Pass-1 yang sudah di-enrich (punya .receipts)
 * @param salesName CONFIG.SALES_NAME
 * @param today     tanggal acuan (stripTime)
 * @return [{ key, label, isCurrent, rows[], totalNilai, totalDibayarBulan, totalSisa }]
 *         newest-first (bulan berjalan dulu).
 */
function buildCollectedMonths(invoices, salesName, today) {
  const ref  = today || stripTime(new Date());
  const cur  = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const prev = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  const windows = [
    { key: _collMonthKey(cur),  label: _periodeLabel(_collMonthKey(cur)),  isCurrent: true,  rows: [] },
    { key: _collMonthKey(prev), label: _periodeLabel(_collMonthKey(prev)), isCurrent: false, rows: [] }
  ];

  // Scope ke Deden — matcher yang sama dipakai Pool B di file-nya & buildMonthlyIssued.
  const mine = _bySalesman(invoices || [], salesName);

  windows.forEach(function(w) {
    mine.forEach(function(i) {
      // uang masuk di bulan ini saja
      let dibayarBulan = 0, tglTerakhir = null;
      (i.receipts || []).forEach(function(r) {
        if (_collMonthKey(r.date) !== w.key) return;
        dibayarBulan += num(r.amount);
        if (!tglTerakhir || r.date > tglTerakhir) tglTerakhir = r.date;
      });
      const terbitBulanIni = _collMonthKey(i.transDate) === w.key;
      if (dibayarBulan <= 0 && !terbitBulanIni) return;

      w.rows.push({
        id: i.id, customerId: i.customerId, number: i.number, customer: i.customer,
        transDate: i.transDate, dueDate: i.dueDate, total: num(i.total),
        dibayarBulan: dibayarBulan, tglBayarTerakhir: tglTerakhir,
        // Total Dibayar / Sisa = kondisi TERKINI faktur, bukan potret akhir bulan itu.
        totalDibayar: num(i.paid), sisa: num(i.outstanding),
        status: i.isPaid ? '✅ Lunas' : (num(i.paid) > 0 ? '🟡 Cicil' : '⚪ Belum bayar'),
        tierText: i.custTierText || ''
      });
    });

    // Yang ada uang masuk di atas (nominal terbesar dulu), sisanya di bawah.
    w.rows.sort(function(a, b) {
      if ((a.dibayarBulan > 0) !== (b.dibayarBulan > 0)) return a.dibayarBulan > 0 ? -1 : 1;
      return a.dibayarBulan > 0 ? (b.dibayarBulan - a.dibayarBulan) : (b.sisa - a.sisa);
    });

    w.totalNilai        = w.rows.reduce(function(s, r) { return s + r.total; }, 0);
    w.totalDibayarBulan = w.rows.reduce(function(s, r) { return s + r.dibayarBulan; }, 0);
    w.totalSisa         = w.rows.reduce(function(s, r) { return s + r.sisa; }, 0);
  });

  return windows;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab 💰 Faktur Collected (view-only, tampilan sekeluarga dengan Pool B)
// ─────────────────────────────────────────────────────────────────────────────
function writeCollectedTab(months) {
  const sh = uiSheet(CONFIG.TABS.COLLECTED);
  const SPAN = COLLECTED_SPAN;

  // Reset struktur (pola writePoolTab: merge vs frozen rows bisa saling lempar error)
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).forEach(function(p) { p.remove(); });
  (sh.getProtections(SpreadsheetApp.ProtectionType.RANGE) || []).forEach(function(p) { p.remove(); });

  let r = uiBanner(sh, 1, SPAN, '💰 Faktur Collected — rincian uang masuk',
    'Faktur kamu dikelompokkan per BULAN UANG MASUK (tanggal pembayaran), bukan bulan faktur terbit. ' +
    'Total "Dibayar (bln ini)" tiap bulan = angka Collected di KPI Matriks Sales & Riwayat THP.',
    UI.GREEN, UI.GREEN_SOFT);
  sh.setFrozenRows(2);

  const statusRanges = [], tierRanges = [];

  (months || []).forEach(function(m) {
    r += 1;  // spacer
    r = uiSection(sh, r, SPAN,
      m.label.toUpperCase() + (m.isCurrent ? '  ·  bulan berjalan' : '') +
      '   —   masuk kas ' + rupiah(m.totalDibayarBulan) + ' · ' + m.rows.length + ' faktur',
      m.isCurrent ? UI.GREEN : UI.INK);

    uiHeaderRow(sh, r, COLLECTED_HEADERS);
    r += 1;

    const matrix = m.rows.map(function(x) {
      return [
        x.number, x.customer, fmtDate(x.transDate), fmtDate(x.dueDate), x.total,
        x.dibayarBulan, fmtDate(x.tglBayarTerakhir), x.totalDibayar, x.sisa, x.status,
        fakturLinkFormula(x.id, x.number, x.customerId), x.tierText
      ];
    });

    if (matrix.length) {
      sh.getRange(r, 1, matrix.length, SPAN).setValues(matrix);
      COLLECTED_MONEY_COLS.forEach(function(c) {
        sh.getRange(r, c, matrix.length, 1).setNumberFormat('"Rp"#,##0');
      });
      statusRanges.push(sh.getRange(r, 10, matrix.length, 1));
      tierRanges.push(sh.getRange(r, 12, matrix.length, 1));
      r += matrix.length;
    } else {
      sh.getRange(r, 1, 1, SPAN).merge()
        .setValue('Belum ada faktur di bulan ini.')
        .setFontColor(UI.NOTE).setFontStyle('italic');
      r += 1;
    }

    // Band TOTAL hitam (pola writePoolTab)
    sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
    sh.getRange(r, 2).setValue('TOTAL ' + m.label);
    sh.getRange(r, 5).setValue(m.totalNilai).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 6).setValue(m.totalDibayarBulan).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 9).setValue(m.totalSisa).setNumberFormat('"Rp"#,##0');
    r += 1;
  });

  // Warna Status + Tier, satu set rule untuk semua section.
  const rules = [];
  if (statusRanges.length) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✅')
      .setBackground(UI.T_GREEN).setRanges(statusRanges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('🟡')
      .setBackground(UI.T_AMBER).setRanges(statusRanges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⚪')
      .setBackground(UI.T_GREY).setRanges(statusRanges).build());
  }
  if (tierRanges.length) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges(tierRanges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges(tierRanges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges(tierRanges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges(tierRanges).build());
  }
  if (rules.length) sh.setConditionalFormatRules(rules);

  r += 1;
  r = uiFootnote(sh, r, SPAN,
    '💰 Cara baca: "Dibayar (bln ini)" = uang yang masuk DI BULAN SECTION ITU — ini yang dipakai hitung ' +
    'Omzet KPI kamu. "Total Dibayar" & "Sisa" = kondisi faktur HARI INI (bukan potret akhir bulan). ' +
    'Faktur bisa muncul di dua bulan: terbit bulan lalu (⚪ Belum bayar) lalu cair bulan ini — itu normal. ' +
    'Faktur yang terbit bulan itu tapi belum ada uang masuk tetap ditampilkan supaya kelihatan yang belum tertagih. ' +
    'Data 🔴 otomatis dari Accurate tiap sync jam 5 pagi — tab ini dibangun ulang tiap sync, jangan diedit manual.');

  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(6, 130);
  sh.setColumnWidth(10, 120);
  sh.setColumnWidth(11, 90);   // 📄 Invoice
  sh.setColumnWidth(12, 190);  // Loyalitas (4bln)

  // View-only: Deden adalah Viewer di file-nya; kunci warning-only, tanpa kolom 🟡.
  const prot = sh.protect().setDescription('Faktur Collected — otomatis dari Accurate');
  prot.setWarningOnly(true);
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAG — kenapa TOTAL "Dibayar (bln ini)" ≠ kolom Collected di 📈 Riwayat THP?
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Jalankan dari editor Apps Script (pilih fungsi ini ▸ Run), baca hasilnya di Execution log.
 * Memisahkan DUA kemungkinan sebab selisih untuk satu bulan:
 *   (1) SNAPSHOT BEKU — baris bulan lalu di ledger `_ThpHistory` dibekukan pada sync terakhir
 *       bulan itu. Pembayaran yang DIINPUT ke Accurate setelah jam itu tapi BERTANGGAL bulan
 *       itu (bukti transfer dientri belakangan) tak pernah masuk ledger, tapi selalu ikut di
 *       tab Collected yang baca receipt live. Diag mencetak receipt di tanggal-tanggal akhir
 *       bulan sebagai kandidat utama.
 *   (2) MATCHER SALESMAN — KPI (computeSalesKpi) pakai match PERSIS `i.salesman === SALES_NAME`;
 *       tab Collected pakai `_bySalesman` yang juga menerima bentuk pendek ("Deden"). Kalau
 *       total strict ≠ total fuzzy, ini sebabnya (atau ikut menyumbang).
 * @param periode 'yyyy-MM', mis. '2026-07'. Kosong = bulan lalu.
 */
function diagCollectedReconcile(periode) {
  const now = stripTime(new Date());
  const key = periode || _collMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  Logger.log('===== RECONCILE Collected — periode ' + key + ' (' + _periodeLabel(key) + ') =====');

  const invoices = fetchSalesInvoices();
  const receiptMap = buildReceiptsByInvoice(null);
  invoices.forEach(function(i) { i.receipts = receiptMap[i.id] || []; });

  const full = String(CONFIG.SALES_NAME).toLowerCase().trim();
  const sumFor = function(list) {
    let s = 0;
    list.forEach(function(i) {
      (i.receipts || []).forEach(function(r) { if (_collMonthKey(r.date) === key) s += num(r.amount); });
    });
    return s;
  };

  // (2) matcher
  const fuzzy  = _bySalesman(invoices, CONFIG.SALES_NAME);
  const strict = invoices.filter(function(i) { return i.salesman === CONFIG.SALES_NAME; });
  const sFuzzy = sumFor(fuzzy), sStrict = sumFor(strict);
  Logger.log('MATCHER — fuzzy (_bySalesman, dipakai tab Collected) : ' + rupiah(sFuzzy) + ' · ' + fuzzy.length + ' faktur');
  Logger.log('MATCHER — strict (===SALES_NAME, dipakai KPI/ledger) : ' + rupiah(sStrict) + ' · ' + strict.length + ' faktur');
  Logger.log('MATCHER — selisih akibat nama salesman              : ' + rupiah(sFuzzy - sStrict));
  if (sFuzzy !== sStrict) {
    const strictIds = {};
    strict.forEach(function(i) { strictIds[i.id] = true; });
    fuzzy.forEach(function(i) {
      if (strictIds[i.id]) return;
      let s = 0;
      (i.receipts || []).forEach(function(r) { if (_collMonthKey(r.date) === key) s += num(r.amount); });
      if (s > 0) Logger.log('   + ' + i.number + ' · salesman="' + i.salesman + '" · ' + rupiah(s));
    });
  }

  // (1) snapshot beku — angka ledger vs live, plus receipt di hari-hari terakhir bulan
  const led = _readThpHistory().sales.filter(function(r) { return r.periode === key; })[0];
  Logger.log('LEDGER  — _ThpHistory collected (' + key + ')          : ' +
             (led ? rupiah(led.collected) + '  · dibekukan ' + led.updated : '(baris tak ada)'));
  Logger.log('LIVE    — hitung ulang sekarang (strict, apple-to-apple): ' + rupiah(sStrict));
  if (led) Logger.log('SELISIH — live − ledger                              : ' + rupiah(sStrict - led.collected));

  const parts = key.split('-');
  const monEnd = new Date(+parts[0], +parts[1], 0).getDate();     // hari terakhir bulan itu
  const cutoff = new Date(+parts[0], +parts[1] - 1, monEnd - 1);  // 2 hari terakhir
  let tail = 0, nTail = 0;
  strict.forEach(function(i) {
    (i.receipts || []).forEach(function(r) {
      if (_collMonthKey(r.date) !== key || r.date < cutoff) return;
      tail += num(r.amount); nTail++;
      Logger.log('   ⏰ ' + fmtDate(r.date) + ' · ' + i.number + ' · ' + i.customer + ' · ' + rupiah(r.amount));
    });
  });
  Logger.log('EKOR    — ' + nTail + ' receipt di 2 hari terakhir bulan  : ' + rupiah(tail) +
             '  (kandidat utama kalau ledger dibekukan sebelum tanggal ' + monEnd + ' malam)');
  Logger.log('===== selesai =====');
}
