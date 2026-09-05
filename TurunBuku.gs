/**
 * ROSH × Accurate — 📉 Turun Buku Piutang.
 *
 * Kemudi program: turunkan outstanding ke CONFIG.TURUN_BUKU.TARGET_AR dalam MONTHS bulan.
 * Makin besar buku piutang, makin besar bagian yang akhirnya jadi NPL.
 *
 * Dua bagian:
 *   1. JALUR TURUN: garis lurus dari buku awal ke target, realisasi per bulan dari
 *      _MetricSnapshots (Health.gs) yang sudah menyimpan totalAR + bucket umur harian sejak
 *      lama, jadi grafik penurunan dan tren NPL bisa ditarik MUNDUR. Itu juga alasan NPL_DAYS
 *      dipatok 60: bucket 61-90 dan 90+ sudah ada.
 *   2. KONVERSI KE TEMPO 14 (Panduan Sales v1.0 bagian 9, berlaku 1 Okt 2026): customer lama
 *      yang masih pegang tempo disegmen Hijau / Kuning / Merah dari rata-rata telatnya, tiap
 *      segmen punya tawaran dan minggu kunjungan sendiri. Sales mencatat pilihan customer di
 *      dua kolom 🟡. Ini pengganti "gelombang cabut tempo" versi lama (2026-09-05): konsepnya
 *      sama (siapa dulu, tawarkan apa), tapi memakai bahasa dan segmen yang sudah ada di SOP.
 *
 * Proyeksi murni: nol call Accurate, nol scope. MASTER-ONLY.
 * Depends: Customer.gs (report), Health.gs (_snapshotSheet, SNAP_HEADERS), Style.gs, Kpi.gs,
 * Restock.gs (_mblock).
 */

var TB_HEADERS = [
  'Segmen', 'Customer', 'Sales', 'Loyalitas (4bln)', 'Rata2 Telat (hari)', 'Nunggak',
  'Belanja / bln', 'Tawaran', 'Minggu Kunjungan', 'Status Konversi', 'Catatan'
];
var TB_SPAN     = TB_HEADERS.length;   // 11
var TB_COL      = {};
TB_HEADERS.forEach(function(h, i) { TB_COL[h] = i + 1; });
var TB_COL_YEL1 = TB_COL['Status Konversi'];   // 🟡 diisi sales/Nathan
var TB_COL_YEL2 = TB_COL['Catatan'];           // 🟡

// Segmen konversi (SOP bagian 9). Ambang hari = rata-rata telat tertimbang.
var TB_SEGMEN = {
  HIJAU:  { label: '🟢 Hijau',  maxTelat: 3,  minggu: 'Minggu 1-2',
            tawaran: 'Opsi B tempo 14 (atau A kalau mau). Tanda tangan SKK baru.' },
  KUNING: { label: '🟡 Kuning', maxTelat: 14, minggu: 'Minggu 2-3',
            tawaran: 'Lunasi tunggakan dulu, lalu Opsi A atau B.' },
  MERAH:  { label: '🔴 Merah',  maxTelat: Infinity, minggu: 'Minggu 3-4',
            tawaran: 'Hanya Opsi A (bayar dulu) setelah tunggakan lunas. Tidak ada tempo. Kalau menolak, biarkan.' }
};

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

// ─────────────────────────────────────────────────────────────────────────────
// KONVERSI — customer lama yang masih pegang tempo, disegmen dari rata-rata telat.
// Kandidat: pernah diberi tempo (tempoModus > COD_TEMPO_MAX), bukan dorman/tunai. Customer
// tanpa riwayat bayar tapi punya faktur terbuka dinilai dari umur faktur terbukanya.
// ─────────────────────────────────────────────────────────────────────────────
function _konversiSegmen(r) {
  if (r.verdict === '🔴 STOP-COD') return 'MERAH';
  let telat = r.wadl;
  if (telat == null) telat = (r.maxOpenDpd != null && r.maxOpenDpd > 0) ? r.maxOpenDpd : null;
  if (telat == null) return 'KUNING';                  // data tipis → jangan langsung Hijau
  if (r.maxOpenDpd != null && r.maxOpenDpd > 14) return 'MERAH';
  if (telat <= TB_SEGMEN.HIJAU.maxTelat)  return 'HIJAU';
  if (telat <= TB_SEGMEN.KUNING.maxTelat) return 'KUNING';
  return 'MERAH';
}

