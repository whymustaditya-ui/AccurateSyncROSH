/**
 * TagihanAr.gs — 🧾 TAGIHAN AR PER CUSTOMER (master + file ROSH AR, BUILT 2026-09-27)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pool A + Pool B digabung jadi satu tab, SATU BARIS PER CUSTOMER. Menggantikan tab Pool A/B di
 * master DAN file ROSH AR (komisi Ade dihapus 2026-09-27, diganti admin tukar faktur, jadi rincian
 * per faktur untuk komisi tidak lagi dibutuhkan). Pool A/B tetap dihitung di memori (Ringkasan,
 * Health, Rute, file Deden); cuma tab-nya yang hilang.
 *
 *   • Faktur yang sudah lunas dibuang; yang tersisa digabung per customer.
 *   • Customer di CONFIG.REKAP_CUSTOMERS DIKELUARKAN (sudah ada di 🏢 Rekap Tagihan Corporate,
 *     cara tagihnya lewat rekap + surat jalan, bukan WA per faktur).
 *   • Urut: Open (belum ada bayar sama sekali) → Partial (sudah cicil), lalu outstanding terbesar.
 *   • 📲 Kirim WA: pesan _penagihanMessageBatch (Pesan.gs, teks sama dengan To-Do master) memuat
 *     SEMUA faktur gantung customer itu + total, jadi sekali klik semua tertagih.
 *   • Kolom Daftar Faktur: tiap nomor faktur jadi link ke PDF-nya kalau PDF sudah ada di Drive.
 *   • 🟡 Channel / Hasil / Tgl Follow-up / Catatan di-upsert PER NAMA CUSTOMER
 *     (collectArCustomerYellow, dikumpulkan sebelum writer mana pun meng-clear tab). Customer yang
 *     baru muncul di-seed sekali dari 🟡 per-faktur Pool A/B (yA/yB) supaya catatan lama tidak hilang.
 *
 * Proyeksi murni: nol call Accurate, nol scope. Depends: Sync.gs, Pesan.gs, Rekap.gs (_rekapMatch,
 * _rekapTarget), Faktur.gs (_fakturFileId), Style.gs, Kpi.gs (rupiah).
 */

var ARC_HEADERS = [
  'Customer', 'Status', 'Pool', 'Jml Faktur', 'Daftar Faktur', 'Total Outstanding', 'Umur Tertua (hr lewat JT)',
  'No. Telp', '📲 Kirim WA',
  'Channel', 'Hasil Negosiasi', 'Tgl Follow-up', 'Catatan',
  'Alamat Customer', 'Loyalitas (4bln)', 'Pesan'
];
var ARC_YELLOW = ['Channel', 'Hasil Negosiasi', 'Tgl Follow-up', 'Catatan'];
var ARC_HROW = 3;   // banner = 1, subtitle = 2
var ARC_DROW = 4;

function _arcCol(name) { return ARC_HEADERS.indexOf(name) + 1; }

function _arcIsRekap(customer) {
  return (CONFIG.REKAP_CUSTOMERS || []).some(function(t) { return _rekapMatch(customer, _rekapTarget(t).match); });
}

