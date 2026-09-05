/**
 * ROSH × Accurate — 📌 To-Do Harian.
 *
 * Satu daftar kerja per hari: siapa yang harus di-WA, dengan pesannya sudah terisi.
 *   🔔 TAGIH HARI INI  = isi ✉️ Pesan Penagihan lama (buildPenagihanBatch, window H-3 → H+14,
 *                        1 pesan per customer menggabungkan fakturnya).
 *   📞 SAPA LAGI       = customer yang lama tidak order (buildFollowUpReminders), dengan pesan
 *                        sales yang ringan (_sapaMessage). Customer yang sedang ditagih atau
 *                        punya faktur lewat jatuh tempo TIDAK disapa jualan (SOP: selesaikan
 *                        tagihannya dulu), dan daftarnya dipotong CONFIG.TODO_SAPA_MAX supaya
 *                        tetap daftar kerja, bukan dump.
 *
 * Menggantikan dua tab (2026-09-05): ✉️ Pesan Penagihan dan 📞 Reaktivasi Customer. Semua teks
 * customer-facing tetap di Pesan.gs (_penagihanMessageBatch, _sapaMessage) supaya satu tempat.
 *
 * Ditulis di master (semua customer, kolom Sales) dan file Deden (input di-scope _bySalesman,
 * alias tab 📌 To-Do Kamu, tanpa kolom Sales). Proyeksi murni: nol call Accurate, nol scope.
 * Depends: Pesan.gs, Sync.gs (buildFollowUpReminders, fmtDate), Style.gs, Kpi.gs (rupiah),
 * Restock.gs (_mblock).
 */

var TODO_TIER_RANK = { A: 1, B: 2, C: 3, D: 4 };

