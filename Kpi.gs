/**
 * ROSH × Accurate — KPI math + THP writers + Summary.
 *
 * Sales KPI  → Memo KPI Sales (Deden). THP = Base 3.5jt + Tunjangan(score×3.5jt,
 *              cap 106%) + Komisi(1.25% × MAX(collected−100jt, 0)).
 *              Basis komisi = seluruh kas masuk bulan itu, termasuk yang cair setelah
 *              faktur pindah ke Ade (H+15). Sama dengan basis omzet.
 *              Weights: Omzet 45% (cap100%) · Cashflow 25% (cap100%) ·
 *                       Diskon 20% (cap120%, 7-tier) · NOO 10% (cap120%).
 *
 * AR KPI v2  → MEMO 2026-05-11 v2. THP = Base 3jt + komisi on CASH COLLECTED this
 *              month, bucketed by how overdue the invoice was on each payment date:
 *              15–45d ×1.5% · 46–90d ×2.5% · >90d ×3.5%. (≤14d = on-time, no komisi.)
 *
 * Both "collected this month" figures are EXACT — summed from receiptHistory
 * (Pass 2 in Sync.gs), excluding void / PPh / non-APPROVED receipts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD helpers (current calendar month, GMT+7)
// ─────────────────────────────────────────────────────────────────────────────
function _monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function _inThisMonth(d) {
  if (!d) return false;
  const ms = _monthStart();
  return d >= ms && d < new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
}
function _monthLabel() { return Utilities.formatDate(new Date(), 'GMT+7', 'MMMM yyyy'); }

// ─────────────────────────────────────────────────────────────────────────────
// SALES KPI  (Deden Sunandar)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param invoices   Pass-1 list, already enriched (needs `.receipts`).
 * @param monthStart OPTIONAL first day of the month to compute. Omit = current month
 *   (every existing caller). Passing a past month lets restampMonth (ThpHistory.gs)
 *   recompute a CLOSED month from live receipt data — the ledger row for a month freezes
 *   at whatever the last in-month sync saw, so payments entered into Accurate after that
 *   sync but dated in that month were silently lost (Juli 2026: Rp9.063.960, komisi
 *   Deden Rp181.572 vs Rp294.872 seharusnya).
 *
 * Month scoping reads `i.receipts` (full history, attached to every invoice by
 * enrichReceipts) instead of the precomputed `i.receiptsThisMonth`, so it works for any
 * month. For the current month the two are identical by construction: same receipts, same
 * `_inThisMonth` window, same collectionBucket call.
 */
