/**
 * ROSH × Accurate — 📉 Turun Buku Piutang.
 *
 * Kemudi program: turunkan outstanding ke CONFIG.TURUN_BUKU.TARGET_AR dalam MONTHS bulan, dan
 * kurangi jumlah customer yang pegang tempo. Alasannya sederhana: makin besar buku piutang,
 * makin besar bagian yang akhirnya jadi NPL.
 *
 * Dua tuas, keduanya ditampilkan sebagai daftar yang bisa dikerjakan:
 *   1. CABUT TEMPO → COD penuh, dipecah jadi gelombang bulanan (yang paling tidak layak duluan).
 *   2. TAGIH LEBIH KERAS bulan ini, menyambung ke 🗺️ Rute dan ✉️ Pesan Penagihan yang sudah ada.
 *
 * Riwayat bukunya GRATIS: _MetricSnapshots (Health.gs) sudah menyimpan totalAR + bucket umur
 * harian sejak lama, jadi grafik penurunan dan tren NPL bisa ditarik MUNDUR, bukan menunggu
 * enam bulan ke depan. Itu juga alasan NPL_DAYS dipatok 60: bucket 61-90 dan 90+ sudah ada.
 *
 * Proyeksi murni: nol call Accurate, nol scope. MASTER-ONLY.
 * Depends: Customer.gs (report), Health.gs (_snapshotSheet, SNAP_HEADERS), Style.gs, Kpi.gs.
 */

var TB_HEADERS = [
  'Gelombang', 'Customer', 'Sales', 'Loyalitas (4bln)', 'Skor Bayar', 'Telat Terlama (hari)',
  'AR Dibebaskan', 'Kumulatif', 'Omzet Berisiko / bln', 'Alasan', 'Status'
];
var TB_SPAN     = TB_HEADERS.length;   // 11
var TB_COL_YEL  = 11;                  // 🟡 Status (diisi Nathan)

var TB_TAGIH_HEADERS = [
  'Prioritas', 'Customer', 'Sales', 'No. Telp', 'Nunggak', 'Telat Terlama (hari)',
  'Skor Bayar', 'Peluang Cair', 'Kumulatif'
];

// ─────────────────────────────────────────────────────────────────────────────
// RIWAYAT BULANAN dari _MetricSnapshots — ambil snapshot TERAKHIR tiap bulan.
// Kolom (SNAP_HEADERS): A tanggal · B totalAR · … · P b_61_90 · Q b_90plus.
// ─────────────────────────────────────────────────────────────────────────────
function _monthlySnapshots() {
  const out = {};
  try {
    const sh = _snapshotSheet();
    const last = sh.getLastRow();
    if (last < 2) return out;
    const vals = sh.getRange(2, 1, last - 1, SNAP_HEADERS.length).getValues();
    vals.forEach(function(r) {
      const ds = String(r[0] || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return;
      const key = ds.slice(0, 7);
      const prev = out[key];
      if (prev && prev.tanggal >= ds) return;      // simpan yang PALING AKHIR di bulan itu
      const totalAR = num(r[1]);
      const npl = num(r[15]) + num(r[16]);         // bucket 61-90 + 90+
      out[key] = { tanggal: ds, totalAR: totalAR, npl: npl,
                   nplPct: totalAR > 0 ? npl / totalAR : null, custWithAR: num(r[8]) };
    });
  } catch (e) { Logger.log('_monthlySnapshots: ' + e.message); }
  return out;
}

function _tbMonthKey(d) { return Utilities.formatDate(d, 'GMT+7', 'yyyy-MM'); }

function _tbMonthLabel(key) {
  const NAMA = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const p = String(key).split('-');
  if (p.length < 2) return key;
  return NAMA[Number(p[1]) - 1] + ' ' + p[0];
}

function _tbAddMonthsKey(key, n) {
  const p = String(key).split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1);
  return _tbMonthKey(d);
}

// Berapa bulan dari PROGRAM_START ke bulan `key` (0 = bulan pertama).
function _tbMonthIndex(startKey, key) {
  const a = String(startKey).split('-'), b = String(key).split('-');
  return (Number(b[0]) - Number(a[0])) * 12 + (Number(b[1]) - Number(a[1]));
}

