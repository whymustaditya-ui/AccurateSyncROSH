/**
 * ROSH × Accurate — Business Health dashboard + daily trend snapshots.
 *
 * Turns the operational AR data fullSync already has (the enriched `invoices` array +
 * `ctx`) into a STRATEGIC one-screen view for Bro: total AR, aging waterfall, DSO,
 * collection vs billing this month, top debtors — plus TREND sparklines backed by a
 * daily snapshot ledger (the one thing the rest of the sheet lacks: history, because
 * every sync overwrites).
 *
 * MASTER-ONLY (like Pesan/StopSupply) — written in fullSync's master block only, so the
 * tab + the `_MetricSnapshots` history live on the owner file, never the staff files.
 *
 * Zero new Accurate calls / scope: every number is a projection of data already pulled.
 * Reuses globals: num, stripTime, DAY_MS, _ss (Sync.gs) · _inThisMonth, _monthLabel,
 * rupiah (Kpi.gs) · UI + uiSheet/uiBanner/uiSection/uiHeaderRow/uiFootnote (Style.gs).
 */

// Snapshot ledger column order (hidden sheet `_MetricSnapshots`). Keep in sync with
// _snapshotRow() and the SPARKLINE column letters in writeHealthSections().
//   A tanggal | B totalAR | C currentAR | D overdueAR | E collectedMTD | F billedMTD |
//   G dso | H openCount | I custWithAR | J poolAOut | K poolBOut | L salesOut |
//   M b_belum | N b_0_30 | O b_31_60 | P b_61_90 | Q b_90plus
var SNAP_SHEET = '_MetricSnapshots';
var SNAP_HEADERS = ['tanggal', 'totalAR', 'currentAR', 'overdueAR', 'collectedMTD', 'billedMTD',
  'dso', 'openCount', 'custWithAR', 'poolAOut', 'poolBOut', 'salesOut',
  'b_belum', 'b_0_30', 'b_31_60', 'b_61_90', 'b_90plus'];

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE — all metrics from the already-enriched invoices + ctx (no API calls)
// ─────────────────────────────────────────────────────────────────────────────
function computeBusinessHealth(invoices, ctx, today) {
  // Aging buckets by days past due (positive = overdue). null due date → "belum JT".
  const aging = {
    belum:   { label: 'Belum jatuh tempo', out: 0, count: 0, tint: UI.BLUE_SOFT },
    d0_30:   { label: '1–30 hari',         out: 0, count: 0, tint: UI.T_GREEN },
    d31_60:  { label: '31–60 hari',        out: 0, count: 0, tint: UI.T_AMBER },
    d61_90:  { label: '61–90 hari',        out: 0, count: 0, tint: '#fed7aa' },
    d90plus: { label: '> 90 hari',         out: 0, count: 0, tint: UI.T_RED }
  };

  let totalAR = 0, overdueAR = 0, billedMTD = 0, collectedMTD = 0, billing90 = 0, openCount = 0;
  const custWithAR = {};                       // _custKey → true
  const debtors = {};                          // _custKey → { name, out, oldest, tierText }
  const win90 = stripTime(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90));

  invoices.forEach(function(i) {
    // billings (gross) — for DSO denominator + this-month billed
    if (i.transDate && i.transDate >= win90) billing90 += i.total;
    if (i.transDate && _inThisMonth(i.transDate)) billedMTD += i.total;
    collectedMTD += num(i.collectedThisMonth);

    const out = num(i.outstanding);
    if (out <= 0) return;                       // only open invoices feed AR metrics

    totalAR += out;
    openCount += 1;
    custWithAR[_custKey(i)] = true;

    const dpd = i.daysPastDue;
    if (dpd != null && dpd > 0) overdueAR += out;

    // dpd ≤ 0 (or no due date) = not yet past due → "belum" bucket, so it matches currentAR.
    let b;
    if (dpd == null || dpd <= 0)  b = aging.belum;
    else if (dpd <= 30)           b = aging.d0_30;
    else if (dpd <= 60)           b = aging.d31_60;
    else if (dpd <= 90)           b = aging.d61_90;
    else                          b = aging.d90plus;
    b.out += out; b.count += 1;

    const k = _custKey(i);
    const d = debtors[k] || (debtors[k] = { name: i.customer || '(tanpa nama)', out: 0, oldest: null, tierText: i.custTierText || '' });
    d.out += out;
    if (dpd != null && (d.oldest == null || dpd > d.oldest)) d.oldest = dpd;
    if (!d.tierText && i.custTierText) d.tierText = i.custTierText;
  });

  const currentAR = Math.max(0, totalAR - overdueAR);
  const avgDaily = billing90 / 90;
  const dso = avgDaily > 0 ? Math.round(totalAR / avgDaily) : null;

  const poolAOut = ctx.poolA.reduce(function(s, i) { return s + num(i.outstanding); }, 0);
  const poolBOut = ctx.poolB.reduce(function(s, i) { return s + num(i.outstanding); }, 0);
  const salesOut = ctx.invoiceSales.reduce(function(s, i) { return s + num(i.outstanding); }, 0);

  const topDebtors = Object.keys(debtors).map(function(k) { return debtors[k]; })
    .sort(function(a, b) { return b.out - a.out; })
    .slice(0, 10);

  return {
    totalAR: totalAR, currentAR: currentAR, overdueAR: overdueAR,
    overduePct: totalAR > 0 ? overdueAR / totalAR : 0,
    collectedMTD: collectedMTD, billedMTD: billedMTD,
    collectVsBill: billedMTD > 0 ? collectedMTD / billedMTD : null,
    dso: dso, openCount: openCount, custWithAR: Object.keys(custWithAR).length,
    poolAOut: poolAOut, poolBOut: poolBOut, salesOut: salesOut,
    aging: aging, topDebtors: topDebtors
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT LEDGER — hidden sheet, one row per DAY (upsert by date → manual mid-day
// syncs refresh today's point instead of polluting the series). Master file only.
// Mirrors the _ContactCache pattern in Sync.gs.
// ─────────────────────────────────────────────────────────────────────────────
function _snapshotSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName(SNAP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SNAP_SHEET);
    sh.getRange(1, 1, 1, SNAP_HEADERS.length).setValues([SNAP_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}

function _snapshotRow(dateStr, m) {
  const a = m.aging;
  return [dateStr, m.totalAR, m.currentAR, m.overdueAR, m.collectedMTD, m.billedMTD,
    (m.dso == null ? '' : m.dso), m.openCount, m.custWithAR, m.poolAOut, m.poolBOut, m.salesOut,
    a.belum.out, a.d0_30.out, a.d31_60.out, a.d61_90.out, a.d90plus.out];
}

function recordMetricSnapshot(m, today) {
  const sh = _snapshotSheet();
  const dateStr = Utilities.formatDate(today, 'GMT+7', 'yyyy-MM-dd');
  const row = _snapshotRow(dateStr, m);

  const last = sh.getLastRow();
  if (last >= 2) {
    const dates = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < dates.length; i++) {
      if (String(dates[i][0]) === dateStr) {                 // today already logged → update in place
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sh.getRange(last + 1, 1, 1, row.length).setValues([row]);   // new day → append
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS HEALTH SECTIONS  — RINGKAS · AGING AR · TREN · TOP DEBITUR.
// Master-only: appended at the bottom of the 📋 Ringkasan tab by writeSummaryTab
// (no longer its own tab — folded in 2026-06-05 to declutter). Writes into the
// given sheet `sh` starting at row `startRow`, returns the next free row. Caller
// owns the banner, column widths, frozen rows, and footnote. Reuses globals:
// rupiah/_monthLabel (Kpi.gs), UI + uiSection/uiHeaderRow (Style.gs).
// ⚠ Call AFTER recordMetricSnapshot() — the TREN sparkline reads the snapshot ledger.
// ─────────────────────────────────────────────────────────────────────────────
function writeHealthSections(sh, startRow, m, span) {
  const SPAN = span || 4;
  const pct = function(x) { return x == null ? '—' : (x * 100).toFixed(0) + '%'; };
  let r = startRow;

  // ── RINGKAS ──
  r = uiSection(sh, r, SPAN, 'RINGKAS', UI.INK);
  uiHeaderRow(sh, r, ['Metrik', 'Nilai', 'Catatan', '']); r += 1;
  const ringkas = [
    ['Total AR (outstanding)', rupiah(m.totalAR), m.openCount + ' invoice open · ' + m.custWithAR + ' customer'],
    ['AR Overdue (lewat JT)', rupiah(m.overdueAR), pct(m.overduePct) + ' dari total AR'],
    ['AR Belum Jatuh Tempo', rupiah(m.currentAR), 'Masih dalam termin'],
    ['Collected bulan ini', rupiah(m.collectedMTD), 'Exact dari receiptHistory'],
    ['Billed bulan ini', rupiah(m.billedMTD), 'Invoice terbit ' + _monthLabel()],
    ['Collected / Billed', pct(m.collectVsBill), 'Rasio tagih vs terbit bln ini'],
    ['DSO (Days Sales Outstanding)', (m.dso == null ? '—' : m.dso + ' hari'), 'Total AR ÷ rata2 billing/hari (90 hr)']
  ];
  ringkas.forEach(function(row) {
    sh.getRange(r, 1, 1, 3).setValues([row]).setVerticalAlignment('middle');
    sh.getRange(r, 1).setFontWeight('bold');
    sh.getRange(r, 2).setHorizontalAlignment('right');
    sh.getRange(r, 3).setFontColor(UI.NOTE).setFontStyle('italic');
    r += 1;
  });
  r += 1;

  // ── AGING AR ──
  r = uiSection(sh, r, SPAN, 'AGING AR — sebaran piutang per umur', UI.RED);
  uiHeaderRow(sh, r, ['Bucket', 'Outstanding', '% AR', 'Jml Invoice']); r += 1;
  const order = ['belum', 'd0_30', 'd31_60', 'd61_90', 'd90plus'];
  order.forEach(function(key) {
    const b = m.aging[key];
    const share = m.totalAR > 0 ? b.out / m.totalAR : 0;
    sh.getRange(r, 1, 1, 4).setValues([[b.label, rupiah(b.out), pct(share), b.count]])
      .setVerticalAlignment('middle');
    sh.getRange(r, 1).setFontWeight('bold').setBackground(b.tint);
    sh.getRange(r, 2).setHorizontalAlignment('right');
    sh.getRange(r, 3).setHorizontalAlignment('right');
    sh.getRange(r, 4).setHorizontalAlignment('right');
    r += 1;
  });
  sh.getRange(r, 1, 1, 4).setValues([['TOTAL AR', rupiah(m.totalAR), '100%', m.openCount]])
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(r, 2, 1, 3).setHorizontalAlignment('right');
  r += 2;

  // ── TREN (sparkline dari snapshot harian) ──
  r = uiSection(sh, r, SPAN, 'TREN — snapshot harian (garis terbentuk seiring hari)', UI.BLUE);
  uiHeaderRow(sh, r, ['Metrik', 'Sekarang', 'Tren', '']); r += 1;
  // Bound the range to the real last snapshot row (re-stamped each sync) so trailing empty
  // cells never distort the line. recordMetricSnapshot ran first → snapLast ≥ 2.
  const snapLast = _snapshotSheet().getLastRow();
  const spark = function(col, color) {
    if (snapLast < 2) return '';                         // no history yet → blank
    return "=SPARKLINE('" + SNAP_SHEET + "'!" + col + "2:" + col + snapLast +
           ', {"charttype","line";"linewidth",2;"color1","' + color + '";"empty","ignore"})';
  };
  const trends = [
    ['Total AR', rupiah(m.totalAR), 'B', UI.RED],
    ['AR Overdue', rupiah(m.overdueAR), 'D', UI.AMBER],
    ['Collected bln ini', rupiah(m.collectedMTD), 'E', UI.GREEN],
    ['DSO (hari)', (m.dso == null ? '—' : String(m.dso)), 'G', UI.BLUE]
  ];
  trends.forEach(function(t) {
    sh.getRange(r, 1).setValue(t[0]).setFontWeight('bold').setVerticalAlignment('middle');
    sh.getRange(r, 2).setValue(t[1]).setHorizontalAlignment('right').setVerticalAlignment('middle');
    const f = spark(t[2], t[3]);
    if (f) sh.getRange(r, 3).setFormula(f);
    else sh.getRange(r, 3).setValue('—').setFontColor(UI.NOTE);
    sh.setRowHeight(r, 26);
    r += 1;
  });
  r += 1;

  // ── TOP DEBITUR ──
  r = uiSection(sh, r, SPAN, 'TOP DEBITUR — 10 outstanding terbesar', UI.RED);
  uiHeaderRow(sh, r, ['Customer', 'Outstanding', 'Umur Tertua', 'Loyalitas (4bln)']); r += 1;
  if (!m.topDebtors.length) {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('Tidak ada piutang terbuka. 🎉')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r += 1;
  } else {
    m.topDebtors.forEach(function(d) {
      const umur = (d.oldest == null) ? '—' : (d.oldest <= 0 ? 'Belum JT' : d.oldest + ' hari');
      sh.getRange(r, 1, 1, 4).setValues([[d.name, rupiah(d.out), umur, d.tierText || '—']])
        .setVerticalAlignment('middle');
      sh.getRange(r, 2).setHorizontalAlignment('right');
      sh.getRange(r, 3).setHorizontalAlignment('right');
      r += 1;
    });
  }
  r += 1;

  return r;
}