// ── Build ────────────────────────────────────────────────────────────────────
// Anggota = sama dengan buildPoolA/buildPoolB (pool A, atau pool B yang sudah lewat handover),
// dikurangi yang lunas. → { rows:[…], excluded:[nama customer rekap yang dibuang] }
function buildArCustomers(invoices, today) {
  const byCust = {}, excluded = {};
  invoices.forEach(function(i) {
    const inPool = i.pool === 'A' || (i.pool === 'B' && i.handoverDate && i.handoverDate <= today);
    if (!inPool || i.isPaid || !(i.outstanding > 0)) return;
    const name = String(i.customer || '').trim();
    if (!name) return;
    if (_arcIsRekap(name)) { excluded[name] = 1; return; }
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, noTlp: '', noVa: '', alamat: '', tierText: '',
                                 invoices: [], totalOutstanding: 0, maxDaysPastDue: -Infinity,
                                 anyPaid: false, pools: {} };
    const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : 0;
    c.invoices.push({ number: i.number, outstanding: i.outstanding, dueDate: i.dueDate, daysPastDue: dpd });
    c.totalOutstanding += i.outstanding;
    if (i.paid > 0) c.anyPaid = true;
    c.pools[i.pool] = 1;
    if (dpd > c.maxDaysPastDue) c.maxDaysPastDue = dpd;
    if (!c.noTlp && i.noTlp)   c.noTlp = i.noTlp;
    if (!c.noVa && i.noVa)     c.noVa = i.noVa;
    if (!c.alamat && i.alamat) c.alamat = i.alamat;
    if (i.custTierText)        c.tierText = i.custTierText;
  });

  const rows = Object.keys(byCust).map(function(k) {
    const c = byCust[k];
    c.status = c.anyPaid ? 'Partial' : 'Open';
    c.pool = Object.keys(c.pools).sort().join('+');                       // A · B · A+B
    c.invoices.sort(function(a, b) { return b.daysPastDue - a.daysPastDue; }); // paling tua dulu
    return c;
  }).sort(function(a, b) {
    if (a.status !== b.status) return a.status === 'Open' ? -1 : 1;
    return b.totalOutstanding - a.totalOutstanding;
  });
  return { rows: rows, excluded: Object.keys(excluded).sort() };
}

// ── 🟡 upsert per customer ───────────────────────────────────────────────────
// → { customer: [channel, hasil, tglFollowUp, catatan] }. Kolom dicari lewat header.
function collectArCustomerYellow(ssList) {
  const map = {};
  (ssList || []).forEach(function(ss) {
    if (!ss) return;
    const sh = ss.getSheetByName(CONFIG.TABS.AR_CUSTOMER);
    if (!sh || sh.getLastRow() < ARC_DROW) return;
    const W = Math.max(sh.getLastColumn(), ARC_HEADERS.length);
    const vals = sh.getRange(1, 1, sh.getLastRow(), W).getValues();
    let idx = null;
    vals.forEach(function(r) {
      const key = String(r[0] || '').trim();
      if (key === 'Customer') { idx = ARC_YELLOW.map(function(h) { return r.indexOf(h); }); return; }
      if (!idx || !key || /^TOTAL/i.test(key)) return;
      const y = idx.map(function(j) { return j >= 0 ? r[j] : ''; });
      const ex = map[key] || ['', '', '', ''];
      for (var k = 0; k < 4; k++) { if (y[k] !== '' && y[k] != null) ex[k] = y[k]; }
      map[key] = ex;
    });
  });
  return map;
}

// Seed pertama kali dari 🟡 per-faktur Pool A/B: Channel/Hasil/Tgl dari follow-up TERBARU,
// Bukti Transfer digabung ke Catatan.
function _arcSeed(c, yPool) {
  let best = null, bestT = -1;
  const bukti = [];
  c.invoices.forEach(function(iv) {
    const y = yPool[iv.number];
    if (!y) return;
    if (y[3] !== '' && y[3] != null) bukti.push(iv.number + ': ' + y[3]);
    if (y[0] === '' && y[1] === '' && y[2] === '') return;
    const t = (y[2] instanceof Date) ? y[2].getTime() : 0;
    if (!best || t > bestT) { best = y; bestT = t; }
  });
  if (!best && !bukti.length) return null;
  return [best ? best[0] : '', best ? best[1] : '', best ? best[2] : '', bukti.length ? 'Bukti ' + bukti.join(' · ') : ''];
}