// Header per seksi & role. Kolom Sales tak ada artinya di file Deden.
function _todoHeaders(section, role) {
  const h = section === 'tagih'
    ? ['Customer', 'Reminder', 'Jml Faktur', 'Total Tagihan', 'No. Telp', 'Loyalitas (4bln)', '📲 Kirim WA', 'Pesan']
    : ['Customer', 'Order Terakhir', 'Hari Diam', 'Bucket', 'No. Telp', 'Loyalitas (4bln)', '📲 Kirim WA', 'Pesan'];
  if (role !== 'deden') h.splice(1, 0, 'Sales');
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildTodo(invoices, today) {
  const tagih = buildPenagihanBatch(invoices, today);
  const inTagih = {};
  tagih.forEach(function(c) { inTagih[c.customer] = true; });

  // Customer dengan faktur lewat jatuh tempo: ditahan, jangan disapa jualan.
  const ditahan = {};
  invoices.forEach(function(i) {
    if (i.isPaid || !(i.outstanding > 0)) return;
    if (typeof i.daysPastDue === 'number' && i.daysPastDue >= CONFIG.STOP_SUPPLY_DAYS) {
      ditahan[String(i.customer || '').trim()] = true;
    }
  });

  const semua = buildFollowUpReminders(invoices, today).filter(function(c) {
    const name = String(c.customer || '').trim();
    return name && !inTagih[name] && !ditahan[name];
  });
  semua.sort(function(a, b) {
    const ra = TODO_TIER_RANK[String(a.tierText || '').charAt(0)] || 9;
    const rb = TODO_TIER_RANK[String(b.tierText || '').charAt(0)] || 9;
    if (ra !== rb) return ra - rb;                 // pelanggan bernilai dulu
    return b.daysSince - a.daysSince;              // lalu yang paling lama diam
  });
  const max = CONFIG.TODO_SAPA_MAX || 30;
  return { tagih: tagih, sapa: semua.slice(0, max), sapaTotal: semua.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER — tab 📌 To-Do Harian. Semua 🔴 generated, tidak ada kolom isian.
// ─────────────────────────────────────────────────────────────────────────────
function writeTodoTab(todo, role) {
  const sh = uiSheet(CONFIG.TABS.TODO);
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  const isDeden = (role === 'deden');
  const H1 = _todoHeaders('tagih', role), H2 = _todoHeaders('sapa', role);
  const SPAN = H1.length;
  const col = function(H) { const m = {}; H.forEach(function(h, i) { m[h] = i + 1; }); return m; };
  const C1 = col(H1), C2 = col(H2);

  // Siapkan baris + hitung yang punya nomor (siap kirim).
  const tagihRows = todo.tagih.map(function(c) {
    const phone = _waPhone(c.noTlp), msg = _penagihanMessageBatch(c);
    return { c: c, phone: phone, msg: msg };
  });
  const sapaRows = todo.sapa.map(function(c) {
    const phone = _waPhone(c.noTlp), msg = _sapaMessage(c);
    return { c: c, phone: phone, msg: msg };
  });
  const siap = tagihRows.concat(sapaRows).filter(function(x) { return !!x.phone; }).length;
  const totTagih = todo.tagih.reduce(function(s, c) { return s + c.totalOutstanding; }, 0);

  let r = uiBanner(sh, 1, SPAN,
    isDeden ? '📌 To-Do Kamu — siapa yang di-WA hari ini' : '📌 To-Do Harian — siapa yang di-WA hari ini',
    (isDeden ? 'Customer atas nama kamu. ' : '') +
    'Dua daftar: TAGIH (faktur di window H' + CONFIG.PENAGIHAN_WINDOW_MIN + ' sampai H+' + CONFIG.PENAGIHAN_WINDOW_MAX +
    ', satu pesan per customer) dan SAPA LAGI (lama tidak order, pesan jualan ringan). ' +
    'Tap 📲 Kirim WA, WhatsApp terbuka dengan pesan terisi, tinggal Send. Tidak ada yang terkirim otomatis. ' +
    'Dibuat ulang tiap jam 5 pagi.',
    UI.INK, UI.BAND);

  // ── strip ringkas ──
  const strip = [
    ['🔔 Tagih', todo.tagih.length + ' customer · ' + rupiah(totTagih)],
    ['📞 Sapa lagi', todo.sapa.length + (todo.sapaTotal > todo.sapa.length ? ' dari ' + todo.sapaTotal : '') + ' customer'],
    ['📲 Siap kirim', siap + ' pesan']
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

  const R = SpreadsheetApp.newConditionalFormatRule;
  const rules = [];
  const tierRules = function(rng) {
    rules.push(R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([rng]).build());
    rules.push(R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([rng]).build());
    rules.push(R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([rng]).build());
    rules.push(R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([rng]).build());
  };
  const styleRows = function(first, n, C) {
    // Satu baris = satu tinggi (24px). Kolom Pesan di-CLIP, bukan wrap: pesan panjang terpotong di
    // sel, isi utuh tetap ada di link Kirim WA dan di formula bar kalau di-klik. Tanpa ini tiap
    // baris melar setinggi pesannya dan daftar 50 baris jadi 3 layar (permintaan Bro 2026-09-05).
    sh.getRange(first, 1, n, SPAN).setVerticalAlignment('middle')
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(first, C['Pesan'], n, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    // setRowHeights biasa masih membiarkan baris melar mengikuti isi sel (pesan multi-baris);
    // setRowHeightsForced yang benar-benar mengunci tingginya.
    sh.setRowHeightsForced(first, n, 24);
    sh.getRange(first, C['📲 Kirim WA'], n, 1).setHorizontalAlignment('center');
    tierRules(sh.getRange(first, C['Loyalitas (4bln)'], n, 1));
  };

  // ── 🔔 TAGIH HARI INI ──
  r = uiSection(sh, r, SPAN, '🔔 TAGIH HARI INI  ·  H' + CONFIG.PENAGIHAN_WINDOW_MIN + ' → H+' + CONFIG.PENAGIHAN_WINDOW_MAX +
    '  ·  ' + todo.tagih.length + ' customer', UI.RED);
  if (!tagihRows.length) {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Tidak ada tagihan di window hari ini.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    r += 2;
  } else {
    uiHeaderRow(sh, r, H1); r++;
    const first = r, n = tagihRows.length;
    const m = tagihRows.map(function(x) {
      const c = x.c;
      const row = [c.customer, c.bucket, c.invoices.length, c.totalOutstanding, x.phone, c.tierText || '',
                   _waLinkFormula(x.phone, x.msg), x.msg];
      if (!isDeden) row.splice(1, 0, c.salesman || '(POS / online)');
      return row;
    });
    sh.getRange(first, 1, n, SPAN).setValues(m);
    styleRows(first, n, C1);
    sh.getRange(first, C1['Jml Faktur'], n, 1).setHorizontalAlignment('center');
    sh.getRange(first, C1['Total Tagihan'], n, 1).setNumberFormat('"Rp"#,##0');
    const rem = sh.getRange(first, C1['Reminder'], n, 1);
    rules.push(R().whenTextStartsWith('H-3').setBackground(UI.T_GREY).setRanges([rem]).build());
    rules.push(R().whenTextStartsWith('H0').setBackground(UI.T_AMBER).setRanges([rem]).build());
    rules.push(R().whenTextStartsWith('H+3').setBackground('#fed7aa').setRanges([rem]).build());
    rules.push(R().whenTextStartsWith('H+7').setBackground(UI.T_RED).setRanges([rem]).build());
    rules.push(R().whenTextStartsWith('H+14').setBackground('#fecaca').setRanges([rem]).build());
    r += n;
    sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
    sh.getRange(r, 1).setValue('TOTAL — ' + n + ' customer');
    sh.getRange(r, C1['Total Tagihan']).setValue(totTagih).setNumberFormat('"Rp"#,##0');
    r += 2;
  }

  // ── 📞 SAPA LAGI ──
  r = uiSection(sh, r, SPAN, '📞 SAPA LAGI  ·  lama tidak order  ·  ' + todo.sapa.length +
    (todo.sapaTotal > todo.sapa.length ? ' dari ' + todo.sapaTotal : '') + ' customer', UI.BLUE);
  if (!sapaRows.length) {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Semua customer order dalam 7 hari terakhir, atau sedang ditagih.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    r += 2;
  } else {
    uiHeaderRow(sh, r, H2); r++;
    const first = r, n = sapaRows.length;
    const m = sapaRows.map(function(x) {
      const c = x.c;
      const row = [c.customer, fmtDate(c.lastTransDate), c.daysSince, c.bucket, x.phone, c.tierText || '',
                   _waLinkFormula(x.phone, x.msg), x.msg];
      if (!isDeden) row.splice(1, 0, c.salesman || '(POS / online)');
      return row;
    });
    sh.getRange(first, 1, n, SPAN).setValues(m);
    styleRows(first, n, C2);
    sh.getRange(first, C2['Order Terakhir'], n, 1).setHorizontalAlignment('center');
    sh.getRange(first, C2['Hari Diam'], n, 1).setHorizontalAlignment('center');
    sh.getRange(first, C2['Bucket'], n, 1).setHorizontalAlignment('center');
    const days = sh.getRange(first, C2['Hari Diam'], n, 1);
    rules.push(R().whenNumberGreaterThanOrEqualTo(90).setBackground(UI.T_RED).setRanges([days]).build());
    rules.push(R().whenNumberBetween(30, 89).setBackground('#fed7aa').setRanges([days]).build());
    rules.push(R().whenNumberBetween(7, 29).setBackground(UI.T_AMBER).setRanges([days]).build());
    r += n + 1;
  }

  // Sekali untuk semua blok: setConditionalFormatRules mengganti SELURUH aturan sheet.
  if (rules.length) sh.setConditionalFormatRules(rules);

  uiFootnote(sh, r, SPAN,
    '◆ TAGIH: satu baris per customer, semua fakturnya di window digabung dalam satu pesan; Reminder ikut jadwal SOP ' +
    '(H-3 dan H0 pengingat, H+3 tindak lanjut, H+7 isyarat halus order berikutnya menunggu pelunasan, H+14 terakhir sebelum handover). ' +
    'SAPA LAGI: customer yang sedang ditagih atau punya faktur lewat jatuh tempo TIDAK ada di sini, selesaikan tagihannya dulu; ' +
    'daftar dibatasi ' + (CONFIG.TODO_SAPA_MAX || 30) + ' customer per hari, pelanggan A/B didahulukan. ' +
    'Baris tanpa No. Telp (POS/online) tidak punya link Kirim WA. Kolom Pesan sengaja dipotong supaya baris tetap pendek; ' +
    'klik selnya untuk melihat teks utuh di formula bar, atau copy dari sana kalau mau diedit dulu.');

  const widths = { 'Customer': 200, 'Sales': 110, 'Reminder': 150, 'Jml Faktur': 80, 'Total Tagihan': 130,
                   'Order Terakhir': 105, 'Hari Diam': 80, 'Bucket': 80, 'No. Telp': 125,
                   'Loyalitas (4bln)': 180, '📲 Kirim WA': 105, 'Pesan': 540 };
  H1.forEach(function(h, i) { sh.setColumnWidth(i + 1, Math.max(widths[h] || 110, widths[H2[i]] || 110)); });
  return sh;
}
