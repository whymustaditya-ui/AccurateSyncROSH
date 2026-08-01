/**
 * ROSH × Accurate — THP & KPI history (payroll archive).
 *
 * The KPI/THP tabs (writeThpSalesTab / writeThpAdeTab) only ever show the CURRENT
 * calendar month — every sync overwrites them, so there is no record of what Deden
 * or Ade earned last month or how their score trended. This module adds that record.
 *
 * STORAGE — hidden ledger `_ThpHistory`, ONE row per (periode, role), UPSERTED by that
 * key (mirrors recordMetricSnapshot in Health.gs). During a live month the row is
 * re-stamped every sync (angka hidup); once the calendar rolls over, later syncs only
 * touch the new month's row, so the previous month FREEZES at its last in-month value.
 * No new trigger, no period-parameterised KPI math needed.
 *
 * NOT redundant with `_MetricSnapshots`: that ledger is daily AR-health (aging/DSO);
 * this one is monthly per-person payroll. Different grain, different data.
 *
 * MASTER-ONLY (like Health/Pesan/StopSupply) — recordThpHistory + writeThpHistoryTab
 * run only in fullSync's master block (TARGET_SS=null), so the archive + tab live on
 * the owner file, never the staff files.
 *
 * Zero new Accurate calls / scope: pure projection of the `sales`/`ar` structs fullSync
 * already computed. Reuses globals: _ss/num (Sync.gs) · rupiah (Kpi.gs) ·
 * UI + uiSheet/uiBanner/uiSection/uiHeaderRow/uiFootnote (Style.gs) · CONFIG.
 */

// Ledger column order (hidden sheet `_ThpHistory`). Columns F–J are reused with a
// role-specific meaning (relabeled by the visible tab), blank where N/A.
//   A periode(yyyy-MM) | B role(sales|ar) | C nama | D thp | E base |
//   F komponen2 (sales: tunjangan KPI · ar: tunjangan ops) |
//   G komisi    (sales: komisi 1.25%    · ar: komisi total) |
//   H skor      (sales: skor total 0..1 · ar: —)            |
//   I collected (sales: omzet collected · ar: total masuk kas) |
//   J noo       (sales: outlet baru     · ar: —)            | K updated
var THPH_SHEET = '_ThpHistory';
var THPH_HEADERS = ['periode', 'role', 'nama', 'thp', 'base',
  'komponen2', 'komisi', 'skor', 'collected', 'noo', 'updated'];

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER — get-or-create hidden sheet, upsert one row by (periode, role).
// ─────────────────────────────────────────────────────────────────────────────
function _thpHistorySheet() {
  // ALWAYS the master file, never _ss()/TARGET_SS. The archive is a single store by
  // design; when the tab renders into Deden's file (TARGET_SS = his sheet) a relative
  // lookup would create an empty ledger there and show "belum ada riwayat".
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(THPH_SHEET);
  if (!sh) {
    sh = ss.insertSheet(THPH_SHEET);
    sh.getRange(1, 1, 1, THPH_HEADERS.length).setValues([THPH_HEADERS]);
    sh.hideSheet();
  }
  // Force periode (col A) + updated (col K) to PLAIN TEXT so Sheets never coerces
  // "2026-06" / "2026-06-30 05:00" into a Date (which broke the upsert key + the label).
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.getRange(1, 11, sh.getMaxRows(), 1).setNumberFormat('@');
  return sh;
}

// Normalize a periode cell back to 'yyyy-MM' whether it came back as text or as a
// Date (defensive — legacy rows written before the text-format fix were coerced).
function _periodeKey(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'GMT+7', 'yyyy-MM');
  return String(v);
}