function computeSalesKpi(invoices, monthStart) {
  const isDeden = function(i) { return i.salesman === CONFIG.SALES_NAME; };
  const ms = monthStart || _monthStart();
  const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
  const inMonth = function(d) { return !!d && d >= ms && d < me; };

  // 1) Omzet — exact cash collected in the month on Deden's invoices.
  //    `collected` = SEMUA kas, termasuk yang cair setelah faktur pindah ke Ade (H+15).
  //    Dipakai dua kali: skor omzet (bobot 45%) DAN basis komisi 1,25%. Deden yang
  //    menciptakan penjualannya, jadi kas apa pun atas fakturnya tetap diakui.
  let collected = 0, onTimeCollected = 0;
  invoices.filter(isDeden).forEach(function(i) {
    (i.receipts || []).forEach(function(r) {
      if (!inMonth(r.date)) return;
      const dov = i.dueDate ? Math.floor((r.date - i.dueDate) / DAY_MS) : null;
      collected += r.amount;
      if (dov == null || dov <= CONFIG.SALES_ONTIME_DAYS) onTimeCollected += r.amount;
    });
  });
  const omzetAchv  = collected / CONFIG.SALES_OMZET_TARGET;
  const omzetScore = clamp(omzetAchv, 0, CONFIG.CAP_OMZET);

  // 2) Cashflow — share of collected (by value) settled within SALES_ONTIME_DAYS of due date.
  const cashRate  = collected > 0 ? onTimeCollected / collected : 0;
  const cashScore = clamp(cashRate, 0, CONFIG.CAP_CASHFLOW);

  // 3) Diskon — TotalDiskon / TotalOmzetBruto on Deden's invoices issued this month.
  let sumBruto = 0, sumDiskon = 0;
  invoices.filter(function(i) { return isDeden(i) && inMonth(i.transDate); }).forEach(function(i) {
    sumBruto  += i.subTotal;
    sumDiskon += i.cashDiscount;
  });
  const diskonRatio = sumBruto > 0 ? sumDiskon / sumBruto : 0;
  const diskonScore = diskonTier(diskonRatio);

  // 4) NOO — customers whose first-ever invoice falls this month AND was Deden's.
  const firstSeen = {}; // customer → { date, salesman }
  invoices.forEach(function(i) {
    if (!i.customer || !i.transDate) return;
    if (!firstSeen[i.customer] || i.transDate < firstSeen[i.customer].date) {
      firstSeen[i.customer] = { date: i.transDate, salesman: i.salesman };
    }
  });
  let noo = 0;
  Object.keys(firstSeen).forEach(function(c) {
    if (inMonth(firstSeen[c].date) && firstSeen[c].salesman === CONFIG.SALES_NAME) noo++;
  });
  const nooScore = clamp(noo / CONFIG.NOO_TARGET, 0, CONFIG.CAP_NOO);

  // Weighted total — NO renormalization (all four components computable).
  const totalScore =
      CONFIG.W_OMZET    * omzetScore +
      CONFIG.W_CASHFLOW * cashScore  +
      CONFIG.W_DISKON   * diskonScore +
      CONFIG.W_NOO      * nooScore;

  // THP
  const base = CONFIG.SALES_BASE;
  const tunjanganScore = clamp(totalScore, 0, CONFIG.SALES_TUNJANGAN_CAP); // cap 106%
  const tunjangan = Math.round(tunjanganScore * CONFIG.SALES_TUNJANGAN_MULT);
  // Basis komisi = seluruh kas bulan itu (termasuk yang ditagih Ade setelah H+15).
  // Sempat dipotong ke kas pre-handover saja (2026-08-02), dibatalkan 2026-08-03 —
  // lihat ROSH Finance/2026-08-02_MEMO_Komisi-Sales-Kas-Post-Handover.html.
  const commission = Math.round(Math.max(0, collected - CONFIG.SALES_COMMISSION_FLOOR) * CONFIG.SALES_COMMISSION_RATE);
  const thp = base + tunjangan + commission;

  return {
    collected: collected, onTimeCollected: onTimeCollected,
    omzetAchv: omzetAchv, omzetScore: omzetScore,
    cashRate: cashRate, cashScore: cashScore,
    diskonRatio: diskonRatio, diskonScore: diskonScore, sumBruto: sumBruto, sumDiskon: sumDiskon,
    noo: noo, nooScore: nooScore,
    totalScore: totalScore, base: base, tunjangan: tunjangan,
    commission: commission, thp: thp
  };
}

// Diskon 7-tier (ratio = TotalDiskon / TotalOmzetBruto, as a fraction).
function diskonTier(ratio) {
  const p = ratio * 100;
  if (p <= 1.00) return 1.20;
  if (p <= 1.50) return 1.00;
  if (p <= 1.75) return 0.80;
  if (p <= 2.00) return 0.60;
  if (p <= 2.25) return 0.40;
  if (p <= 2.50) return 0.20;
  return 0.00;
}

