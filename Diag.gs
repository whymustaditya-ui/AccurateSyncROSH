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

// Sekali jalan setelah layout Rapor Customer / Turun Buku berubah (2026-09-05): kosongkan kolom
// kuning di kedua tab. Sync pertama pasca-perubahan sempat membaca kolom lama sebagai 🟡 dan
// menuliskannya kembali ke posisi baru, jadi sampahnya perlu dihapus sekali; sesudah itu pembaca
// header-aware + sanitasi menjaganya. Hanya menghapus Limit Disetujui/Catatan Nathan dan
// Status Konversi/Catatan yang SUDAH ada; kalau Nathan pernah mengisi, catat dulu sebelum jalan.
function clearYellowAfterLayoutChangeNow() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const wipe = function(tabName, headers) {
    const sh = ss.getSheetByName(tabName);
    if (!sh || sh.getLastRow() < 2) return 0;
    const vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    let n = 0;
    vals.forEach(function(row, i) {
      const cols = headers.map(function(h) { return row.indexOf(h); });
      if (cols.some(function(c) { return c < 0; })) return;
      // baris header ditemukan → bersihkan kolom itu dari baris berikutnya sampai baris kosong pertama
      let r = i + 2;
      while (r <= vals.length && String(vals[r - 1][0] || '').trim() !== '') {
        cols.forEach(function(c) { sh.getRange(r, c + 1).clearContent(); });
        n++; r++;
      }
    });
    return n;
  };
  const a = wipe(CONFIG.TABS.CUSTOMER, ['Limit Disetujui', 'Catatan Nathan']);
  const b = wipe(CONFIG.TABS.TURUN_BUKU, ['Status Konversi', 'Catatan']);
  Logger.log('Kolom kuning dibersihkan: Rapor ' + a + ' baris, Turun Buku ' + b + ' baris. Sekarang Run Full Sync.');
  try { SpreadsheetApp.getUi().alert('Kolom kuning dibersihkan: Rapor ' + a + ' baris, Turun Buku ' + b + ' baris. Sekarang jalankan Run Full Sync now.'); } catch (e) {}
}