function _upsertThpRow(periode, role, row) {
  const sh = _thpHistorySheet();
  const last = sh.getLastRow();
  if (last >= 2) {
    const keys = sh.getRange(2, 1, last - 1, 2).getValues(); // periode + role
    for (let i = 0; i < keys.length; i++) {
      if (_periodeKey(keys[i][0]) === periode && String(keys[i][1]) === role) {
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]); // same month+person → refresh
        return;
      }
    }
  }
  sh.getRange(last + 1, 1, 1, row.length).setValues([row]);    // new month/person → append
}

// Called from fullSync's master block, AFTER computeSalesKpi/computeArKpi. Stamps this
// month's Sales + AR figures into the ledger. AR is skipped before Ade's onboard month
// (a.notStarted) so the archive holds no pre-employment zero rows.
function recordThpHistory(sales, ar, today) {
  const periode = Utilities.formatDate(today, 'GMT+7', 'yyyy-MM');
  const stamp   = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm');

  _upsertThpRow(periode, 'sales', [
    periode, 'sales', CONFIG.SALES_NAME, sales.thp, sales.base,
    sales.tunjangan, sales.commission, sales.totalScore, sales.collected, sales.noo, stamp
  ]);

  if (ar && !ar.notStarted) {
    _upsertThpRow(periode, 'ar', [
      periode, 'ar', CONFIG.AR_OFFICER_NAME, ar.thp, ar.base,
      ar.ops, ar.komisi, '', ar.collectedTotal, '', stamp
    ]);
  }
}

// Read the ledger back, split by role, sorted ascending by periode.
function _readThpHistory() {
  const sh = _thpHistorySheet();
  const last = sh.getLastRow();
  const out = { sales: [], ar: [] };
  if (last < 2) return out;
  const vals = sh.getRange(2, 1, last - 1, THPH_HEADERS.length).getValues();
  vals.forEach(function(v) {
    const rec = {
      periode: _periodeKey(v[0]), role: String(v[1]), nama: v[2],
      thp: num(v[3]), base: num(v[4]), komponen2: num(v[5]), komisi: num(v[6]),
      skor: v[7] === '' ? null : num(v[7]), collected: num(v[8]),
      noo: v[9] === '' ? null : num(v[9]), updated: _fmtUpdated(v[10])
    };
    if (rec.role === 'sales') out.sales.push(rec);
    else if (rec.role === 'ar') out.ar.push(rec);
  });
  const byPeriode = function(a, b) { return a.periode < b.periode ? -1 : a.periode > b.periode ? 1 : 0; };
  out.sales.sort(byPeriode);
  out.ar.sort(byPeriode);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIBLE TAB — 📈 Riwayat THP (master only). Two stacked tables (Sales, AR), each
// newest month first, with a self-contained THP trend sparkline (inline array literal
// → no coupling to the hidden ledger's row layout).
// ─────────────────────────────────────────────────────────────────────────────
var _ID_MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// 'yyyy-MM' (or a coerced Date) → 'Juni 2026'.
function _periodeLabel(p) {
  const parts = _periodeKey(p).split('-');
  if (parts.length < 2) return _periodeKey(p);
  const m = Number(parts[1]) - 1;
  return (_ID_MONTHS[m] || parts[1]) + ' ' + parts[0];
}

// updated cell → compact 'dd/MM HH:mm' string (handles text or coerced Date).
function _fmtUpdated(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'GMT+7', 'dd/MM/yy HH:mm');
  return String(v);
}

// Inline-array sparkline from a chronological list of numbers (oldest→newest).
function _thpSparkline(values, color) {
  if (!values.length) return '';
  return '=SPARKLINE({' + values.join(';') + '}, {"charttype","column";"color1","' + color + '";"empty","zero"})';
}