// Tulis tab gabungan di file aktif (TARGET_SS), lalu buang tab Pool A/B. Gagal → Pool A/B ditulis
// seperti dulu supaya file tidak pernah kosong tagihan. 🟡 per-faktur Pool A/B (yA/yB, dibaca
// sebelum tab dibuang) jadi seed 🟡 per customer untuk customer yang belum punya baris.
function writeArCustomerOrPools(arCust, yArc, yA, yB, poolA, poolB) {
  try {
    const yPool = {};
    [yA, yB].forEach(function(m) { Object.keys(m || {}).forEach(function(k) { yPool[k] = m[k]; }); });
    writeArCustomerTab(arCust, yArc, yPool);
    _dropTabs([CONFIG.TABS.POOL_A, CONFIG.TABS.POOL_B]);   // hanya setelah tab gabungan berhasil ditulis
  } catch (e) {
    Logger.log('Tagihan AR per Customer dilewati, Pool A/B dipertahankan: ' + e.message);
    try { _log('WARN', 'Tagihan AR per Customer dilewati: ' + e.message); } catch (e2) {}
    writePoolTab(CONFIG.TABS.POOL_A, poolA, 'A', yA);
    writePoolTab(CONFIG.TABS.POOL_B, poolB, 'B', yB);
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────
// yellow = hasil collectArCustomerYellow; yPool = gabungan 🟡 per faktur Pool A/B (untuk seed).
function writeArCustomerTab(data, yellow, yPool) {
  yellow = yellow || {}; yPool = yPool || {};
  const rows = data.rows;
  const SPAN = ARC_HEADERS.length;
  const C = function(h) { return _arcCol(h); };

  const sh = uiSheet(CONFIG.TABS.AR_CUSTOMER);
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  sh.getRange(1, 1, sh.getMaxRows(), SPAN).breakApart().clearDataValidations();
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(p) { if (p.canEdit()) p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(p) { if (p.canEdit()) p.remove(); });

  const totOut = rows.reduce(function(s, c) { return s + c.totalOutstanding; }, 0);
  const nInv = rows.reduce(function(s, c) { return s + c.invoices.length; }, 0);
  uiBanner(sh, 1, SPAN, '🧾 Tagihan AR per Customer — Pool A + B',
    rows.length + ' customer · ' + nInv + ' faktur · ' + rupiah(totOut) + '. Satu baris per customer, faktur lunas dibuang. ' +
    'Urut Open → Partial, lalu outstanding terbesar. Tap 📲 Kirim WA: pesan berisi semua faktur gantung customer itu. ' +
    'Customer rekap corporate ada di tab ' + CONFIG.TABS.REKAP + '.',
    UI.BLUE, UI.BLUE_SOFT);
  uiHeaderRow(sh, ARC_HROW, ARC_HEADERS);
  sh.getRange(ARC_HROW, C('Channel'), 1, 4).setBackground(UI.AMBER).setFontColor(UI.WHITE);
  sh.setFrozenRows(ARC_HROW);

  const n = rows.length;
  if (n) {
    const matrix = rows.map(function(c) {
      const phone = _waPhone(c.noTlp);
      const msg = _penagihanMessageBatch(c);
      const y = yellow.hasOwnProperty(c.customer) ? yellow[c.customer] : (_arcSeed(c, yPool) || ['', '', '', '']);
      return [
        c.customer, c.status, c.pool, c.invoices.length,
        c.invoices.map(function(iv) { return iv.number; }).join('\n'),
        c.totalOutstanding, c.maxDaysPastDue, c.noTlp || '', _waLinkFormula(phone, msg),
        y[0], y[1], y[2], y[3],
        c.alamat, c.tierText || '', msg
      ];
    });
    const body = sh.getRange(ARC_DROW, 1, n, SPAN);
    body.setValues(matrix);
    body.setVerticalAlignment('top')
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);

    // Daftar Faktur: tiap nomor jadi link ke PDF kalau sudah ada di Drive.
    const rich = rows.map(function(c) {
      const text = c.invoices.map(function(iv) { return iv.number; }).join('\n');
      const b = SpreadsheetApp.newRichTextValue().setText(text);
      let pos = 0;
      c.invoices.forEach(function(iv) {
        const fid = _fakturFileId(iv.number);
        if (fid) b.setLinkUrl(pos, pos + iv.number.length, 'https://drive.google.com/file/d/' + fid + '/view');
        pos += iv.number.length + 1;
      });
      return [b.build()];
    });
    sh.getRange(ARC_DROW, C('Daftar Faktur'), n, 1).setRichTextValues(rich).setWrap(true);

    sh.getRange(ARC_DROW, C('Total Outstanding'), n, 1).setNumberFormat('"Rp"#,##0');
    [C('Status'), C('Pool'), C('Jml Faktur'), C('Umur Tertua (hr lewat JT)'), C('📲 Kirim WA')].forEach(function(col) {
      sh.getRange(ARC_DROW, col, n, 1).setHorizontalAlignment('center');
    });
    sh.getRange(ARC_DROW, C('Tgl Follow-up'), n, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(ARC_DROW, C('Alamat Customer'), n, 1).setWrap(true);
    sh.getRange(ARC_DROW, C('Pesan'), n, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

    // 🟡 dropdown + tint (pola writePoolTab)
    sh.getRange(ARC_DROW, C('Channel'), n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['WA', 'Telp', 'Visit'], true).setAllowInvalid(true).build());
    sh.getRange(ARC_DROW, C('Hasil Negosiasi'), n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Cicil', 'Payment', 'Komitmen Bayar', '-'], true).setAllowInvalid(true).build());
    sh.getRange(ARC_DROW, C('Channel'), n, 4).setBackground(UI.AMBER_BODY);

    const R = SpreadsheetApp.newConditionalFormatRule;
    const st = sh.getRange(ARC_DROW, C('Status'), n, 1);
    const age = sh.getRange(ARC_DROW, C('Umur Tertua (hr lewat JT)'), n, 1);
    const tier = sh.getRange(ARC_DROW, C('Loyalitas (4bln)'), n, 1);
    sh.setConditionalFormatRules([
      R().whenTextEqualTo('Open').setBackground(UI.T_RED).setRanges([st]).build(),
      R().whenTextEqualTo('Partial').setBackground(UI.T_AMBER).setRanges([st]).build(),
      R().whenNumberGreaterThanOrEqualTo(60).setBackground('#fecaca').setRanges([age]).build(),
      R().whenNumberBetween(30, 59).setBackground('#fed7aa').setRanges([age]).build(),
      R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tier]).build(),
      R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tier]).build(),
      R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tier]).build(),
      R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tier]).build()
    ]);
  }

  // TOTAL + footnote
  const totRow = ARC_DROW + n;
  sh.getRange(totRow, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(totRow, 1).setValue('TOTAL — ' + n + ' customer');
  sh.getRange(totRow, C('Jml Faktur')).setValue(nInv).setHorizontalAlignment('center');
  sh.getRange(totRow, C('Total Outstanding')).setValue(totOut).setNumberFormat('"Rp"#,##0');
  uiFootnote(sh, totRow + 1, SPAN,
    '◆ Open = belum ada pembayaran sama sekali; Partial = sudah ada cicilan di salah satu faktur. Pool A = piutang lama (beku), ' +
    'Pool B = lewat H+14 setelah onboard. Nomor di Daftar Faktur bisa diklik ke PDF-nya kalau sudah dibuat. ' +
    'Kolom 🟡 (Channel, Hasil, Tgl Follow-up, Catatan) tersimpan per nama customer. ' +
    (data.excluded.length ? 'Dikeluarkan karena ada di Rekap Corporate: ' + data.excluded.join(', ') + '.' : ''));

  const widths = { 'Customer': 200, 'Status': 75, 'Pool': 55, 'Jml Faktur': 70, 'Daftar Faktur': 150,
                   'Total Outstanding': 130, 'Umur Tertua (hr lewat JT)': 95, 'No. Telp': 125, '📲 Kirim WA': 105,
                   'Channel': 80, 'Hasil Negosiasi': 120, 'Tgl Follow-up': 100, 'Catatan': 220,
                   'Alamat Customer': 260, 'Loyalitas (4bln)': 180, 'Pesan': 300 };
  ARC_HEADERS.forEach(function(h, i) { sh.setColumnWidth(i + 1, widths[h] || 110); });

  // 🔴 dikunci (warning-only, pola writePoolTab); 🟡 bebas diisi.
  const prot = sh.protect().setDescription('ROSH AccurateSync — kolom 🔴 dikunci. Hanya 🟡 (Channel, Hasil Negosiasi, Tgl Follow-up, Catatan) yang bisa diedit.');
  prot.setUnprotectedRanges([sh.getRange(ARC_DROW, C('Channel'), Math.max(n, 1), 4)]);
  prot.setWarningOnly(true);
  return sh;
}
