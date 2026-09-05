/**
 * ROSH × Accurate — 🚦 Status Customer.
 *
 * Tab yang dibaca SALES sebelum membuat SO (Panduan Sales v1.0 bagian 3): untuk tiap customer,
 * BOLEH SUPPLY? (YA/TIDAK), cara bayar (tempo 14 hari atau bayar dulu), limit, dan sisa limit.
 * Menjawab pertanyaan harian "si A boleh saya jual berapa?" yang tidak bisa dijawab Stop Supply
 * (isinya cuma yang ditahan) maupun Rapor Customer (master-only, membawa margin).
 *
 * Sumber angka SATU: `rapor` dari buildCustomerReport (Customer.gs). Tab ini cuma memproyeksikan
 * kolom sisi bayar + limit; kolom margin/harga beli TIDAK pernah ikut, jadi aman ditulis ke file
 * Deden. Ditulis di master (semua customer) dan file Deden (di-scope _bySalesman).
 *
 * Aturan gate (biner, seperti SOP):
 *   ⛔ TIDAK  ada faktur lewat jatuh tempo (OVD) atau outstanding > limit berlaku (LIM).
 *             Identik dengan keanggotaan ⛔ Stop Supply, sengaja: dua tab tak boleh beda vonis.
 *   ✅ YA     selain itu. Cara bayar: TEMPO kalau punya tempo & limit berlaku > 0, else BAYAR DULU.
 *
 * Limit berlaku = Limit Disetujui Nathan kalau diisi, kalau tidak Jatah Plafon bulan ini
 * (_limitBerlaku, StopSupply.gs). Jatah ikut plafon program Turun Buku, jadi bisa MENGECIL tiap
 * bulan; RINGKAS menyebut plafon bulan ini terus terang.
 *
 * Proyeksi murni: nol call Accurate, nol scope. Depends: Sync.gs (_ss, _bySalesman, num),
 * Style.gs (UI), Kpi.gs (rupiah), Restock.gs (_mblock), StopSupply.gs (_limitBerlaku,
 * _stopSupplyStep), Customer.gs (bentuk baris rapor).
 */

var STATUS_YA = '✅ YA', STATUS_TIDAK = '⛔ TIDAK';
var STATUS_TEMPO = '🧾 TEMPO', STATUS_COD = '💵 BAYAR DULU';