// Invoices ISSUED per calendar month for one salesman, keyed 'yyyy-MM' → {count, value}.
// Computed live from the Pass-1 invoice list (NOT stored in the ledger) so past months
// backfill themselves instead of showing blanks for every month recorded before this
// column existed. Zero API cost — `invoices` is already in memory.
//
// NB this is BILLED, not collected: it answers "berapa yang gue terbitkan bulan itu"
// next to "berapa yang masuk kas" (Collected). The two never tie out in one month —
// invoice terbit akhir bulan baru masuk kas bulan berikutnya.
function buildMonthlyIssued(invoices, salesName) {
  const out = {};
  if (!invoices) return out;
  _bySalesman(invoices, salesName).forEach(function(i) {
    if (!i.transDate) return;
    const k = Utilities.formatDate(i.transDate, 'GMT+7', 'yyyy-MM');
    const a = out[k] || (out[k] = { count: 0, value: 0 });
    a.count += 1;
    a.value += num(i.total);
  });
  return out;
}

function _issuedText(m) {
  return m ? (m.count + ' faktur · ' + rupiah(m.value)) : '—';
}

/** @param invoices Pass-1 list (for the Invoice Terbit column). @param role 'master' | 'deden'.
 *  role 'deden' renders the SALES section ONLY — his file must never show Ade's THP. */