function _konversiList(raporList) {
  const ORDER = { HIJAU: 1, KUNING: 2, MERAH: 3 };
  return raporList.filter(function(r) {
    if (r.isCod || r.isDormant) return false;
    if (r.verdict === '💵 TUNAI' || r.verdict === '😴 DORMAN' || r.verdict === '🆕 BARU') return false;
    return r.tempoModus != null && r.tempoModus > CONFIG.CUSTOMER.COD_TEMPO_MAX;
  }).map(function(r) {
    const seg = _konversiSegmen(r);
    const S = TB_SEGMEN[seg];
    return { seg: seg, label: S.label, customer: r.customer, salesman: r.salesman, tierText: r.tierText,
             wadl: r.wadl, outstanding: r.outstanding, belanjaBulanan: r.belanjaBulanan,
             tawaran: S.tawaran, minggu: S.minggu, status: r.tbStatus || '', catatan: r.tbCatatan || '' };
  }).sort(function(a, b) {
    if (ORDER[a.seg] !== ORDER[b.seg]) return ORDER[a.seg] - ORDER[b.seg];
    return b.belanjaBulanan - a.belanjaBulanan;      // dalam segmen: yang paling berarti dulu
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildTurunBuku(rapor, health, today, yMap) {
  const T = CONFIG.TURUN_BUKU;
  const list = rapor.list.map(function(r) {
    const y = (yMap && yMap[r.customer]) || {};
    r.tbStatus = y.status || '';
    r.tbCatatan = y.catatan || '';
    return r;
  });

  const arNow = (health && health.totalAR != null) ? health.totalAR : rapor.totals.arBook;
  const glide = _glidePath(arNow, today);
  const konversi = _konversiList(list);

  const idx = _tbMonthIndex(glide.startKey, _tbMonthKey(today));
  const targetBulanIni = (idx >= 0 && idx < glide.rows.length) ? glide.rows[idx].target : T.TARGET_AR;

  return {
    arNow: arNow, target: T.TARGET_AR, targetBulanIni: targetBulanIni,
    tempoCount: rapor.totals.tempoCount, cadangan: rapor.totals.cadangan,
    glide: glide, konversi: konversi, health: health
  };
}

// 🟡 Status Konversi + Catatan — dikumpulkan SEBELUM tab dibersihkan. Kunci = nama customer.
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
        const nama = String(row[TB_COL['Customer'] - 1] || '').trim();
        if (!nama || nama === 'Customer') return;
        const st = row[TB_COL_YEL1 - 1], ct = row[TB_COL_YEL2 - 1];
        if ((st === '' || st == null) && (ct === '' || ct == null)) return;
        map[nama] = { status: st || '', catatan: ct || '' };
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
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  const SPAN = TB_SPAN;
  const C = TB_COL;
  const T = CONFIG.TURUN_BUKU;

  let r = uiBanner(sh, 1, SPAN, '📉 Turun Buku Piutang — target ' + rupiah(T.TARGET_AR),
    'Menurunkan piutang berjalan ke ' + rupiah(T.TARGET_AR) + ' dalam ' + T.MONTHS + ' bulan. Jalur bulanan di atas, ' +
    'daftar konversi customer lama ke tempo ' + CONFIG.CUSTOMER.TEMPO_MAX + ' hari di bawah (segmen Hijau / Kuning / Merah, ' +
    'Panduan Sales bagian 9). Realisasi dari catatan harian. Dibuat ulang tiap jam 5 pagi.',
    UI.RED, UI.RED_SOFT);

  // ── POSISI HARI INI ──
  r = uiSection(sh, r, SPAN, 'POSISI HARI INI', UI.INK);
  const nplRp = (m.health && m.health.aging) ? (m.health.aging.d61_90.out + m.health.aging.d90plus.out) : 0;
  const nplPct = m.arNow > 0 ? nplRp / m.arNow : 0;
  const selisih = m.arNow - m.targetBulanIni;
  const pos = [
    ['Buku sekarang', m.arNow, 'Total piutang berjalan · target akhir program ' + rupiah(T.TARGET_AR)],
    ['Target bulan ini', m.targetBulanIni,
      selisih > 0 ? '⚠ tertinggal ' + rupiah(selisih) + ' dari jalur' : '✅ sesuai jalur'],
    ['Customer pegang tempo', m.tempoCount + ' customer', 'Angka inilah yang harus turun, bukan cuma rupiahnya'],
    ['NPL lewat ' + T.NPL_DAYS + ' hari', nplRp, (nplPct * 100).toFixed(1) + '% dari buku · yang biasanya paling sulit cair'],
    ['Potensi gagal bayar', m.cadangan, 'Perkiraan bagian buku yang berpotensi tidak tertagih, dari umur tunggakannya']
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
  uiHeaderRow(sh, r, ['Bulan', 'Target buku', 'Realisasi', 'Selisih', 'Status', 'NPL ' + T.NPL_DAYS + '+ hari']);
  r++;
  const gm = m.glide.rows.map(function(g) {
    let status;
    if (g.realisasi == null) status = '⏳ belum berjalan';
    else if (g.realisasi <= g.target) status = '✅ sesuai jalur';
    else status = '⚠️ tertinggal ' + rupiah(g.realisasi - g.target);
    return [g.label, g.target, g.realisasi == null ? '' : g.realisasi,
            g.realisasi == null ? '' : (g.realisasi - g.target), status, g.npl == null ? '' : g.npl];
  });
  sh.getRange(r, 1, gm.length, 6).setValues(gm).setVerticalAlignment('middle');
  sh.getRange(r, 2, gm.length, 3).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, 6, gm.length, 1).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, 1, gm.length, 6)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  r += gm.length;

  const seriesAr = m.glide.rows.filter(function(g) { return g.realisasi != null; }).map(function(g) { return g.realisasi; });
  if (seriesAr.length >= 2) {
    _mblock(sh, r, 1, 3, 'Tren buku (per bulan)').setFontWeight('bold');
    sh.getRange(r, 4).setFormula('=SPARKLINE({' + seriesAr.join(';') + '},{"charttype","line";"color","#a23e2a"})');
    _mblock(sh, r, 6, SPAN, 'Turun berarti program jalan. Naik berarti order baru masih keluar ke customer yang belum bayar.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  }
  r++;

  // ── KONVERSI KE TEMPO 14 ──
  const k = m.konversi;
  const nSeg = { HIJAU: 0, KUNING: 0, MERAH: 0 };
  k.forEach(function(x) { nSeg[x.seg]++; });
  r = uiSection(sh, r, SPAN, '🔁 KONVERSI KE TEMPO ' + CONFIG.CUSTOMER.TEMPO_MAX + ' HARI  ·  ' + k.length + ' customer  ·  ' +
    '🟢 ' + nSeg.HIJAU + '  🟡 ' + nSeg.KUNING + '  🔴 ' + nSeg.MERAH, UI.RED);
  sh.getRange(r, 1, 1, SPAN).merge().setValue(
    'Mulai 1 Oktober 2026 semua faktur baru bertempo ' + CONFIG.CUSTOMER.TEMPO_MAX + ' hari; faktur yang sudah terbit ikut ' +
    'tempo lama sampai lunas. Kunjungi urut segmen: Hijau minggu 1-2, Kuning minggu 2-3, Merah minggu 3-4. Tawaran ' +
    'pelunasan tunggakan berlaku semua segmen: lunas dalam 14 hari sejak pengumuman potongan 3%, 15-30 hari 1,5%, ' +
    'lewat 30 hari 0% dan status TIDAK. Isi Status Konversi (mis. Setuju B / Setuju A / Menolak / SKK ttd) dan Catatan.')
    .setBackground(UI.RED_SOFT).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(r, 58); r++;
  uiHeaderRow(sh, r, TB_HEADERS); r++;
  if (!k.length) {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Tidak ada customer yang masih memegang tempo lama.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  } else {
    const km = k.map(function(x) {
      return [x.label, x.customer, x.salesman, x.tierText, x.wadl == null ? '' : Math.round(x.wadl),
              x.outstanding, x.belanjaBulanan, x.tawaran, x.minggu, x.status, x.catatan];
    });
    const first = r, n = km.length;
    sh.getRange(r, 1, n, SPAN).setValues(km).setVerticalAlignment('middle');
    sh.getRange(r, C['Nunggak'], n, 2).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, C['Rata2 Telat (hari)'], n, 1).setHorizontalAlignment('center');
    sh.getRange(r, C['Minggu Kunjungan'], n, 1).setHorizontalAlignment('center');
    sh.getRange(r, C['Tawaran'], n, 1).setWrap(true);
    sh.getRange(r, TB_COL_YEL1, n, 2).setBackground(UI.AMBER_BODY);
    sh.getRange(r, 1, n, SPAN).setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    const seg = sh.getRange(first, C['Segmen'], n, 1), tier = sh.getRange(first, C['Loyalitas (4bln)'], n, 1);
    const R = SpreadsheetApp.newConditionalFormatRule;
    sh.setConditionalFormatRules([
      R().whenTextStartsWith('🟢').setBackground(UI.T_GREEN).setRanges([seg]).build(),
      R().whenTextStartsWith('🟡').setBackground(UI.T_AMBER).setRanges([seg]).build(),
      R().whenTextStartsWith('🔴').setBackground(UI.T_RED).setRanges([seg]).build(),
      R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tier]).build(),
      R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tier]).build(),
      R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tier]).build(),
      R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tier]).build()
    ]);
    r += n;
    sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
    sh.getRange(r, 1).setValue('TOTAL — ' + n + ' customer');
    sh.getRange(r, C['Nunggak']).setValue(k.reduce(function(s, x) { return s + x.outstanding; }, 0)).setNumberFormat('"Rp"#,##0');
    sh.getRange(r, C['Belanja / bln']).setValue(k.reduce(function(s, x) { return s + x.belanjaBulanan; }, 0)).setNumberFormat('"Rp"#,##0');
    r++;
  }
  r++;

  uiFootnote(sh, r, SPAN,
    '◆ Segmen dari rata-rata telat saat bayar (Hijau ≤' + TB_SEGMEN.HIJAU.maxTelat + ' hari · Kuning ≤' + TB_SEGMEN.KUNING.maxTelat +
    ' · Merah di atasnya, atau ada faktur terbuka >14 hari, atau vonis STOP-COD). Customer yang selama ini tunai, baru, ' +
    'atau dorman tidak perlu dikonversi dan tidak ada di daftar. Status Konversi dan Catatan diisi tangan dan tidak tertimpa sync. ' +
    'Dua siklus pertama setelah 1 Oktober tidak ada override.');

  const widths = { 'Segmen': 100, 'Customer': 220, 'Sales': 110, 'Loyalitas (4bln)': 170, 'Rata2 Telat (hari)': 95,
                   'Nunggak': 130, 'Belanja / bln': 130, 'Tawaran': 330, 'Minggu Kunjungan': 120,
                   'Status Konversi': 150, 'Catatan': 220 };
  TB_HEADERS.forEach(function(h, i) { sh.setColumnWidth(i + 1, widths[h] || 110); });
  return sh;
}