// Header per role. Kolom Sales tak ada artinya di file Deden (isinya dia semua).
function _statusHeaders(role) {
  const h = ['Customer', 'Boleh Supply?', 'Cara Bayar', 'Sisa Limit', 'Limit', 'Nunggak Sekarang',
             'Hari Telat', 'Keterangan', 'Loyalitas (4bln)', 'No. Telp'];
  if (role !== 'deden') h.push('Sales');
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — satu baris per customer dari rapor.list. Tidak menyentuh margin.
// ─────────────────────────────────────────────────────────────────────────────
function buildCustomerStatus(rapor) {
  const rows = [];
  if (!rapor || !rapor.list) return { rows: rows, budget: 0, budgetSrc: '' };
  const DPD = CONFIG.STOP_SUPPLY_DAYS;
  const tempoMax = CONFIG.CUSTOMER.TEMPO_MAX;

  rapor.list.forEach(function(r) {
    const limit = _limitBerlaku(r);
    const dpd = (r.maxOpenDpd == null) ? null : r.maxOpenDpd;
    const ovd = dpd != null && dpd >= DPD;
    const lim = limit > 0 && r.outstanding > limit;
    const tempo = r.tempo > 0 ? Math.min(r.tempo, tempoMax) : 0;

    let boleh, cara = '', sisa = 0, ket = '';
    if (ovd || lim) {
      boleh = STATUS_TIDAK;
      if (ovd) {
        ket = 'Ada faktur lewat jatuh tempo, tertua ' + dpd + ' hari, nunggak ' + rupiah(r.outstanding) +
              '. Jangan buat SO. Tagih dulu; status kembali YA begitu sisa Rp0.';
        const step = _stopSupplyStep(dpd);
        if (step) ket += ' Tindakan: ' + step + '.';
      } else {
        ket = 'Outstanding ' + rupiah(r.outstanding) + ' sudah melewati limit ' + rupiah(limit) +
              '. Bayar sampai di bawah limit dulu, atau minta owner naikkan limit tertulis.';
      }
    } else {
      boleh = STATUS_YA;
      if (tempo > 0 && limit > 0) {
        cara = STATUS_TEMPO + ' ' + tempo + ' HARI';
        sisa = Math.max(0, limit - r.outstanding);
        ket = sisa > 0
          ? 'Boleh order sampai ' + rupiah(sisa) + ' dengan tempo ' + tempo + ' hari. Lebih dari itu, sisanya bayar dulu.'
          : 'Limit sudah terpakai penuh (nunggak ' + rupiah(r.outstanding) + '). Order berikutnya bayar dulu sampai ada pelunasan.';
      } else {
        cara = STATUS_COD;
        ket = _statusCodReason(r, limit, tempo);
      }
    }

    rows.push({
      customer: r.customer, salesman: r.salesman || '', noTlp: r.noTlp || '', tierText: r.tierText || '',
      verdict: r.verdict, boleh: boleh, cara: cara, sisa: sisa, limit: limit,
      outstanding: r.outstanding, hariTelat: dpd == null ? '' : dpd, ket: ket,
      belanjaBulanan: r.belanjaBulanan || 0
    });
  });
  return { rows: rows, budget: rapor.totals.budget, budgetSrc: rapor.totals.budgetSrc };
}

// Kenapa YA tapi bayar dulu. Urutan: sebab yang paling spesifik dulu.
function _statusCodReason(r, limit, tempo) {
  const v = r.verdict || '';
  if (v.indexOf('🆕') === 0) return 'Customer baru. Bayar dulu sampai 3 transaksi lancar, setelah itu sales boleh ajukan tempo ke owner.';
  if (v.indexOf('💵') === 0) return 'Selama ini selalu bayar tunai. Boleh order seperti biasa, bayar dulu.';
  if (v.indexOf('😴') === 0) return 'Lama tidak order. Boleh order, bayar dulu; tempo bisa diajukan lagi setelah lancar.';
  if (v.indexOf('⚪') === 0) return 'Belum cukup riwayat bayar untuk dinilai. Bayar dulu.';
  if (v.indexOf('🔴') === 0) return 'Catatan bayar buruk (skor ' + r.skor + '). Boleh order hanya dengan bayar di muka.';
  if (tempo <= 0) return 'Catatan bayar kurang rapi (skor ' + r.skor + '). Bayar dulu sampai catatannya membaik.';
  if (limit <= 0 && r.limit > 0) return 'Plafon kredit ROSH bulan ini sudah terbagi habis. Bulan ini bayar dulu; tempo dilanjutkan begitu plafon tersedia.';
  return 'Belum ada limit kredit. Bayar dulu.';
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab 🚦 Status Customer. Tiga seksi: DITAHAN → BOLEH (TEMPO) → BOLEH (BAYAR DULU).
// `role`: 'master' | 'deden'. Semua 🔴 generated, tidak ada kolom isian.
// ─────────────────────────────────────────────────────────────────────────────
function writeCustomerStatusTab(status, role) {
  const sh = uiSheet(CONFIG.TABS.STATUS_CUST);
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  const H = _statusHeaders(role);
  const SPAN = H.length;
  const C = {}; H.forEach(function(h, i) { C[h] = i + 1; });
  const isDeden = (role === 'deden');
  const rows = status.rows;
  const tempoMax = CONFIG.CUSTOMER.TEMPO_MAX;

  let r = uiBanner(sh, 1, SPAN,
    '🚦 Status Customer — cek dulu sebelum buat SO',
    (isDeden
      ? 'Semua customer atas nama kamu. '
      : 'Semua customer ROSH. ') +
    'Baca kolom Boleh Supply?: ⛔ TIDAK = jangan buat SO berapa pun nilainya, tagih dulu. ✅ YA = boleh order; ' +
    'lihat Cara Bayar dan Sisa Limit. Tempo maksimal ' + tempoMax + ' hari untuk semua customer. ' +
    'Cicilan tidak membuka kiriman; lunas = sisa Rp0. Dibuat ulang otomatis tiap jam 5 pagi.',
    UI.INK, UI.BAND);

  // ── strip ringkas ──
  const tidak = rows.filter(function(x) { return x.boleh === STATUS_TIDAK; });
  const tempoRows = rows.filter(function(x) { return x.boleh === STATUS_YA && x.cara.indexOf(STATUS_TEMPO) === 0; });
  const codRows = rows.filter(function(x) { return x.boleh === STATUS_YA && x.cara === STATUS_COD; });
  const sisaTotal = tempoRows.reduce(function(s, x) { return s + x.sisa; }, 0);
  const nunggakTidak = tidak.reduce(function(s, x) { return s + x.outstanding; }, 0);
  const strip = [
    ['⛔ Ditahan', tidak.length + ' customer · ' + rupiah(nunggakTidak)],
    ['🧾 Boleh, tempo ' + tempoMax + ' hari', tempoRows.length + ' customer'],
    ['💵 Boleh, bayar dulu', codRows.length + ' customer'],
    ['💳 Sisa limit tersedia', rupiah(sisaTotal)]
  ];
  const w = Math.floor(SPAN / strip.length);
  strip.forEach(function(kv, i) {
    const c1 = i * w + 1, c2 = (i === strip.length - 1) ? SPAN : c1 + w - 1;
    _mblock(sh, r, c1, c2, kv[0] + '   ' + kv[1])
      .setBackground(UI.BAND).setFontWeight('bold').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, false, false, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.setRowHeight(r, 30); r++;
  sh.setRowHeight(r, 8); r++;

  const blocks = [];
  const sections = [
    { label: '⛔ DITAHAN — jangan buat SO, tagih dulu', color: UI.RED, list: tidak,
      empty: '✅ Tidak ada customer yang ditahan.',
      sort: function(a, b) {
        const da = a.hariTelat === '' ? -1 : a.hariTelat, db = b.hariTelat === '' ? -1 : b.hariTelat;
        if (db !== da) return db - da;
        return b.outstanding - a.outstanding;
      } },
    { label: '✅ BOLEH ORDER — tempo ' + tempoMax + ' hari, sampai Sisa Limit', color: UI.GREEN, list: tempoRows,
      empty: 'Belum ada customer yang memegang tempo.',
      sort: function(a, b) { return a.customer.localeCompare(b.customer); } },
    { label: '💵 BOLEH ORDER — bayar dulu (belum / tidak punya tempo)', color: UI.BLUE, list: codRows,
      empty: 'Tidak ada.',
      sort: function(a, b) { return a.customer.localeCompare(b.customer); } }
  ];

  sections.forEach(function(sec) {
    r = uiSection(sh, r, SPAN, sec.label + '  ·  ' + sec.list.length + ' customer', sec.color);
    if (!sec.list.length) {
      sh.getRange(r, 1, 1, SPAN).merge().setValue(sec.empty)
        .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
      r += 2;
      return;
    }
    uiHeaderRow(sh, r, H); r++;
    const list = sec.list.slice().sort(sec.sort);
    const matrix = list.map(function(x) {
      const row = [x.customer, x.boleh, x.cara, x.sisa, x.limit > 0 ? x.limit : '',
                   x.outstanding, x.hariTelat, x.ket, x.tierText, x.noTlp];
      if (!isDeden) row.push(x.salesman || '(POS / online)');
      return row;
    });
    const n = matrix.length;
    sh.getRange(r, 1, n, SPAN).setValues(matrix).setVerticalAlignment('middle');
    sh.getRange(r, 1, n, SPAN)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(r, C['Boleh Supply?'], n, 1).setHorizontalAlignment('center').setFontWeight('bold');
    sh.getRange(r, C['Cara Bayar'], n, 1).setHorizontalAlignment('center');
    [C['Sisa Limit'], C['Limit'], C['Nunggak Sekarang']].forEach(function(c) {
      sh.getRange(r, c, n, 1).setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
    });
    sh.getRange(r, C['Sisa Limit'], n, 1).setFontWeight('bold');
    sh.getRange(r, C['Hari Telat'], n, 1).setHorizontalAlignment('center');
    sh.getRange(r, C['Keterangan'], n, 1).setWrap(true).setFontColor(UI.INK);
    blocks.push({ first: r, n: n });
    r += n;
    // pita TOTAL seksi
    sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
    sh.getRange(r, 1).setValue('TOTAL — ' + n + ' customer');
    sh.getRange(r, C['Sisa Limit']).setValue(list.reduce(function(s, x) { return s + x.sisa; }, 0)).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, C['Nunggak Sekarang']).setValue(list.reduce(function(s, x) { return s + x.outstanding; }, 0)).setNumberFormat('"Rp"#,##0');
    r += 2;
  });

  _statusCondFormats(sh, blocks, C);

  r = uiFootnote(sh, r, SPAN,
    '◆ Boleh Supply? TIDAK kalau ada faktur lewat jatuh tempo (≥ H+' + CONFIG.STOP_SUPPLY_DAYS +
    ') atau nunggak melewati Limit; daftarnya sama persis dengan tab Stop Supply. ' +
    'Limit = limit yang disetujui owner, kalau belum ada memakai jatah plafon kredit bulan ini' +
    (isDeden ? '' : ' (' + rupiah(status.budget) + ', ' + status.budgetSrc + ')') +
    '; plafon mengikuti program penurunan piutang jadi bisa mengecil tiap bulan. ' +
    'Sisa Limit = Limit dikurangi Nunggak Sekarang; order di atas Sisa Limit, kelebihannya bayar dulu. ' +
    'Semua customer kredit tempo ' + tempoMax + ' hari; faktur lama yang sudah terbit tetap ikut tempo lamanya sampai lunas. ' +
    'Loyalitas (A/B/C/D) = seberapa sering dia order, bukan izin kredit.');
  r++;

  _statusCaraBaca(sh, r, SPAN, isDeden);

  const widths = { 'Customer': 220, 'Boleh Supply?': 110, 'Cara Bayar': 150, 'Sisa Limit': 130, 'Limit': 120,
                   'Nunggak Sekarang': 130, 'Hari Telat': 85, 'Keterangan': 420, 'Loyalitas (4bln)': 190,
                   'No. Telp': 130, 'Sales': 120 };
  H.forEach(function(h, i) { sh.setColumnWidth(i + 1, widths[h] || 120); });
  return sh;
}

// Sekali untuk semua blok: setConditionalFormatRules mengganti SELURUH aturan sheet.
function _statusCondFormats(sh, blocks, C) {
  const use = (blocks || []).filter(function(b) { return b && b.n > 0; });
  if (!use.length) return;
  const rng = function(col) { return use.map(function(b) { return sh.getRange(b.first, col, b.n, 1); }); };
  const boleh = rng(C['Boleh Supply?']), cara = rng(C['Cara Bayar']), telat = rng(C['Hari Telat']);
  const sisa = rng(C['Sisa Limit']), tier = rng(C['Loyalitas (4bln)']);
  const R = SpreadsheetApp.newConditionalFormatRule;
  sh.setConditionalFormatRules([
    R().whenTextStartsWith('✅').setBackground(UI.T_GREEN).setRanges(boleh).build(),
    R().whenTextStartsWith('⛔').setBackground(UI.T_RED).setRanges(boleh).build(),
    R().whenTextStartsWith('🧾').setBackground(UI.BLUE_SOFT).setRanges(cara).build(),
    R().whenTextStartsWith('💵').setBackground(UI.T_AMBER).setRanges(cara).build(),
    R().whenNumberGreaterThanOrEqualTo(30).setBackground(UI.T_RED).setRanges(telat).build(),
    R().whenNumberBetween(7, 29).setBackground('#fed7aa').setRanges(telat).build(),
    R().whenNumberBetween(CONFIG.STOP_SUPPLY_DAYS, 6).setBackground(UI.T_AMBER).setRanges(telat).build(),
    R().whenNumberGreaterThan(0).setBackground(UI.T_GREEN).setRanges(sisa).build(),
    R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges(tier).build(),
    R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges(tier).build(),
    R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges(tier).build(),
    R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges(tier).build()
  ]);
}

function _statusCaraBaca(sh, row, SPAN, isDeden) {
  let r = uiSection(sh, row, SPAN, '📖 CARA BACA', UI.GOLD);
  const rows = [
    ['Boleh Supply?', '⛔ TIDAK = ada faktur lewat jatuh tempo atau nunggak melewati limit. Jangan buat SO, berapa pun nilai ordernya. Tagih dulu; begitu sisa Rp0 status otomatis kembali YA di sync berikutnya. ✅ YA = boleh order, lihat Cara Bayar.'],
    ['Cara Bayar', '🧾 TEMPO ' + CONFIG.CUSTOMER.TEMPO_MAX + ' HARI = boleh kirim dulu, bayar paling lambat ' + CONFIG.CUSTOMER.TEMPO_MAX + ' hari, sampai angka Sisa Limit. 💵 BAYAR DULU = boleh order tapi transfer harus masuk sebelum barang naik mobil (customer baru, tunai, catatan bayar kurang, atau plafon bulan ini habis). Alasannya ada di Keterangan.'],
    ['Sisa Limit', 'Limit dikurangi Nunggak Sekarang. Order lebih dari ini boleh, tapi kelebihannya bayar dulu. Nol untuk customer bayar dulu.'],
    ['Limit', 'Limit kredit yang berlaku: angka yang disetujui owner, atau kalau belum ada, jatah plafon kredit bulan ini. Naik hanya lewat owner setelah 3 bulan tanpa telat; sales boleh mengingatkan.'],
    ['Hari Telat', 'Faktur terbuka paling lama, dihitung dari jatuh tempo. Makin besar makin prioritas ditagih. Kosong = tidak ada yang lewat jatuh tempo.'],
    ['Cicilan', 'Tidak membuka kiriman. Faktur dianggap lunas hanya kalau sisa Rp0. Transfer kurang (motong sendiri) = belum lunas.'],
    ['Tempo', 'Semua customer kredit ' + CONFIG.CUSTOMER.TEMPO_MAX + ' hari. Tidak ada tempo 21 atau 30. Kalau customer minta lebih: "Sistem kami ' + CONFIG.CUSTOMER.TEMPO_MAX + ' hari untuk semua; yang bisa naik itu limitnya, kalau pembayarannya lancar."'],
    ['Kalau ragu', isDeden ? 'Jangan buat SO, tanya owner.' : 'Cocokkan dengan Rapor Customer (kolom Keputusan, Saran Limit) dan Stop Supply. Ketiganya membaca angka yang sama.']
  ];
  rows.forEach(function(pair) {
    _mblock(sh, r, 1, 2, pair[0]).setFontWeight('bold').setVerticalAlignment('top');
    _mblock(sh, r, 3, SPAN, pair[1]).setWrap(true).setVerticalAlignment('top');
    sh.setRowHeight(r, Math.max(30, Math.ceil(pair[1].length / 120) * 18 + 12));
    r++;
  });
  return r;
}