// Styled to mirror writeThpAdeTab (KPI Matriks AR): banner → green THP headline →
// Komponen KPI section → Skor Total band → Take-Home Pay section → footnote.
// `role` = 'deden' saat menulis ke file Deden: kolom keterangan baris Komisi
// dikosongkan (dia cuma mau lihat angka + basisnya, tanpa paragraf aturan).
function writeThpSalesTab(k, role) {
  const sh = uiSheet(CONFIG.TABS.THP_SALES);
  const SPAN = 4;
  const pct = function(x) { return x == null ? '—' : (x * 100).toFixed(0) + '%'; };
  const capTunjangan = Math.round(CONFIG.SALES_TUNJANGAN_CAP * CONFIG.SALES_TUNJANGAN_MULT);
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📊 KPI & THP Dashboard — Sales (' + CONFIG.SALES_NAME + ')',
    'Auto-calculate dari invoice & receiptHistory · Periode ' + _monthLabel() +
    ' · KPI berbobot · THP = Base + Tunjangan KPI + Komisi.',
    UI.INK, UI.BAND);
  r += 1;

  // THP headline (green emphasis band)
  sh.getRange(r, 1, 1, 3).merge().setValue('THP — TAKE-HOME PAY BULAN INI')
    .setBackground(UI.GREEN_SOFT).setFontColor(UI.GREEN).setFontWeight('bold')
    .setFontSize(12).setVerticalAlignment('middle');
  sh.getRange(r, 4).setValue(rupiah(k.thp)).setBackground(UI.GREEN_SOFT)
    .setFontColor(UI.GREEN).setFontWeight('bold').setFontSize(12)
    .setHorizontalAlignment('right');
  sh.setRowHeight(r, 32);
  r += 2;

  // ── KOMPONEN KPI ──
  r = uiSection(sh, r, SPAN, 'KOMPONEN KPI — berbobot, tanpa normalisasi (maks alami 106%)', UI.INK);
  uiHeaderRow(sh, r, ['Komponen', 'Bobot', 'Capaian', 'Skor']); r += 1;
  r = _arRow(sh, r, 'Omzet (collected bln ini)', '45%',
      rupiah(k.collected) + ' / ' + rupiah(CONFIG.SALES_OMZET_TARGET), pct(k.omzetScore));
  r = _arRow(sh, r, 'Cashflow (≤H+' + CONFIG.SALES_ONTIME_DAYS + ')', '25%',
      pct(k.cashRate) + ' on-time', pct(k.cashScore));
  r = _arRow(sh, r, 'Efisiensi Diskon', '20%',
      (k.diskonRatio * 100).toFixed(2) + '% (' + rupiah(k.sumDiskon) + ' / ' + rupiah(k.sumBruto) + ')', pct(k.diskonScore));
  r = _arRow(sh, r, 'NOO (outlet baru)', '10%',
      k.noo + ' / ' + CONFIG.NOO_TARGET + ' outlet', pct(k.nooScore));
  r = _arRow(sh, r, 'SKOR TOTAL', '100%', '', pct(k.totalScore));
  sh.getRange(r - 1, 1, 1, SPAN).setBackground(UI.BAND).setFontWeight('bold');
  r += 1;

  // ── TAKE-HOME PAY ──
  r = uiSection(sh, r, SPAN, 'TAKE-HOME PAY', UI.INK);
  r = _arRow(sh, r, 'Base', rupiah(k.base), '', 'Fixed');
  r = _arRow(sh, r, 'Tunjangan KPI', rupiah(k.tunjangan), '',
      'Skor × ' + rupiah(CONFIG.SALES_TUNJANGAN_MULT) + ' (cap 106% = ' + rupiah(capTunjangan) + ')');
  r = _arRow(sh, r, 'Komisi 1.25%', rupiah(k.commission),
      'Basis ' + rupiah(k.collected),
      (role === 'deden'
        ? '(Basis − ' + rupiah(CONFIG.SALES_COMMISSION_FLOOR) + ') × 1,25%, hanya kelebihannya'
        : 'Atas collected di atas ' + rupiah(CONFIG.SALES_COMMISSION_FLOOR)));
  r = _arRow(sh, r, 'THP — TOTAL', rupiah(k.thp), 'Floor ' + rupiah(k.base), 'Take-home pay bulan ini');
  sh.getRange(r - 1, 1, 1, SPAN).setBackground(UI.GREEN_SOFT).setFontColor(UI.GREEN).setFontWeight('bold');
  r += 1;

  // File Deden dapat satu paragraf contoh perhitungan komisi — D17 terlalu sempit untuk
  // memuatnya, jadi rumus pendek di sana + contoh angka di sini (usulan Bro 2026-08-02).
  if (role === 'deden') {
    const floorTxt = rupiah(CONFIG.SALES_COMMISSION_FLOOR);
    r = uiFootnote(sh, r, SPAN,
      '💡 Komisi 1,25% dihitung dari KELEBIHAN basis di atas ' + floorTxt + ', bukan dari seluruh collected. ' +
      'Contoh: basis Rp120.000.000, komisi = (Rp120.000.000 − ' + floorTxt + ') × 1,25% = Rp250.000, ' +
      'bukan Rp1.500.000. Basis di bawah ' + floorTxt + ', komisi Rp0.');
  }

  uiFootnote(sh, r, SPAN,
    '⚙️ Semua angka dihitung ulang tiap sync (jam 5 pagi) dari data Accurate — jangan edit manual. ' +
    'Omzet & Cashflow exact dari receiptHistory; Diskon 7-tier; NOO = outlet pertama kali order bln ini milik ' + CONFIG.SALES_NAME + '.');

  sh.setColumnWidth(1, 340);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 320);
  sh.setColumnWidth(4, 280);
  sh.setFrozenRows(2); // banner + subtitle
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// AR OFFICER KPI — Offering Letter (2026-05-20)  (Ade)
// ─────────────────────────────────────────────────────────────────────────────
// Komisi = cash masuk kas THIS MONTH in Ade's window, × rate of the bucket LOCKED
// at the first post-onboard payment (handover-based aging). Pool A and Pool B both
// earn komisi. THP floor = Gaji Pokok 3jt + Tunjangan Operasional 800rb = 3.8jt.
// Probation bonuses (Sprint / Milestone / Cleanup) are Pool A ONLY.
function computeArKpi(invoices, onboard, today) {
  // 0) PRE-START GUARD — Ade starts on CONFIG.ADE_ONBOARD_DATE. Before that date
  //    NOTHING accrues: komisi, penalty flags, bonus progress, and pool snapshots all
  //    read 0. Returns a fully-shaped zero struct so writeThpAdeTab renders cleanly.
  if (today < onboard) {
    const z3 = function() { return { reg: 0, aging1: 0, aging2: 0 }; };
    const sprintEnd = addDays(onboard, CONFIG.AR_SPRINT_WINDOW_DAYS);
    const mileEnd   = addDays(onboard, CONFIG.AR_MILESTONE_WINDOW_DAYS);
    const NOTSTART  = '⏳ Belum mulai';
    return {
      notStarted: true,
      collected: z3(), kom: z3(), komisi: 0, collectedTotal: 0,
      komisiPoolA: 0, komisiPoolB: 0,
      base: CONFIG.AR_BASE, ops: CONFIG.AR_TUNJANGAN_OPS,
      thp: CONFIG.AR_BASE + CONFIG.AR_TUNJANGAN_OPS, floor: CONFIG.AR_BASE + CONFIG.AR_TUNJANGAN_OPS,
      poolA: { backlogAtOnboard: 0, remaining: 0, collectedSinceOnboard: 0 },
      poolB: { outstanding: 0, count: 0, komisi: 0 },
      bonus: {
        sprint:    { collected: 0, target: CONFIG.AR_SPRINT_TARGET,    reward: CONFIG.AR_SPRINT_BONUS,    pct: 0, end: sprintEnd, status: NOTSTART },
        milestone: { collected: 0, target: CONFIG.AR_MILESTONE_TARGET, reward: CONFIG.AR_MILESTONE_BONUS, pct: 0, end: mileEnd,   status: NOTSTART },
        cleanup:   { remaining: 0, ceiling: CONFIG.AR_CLEANUP_CEILING, reward: CONFIG.AR_CLEANUP_BONUS,            end: mileEnd,   status: NOTSTART }
      },
      flags: { regToAging1: 0, aging1ToAging2: 0, penaltyPotential: 0, list: [] }
    };
  }

  // 1) Komisi this month, grouped by the locked bucket (across A + B).
  const collected = { reg: 0, aging1: 0, aging2: 0 };
  const kom       = { reg: 0, aging1: 0, aging2: 0 };
  let komisiPoolA = 0, komisiPoolB = 0;
  invoices.forEach(function(i) {
    if ((i.pool !== 'A' && i.pool !== 'B') || !i.bucketLock || i.komisiEligibleThisMonth <= 0) return;
    collected[i.bucketLock] += i.komisiEligibleThisMonth;
    kom[i.bucketLock]       += i.adeKomisiThisMonth;
    if (i.pool === 'A') komisiPoolA += i.adeKomisiThisMonth; else komisiPoolB += i.adeKomisiThisMonth;
  });
  const komisi         = kom.reg + kom.aging1 + kom.aging2;
  const collectedTotal = collected.reg + collected.aging1 + collected.aging2;

  // 2) Pool A backlog + bonus windows.
  let backlogAtOnboard = 0, remainingA = 0, collectedSinceOnboardA = 0,
      sprintCollected = 0, mileCollected = 0;
  invoices.filter(function(i) { return i.pool === 'A'; }).forEach(function(i) {
    backlogAtOnboard       += i.piutangAtOnboard;
    remainingA             += i.outstanding;
    collectedSinceOnboardA += i.collectedSinceOnboard;
    sprintCollected        += i.collectedSprint;
    mileCollected          += i.collectedMilestone;
  });

  const sprintEnd  = addDays(onboard, CONFIG.AR_SPRINT_WINDOW_DAYS);
  const mileEnd    = addDays(onboard, CONFIG.AR_MILESTONE_WINDOW_DAYS);
  const bonus = {
    sprint: {
      collected: sprintCollected, target: CONFIG.AR_SPRINT_TARGET, reward: CONFIG.AR_SPRINT_BONUS,
      pct: clamp(sprintCollected / CONFIG.AR_SPRINT_TARGET, 0, 9), end: sprintEnd,
      status: _bonusStatus(sprintCollected >= CONFIG.AR_SPRINT_TARGET, today > sprintEnd)
    },
    milestone: {
      collected: mileCollected, target: CONFIG.AR_MILESTONE_TARGET, reward: CONFIG.AR_MILESTONE_BONUS,
      pct: clamp(mileCollected / CONFIG.AR_MILESTONE_TARGET, 0, 9), end: mileEnd,
      status: _bonusStatus(mileCollected >= CONFIG.AR_MILESTONE_TARGET, today > mileEnd)
    },
    cleanup: {
      remaining: remainingA, ceiling: CONFIG.AR_CLEANUP_CEILING, reward: CONFIG.AR_CLEANUP_BONUS,
      end: mileEnd, // FORFEIT deadline (end of month 3); payable the moment remaining < ceiling
      status: _bonusStatus(remainingA < CONFIG.AR_CLEANUP_CEILING, today > mileEnd)
    }
  };

  // 3) Penalty auto-FLAGS (owner decides; waived if documented follow-up in 🟡 cols).
  //    Bucket worsening = an unpaid pool invoice whose CURRENT handover-aging sits
  //    in aging1 / aging2 (i.e. it slipped past the 30 / 75-day lines while open).
  let flagReg2A1 = 0, flagA12A2 = 0;
  const flagList = [];
  invoices.forEach(function(i) {
    if ((i.pool !== 'A' && i.pool !== 'B') || i.isPaid || i.outstanding <= 0 || !i.handoverDate) return;
    const dsh = Math.floor((today - i.handoverDate) / DAY_MS);
    let bucket = null;
    if (dsh > CONFIG.AR_BUCKET_AGING1_MAX) { flagA12A2++; bucket = 'aging2'; }
    else if (dsh > CONFIG.AR_BUCKET_REG_MAX) { flagReg2A1++; bucket = 'aging1'; }
    if (bucket) flagList.push({
      number: i.number, customer: i.customer, outstanding: i.outstanding,
      dueDate: i.dueDate, daysPastDue: i.daysPastDue, dsh: dsh, bucket: bucket, pool: i.pool
    });
  });
  flagList.sort(function(x, y) { return y.dsh - x.dsh; }); // paling tua di atas
  const penaltyPotential = flagReg2A1 * CONFIG.AR_PENALTY_REG_TO_AGING1 +
                           flagA12A2 * CONFIG.AR_PENALTY_AGING1_TO_AGING2;

  // 4) Pool B current outstanding.
  let outstandingB = 0, countB = 0;
  invoices.forEach(function(i) {
    if (i.pool === 'B' && i.handoverDate && i.handoverDate <= today && !i.isPaid && i.outstanding > 0) {
      outstandingB += i.outstanding; countB++;
    }
  });

  // THP — floor is base + ops; komisi is additive; bonuses & penalties are owner-decided (NOT auto-applied).
  const thp = CONFIG.AR_BASE + CONFIG.AR_TUNJANGAN_OPS + komisi;

  return {
    collected: collected, kom: kom, komisi: komisi, collectedTotal: collectedTotal,
    komisiPoolA: komisiPoolA, komisiPoolB: komisiPoolB,
    base: CONFIG.AR_BASE, ops: CONFIG.AR_TUNJANGAN_OPS, thp: thp, floor: CONFIG.AR_BASE + CONFIG.AR_TUNJANGAN_OPS,
    poolA: {
      backlogAtOnboard: backlogAtOnboard, remaining: remainingA,
      collectedSinceOnboard: collectedSinceOnboardA
    },
    poolB: { outstanding: outstandingB, count: countB, komisi: komisiPoolB },
    bonus: bonus,
    flags: { regToAging1: flagReg2A1, aging1ToAging2: flagA12A2, penaltyPotential: penaltyPotential, list: flagList }
  };
}

