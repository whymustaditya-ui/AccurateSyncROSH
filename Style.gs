/**
 * ROSH × Accurate — shared UI layer.
 *
 * Visual system used across the human-facing tabs (Cara Baca, Pool A/B, KPI/THP
 * Dashboard, Summary) so the daily 5am sync regenerates a consistent, narrative,
 * colour-coded look instead of a plain grid. Pure presentation — no business math.
 *
 * Palette + helpers live here; the writers (writePoolTab, writeThpAdeTab,
 * writeSummaryTab) and writeCaraBacaTab() call into them.
 */

// ── Palette ──────────────────────────────────────────────────────────────────
var UI = {
  INK:   '#1f2937',  WHITE: '#ffffff',
  RED:   '#a23e2a',  RED_SOFT:   '#fbeae7',   // Pool A / definisi
  BLUE:  '#2f4bd6',  BLUE_SOFT:  '#e8edfb',   // Pool B / KPI per fase
  GREEN: '#2f7d4f',  GREEN_SOFT: '#e7f4ec',   // dokumentasi / on-track
  GOLD:  '#d9a21b',                            // color-coding band
  AMBER: '#b45309',  AMBER_BODY: '#fffbeb',   // 🟡 human columns
  BAND:  '#f3f4f6',  NOTE: '#6b7280',  BORDER: '#d1d5db',
  T_GREEN: '#dcfce7', T_RED: '#fee2e2', T_AMBER: '#fef3c7', T_GREY: '#e5e7eb'
};

// Get-or-create a sheet and wipe it (content + formats + conditional rules).
function uiSheet(name) {
  const ss = _ss();
  name = _tabName(name);            // file role bisa punya nama tampilan sendiri (TAB_ALIAS)
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  if (sh.clearConditionalFormatRules) sh.clearConditionalFormatRules();
  return sh;
}

// Full-width banner: bold title + optional italic subtitle. Returns next free row.
function uiBanner(sh, row, span, title, subtitle, color, softColor) {
  sh.getRange(row, 1, 1, span).merge()
    .setValue(title).setBackground(color).setFontColor(UI.WHITE)
    .setFontWeight('bold').setFontSize(13)
    .setVerticalAlignment('middle').setHorizontalAlignment('left');
  sh.setRowHeight(row, 36);
  let next = row + 1;
  if (subtitle) {
    sh.getRange(next, 1, 1, span).merge()
      .setValue(subtitle).setBackground(softColor || UI.BAND).setFontColor(UI.NOTE)
      .setFontStyle('italic').setFontSize(10).setVerticalAlignment('middle');
    sh.setRowHeight(next, 24);
    next += 1;
  }
  return next;
}

// Colored section band across the row. Returns the row after the band.
function uiSection(sh, row, span, label, color) {
  sh.getRange(row, 1, 1, span).merge()
    .setValue(label).setBackground(color || UI.INK).setFontColor(UI.WHITE)
    .setFontWeight('bold').setFontSize(11).setVerticalAlignment('middle');
  sh.setRowHeight(row, 28);
  return row + 1;
}

// Dark column-header row.
function uiHeaderRow(sh, row, headers) {
  sh.getRange(row, 1, 1, headers.length).setValues([headers])
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(row, 32);
}

// Italic grey footnote across the row.
function uiFootnote(sh, row, span, text) {
  sh.getRange(row, 1, 1, span).merge()
    .setValue(text).setFontColor(UI.NOTE).setFontStyle('italic').setFontSize(9)
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(row, 30);
  return row + 1;
}

// Colour a status-bearing cell by its leading glyph / keyword.
function uiTintStatus(range, value) {
  const v = String(value || '');
  if (/^✅/.test(v) || /Lunas/i.test(v))                 range.setBackground(UI.T_GREEN);
  else if (/^⏳/.test(v) || /Partial|Berjalan/i.test(v)) range.setBackground(UI.T_AMBER);
  else if (/^❌/.test(v) || /Open|tutup|Belum/i.test(v)) range.setBackground(UI.T_RED);
  else if (/Bad Debt/i.test(v))                          range.setBackground(UI.T_GREY);
}