// ─────────────────────────────────────────────────────────────────────────────
// GLIDE PATH — garis lurus dari buku awal ke TARGET_AR dalam MONTHS bulan.
// Buku awal dikunci dari snapshot bulan PROGRAM_START; kalau belum ada (program baru mulai),
// pakai buku hari ini sebagai titik awal.
// ─────────────────────────────────────────────────────────────────────────────
function _glidePath(startAr, today) {
  const T = CONFIG.TURUN_BUKU;
  const snaps = _monthlySnapshots();
  const startKey = T.PROGRAM_START;
  const base = (snaps[startKey] && snaps[startKey].totalAR > 0) ? snaps[startKey].totalAR : startAr;
  const rows = [];
  for (let n = 0; n <= T.MONTHS; n++) {
    const key = _tbAddMonthsKey(startKey, n);
    const target = base - (base - T.TARGET_AR) * (n / T.MONTHS);
    const s = snaps[key];
    rows.push({
      key: key, label: _tbMonthLabel(key), n: n,
      target: Math.max(T.TARGET_AR, Math.round(target)),
      realisasi: s ? s.totalAR : null,
      npl: s ? s.npl : null, nplPct: s ? s.nplPct : null
    });
  }
  return { base: base, rows: rows, startKey: startKey };
}

// Target buku untuk bulan berjalan — dipakai Customer.gs sebagai plafon kredit bulan ini,
// sehingga pengetatan ikut mengencang otomatis tiap bulan tanpa ada yang perlu mengubah angka.
function _glideTargetFor(today, arNow) {
  try {
    const g = _glidePath(arNow, today);
    const idx = _tbMonthIndex(g.startKey, _tbMonthKey(today));
    if (idx < 0) return null;                                   // program belum mulai
    const row = g.rows[Math.min(idx, g.rows.length - 1)];
    return row ? row.target : null;
  } catch (e) { Logger.log('_glideTargetFor: ' + e.message); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// GELOMBANG CABUT TEMPO — customer paling tidak layak pegang tempo duluan, dipecah jadi
// gelombang bulanan yang masing-masing membebaskan cukup rupiah untuk mengejar target bulan itu.
// ─────────────────────────────────────────────────────────────────────────────
function _codWaves(raporList, glide, today) {
  const T = CONFIG.TURUN_BUKU;
  const startIdx = Math.max(0, _tbMonthIndex(glide.startKey, _tbMonthKey(today)));

  // Kandidat: masih pegang tempo DAN memang tidak layak memegangnya.
  //
  // Sengaja HANYA 🔴 STOP-COD dan 🟡 GAS TERBATAS. Dua yang lain dikecualikan atas alasan
  // yang berbeda, dan keduanya penting:
  //   • 🟢 GAS — customer terbaik. Mencabut tempo mereka demi mengejar target justru merusak
  //     bisnis yang sedang kita selamatkan. Kalau kandidat yang layak tidak cukup menutup
  //     kebutuhan, tab akan mengatakannya terus terang (lihat peringatan di writer), BUKAN diam-diam
  //     mengorbankan pelanggan andalan.
  //   • 🟠 NAIKKAN HARGA — masalahnya harga, bukan kelakuan bayar. Tuasnya menaikkan harga,
  //     bukan mencabut tempo. Mereka muncul di tab Rapor Customer dengan angka kenaikannya.
  const kandidat = raporList.filter(function(r) {
    if (r.isCod || r.verdict === '💵 TUNAI' || r.verdict === '😴 DORMAN') return false;
    if (r.tempoModus == null || r.tempoModus <= CONFIG.CUSTOMER.COD_TEMPO_MAX) return false;
    return r.verdict === '🔴 STOP-COD' || r.verdict === '🟡 GAS TERBATAS';
  }).sort(function(a, b) {
    // Paling tidak layak duluan: skor rendah, tunggakan tua, nilai besar.
    if (a.skor !== b.skor) return a.skor - b.skor;
    const da = a.maxOpenDpd == null ? -1 : a.maxOpenDpd;
    const db = b.maxOpenDpd == null ? -1 : b.maxOpenDpd;
    if (da !== db) return db - da;
    return b.outstanding - a.outstanding;
  });

  // Berapa rupiah yang harus dibebaskan di tiap bulan sisa program.
  const sisaBulan = [];
  for (let n = startIdx; n < glide.rows.length; n++) {
    const prevTarget = n === 0 ? glide.base : glide.rows[n - 1].target;
    sisaBulan.push({ n: n, key: glide.rows[n].key, label: glide.rows[n].label,
                     butuh: Math.max(0, prevTarget - glide.rows[n].target) });
  }
  if (!sisaBulan.length) {
    sisaBulan.push({ n: startIdx, key: _tbMonthKey(today),
                     label: _tbMonthLabel(_tbMonthKey(today)), butuh: 0 });
  }

  const waves = [];
  let wi = 0, terkumpul = 0, kum = 0, nWave = 0;
  kandidat.forEach(function(r) {
    const w = sisaBulan[Math.min(wi, sisaBulan.length - 1)];
    kum += r.outstanding;
    terkumpul += r.outstanding;
    nWave++;
    waves.push({
      gelombang: w.label, customer: r.customer, salesman: r.salesman, tierText: r.tierText,
      skor: r.skor, maxOpenDpd: r.maxOpenDpd, arDibebaskan: r.outstanding, kumulatif: kum,
      omzetBerisiko: r.belanjaBulanan,
      alasan: r.verdict === '🔴 STOP-COD'
        ? 'Sudah masuk stop supply, tempo dicabut duluan'
        : 'Skor bayar ' + r.skor +
          (r.maxOpenDpd ? ', faktur terlama lewat ' + r.maxOpenDpd + ' hari' : ''),
      status: r.tbStatus || ''
    });
    // Pindah gelombang begitu kebutuhan bulan ini tercapai DAN sudah cukup banyak orang.
    if (terkumpul >= w.butuh && nWave >= T.MIN_WAVE && wi < sisaBulan.length - 1) {
      wi++; terkumpul = 0; nWave = 0;
    }
  });
  return { waves: waves, sisaBulan: sisaBulan, totalDibebaskan: kum };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildTurunBuku(rapor, health, today, yMap) {
  const T = CONFIG.TURUN_BUKU;
  const list = rapor.list.map(function(r) {
    const y = (yMap && yMap[r.customer]) || {};
    r.tbStatus = y.status || '';
    return r;
  });

  const arNow = (health && health.totalAR != null) ? health.totalAR : rapor.totals.arBook;
  const glide = _glidePath(arNow, today);
  const cod = _codWaves(list, glide, today);

  // Tagih dulu bulan ini: nunggak besar × tua × peluang cair (skor tinggi = lebih mungkin cair).
  const tagih = list
    .filter(function(r) { return r.outstanding > 0 && r.maxOpenDpd != null && r.maxOpenDpd > 0; })
    .map(function(r) {
      const peluang = clamp(r.skor / 100, 0.05, 0.95);
      return { customer: r.customer, salesman: r.salesman, noTlp: r.noTlp || '',
               outstanding: r.outstanding, maxOpenDpd: r.maxOpenDpd, skor: r.skor,
               peluang: peluang,
               nilai: r.outstanding * peluang * (1 + r.maxOpenDpd * 0.01) };
    })
    .sort(function(a, b) { return b.nilai - a.nilai; })
    .slice(0, 20);
  let kum = 0;
  tagih.forEach(function(t) { kum += t.outstanding * t.peluang; t.kumulatif = kum; });

  const idx = _tbMonthIndex(glide.startKey, _tbMonthKey(today));
  const targetBulanIni = (idx >= 0 && idx < glide.rows.length)
    ? glide.rows[idx].target : T.TARGET_AR;

  return {
    arNow: arNow, target: T.TARGET_AR, harusTurun: Math.max(0, arNow - T.TARGET_AR),
    targetBulanIni: targetBulanIni,
    tempoCount: rapor.totals.tempoCount, cadangan: rapor.totals.cadangan,
    glide: glide, cod: cod, tagih: tagih,
    health: health, mulaiIdx: idx
  };
}

// 🟡 Status gelombang diisi Nathan — dikumpulkan SEBELUM tab dibersihkan.
function collectTurunYellow(files) {
  const map = {};
  (files || []).forEach(function(ss) {
    if (!ss) return;
    try {
      const sh = ss.getSheetByName(CONFIG.TABS.TURUN_BUKU);
      if (!sh) return;
      const last = sh.getLastRow();
      if (last < 2) return;
      const vals = sh.getRange(1, 1, last, TB_SPAN).getValues();
      vals.forEach(function(row) {
        const nama = String(row[1] || '').trim();
        const st = row[TB_COL_YEL - 1];
        if (!nama || nama === 'Customer' || st === '' || st == null) return;
        map[nama] = { status: st };
      });
    } catch (e) { Logger.log('collectTurunYellow: ' + e.message); }
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER
// ─────────────────────────────────────────────────────────────────────────────
function writeTurunBukuTab(m) {
  const sh = uiSheet(CONFIG.TABS.TURUN_BUKU);
  const SPAN = TB_SPAN;
  const T = CONFIG.TURUN_BUKU;

  let r = uiBanner(sh, 1, SPAN, '📉 Turun Buku Piutang — target ' + rupiah(T.TARGET_AR),
    'Makin besar piutang berjalan, makin besar bagian yang akhirnya tidak tertagih. Program ini ' +
    'menurunkan buku ke ' + rupiah(T.TARGET_AR) + ' dalam ' + T.MONTHS + ' bulan lewat dua cara: ' +
    'mencabut tempo customer yang tidak layak (jadi COD) dan menagih lebih keras yang masih bisa ' +
    'cair. Angka realisasi diambil dari catatan harian yang sudah berjalan sejak lama.',
    UI.RED, UI.RED_SOFT);

  // ── POSISI HARI INI ──
  r = uiSection(sh, r, SPAN, 'POSISI HARI INI', UI.INK);
  const nplRp = (m.health && m.health.aging)
    ? (m.health.aging.d61_90.out + m.health.aging.d90plus.out) : 0;
  const nplPct = m.arNow > 0 ? nplRp / m.arNow : 0;
  const pos = [
    ['Buku sekarang', m.arNow, 'Total piutang berjalan seluruh customer'],
    ['Target akhir program', T.TARGET_AR, 'Dicapai bertahap dalam ' + T.MONTHS + ' bulan'],
    ['Harus turun', m.harusTurun, m.harusTurun > 0
      ? 'Selisih yang harus dibereskan' : '✅ Buku sudah di bawah target'],
    ['Target bulan ini', m.targetBulanIni, 'Ini juga yang jadi plafon kredit di tab Rapor Customer'],
    ['Customer pegang tempo', m.tempoCount + ' customer', 'Angka inilah yang harus turun, bukan cuma rupiahnya'],
    ['NPL lewat ' + T.NPL_DAYS + ' hari', nplRp,
      (nplPct * 100).toFixed(1) + '% dari buku · tagihan seumur ini yang biasanya paling sulit cair'],
    ['Total Gagal Bayar (Potensi Besar)', m.cadangan,
      'Perkiraan bagian buku yang berpotensi tidak tertagih, dihitung dari umur tunggakannya']
  ];
  pos.forEach(function(row) {
    _mblock(sh, r, 1, 3, row[0]).setFontWeight('bold');
    const c = _mblock(sh, r, 4, 5, row[1]);
    if (typeof row[1] === 'number') c.setNumberFormat('"Rp"#,##0');
    _mblock(sh, r, 6, SPAN, row[2]).setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  });
  r++;

  // ── JALUR TURUN ──
  r = uiSection(sh, r, SPAN, 'JALUR TURUN ' + T.MONTHS + ' BULAN', UI.BLUE);
  uiHeaderRow(sh, r, ['Bulan', 'Target buku', 'Realisasi', 'Selisih', 'Status',
                      'NPL ' + T.NPL_DAYS + '+ hari', '', '', '', '', '']);
  r++;
  const gm = m.glide.rows.map(function(g) {
    let status;
    if (g.realisasi == null) status = '⏳ belum berjalan';
    else if (g.realisasi <= g.target) status = '✅ sesuai jalur';
    else status = '⚠️ tertinggal ' + rupiah(g.realisasi - g.target);
    return [g.label, g.target, g.realisasi == null ? '' : g.realisasi,
            g.realisasi == null ? '' : (g.realisasi - g.target), status,
            g.npl == null ? '' : g.npl, '', '', '', '', ''];
  });
  sh.getRange(r, 1, gm.length, SPAN).setValues(gm).setVerticalAlignment('middle');
  sh.getRange(r, 2, gm.length, 3).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, 6, gm.length, 1).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, 1, gm.length, 6)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  r += gm.length;

  // Tren buku dari catatan harian yang sudah menumpuk.
  const seriesAr = m.glide.rows.filter(function(g) { return g.realisasi != null; })
    .map(function(g) { return g.realisasi; });
  if (seriesAr.length >= 2) {
    _mblock(sh, r, 1, 3, 'Tren buku (per bulan)').setFontWeight('bold');
    sh.getRange(r, 4).setFormula('=SPARKLINE({' + seriesAr.join(';') +
      '},{"charttype","line";"color","#a23e2a"})');
    _mblock(sh, r, 6, SPAN, 'Turun berarti program jalan. Naik berarti order baru masih keluar ' +
      'ke customer yang belum bayar.').setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  }
  r++;

  // ── GELOMBANG CABUT TEMPO ──
  r = uiSection(sh, r, SPAN, '⛔ GELOMBANG CABUT TEMPO (jadi COD penuh)', UI.RED);
  sh.getRange(r, 1, 1, SPAN).merge().setValue(
    'Urut dari yang paling tidak layak pegang tempo. Kolom Omzet Berisiko adalah belanja bulanan ' +
    'yang dipertaruhkan kalau customer menolak COD, jadi keputusan mencabut diambil dengan mata ' +
    'terbuka. Isi kolom Status sendiri: sudah diberitahu, setuju, menolak, atau lepas.')
    .setBackground(UI.RED_SOFT).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(r, 44); r++;
  uiHeaderRow(sh, r, TB_HEADERS); r++;
  if (!m.cod.waves.length) {
    sh.getRange(r, 1, 1, SPAN).merge()
      .setValue('✅ Tidak ada customer yang perlu dicabut temponya.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  } else {
    const cm = m.cod.waves.map(function(w) {
      return [w.gelombang, w.customer, w.salesman, w.tierText, w.skor,
              w.maxOpenDpd == null ? '' : w.maxOpenDpd, w.arDibebaskan, w.kumulatif,
              w.omzetBerisiko, w.alasan, w.status];
    });
    sh.getRange(r, 1, cm.length, SPAN).setValues(cm).setVerticalAlignment('middle');
    sh.getRange(r, 7, cm.length, 3).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 5, cm.length, 2).setHorizontalAlignment('center');
    sh.getRange(r, 10, cm.length, 1).setWrap(true);
    sh.getRange(r, TB_COL_YEL, cm.length, 1).setBackground(UI.AMBER_BODY);
    sh.getRange(r, 1, cm.length, SPAN)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    r += cm.length;
  }

  // Peringatan jujur: kalau cabut tempo saja tidak cukup, katakan.
  const kurang = m.harusTurun - m.cod.totalDibebaskan;
  _mblock(sh, r, 1, SPAN, kurang > 0
    ? '⚠️ Mencabut tempo SELURUH customer di daftar ini membebaskan ' + rupiah(m.cod.totalDibebaskan) +
      ', masih kurang ' + rupiah(kurang) + ' dari yang harus turun. Customer berstatus 🟢 GAS ' +
      'sengaja TIDAK dimasukkan ke daftar ini: mengorbankan pelanggan terbaik demi mengejar target ' +
      'akan merusak bisnis yang sedang diselamatkan. Sisanya harus datang dari penagihan, dari ' +
      'menaikkan harga, atau dari tagihan lama yang memang perlu diakui tidak tertagih.'
    : '✅ Daftar ini membebaskan ' + rupiah(m.cod.totalDibebaskan) +
      ', cukup untuk menutup kebutuhan penurunan ' + rupiah(m.harusTurun) + '.')
    .setBackground(kurang > 0 ? UI.T_AMBER : UI.T_GREEN).setWrap(true);
  sh.setRowHeight(r, 34); r += 2;

  // ── TARIK DULU BULAN INI ──
  r = uiSection(sh, r, SPAN, '💰 TARIK DULU BULAN INI', UI.GREEN);
  uiHeaderRow(sh, r, TB_TAGIH_HEADERS.concat(['', ''])); r++;
  if (!m.tagih.length) {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Tidak ada tunggakan yang lewat jatuh tempo.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  } else {
    const tm = m.tagih.map(function(t, i) {
      return [i + 1, t.customer, t.salesman, t.noTlp, t.outstanding, t.maxOpenDpd,
              t.skor, t.peluang, t.kumulatif, '', ''];
    });
    sh.getRange(r, 1, tm.length, SPAN).setValues(tm).setVerticalAlignment('middle');
    sh.getRange(r, 5, tm.length, 1).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 9, tm.length, 1).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, 8, tm.length, 1).setNumberFormat('0%').setHorizontalAlignment('center');
    sh.getRange(r, 1, tm.length, 1).setHorizontalAlignment('center');
    sh.getRange(r, 6, tm.length, 2).setHorizontalAlignment('center');
    sh.getRange(r, 1, tm.length, TB_TAGIH_HEADERS.length)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    r += tm.length;
  }
  r++;

  uiFootnote(sh, r, SPAN,
    '◆ Peluang Cair diperkirakan dari skor bayar customer, dipakai untuk mengurutkan usaha ' +
    'penagihan: tagihan besar milik customer yang biasanya membayar didahulukan daripada tagihan ' +
    'besar milik customer yang tidak pernah membayar. Daftar ini melengkapi 🗺️ Rute Penagihan dan ' +
    '✉️ Pesan Penagihan, bukan menggantikannya. Kolom Status pada gelombang cabut tempo diisi ' +
    'tangan dan tidak akan tertimpa sync.');

  [110, 220, 130, 150, 95, 120, 140, 140, 150, 320, 160].forEach(function(px, i) {
    sh.setColumnWidth(i + 1, px);
  });
  sh.setFrozenRows(2);
  return sh;
}