function writeThpHistoryTab(invoices, role) {
  const forDeden = (role === 'deden');
  const sh = uiSheet(CONFIG.TABS.THP_HISTORY);
  const SPAN = 10;
  const pct = function(x) { return x == null ? '—' : (x * 100).toFixed(0) + '%'; };
  const rows = _readThpHistory();
  const issued = buildMonthlyIssued(invoices, CONFIG.SALES_NAME);
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📈 Riwayat THP & KPI — arsip per bulan',
    (forDeden
      ? 'Rekap take-home pay kamu tiap bulan beserta rincian komponennya. Bulan berjalan = angka hidup ' +
        '(ikut berubah tiap sync), bulan lalu = nilai terakhir bulan itu. THP = Base + Tunjangan + Komisi. ' +
        '"Invoice Terbit" = faktur yang kamu terbitkan bulan itu (nilai tagihan, bukan uang masuk).'
      : 'Jejak take-home pay & rincian komponennya tiap bulan · master-only · ' +
        'bulan berjalan = angka hidup (update tiap sync), bulan lalu = nilai terakhir bulan itu. ' +
        'THP Sales = Base + Tunjangan + Komisi · THP AR = Pokok + Ops + Komisi.'),
    UI.INK, UI.BAND);
  r += 1;

  // ── THP SALES (Deden) — full component breakdown ──
  r = uiSection(sh, r, SPAN, 'THP SALES — ' + CONFIG.SALES_NAME, UI.BLUE);
  if (!rows.sales.length) {
    r = _emptyHistRow(sh, r, SPAN);
  } else {
    uiHeaderRow(sh, r, ['Periode', 'Skor KPI', 'Invoice Terbit', 'Collected', 'NOO', 'Base', 'Tunjangan', 'Komisi', 'THP', 'Diperbarui']); r += 1;
    if (rows.sales.length >= 2) r = _trendRow(sh, r, SPAN, rows.sales, UI.GREEN);
    rows.sales.slice().reverse().forEach(function(rec) {   // newest first
      sh.getRange(r, 1, 1, SPAN).setValues([[
        _periodeLabel(rec.periode), pct(rec.skor),
        _issuedText(issued[_periodeKey(rec.periode)]), rupiah(rec.collected),
        (rec.noo == null ? '—' : rec.noo + ' outlet'),
        rupiah(rec.base), rupiah(rec.komponen2), rupiah(rec.komisi), rupiah(rec.thp), rec.updated
      ]]).setVerticalAlignment('middle');
      sh.getRange(r, 1).setFontWeight('bold');
      sh.getRange(r, 3, 1, 7).setHorizontalAlignment('right');      // invoice terbit..THP
      sh.getRange(r, 9).setFontWeight('bold').setFontColor(UI.GREEN);
      sh.getRange(r, 10).setFontColor(UI.NOTE).setFontSize(9);
      r += 1;
    });
  }
  r += 1;

  // ── THP AR (Ade) — full component breakdown. SKIPPED on Deden's file (salary isolation). ──
  if (!forDeden) {
    r = uiSection(sh, r, SPAN, 'THP AR — ' + CONFIG.AR_OFFICER_NAME, UI.BLUE);
    if (!rows.ar.length) {
      r = _emptyHistRow(sh, r, SPAN);
    } else {
      uiHeaderRow(sh, r, ['Periode', 'Masuk Kas', 'Pokok', 'Ops', 'Komisi', 'THP', '', '', '', 'Diperbarui']); r += 1;
      if (rows.ar.length >= 2) r = _trendRow(sh, r, SPAN, rows.ar, UI.GREEN);
      rows.ar.slice().reverse().forEach(function(rec) {
        // ledger: base = pokok (AR_BASE), komponen2 = ops (AR_TUNJANGAN_OPS), komisi = komisi.
        sh.getRange(r, 1, 1, SPAN).setValues([[
          _periodeLabel(rec.periode), rupiah(rec.collected), rupiah(rec.base), rupiah(rec.komponen2),
          rupiah(rec.komisi), rupiah(rec.thp), '', '', '', rec.updated
        ]]).setVerticalAlignment('middle');
        sh.getRange(r, 1).setFontWeight('bold');
        sh.getRange(r, 2, 1, 5).setHorizontalAlignment('right');      // masuk kas..THP
        sh.getRange(r, 6).setFontWeight('bold').setFontColor(UI.GREEN);
        sh.getRange(r, 10).setFontColor(UI.NOTE).setFontSize(9);
        r += 1;
      });
    }
    r += 1;
  }

  uiFootnote(sh, r, SPAN,
    '⚙️ Arsip otomatis tiap sync (jam 5 pagi) dari data Accurate — jangan edit manual. Kolom "Diperbarui" = ' +
    'kapan baris itu terakhir di-refresh; bulan berjalan ikut tiap sync, bulan lalu beku di sync terakhir bulan itu. ' +
    '"Invoice Terbit" dihitung ulang tiap sync dari tanggal faktur, jadi bulan lama pun ikut terisi. ' +
    'Untuk mengunci angka final bulan ini secara presisi, jalankan "Run Full Sync now" di malam terakhir bulan ' +
    '(koleksi hari terakhir setelah jam 5 pagi belum tertangkap di sync rutin). Tren = THP per bulan (muncul setelah ≥2 bulan).');

  sh.setColumnWidth(1, 140);   // Periode (e.g. "September 2026")
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 200);   // Invoice Terbit ("62 faktur · Rp215.400.000")
  sh.setColumnWidth(4, 140);
  sh.setColumnWidth(5, 95);
  sh.setColumnWidth(6, 120);
  sh.setColumnWidth(7, 120);
  sh.setColumnWidth(8, 130);
  sh.setColumnWidth(9, 140);
  sh.setColumnWidth(10, 110);  // Diperbarui
  sh.setFrozenRows(2);
  return sh;
}

// One "Tren THP" row with an inline-array column sparkline of THP over time (oldest→newest).
// Only called when ≥2 months exist (a 1-point column chart renders as a useless solid block).
function _trendRow(sh, r, span, recs, color) {
  const f = _thpSparkline(recs.map(function(x) { return Math.round(x.thp); }), color);
  sh.getRange(r, 1).setValue('Tren THP').setFontWeight('bold').setVerticalAlignment('middle');
  if (f) sh.getRange(r, 2, 1, span - 1).merge().setFormula(f);
  else sh.getRange(r, 2, 1, span - 1).merge().setValue('—').setFontColor(UI.NOTE);
  sh.setRowHeight(r, 30);
  return r + 1;
}

function _emptyHistRow(sh, r, span) {
  sh.getRange(r, 1, 1, span).merge()
    .setValue('Belum ada riwayat — terisi otomatis mulai sync berikutnya.')
    .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
  return r + 1;
}