// ─────────────────────────────────────────────────────────────────────────────
// CARA BACA — onboarding / how-to-read guide (static content, rebuilt each sync)
// ─────────────────────────────────────────────────────────────────────────────
function writeCaraBacaTab() {
  const sh = uiSheet(CONFIG.TABS.CARA_BACA);
  const SPAN = 3;
  const me = CONFIG.AR_OFFICER_NAME;
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    'ROSH Distribution — AR Tracker: ' + me,
    'Panduan baca tracker piutang ROSH — Pool A (stuck AR) & Pool B (ongoing AR). ' +
    'Data 🔴 otomatis dari Accurate tiap jam 5 pagi; kolom 🟡 diisi ' + me + '.',
    UI.RED, UI.RED_SOFT);
  r += 1;

  // Each block: { band, color, header? , rows:[[c1,c2,c3, (optional c1bg)]] }
  const blocks = [
    { band: 'STRUKTUR TAB', color: UI.INK,
      header: ['Tab', 'Isi', ''],
      rows: [
        [CONFIG.TABS.CARA_BACA, 'Dokumen ini — panduan penggunaan tracker', ''],
        [CONFIG.TABS.SUMMARY, 'Ringkasan semua tab + kesehatan bisnis (AR aging, DSO, collection, tren harian) dalam satu layar', 'Pantau strategis'],
        [CONFIG.TABS.TODO, 'To-do harian: penagihan jatuh tempo (H-1→H+3) & follow-up customer pasif', 'Aksi hari ini'],
        [CONFIG.TABS.PESAN, 'Pesan WA penagihan siap kirim, 1 pesan/pelanggan (gabung faktur H-1→H+14)', 'Copy / tap Kirim WA'],
        [CONFIG.TABS.STOP_SUPPLY, 'Customer lewat jatuh tempo belum bayar — Nathan tahan order baru sampai lunas', 'HOLD order'],
        [CONFIG.TABS.CUSTOMER, 'Rapor per customer: layak dikasih order baru atau tidak, saran limit kredit & tempo, margin bersih setelah biaya modal', 'Gate order baru'],
        [CONFIG.TABS.TURUN_BUKU, 'Program menurunkan piutang berjalan ke target: jalur bulanan, NPL, gelombang cabut tempo, siapa ditagih dulu', 'Kemudi bulanan'],
        [CONFIG.TABS.POOL_A, 'Stuck AR — backlog lama, frozen per hari onboard', 'Burn-down ke Rp0'],
        [CONFIG.TABS.POOL_B, 'Ongoing AR — invoice baru yang lewat ke ' + me + ' (H+15)', 'Terus bertambah'],
        [CONFIG.TABS.RUTE, 'Daftar jalan penagihan: piutang terbuka per zona, diurut prioritas + rute terdekat', 'Isi Zona & Pin Maps'],
        [CONFIG.TABS.INVOICE_SALES, 'Piutang yang masih di tangan Sales (pre-handover)', 'H+0–H+14'],
        [CONFIG.TABS.THP_ADE, 'Komisi, bonus, & take-home pay ' + me + ' bulan ini', ''],
        [CONFIG.TABS.THP_SALES, 'KPI & take-home pay Sales (Deden & Dian)', ''],
        [CONFIG.TABS.THP_HISTORY, 'Arsip THP & performa Sales / AR per bulan (riwayat + tren)', 'Master-only']
      ] },
    { band: 'POOL A vs POOL B — DEFINISI', color: UI.RED,
      header: ['Konsep', 'Penjelasan', 'Catatan'],
      rows: [
        ['Pool A — Stuck AR', 'Semua invoice overdue SEBELUM ' + me + ' onboard. Snapshot frozen di hari pertama.', 'Tidak bertambah. Berkurang hanya saat customer bayar.'],
        ['Pool B — Ongoing AR', 'Invoice yang jatuh tempo & handover H+15 SETELAH onboard.', 'Sales handle H+0–H+14. ' + me + ' ambil alih dari H+15.'],
        ['Tgl Handover (H+15)', 'Tgl Jatuh Tempo + 15 hari. Titik invoice resmi jadi tanggungan ' + me + '.', 'Jam komisi mulai berdetak dari sini.'],
        ['Aging saat Collect', 'Selisih hari Tgl Handover → Tgl Bayar. Penentu bucket komisi.', 'Dikunci di pembayaran pertama (partial = bucket tetap).']
      ] },
    { band: 'RUTE PENAGIHAN — DAFTAR JALAN', color: UI.GREEN,
      header: ['Konsep', 'Penjelasan', 'Catatan'],
      rows: [
        ['Sumber', 'Semua piutang terbuka ' + me + ' (Pool A + Pool B), digabung per CUSTOMER.', '1 customer = 1 titik kunjungan'],
        ['Zona (auto)', 'Kecamatan dibaca dari teks alamat (kata "Kecamatan"), fallback geocode. Read-only — dipakai kalau Zona kosong.', 'Bisa meleset → koreksi di kolom Zona'],
        ['Zona / Kecamatan', 'Diisi ' + me + ' (kolom 🟡) bila tebakan auto salah/kosong. Input ' + me + ' menang.', 'Nempel terus antar-sync'],
        ['Pin Maps', 'Tempel link Google Maps (share → copy link), termasuk maps.app.goo.gl.', 'Presisi; kalau kosong pakai koordinat geocode'],
        ['Prioritas zona', 'total Outstanding × (1 + umur tertua × ' + CONFIG.ROUTE.AGING_WEIGHT + '). Banyak tunggakan kecil tapi tua tetap naik.', 'Lihat panel "Prioritas Zona"'],
        ['Urutan titik', 'Dalam zona, diurut nearest-neighbour dari pin (mulai tagihan terbesar).', 'Tinggal ikut Urutan 1→bawah'],
        ['Belum dizonakan', 'Customer tanpa Zona dikumpulkan paling bawah — sinyal buat diisi.', 'Tidak ikut ranking sampai diisi']
      ] },
    { band: 'SKEMA KOMISI', color: UI.INK,
      header: ['Bucket (hari sejak handover)', 'Rate × masuk kas', 'Setara overdue'],
      rows: [
        ['0–30 hari', '1.5%', '15–45 hari lewat JT'],
        ['31–75 hari', '2.5%', '46–90 hari lewat JT'],
        ['>75 hari', '3.5%', '91+ hari lewat JT'],
        ['Partial payment', 'Komisi dihitung dari jumlah yang MASUK KAS (bukan nilai penuh invoice)', 'Bucket dikunci di bayar pertama'],
        ['Clawback', 'Komisi bisa ditarik bila pembayaran di-void / retur setelah dibayar', 'Pantau manual']
      ] },
    { band: 'BONUS PROBATION — POOL A SAJA', color: UI.BLUE,
      header: ['Bonus', 'Target', 'Reward'],
      rows: [
        ['Sprint', '≥ ' + rupiah(CONFIG.AR_SPRINT_TARGET) + ' dalam ' + CONFIG.AR_SPRINT_WINDOW_DAYS + ' hari sejak onboard', rupiah(CONFIG.AR_SPRINT_BONUS)],
        ['Milestone', '≥ ' + rupiah(CONFIG.AR_MILESTONE_TARGET) + ' dalam 3 bulan (kumulatif)', rupiah(CONFIG.AR_MILESTONE_BONUS)],
        ['Cleanup', 'Sisa Pool A < ' + rupiah(CONFIG.AR_CLEANUP_CEILING) + ' di akhir bulan ke-3', rupiah(CONFIG.AR_CLEANUP_BONUS)]
      ] },
    { band: 'STANDAR DOKUMENTASI FOLLOW-UP', color: UI.GREEN,
      header: ['Aturan', 'Detail', 'Catatan'],
      rows: [
        ['Frekuensi minimal', '1 entri per customer per minggu', 'Wajib agar penalty tidak diterapkan'],
        ['Isi entri', 'Tanggal + Channel (WA/Telp/Visit) + Hasil Negosiasi', 'kolom 🟡'],
        ['Penalty aging naik bucket', '31–75 hr: ' + rupiah(CONFIG.AR_PENALTY_REG_TO_AGING1) + ' · >75 hr: ' + rupiah(CONFIG.AR_PENALTY_AGING1_TO_AGING2) + ' / invoice', 'Auto-flag; gugur bila ada follow-up terdokumentasi'],
        ['Akses', me + ': edit kolom 🟡 saja · Owner: full', 'Kolom 🔴 dikunci otomatis oleh script']
      ] },
    { band: 'KLASIFIKASI CUSTOMER (TIER) — ' + CONFIG.CUST_TIER.WINDOW_MONTHS + ' bulan terakhir', color: UI.GOLD,
      header: ['Tier', 'Kriteria (jumlah invoice)', 'Maksud'],
      rows: [
        ['A', '≥ ' + CONFIG.CUST_TIER.A_MIN + '×', 'Paling loyal — tagih paling lembut, jaga hubungan', UI.T_GREEN],
        ['B', CONFIG.CUST_TIER.B_MIN + '–' + (CONFIG.CUST_TIER.A_MIN - 1) + '×', 'Loyal — pendekatan halus', UI.BLUE_SOFT],
        ['C', CONFIG.CUST_TIER.C_MIN + '–' + (CONFIG.CUST_TIER.B_MIN - 1) + '×', 'Sedang', UI.T_AMBER],
        ['D', '1×', 'Baru / jarang — boleh lebih tegas', UI.T_GREY],
        ['(kosong)', '0× dalam ' + CONFIG.CUST_TIER.WINDOW_MONTHS + ' bln', 'Tidak aktif di window ini'],
        ['Format kolom', 'Huruf · jumlah transaksi · nilai (mis. "B · 7× · Rp45.000.000")', 'Info saja — tidak mengubah komisi/penalty']
      ] },
    { band: 'TAKE-HOME PAY', color: UI.INK,
      header: ['Komponen', 'Nilai', 'Catatan'],
      rows: [
        ['Gaji Pokok', rupiah(CONFIG.AR_BASE), 'Fixed sejak hari 1'],
        ['Tunjangan Operasional', rupiah(CONFIG.AR_TUNJANGAN_OPS), 'Bensin / pulsa / makan'],
        ['Komisi', 'Variabel', 'Atas masuk kas, sesuai bucket'],
        ['THP Floor', rupiah(CONFIG.AR_BASE + CONFIG.AR_TUNJANGAN_OPS), 'Sebelum komisi & bonus']
      ] },
    { band: 'COLOR CODING STATUS', color: UI.GOLD,
      header: ['Status', 'Arti', ''],
      rows: [
        ['🟢 Lunas', 'Invoice dibayar penuh. Komisi sudah dihitung.', '', UI.T_GREEN],
        ['🟡 Partial', 'Customer bayar sebagian. Outstanding masih ada. Komisi dari yang masuk.', '', UI.T_AMBER],
        ['🔴 Open', 'Belum ada pembayaran sama sekali.', '', UI.T_RED],
        ['🟡 Kolom kuning', 'Input ' + me + ': Channel, Hasil Negosiasi, Tgl Follow-up, Bukti Transfer', '', UI.AMBER_BODY],
        ['🔴 Kolom merah/abu', 'Otomatis dari script — jangan diedit', '', UI.T_GREY]
      ] }
  ];

  blocks.forEach(function(bl) {
    r = uiSection(sh, r, SPAN, bl.band, bl.color);
    if (bl.header) { uiHeaderRow(sh, r, bl.header); r += 1; }
    bl.rows.forEach(function(row) {
      sh.getRange(r, 1, 1, SPAN).setValues([[row[0], row[1], row[2]]]).setVerticalAlignment('top');
      sh.getRange(r, 1).setFontWeight('bold');
      if (row[3]) sh.getRange(r, 1).setBackground(row[3]);
      sh.getRange(r, 3).setFontColor(UI.NOTE).setFontStyle('italic');
      sh.setRowHeight(r, 30);
      r += 1;
    });
    r += 1; // gap between blocks
  });

  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 470);
  sh.setColumnWidth(3, 300);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), SPAN).setWrap(true);
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB ORDER — arrange tabs left→right for the three audiences.
// ─────────────────────────────────────────────────────────────────────────────
function orderTabs() {
  const ss = _ss();
  const order = [
    CONFIG.TABS.CARA_BACA, CONFIG.TABS.SUMMARY, CONFIG.TABS.RESTOCK, CONFIG.TABS.TODO,
    CONFIG.TABS.PESAN, CONFIG.TABS.STOP_SUPPLY, CONFIG.TABS.CUSTOMER, CONFIG.TABS.TURUN_BUKU,
    CONFIG.TABS.POOL_A, CONFIG.TABS.POOL_B, CONFIG.TABS.RUTE,
    CONFIG.TABS.INVOICE_SALES, CONFIG.TABS.COLLECTED, CONFIG.TABS.TAGIHAN_LAIN, CONFIG.TABS.KONTAK,
    CONFIG.TABS.THP_ADE, CONFIG.TABS.THP_SALES, CONFIG.TABS.THP_HISTORY, CONFIG.TABS.LOG
  ];
  // Position counts only the tabs THIS file actually has. Using the array index would
  // aim past the last sheet in a role file (Deden has ~4 tabs, the array has 16) and
  // moveActiveSheet() throws "Invalid argument". Identical result on master, where
  // every tab exists. Keeps orderTabs() safe to call on any target file.
  let pos = 0;
  order.forEach(function(name) {
    const sh = ss.getSheetByName(_tabName(name));
    if (!sh) return;
    pos++;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos);
  });
}
