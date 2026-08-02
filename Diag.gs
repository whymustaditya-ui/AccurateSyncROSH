/**
 * DIAGNOSTIC v4 — learn the sales-receipt (Penerimaan Penjualan) list/detail shape,
 * so we can pull THIS MONTH's collections in a few paged calls instead of one
 * detail.do per paid invoice (which scales badly toward month-end).
 *
 * HOW TO RUN:
 *   1. Pick "diagReceipts" → Run ▶.
 *   2. Execution log → copy EVERYTHING → paste back to me.
 */
function diagReceipts() {
  Logger.log('===== sales-receipt/list.do — probe fields =====');

  // First, see what the list returns with a generous field request.
  const fieldList = [
    'id', 'number', 'transDate', 'transDateView',
    'customer', 'totalAmount', 'totalPayment', 'detailInvoice', 'chequeAmount'
  ].join(',');

  let list;
  try {
    list = accApi('/accurate/api/sales-receipt/list.do', {
      'sp.page': 1, 'sp.pageSize': 5, 'sp.sort': 'transDate|desc',
      'fields': fieldList
    });
  } catch (e) {
    Logger.log('list.do FAILED: ' + String(e).slice(0, 200));
    Logger.log('→ endpoint name may differ. Tell me and I will try alternates.');
    return;
  }

  const rows = (list && list.d) || [];
  Logger.log('Returned ' + rows.length + ' receipt rows. pageCount=' +
             (list.sp ? list.sp.pageCount : '?'));
  for (let i = 0; i < Math.min(2, rows.length); i++) {
    Logger.log('--- RAW RECEIPT ROW ' + i + ' ---');
    Logger.log(JSON.stringify(rows[i], null, 2));
    Logger.log('KEYS: ' + Object.keys(rows[i]).sort().join(', '));
  }

  // Now pull ONE receipt's detail to see how invoices + amounts are linked.
  if (rows.length) {
    const id = rows[0].id;
    Logger.log('===== sales-receipt/detail.do (id ' + id + ') =====');
    try {
      const det = accApi('/accurate/api/sales-receipt/detail.do', { id: id });
      const d = det && det.d;
      Logger.log('KEYS: ' + (d ? Object.keys(d).sort().join(', ') : '(none)'));
      Logger.log(JSON.stringify({
        number: d.number, transDate: d.transDate,
        totalPayment: d.totalPayment, totalAmount: d.totalAmount,
        detailInvoice: d.detailInvoice   // expect array linking to invoices + paid amount
      }, null, 2).slice(0, 3000));
    } catch (e) {
      Logger.log('detail.do FAILED: ' + String(e).slice(0, 200));
    }
  }
  Logger.log('===== END — copy everything above =====');
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILE — prove the bulk receipt path (buildReceiptsByInvoice, Sync.gs) matches
// the live per-invoice detail.do path EXACTLY before we switch enrichReceipts over.
// This drives KPI / commission = salary, so we never switch on trust. Read-only.
//
// HOW TO RUN: pick "diagReceiptReconcile" → Run ▶ → paste the Execution log.
//   "✅ AMAN" with 0 beda → safe to wire bulk into enrichReceipts.
//   any "✗ …" line       → do NOT switch; the line shows which invoice differs
//                           (usually void / PPh / multi-invoice) — send me the log.
// ─────────────────────────────────────────────────────────────────────────────
function diagReceiptReconcile() {
  const SAMPLE = 40;
  const t0 = Date.now();
  Logger.log('===== RECONCILE: bulk sales-receipt vs detail.do receiptHistory =====');

  const map = buildReceiptsByInvoice(null);                 // all-time, for a fair compare
  let nRec = 0; Object.keys(map).forEach(function(k) { nRec += map[k].length; });
  Logger.log('Bulk map: ' + Object.keys(map).length + ' invoice · ' + nRec + ' receipt lines · ' +
             ((Date.now() - t0) / 1000).toFixed(0) + 's');

  const invoices = fetchSalesInvoices();
  const withPay = invoices.filter(function(i) { return i.lastPaymentDate != null && i.id != null; });
  const n = Math.min(SAMPLE, withPay.length);
  Logger.log('Invoice ber-pembayaran: ' + withPay.length + ' · sampel ' + n + ' (detail.do per sampel)');

  let ok = 0, mism = 0;
  for (let i = 0; i < n; i++) {
    const inv = withPay[i];
    const cur  = _detailReceipts(inv.id);                   // current source of truth
    const bulk = map[inv.id] || [];
    const curSum  = Math.round(cur.reduce(function(s, r) { return s + r.amount; }, 0));
    const bulkSum = Math.round(bulk.reduce(function(s, r) { return s + r.amount; }, 0));
    if (curSum === bulkSum && cur.length === bulk.length) { ok++; }
    else {
      mism++;
      Logger.log('✗ ' + inv.number + ' (id ' + inv.id + '): detail.do Rp' + curSum + '/' + cur.length +
                 'x · bulk Rp' + bulkSum + '/' + bulk.length + 'x');
    }
  }
  Logger.log('HASIL: ' + ok + ' cocok · ' + mism + ' beda (dari ' + n + ') · total ' +
             ((Date.now() - t0) / 1000).toFixed(0) + 's');
  Logger.log(mism === 0
    ? '✅ AMAN — bulk == detail.do. Boleh switch enrichReceipts ke bulk.'
    : '⚠️ ADA SELISIH — JANGAN switch. Kirim log ini (kemungkinan void / PPh / multi-invoice).');
}

// Replicates enrichReceipts' invoice-side receipt extraction (the CURRENT source of
// truth) so the reconcile compares apples-to-apples. Keep in sync with the
// receiptHistory filter in enrichReceipts: APPROVED · not void · not PPh · amount>0.
function _detailReceipts(invId) {
  const det = accApi('/accurate/api/sales-invoice/detail.do', { id: invId });
  const d = det && det.d;
  const out = [];
  if (!d) return out;
  (d.receiptHistory || []).forEach(function(h) {
    if (h.approvalStatus !== 'APPROVED') return;
    if (h.historyIsVoidReceipt) return;
    if (h.historyIsPPhPayment) return;
    const pd = parseAccDate(h.historyDate);
    const amt = num(h.historyAmount);
    if (!pd || amt <= 0) return;
    out.push({ date: pd, amount: amt });
  });
  out.sort(function(a, b) { return a.date - b.date; });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULASI KEBIJAKAN — basis komisi 1,25% Deden: SEMUA kas vs kas PRE-HANDOVER saja
// ─────────────────────────────────────────────────────────────────────────────
// Konteks: satu rupiah yang ditagih Ade (kas cair setelah handoverDate = JT+15) sekarang
// dibayar DUA KALI — 1,25% ke Deden lewat komisi Sales, dan 1,5–3,5% ke Ade lewat komisi
// AR. Usulan: omzet (bobot 45%) tetap menghitung semua kas — Deden yang menciptakan
// penjualannya — tapi BASIS KOMISI dipotong ke kas yang cair sebelum faktur pindah tangan.
//
// Fungsi ini TIDAK mengubah perhitungan apa pun. Read-only, cuma mencetak angka pembanding
// per bulan supaya keputusan diambil pakai data. Jalankan dari editor ▸ Run, baca di log.
// @param nBulan berapa bulan ke belakang yang disimulasikan (default 3, termasuk bulan berjalan).
function diagKomisiPreHandover(nBulan) {
  // Guard: dipanggil dari menu → argumennya bisa berupa event object, bukan angka.
  const n = (typeof nBulan === 'number' && nBulan > 0) ? Math.floor(nBulan) : 3;
  const today = stripTime(new Date());
  Logger.log('===== SIMULASI basis komisi Deden — ' + n + ' bulan terakhir =====');
  Logger.log('Aturan sekarang : komisi = ' + (CONFIG.SALES_COMMISSION_RATE * 100) + '% × (SEMUA kas − ' +
             rupiah(CONFIG.SALES_COMMISSION_FLOOR) + ')');
  Logger.log('Usulan          : komisi = ' + (CONFIG.SALES_COMMISSION_RATE * 100) + '% × (kas PRE-handover − ' +
             rupiah(CONFIG.SALES_COMMISSION_FLOOR) + ')   · omzet & skor TIDAK berubah');
  Logger.log('');

  const invoices = _invoicesForRestamp(today);
  const mine = invoices.filter(function(i) { return i.salesman === CONFIG.SALES_NAME; });
  const komisiOf = function(v) {
    return Math.round(Math.max(0, v - CONFIG.SALES_COMMISSION_FLOOR) * CONFIG.SALES_COMMISSION_RATE);
  };
  let sumNow = 0, sumNew = 0;

  for (let k = n - 1; k >= 0; k--) {
    const ms = new Date(today.getFullYear(), today.getMonth() - k, 1);
    const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
    let all = 0, pre = 0;
    const postList = [];
    mine.forEach(function(i) {
      let postInv = 0;
      (i.receipts || []).forEach(function(r) {
        if (!r.date || r.date < ms || r.date >= me) return;
        all += num(r.amount);
        // pre-handover = kas cair sebelum faktur jadi tanggung jawab Ade (JT+15)
        if (!i.handoverDate || r.date < i.handoverDate) pre += num(r.amount);
        else postInv += num(r.amount);
      });
      if (postInv > 0) postList.push({ number: i.number, customer: i.customer, amount: postInv,
                                       dsh: Math.floor((today - i.handoverDate) / DAY_MS) });
    });
    const post = all - pre;
    const kNow = komisiOf(all), kNew = komisiOf(pre);
    sumNow += kNow; sumNew += kNew;

    Logger.log('── ' + _periodeLabel(Utilities.formatDate(ms, 'GMT+7', 'yyyy-MM')) +
               (k === 0 ? '  (bulan berjalan, belum penuh)' : ''));
    Logger.log('   Kas masuk total        : ' + rupiah(all));
    Logger.log('   ├─ pre-handover (Deden): ' + rupiah(pre) + '  (' + (all ? Math.round(pre / all * 100) : 0) + '%)');
    Logger.log('   └─ post-handover (Ade) : ' + rupiah(post) + '  (' + (all ? Math.round(post / all * 100) : 0) + '%) · ' +
               postList.length + ' faktur');
    Logger.log('   Komisi SEKARANG        : ' + rupiah(kNow));
    Logger.log('   Komisi USULAN          : ' + rupiah(kNew) + '   → selisih ' + rupiah(kNew - kNow));
    postList.sort(function(a, b) { return b.amount - a.amount; }).slice(0, 5).forEach(function(p) {
      Logger.log('      · post-handover: ' + p.number + ' · ' + p.customer + ' · ' + rupiah(p.amount));
    });
  }

  Logger.log('');
  Logger.log('TOTAL ' + n + ' bulan — komisi sekarang ' + rupiah(sumNow) + ' vs usulan ' + rupiah(sumNew) +
             '  → Deden ' + (sumNew < sumNow ? 'turun ' : 'naik ') + rupiah(Math.abs(sumNow - sumNew)) +
             ' (rata-rata ' + rupiah(Math.round(Math.abs(sumNow - sumNew) / n)) + '/bulan)');
  Logger.log('===== selesai — TIDAK ada perhitungan yang diubah =====');
}