// Bonus status string from (target met?, window passed?).
// Bonus targets are monotonic (Sprint/Milestone collected only grows; Cleanup's Pool A
// backlog only burns down), so once `met` it can't un-achieve → payable immediately, no
// need to wait for the window to close. The window is only a FORFEIT deadline: miss it
// (still not met when it closes) → gugur.
function _bonusStatus(met, windowClosed) {
  if (met) return windowClosed ? '✅ Tercapai' : '✅ Cair — bisa dibayar';
  return windowClosed ? '❌ Window tutup' : '⏳ Berjalan';
}

// Write one 4-col line; bold col1. Returns next row.
function _arRow(sh, r, a, b, c, d) {
  sh.getRange(r, 1, 1, 4).setValues([[a, b == null ? '' : b, c == null ? '' : c, d == null ? '' : d]])
    .setVerticalAlignment('middle');
  sh.getRange(r, 1).setFontWeight('bold');
  return r + 1;
}

function writeThpAdeTab(a) {
  const sh = uiSheet(CONFIG.TABS.THP_ADE);
  const SPAN = 4;
  const b = a.bonus;
  const pct = function(x) { return (x * 100).toFixed(0) + '%'; };
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📊 KPI & THP Dashboard — ' + CONFIG.AR_OFFICER_NAME,
    a.notStarted
      ? '⏳ KPI mulai berlaku ' + CONFIG.ADE_ONBOARD_DATE + ' (hari pertama ' + CONFIG.AR_OFFICER_NAME +
        '). Semua angka masih 0 — komisi, flag penalty, & bonus belum berjalan sampai tanggal mulai.'
      : 'Auto-calculate dari Pool A & Pool B · Periode ' + _monthLabel() +
        ' · Komisi atas masuk kas, bucket dikunci sejak handover.',
    UI.INK, UI.BAND);
  r += 1;

  // Komisi headline (green emphasis band)
  sh.getRange(r, 1, 1, 3).merge().setValue('KOMISI DIPEROLEH BULAN INI')
    .setBackground(UI.GREEN_SOFT).setFontColor(UI.GREEN).setFontWeight('bold')
    .setFontSize(12).setVerticalAlignment('middle');
  sh.getRange(r, 4).setValue(rupiah(a.komisi)).setBackground(UI.GREEN_SOFT)
    .setFontColor(UI.GREEN).setFontWeight('bold').setFontSize(12)
    .setHorizontalAlignment('right');
  sh.setRowHeight(r, 32);
  r += 2;

  // ── KOMISI per BUCKET ──
  r = uiSection(sh, r, SPAN, 'KOMISI per BUCKET — aging sejak handover, dikunci di pembayaran pertama', UI.INK);
  uiHeaderRow(sh, r, ['Bucket', 'Masuk Kas', 'Rate', 'Komisi']); r += 1;
  r = _arRow(sh, r, '0–30 hari (regular)',  rupiah(a.collected.reg),    '1.5%', rupiah(a.kom.reg));
  r = _arRow(sh, r, '31–75 hari (aging-1)', rupiah(a.collected.aging1), '2.5%', rupiah(a.kom.aging1));
  r = _arRow(sh, r, '>75 hari (aging-2)',   rupiah(a.collected.aging2), '3.5%', rupiah(a.kom.aging2));
  r = _arRow(sh, r, 'Total masuk kas (basis komisi)', rupiah(a.collectedTotal), '', rupiah(a.komisi));
  sh.getRange(r - 1, 1, 1, SPAN).setBackground(UI.BAND).setFontWeight('bold');
  r = _arRow(sh, r, '   · dari Pool A (legacy)',   '', '', rupiah(a.komisiPoolA));
  r = _arRow(sh, r, '   · dari Pool B (berjalan)', '', '', rupiah(a.komisiPoolB));
  r += 1;

  // ── TAKE-HOME PAY ──
  r = uiSection(sh, r, SPAN, 'TAKE-HOME PAY', UI.INK);
  r = _arRow(sh, r, 'Gaji Pokok', rupiah(a.base), '', 'Fixed sejak hari 1');
  r = _arRow(sh, r, 'Tunjangan Operasional', rupiah(a.ops), '', 'Bensin / pulsa / makan (fixed)');
  r = _arRow(sh, r, 'Komisi', rupiah(a.komisi), '', 'Variabel — atas masuk kas');
  r = _arRow(sh, r, 'THP — TOTAL', rupiah(a.thp), 'Floor ' + rupiah(a.floor), 'Take-home pay bulan ini');
  sh.getRange(r - 1, 1, 1, SPAN).setBackground(UI.GREEN_SOFT).setFontColor(UI.GREEN).setFontWeight('bold');
  r += 1;

  // Pool A burn-down + Bonus Probation DIHAPUS dari tab 2026-09-05: semua window bonus (Sprint 30 hr,
  // Milestone/Cleanup 92 hr sejak onboard 2026-06-02) sudah tutup 2 Sep 2026, seksinya tak akan
  // berubah lagi. Angkanya tetap dihitung di computeArKpi (a.bonus, a.poolA) untuk arsip; kalau
  // Pool A masih bersisa, satu baris di bawah ini cukup.
  if (a.poolA && a.poolA.remaining > 0) {
    r = uiSection(sh, r, SPAN, 'POOL A — SISA BACKLOG LAMA', UI.RED);
    r = _arRow(sh, r, 'Sisa backlog (target Rp0)', rupiah(a.poolA.remaining), '',
      'dari ' + rupiah(a.poolA.backlogAtOnboard) + ' saat onboard ' + CONFIG.ADE_ONBOARD_DATE);
    r += 1;
  }

  // ── POOL B ──
  r = uiSection(sh, r, SPAN, 'POOL B — ONGOING AR', UI.BLUE);
  r = _arRow(sh, r, 'Outstanding Pool B', rupiah(a.poolB.outstanding), a.poolB.count + ' invoice', 'Komisi ' + rupiah(a.poolB.komisi));
  r += 1;

  // ── FLAG PENALTY ──
  r = uiSection(sh, r, SPAN, 'FLAG PENALTY — auto-flag · keputusan owner · gugur bila ada follow-up', UI.GOLD);
  r = _arRow(sh, r, 'Slip ke aging-1 (31–75 hr, belum lunas)', a.flags.regToAging1 + ' invoice', '@' + rupiah(CONFIG.AR_PENALTY_REG_TO_AGING1), '');
  r = _arRow(sh, r, 'Slip ke aging-2 (>75 hr, belum lunas)', a.flags.aging1ToAging2 + ' invoice', '@' + rupiah(CONFIG.AR_PENALTY_AGING1_TO_AGING2), '');
  r = _arRow(sh, r, 'Potensi potongan (Tunjangan Ops)', rupiah(a.flags.penaltyPotential), '', 'TIDAK dipotong otomatis — owner cek 🟡 follow-up');
  r = _arRow(sh, r, 'Clawback komisi', 'Pantau manual', '', 'Bila pembayaran di-void/retur setelah komisi dibayar');
  r += 1;

  // ── RINCIAN INVOICE KE-FLAG — invoice mana saja yang menyumbang angka di atas ──
  if (a.flags.list && a.flags.list.length) {
    r = uiSection(sh, r, SPAN, 'RINCIAN INVOICE KE-FLAG — cek 🟡 follow-up sebelum potong (paling tua di atas)', UI.GOLD);
    uiHeaderRow(sh, r, ['Faktur', 'Customer', 'Outstanding', 'Umur sejak handover']); r += 1;
    const flagStart = r;
    a.flags.list.forEach(function(f) {
      const tag = f.bucket === 'aging2' ? '🔴 aging-2 (>75 hr)' : '🟠 aging-1 (31–75 hr)';
      const dueTxt = (f.daysPastDue != null) ? ' · ' + f.daysPastDue + ' hr lewat due' : '';
      r = _arRow(sh, r, f.number, f.customer, rupiah(f.outstanding),
        f.dsh + ' hr · ' + tag + dueTxt);
    });
    // tint baris aging-2 merah lembut biar yang paling parah menonjol
    a.flags.list.forEach(function(f, i) {
      if (f.bucket === 'aging2') sh.getRange(flagStart + i, 1, 1, SPAN).setBackground(UI.RED_SOFT || '#fde8e8');
    });
    r += 1;
  }

  uiFootnote(sh, r, SPAN, '⚠️ Bonus & penalty = keputusan owner, TIDAK auto-apply. THP otomatis = Gaji Pokok + Tunjangan Operasional + Komisi.');

  sh.setColumnWidth(1, 340);
  sh.setColumnWidth(2, 210);
  sh.setColumnWidth(3, 260);
  sh.setColumnWidth(4, 280);
  sh.setFrozenRows(2); // banner + subtitle
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY — overview of the four tabs
// ─────────────────────────────────────────────────────────────────────────────
// role: 'master' (default) shows everything · 'ade' hides THP Sales · 'deden' hides THP AR.
// Keeps each staff file from leaking the other person's take-home pay.
function writeSummaryTab(ctx, role, health) {
  role = role || 'master';
  const showSales = (role === 'master' || role === 'deden');
  const showAr    = (role === 'master' || role === 'ade');
  const inv = ctx.invoices, sales = ctx.sales, ar = ctx.ar;

  // collected this month split by attribution
  let collDeden = 0, collPos = 0, collOther = 0;
  inv.forEach(function(i) {
    const c = i.collectedThisMonth;
    if (!c) return;
    if (i.salesman === CONFIG.SALES_NAME) collDeden += c;
    else if (i.salesman === '') collPos += c;
    else collOther += c;
  });
  const collTotal = collDeden + collPos + collOther;

  const outstandingSales = ctx.invoiceSales.reduce(function(s, i) { return s + i.outstanding; }, 0);
  const outstandingA = ctx.poolA.reduce(function(s, i) { return s + i.outstanding; }, 0);
  const outstandingB = ctx.poolB.reduce(function(s, i) { return s + i.outstanding; }, 0);
  const outstandingAde = outstandingA + outstandingB;

  const sh = uiSheet(CONFIG.TABS.SUMMARY);
  const SPAN = 3;
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📋 Summary — ROSH AR & Sales',
    'Periode ' + _monthLabel() + ' · diperbarui otomatis tiap jam 5 pagi · update terakhir ' +
    Utilities.formatDate(new Date(), 'GMT+7', 'dd/MM/yyyy HH:mm'),
    UI.INK, UI.BAND);
  r += 1;

  // section helper: band + rows([label, value, note]); bolds col1, greys note.
  const block = function(label, color, rows) {
    r = uiSection(sh, r, SPAN, label, color);
    rows.forEach(function(row) {
      sh.getRange(r, 1, 1, SPAN).setValues([row]).setVerticalAlignment('middle');
      sh.getRange(r, 1).setFontWeight('bold');
      sh.getRange(r, 3).setFontColor(UI.NOTE).setFontStyle('italic');
      r += 1;
    });
    r += 1;
  };

  // PIUTANG — Sales row for master/Deden; Pool A/B + Total Ade for master/Ade; grand total master only.
  const piutangRows = [];
  if (showSales)
    piutangRows.push(['Di tangan Sales (pre-handover)', rupiah(outstandingSales), ctx.invoiceSales.length + ' invoice → ' + CONFIG.TABS.INVOICE_SALES]);
  if (showAr) {
    piutangRows.push(['Pool A — legacy backlog (frozen)', rupiah(outstandingA), ctx.poolA.length + ' invoice → ' + CONFIG.TABS.POOL_A]);
    piutangRows.push(['Pool B — ongoing AR', rupiah(outstandingB), ctx.poolB.length + ' invoice → ' + CONFIG.TABS.POOL_B]);
    piutangRows.push(['Total di tangan ' + CONFIG.AR_OFFICER_NAME, rupiah(outstandingAde), 'Pool A + Pool B']);
  }
  if (role === 'master')
    piutangRows.push(['TOTAL OUTSTANDING', rupiah(outstandingSales + outstandingAde), 'Semua piutang']);
  block('PIUTANG (OUTSTANDING)', UI.RED, piutangRows);

  // COLLECTED — only relevant to Sales view (master full breakdown; Deden just his own). Skip for Ade.
  if (showSales) {
    const collRows = [['Oleh Sales (' + CONFIG.SALES_NAME + ')', rupiah(collDeden), 'Basis KPI Sales']];
    if (role === 'master') {
      collRows.push(['POS / online', rupiah(collPos), 'Tanpa salesman']);
      collRows.push(['Sales lain', rupiah(collOther), '']);
      collRows.push(['TOTAL COLLECTED', rupiah(collTotal), 'Exact dari receiptHistory']);
    }
    block('COLLECTED BULAN INI', UI.GREEN, collRows);
  }

  if (showSales) {
    const salesRows = [
      ['Skor KPI', (sales.totalScore * 100).toFixed(0) + '%', 'Maks 106%'],
      ['Base + Tunjangan + Komisi', rupiah(sales.base) + ' + ' + rupiah(sales.tunjangan) + ' + ' + rupiah(sales.commission), ''],
      ['THP Sales', rupiah(sales.thp), '→ ' + CONFIG.TABS.THP_SALES]
    ];
    if (role === 'master') salesRows.push(['Riwayat bulanan', '→ ' + CONFIG.TABS.THP_HISTORY, 'Arsip THP & skor tiap bulan']);
    block('THP SALES — ' + CONFIG.SALES_NAME, UI.BLUE, salesRows);
  }

  if (showAr) {
    const arRows = [
      ['Komisi diperoleh bln ini', rupiah(ar.komisi), 'Atas masuk kas (aging sejak handover)'],
      ['Pokok + Tunjangan Ops + Komisi', rupiah(ar.base) + ' + ' + rupiah(ar.ops) + ' + ' + rupiah(ar.komisi), 'Floor ' + rupiah(ar.floor)],
      ['THP ' + CONFIG.AR_OFFICER_NAME, rupiah(ar.thp), '→ ' + CONFIG.TABS.THP_ADE]
    ];
    if (role === 'master') arRows.push(['Riwayat bulanan', '→ ' + CONFIG.TABS.THP_HISTORY, 'Arsip THP & komisi tiap bulan']);
    block('THP AR OFFICER — ' + CONFIG.AR_OFFICER_NAME, UI.BLUE, arRows);
  }

  // BUSINESS HEALTH — folded into Ringkasan (master only) so the sheet keeps one strategic
  // screen instead of a separate tab. Needs 4 cols (aging + top debitur tables). `health`
  // is only passed in the master block; ade/deden get undefined → block skipped.
  let foot = 'Total invoice dari Accurate: ' + inv.length + '. Semua angka dihitung ulang tiap sync — jangan edit manual.';
  if (role === 'master' && health) {
    r = uiSection(sh, r, 4, '📊 BUSINESS HEALTH', UI.INK);
    r = writeHealthSections(sh, r, health, 4);
    sh.setColumnWidth(4, 160);
    foot += ' DSO = Total AR ÷ (billing 90 hari terakhir ÷ 90) — aproksimasi gross wholesale; makin kecil makin cepat tertagih. ' +
            'Snapshot harian disimpan di sheet tersembunyi "' + SNAP_SHEET + '".';
  }

  uiFootnote(sh, r, SPAN, foot);

  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(2, 240);
  sh.setColumnWidth(3, 340);
  sh.setFrozenRows(2);
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function rupiah(n) { return 'Rp' + Math.round(n).toLocaleString('id-ID'); }
