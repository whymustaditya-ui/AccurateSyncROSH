/**
 * ROSH × Accurate — Restock Engine (SKU tiering + reorder point + cash-capped PO).
 *
 * Turns invoice line-items (sales velocity + customer penetration) and the Accurate
 * item master (stok on-hand + harga beli) into a one-screen "beli SKU ini, sekian
 * karton, sekarang/tunda" list — supaya restock bukan lagi "feeling". Tiga layer:
 *
 *   1. TIER (importance)  — velocity 60% + penetration 40%, skor PERCENTILE (self-calibrating
 *                            ke katalog ROSH) → A/B/C/D. Window 6 bln (stabil).
 *   2. KAPAN & BERAPA      — demand RECENCY-weighted (EWMA mingguan) + normalisasi SKU baru.
 *                            Reorder point statistik: ROP = d×LT + Z[tier]×σ_LT (safety stock
 *                            ngikut volatilitas demand & lead time — anti supply acak).
 *                            Order-up-to S = ROP + d×cycle(tier). Inventory position = stok + on-order.
 *   3. CASH CAP            — rank SKU yang perlu order by Revenue-at-Risk ÷ biaya,
 *                            alokasi PO_BUDGET top-down → BELI SEKARANG vs TUNDA
 *
 * MASTER-ONLY (seperti Pesan/StopSupply/Health) — ditulis di blok master fullSync saja.
 *
 * Data acquisition:
 *   • `_ItemCache`     — item/list.do paged (scope `item_view`): stok (availableToSell) + cost
 *                        (vendorPrice) + leadTime (deliveryLeadTime). Cache tersembunyi.
 *   • `_SkuSalesCache` — line-item per invoice dari sales-invoice/detail.do, di-harvest
 *                        incremental + time-budgeted (tiru attachCustomerContacts), prune > window.
 *   • on-order PO      — purchase-order/list+detail.do (scope `purchase_order_view`), dihitung
 *                        tiap sync (volume kecil, tanpa cache) → buildOnOrderByItem().
 *
 * Reuse globals: accApi (Code.gs) · num, stripTime, DAY_MS, parseAccDate, _ss, SYNC_START,
 * _props (Code.gs) · rupiah (Kpi.gs) · UI + uiSheet/uiBanner/uiSection/uiHeaderRow/
 * uiFootnote/uiTintStatus (Style.gs).
 */

// ─────────────────────────────────────────────────────────────────────────────
// ITEM MASTER CACHE — stok on-hand + harga beli per SKU (item/list.do, butuh item_view)
// ─────────────────────────────────────────────────────────────────────────────
var ITEM_SHEET = '_ItemCache';
var ITEM_HEADERS = ['itemNo', 'name', 'unit', 'onHand', 'cost', 'leadTime'];

// Get-or-create cache; AUTO-MIGRATE schema lama (5 kolom tanpa leadTime) dengan wipe sekali
// → rebuild di refresh berikut. Pola _contactCacheSheet (Sync.gs).
function _itemCacheSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName(ITEM_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ITEM_SHEET);
    sh.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]);
    sh.hideSheet();
    return sh;
  }
  const hdr = sh.getRange(1, 1, 1, ITEM_HEADERS.length).getValues()[0];
  if (String(hdr[ITEM_HEADERS.length - 1]).trim() !== 'leadTime') {   // schema lama → migrate
    sh.clearContents();
    sh.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]);
  }
  return sh;
}

function _loadItemCache() {
  const sh = _itemCacheSheet();
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 6).getValues().forEach(function(r) {
      const no = String(r[0] || '');
      if (!no) return;
      map[no] = {
        name: r[1] || '',
        unit: r[2] || '',
        onHand: (r[3] === '' || r[3] == null) ? null : num(r[3]),  // '' = stok tak diketahui
        cost: num(r[4]),
        leadTime: num(r[5])                                          // 0 = pakai CONFIG.LEAD_TIME
      };
    });
  }
  return map;
}

function _saveItemCache(map) {
  const sh = _itemCacheSheet();
  const rows = Object.keys(map).map(function(no) {
    const m = map[no];
    return [no, m.name || '', m.unit || '', (m.onHand == null ? '' : m.onHand), m.cost || 0, m.leadTime || 0];
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 6).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 6).setValues(rows);
}

// Pull the full item master with stok + cost. CONFIRMED via diagItemFields() (2026-06-07):
// item/list.do HONOURS `fields` (unlike customer/list.do) → satu paged pull, murah, no detail.do.
//   onHand = availableToSell (stok bisa dijual, agregat semua gudang, satuan CTN)
//   cost   = vendorPrice (harga beli)
// Item `suspended` (disetop/discontinued) di-SKIP — jangan sarankan restock barang mati.
// Run every sync (stok harus fresh). Fallback field tetap defensif kalau build Accurate beda.
function refreshItemMaster() {
  const fields = ['id', 'no', 'name', 'suspended', 'availableToSell', 'quantity', 'balance',
                  'vendorPrice', 'averageCost', 'lastPurchasePrice', 'deliveryLeadTime'].join(',');
  const map = {};
  let page = 1;
  while (true) {
    const res = accApi('/accurate/api/item/list.do',
      { 'sp.page': page, 'sp.pageSize': 100, 'fields': fields });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) {
      if (r.suspended === true) return;                       // item disetop → tidak di-restock
      const no = r.no || r.itemNo || (r.id != null ? String(r.id) : '');
      if (!no) return;
      const onHand = (r.availableToSell != null) ? num(r.availableToSell)
                   : (r.quantity != null) ? num(r.quantity)
                   : (r.balance != null) ? num(r.balance) : null;
      const cost = num(r.vendorPrice != null ? r.vendorPrice
                     : (r.averageCost != null ? r.averageCost
                     : (r.lastPurchasePrice != null ? r.lastPurchasePrice : 0)));
      map[no] = { name: r.name || '', unit: 'CTN', onHand: onHand, cost: cost,
                  leadTime: num(r.deliveryLeadTime) };       // 0 → fallback CONFIG.LEAD_TIME saat compute
    });
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (page >= pc || rows.length === 0) break;
    page++;
    if (page > 50) break;  // safety
  }
  _saveItemCache(map);
  Logger.log('Item master: ' + Object.keys(map).length + ' SKU di-refresh');
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SKU SALES CACHE — line-item per invoice (qty, omzet, customer) di-harvest incremental.
// Satu baris per (invoice × item). Sentinel row (itemNo kosong) menandai invoice yang
// sudah di-harvest tapi tanpa line-item → tidak di-fetch ulang. Prune baris > window.
// Time-budgeted via SYNC_START — pola attachCustomerContacts (Sync.gs).
// ─────────────────────────────────────────────────────────────────────────────
var SKU_SALES_SHEET   = '_SkuSalesCache';
var SKU_SALES_HEADERS = ['invoiceId', 'transDate', 'itemNo', 'itemName', 'qty', 'lineTotal', 'customerId'];
var SKU_HARVEST_BUDGET_MS = 300000;  // berhenti ~5 menit → sisakan ≥1 menit untuk writers
var SKU_HARVEST_MAX       = 250;     // batas keras detail.do per run

function _skuSalesSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName(SKU_SALES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SKU_SALES_SHEET);
    sh.getRange(1, 1, 1, SKU_SALES_HEADERS.length).setValues([SKU_SALES_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}

function _loadSkuSalesCache() {
  const sh = _skuSalesSheet();
  const last = sh.getLastRow();
  const out = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 7).getValues().forEach(function(r) {
      out.push({
        invoiceId: r[0],
        transDate: parseAccDate(r[1]),
        itemNo: String(r[2] || ''),
        itemName: r[3] || '',
        qty: num(r[4]),
        lineTotal: num(r[5]),
        customerId: r[6]
      });
    });
  }
  return out;
}

function _loadHarvestedSet() {
  const sh = _skuSalesSheet();
  const last = sh.getLastRow();
  const set = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function(r) {
      if (r[0] !== '' && r[0] != null) set[r[0]] = true;
    });
  }
  return set;
}

function _appendSkuSales(rows) {
  const sh = _skuSalesSheet();
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 7).setValues(rows);
}

function _pruneSkuSales(winStart) {
  const sh = _skuSalesSheet();
  const last = sh.getLastRow();
  if (last < 2) return;
  const vals = sh.getRange(2, 1, last - 1, 7).getValues();
  const keep = vals.filter(function(r) { const d = parseAccDate(r[1]); return d && d >= winStart; });
  if (keep.length === vals.length) return;          // tidak ada yang basi
  sh.getRange(2, 1, last - 1, 7).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, 7).setValues(keep);
}

function harvestSkuSales(invoices, today) {
  const W = (CONFIG.RESTOCK && CONFIG.RESTOCK.WINDOW_MONTHS) || 6;
  const t = today || stripTime(new Date());
  const winStart = stripTime(new Date(t.getFullYear(), t.getMonth() - W, t.getDate()));

  const harvested = _loadHarvestedSet();
  const toAppend = [];
  let pulls = 0, fails = 0, skipped = 0;

  for (let k = 0; k < invoices.length; k++) {
    const inv = invoices[k];
    if (inv.id == null) continue;
    if (!inv.transDate || inv.transDate < winStart) continue;   // di luar window
    if (harvested[inv.id]) continue;                            // sudah di-cache
    if (pulls >= SKU_HARVEST_MAX ||
        (SYNC_START && (Date.now() - SYNC_START) > SKU_HARVEST_BUDGET_MS)) { skipped++; continue; }
    try {
      const det = accApi('/accurate/api/sales-invoice/detail.do', { id: inv.id });
      const d = det && det.d;
      const items = (d && (d.detailItem || d.detailItems || d.detailExpense)) || [];
      const dateStr = Utilities.formatDate(inv.transDate, 'GMT+7', 'yyyy-MM-dd');
      const cust = (inv.customerId != null) ? inv.customerId : '';
      if (!items.length) {
        toAppend.push([inv.id, dateStr, '', '', 0, 0, cust]);   // sentinel: harvested, no items
      } else {
        for (let j = 0; j < items.length; j++) {
          const it = items[j];
          const no = (it.item && (it.item.no || it.item.code)) || it.itemNo || it.no || '';
          const nm = (it.item && it.item.name) || it.detailName || it.itemName || it.name || '';
          const qty = num(it.quantity != null ? it.quantity : it.qty);
          const ltot = num(it.totalPrice != null ? it.totalPrice : (it.amount != null ? it.amount : 0));
          toAppend.push([inv.id, dateStr, no, nm, qty, ltot, cust]);
        }
      }
      harvested[inv.id] = true;
    } catch (e) { fails++; }                                     // biarkan → dicoba sync berikut
    pulls++;
    if (pulls % 25 === 0) Utilities.sleep(150);
  }

  if (toAppend.length) _appendSkuSales(toAppend);
  _pruneSkuSales(winStart);
  Logger.log('SKU harvest: ' + pulls + ' detail.do · ' + toAppend.length + ' baris' +
             (fails ? (' · ' + fails + ' gagal') : '') +
             (skipped ? (' · ' + skipped + ' ditunda (sync berikut)') : ' · lengkap'));
}

// ─────────────────────────────────────────────────────────────────────────────
// ON-ORDER PO — barang yang sudah di-PO tapi belum datang, per SKU. Inventory position =
// stok + on-order → anti double-order. purchase-order/list.do (open saja) + detail.do utk
// line-item. Volume PO terbuka kecil → tanpa cache, dihitung tiap sync. Butuh scope
// purchase_order_view. Fail-soft (caller wrap try). Field bervariasi → cek diagPurchaseFields().
// ─────────────────────────────────────────────────────────────────────────────
var PO_MAX_DETAIL  = 150;     // batas detail.do PO per run
var PO_BUDGET_MS   = 330000;  // berhenti ~5,5 menit (jaga 6-min limit)

// PO masih terbuka (ada barang belum datang) = percentShipped < 100. CONFIRMED via
// diagPurchaseFields() (2026-06-07): list.do balikin `percentShipped` (0=belum, 100=lunas terima)
// — filter bebas-bahasa, lebih andal dari status string. Fallback ke statusName kalau absen.
function _poIsOpen(r) {
  if (r && r.percentShipped != null) return num(r.percentShipped) < 100;
  const s = String((r && r.statusName) || '');
  if (!s) return true;                                  // tak ada info → anggap terbuka (konservatif)
  return !/terproses|penuh|full|closed|selesai|tutup|finished/i.test(s);  // "Sebagian diproses" tetap terbuka
}

function buildOnOrderByItem(today) {
  const map = {};                                       // itemNo → incomingQty (CTN)
  let page = 1, pulls = 0;
  const open = [];
  // 1) list semua PO (light) → saring yang masih jalan (percentShipped < 100)
  while (true) {
    const res = accApi('/accurate/api/purchase-order/list.do',
      { 'sp.page': page, 'sp.pageSize': 100, 'sp.sort': 'transDate|desc',
        'fields': ['id', 'number', 'statusName', 'percentShipped'].join(',') });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) { if (r.id != null && _poIsOpen(r)) open.push(r.id); });
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (page >= pc || rows.length === 0) break;
    page++;
    if (page > 50) break;
  }
  // 2) detail per PO terbuka → Σ remainingQuantity per item (barang belum datang, sudah
  //    memperhitungkan partial receipt). Fallback qty − received kalau field beda.
  for (let k = 0; k < open.length; k++) {
    if (pulls >= PO_MAX_DETAIL || (SYNC_START && (Date.now() - SYNC_START) > PO_BUDGET_MS)) break;
    try {
      const det = accApi('/accurate/api/purchase-order/detail.do', { id: open[k] });
      const d = det && det.d;
      const items = (d && (d.detailItem || d.detailItems || d.detailExpense)) || [];
      items.forEach(function(it) {
        const no = (it.item && (it.item.no || it.item.code)) || it.itemNo || it.no || '';
        if (!no) return;
        let incoming;
        if (it.remainingQuantity != null) {
          incoming = num(it.remainingQuantity);                 // belum datang (CONFIRMED field)
        } else {
          const qty = num(it.quantity != null ? it.quantity : it.qty);
          const recv = num(it.receivedQuantity != null ? it.receivedQuantity
                         : (it.shipQuantity != null ? it.shipQuantity : 0));
          incoming = qty - recv;
        }
        if (incoming > 0) map[no] = (map[no] || 0) + incoming;
      });
    } catch (e) { /* skip PO ini */ }
    pulls++;
    if (pulls % 25 === 0) Utilities.sleep(150);
  }
  Logger.log('On-order PO: ' + open.length + ' PO terbuka · ' + pulls + ' detail.do · ' +
             Object.keys(map).length + ' SKU punya barang jalan');
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SALDO BANK (PO_BUDGET auto) — tarik saldo akun kas/bank yang namanya cocok BANK_MATCH
// (mis. "Jago") dari glaccount/list.do (scope gl_account_view, read-only). Dipakai sbg
// budget restock = PO_BUDGET_PCT × saldo, KALAU Script Property PO_BUDGET kosong. Fail-soft.
// Field bervariasi → verifikasi diagCashBankFields() dulu. Return {name, balance} | null.
// ─────────────────────────────────────────────────────────────────────────────
function pullBankBalance() {
  const cfg = (CONFIG.RESTOCK && CONFIG.RESTOCK.BANK_MATCH) || [];
  const matches = (Array.isArray(cfg) ? cfg : [cfg])
    .map(function(s) { return String(s).toLowerCase(); }).filter(Boolean);
  if (!matches.length) return null;
  const fields = ['id', 'no', 'name', 'accountType', 'balance'].join(',');
  let page = 1; const accounts = [];
  while (true) {
    const res = accApi('/accurate/api/glaccount/list.do',
      { 'sp.page': page, 'sp.pageSize': 100, 'fields': fields });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) {
      if (String(r.accountType || '').toUpperCase() !== 'CASH_BANK') return;  // HANYA kas/bank — jangan jumlah piutang/persediaan/parent rollup non-cash
      const nm = String(r.name || '').toLowerCase();
      if (!matches.some(function(m) { return nm.indexOf(m) >= 0; })) return;
      const bal = (r.balance != null) ? num(r.balance)
                : (r.currentBalance != null) ? num(r.currentBalance)
                : (r.endingBalance != null) ? num(r.endingBalance) : null;
      if (bal == null) return;
      accounts.push({ name: r.name, balance: bal });   // JUMLAHKAN semua akun yang cocok (BCA Roshan + Jago)
    });
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (page >= pc || rows.length === 0) break;
    page++;
    if (page > 50) break;
  }
  if (!accounts.length) { Logger.log('Akun bank cocok (' + matches.join('/') + ') tidak ketemu di glaccount/list.do'); return null; }
  const total = accounts.reduce(function(s, a) { return s + a.balance; }, 0);
  Logger.log('Saldo kas/bank: ' + accounts.map(function(a) { return a.name + '=' + a.balance; }).join(', ') + ' → total ' + total);
  return { total: total, accounts: accounts };
}

// Baca cell budget manual yang diketik user di tab Restock (master). Dipanggil SEBELUM
// tab ditulis ulang (pola upsert) → angka yang diketik bertahan antar sync. Return Rp | null.
function _readRestockBudget() {
  try {
    const sh = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TABS.RESTOCK);
    if (!sh) return null;
    const last = Math.min(sh.getLastRow(), 20);
    if (last < 1) return null;
    const vals = sh.getRange(1, 1, last, 2).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!/^Budget restock \(ketik/i.test(String(vals[i][0]))) continue;
      const v = vals[i][1];
      if (v === '' || v == null) return null;
      if (typeof v === 'number') return v > 0 ? v : null;
      const digits = String(v).replace(/[^0-9]/g, '');   // "80.000.000" / "Rp80jt" → ambil digit saja
      return digits ? Number(digits) : null;
    }
  } catch (e) { Logger.log('Baca budget manual gagal: ' + e.message); }
  return null;
}

// DIAG — konfirmasi endpoint + field saldo kas/bank SEBELUM andalkan PO_BUDGET auto.
// Butuh scope gl_account_view aktif.
function diagCashBankFields() {
  try {
    const res = accApi('/accurate/api/glaccount/list.do',
      { 'sp.page': 1, 'sp.pageSize': 30, 'fields': ['id', 'no', 'name', 'accountType', 'balance'].join(',') });
    const rows = (res && res.d) || [];
    Logger.log('glaccount/list.do count: ' + rows.length);
    if (rows.length) {
      Logger.log('keys: ' + Object.keys(rows[0]).join(', '));
      rows.forEach(function(r) {
        Logger.log(JSON.stringify({ no: r.no, name: r.name, type: r.accountType, balance: r.balance }));
      });
    } else {
      Logger.log('Kosong — mungkin list.do balas {id} saja / scope kurang. Coba detail.do per akun.');
    }
  } catch (e) {
    Logger.log('glaccount/list.do GAGAL: ' + e.message +
      '\n→ Sudah tambah scope gl_account_view + forceReauthorize()? Atau nama scope/endpoint beda.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE — tier (percentile) + reorder (s,S statistik) + cash rank. No API call.
// ─────────────────────────────────────────────────────────────────────────────
function _bandScore(v, bands) {                 // mode 'absolute' (fallback)
  for (let i = 0; i < bands.length; i++) { if (v >= bands[i][0]) return bands[i][1]; }
  return bands.length ? bands[bands.length - 1][1] : 0;
}
function _restockTier(s, c) {
  if (s >= c.A) return 'A';
  if (s >= c.B) return 'B';
  if (s >= c.C) return 'C';
  return 'D';
}
// Alokasi cash-cap: items SUDAH urut prioritas (RaR÷biaya). Greedy isi budget — item yang
// overflow di-skip (TUNDA), item lebih murah di belakang masih bisa masuk. Return tiap item
// + {beli, cumAfter} (cumAfter = total komit setelah item ini; cuma naik saat BELI). budget
// 0/null → semua BELI (tanpa cap). Dipakai bareng writeRestockTab + onEdit live re-rank.
// Tulis 1 block (merge col c1..c2) + isi nilai. Return range utk chaining format.
function _mblock(sh, row, c1, c2, value) {
  const rng = sh.getRange(row, c1, 1, c2 - c1 + 1);
  if (c2 > c1) rng.merge();
  rng.setValue(value).setVerticalAlignment('middle');
  return rng;
}
function _allocateCart(items, budget) {
  let cum = 0;
  return items.map(function(x) {
    const cost = num(x.estCost);
    let beli;
    if (!budget) { beli = true; cum += cost; }
    else if (cum + cost <= budget) { beli = true; cum += cost; }
    else beli = false;
    return { no: x.no, name: x.name, qty: x.qty != null ? x.qty : x.orderQty,
             cost: x.cost, estCost: cost, beli: beli, cumAfter: cum,
             rar: x.rar || 0, tier: x.tier || '' };
  });
}
// Skor 1–5 percentile (self-calibrating). sortedAsc = semua nilai katalog urut naik;
// cuts desc (mis. [.8,.6,.4,.2]) → top 20%→5, 60–80%→4, …, bottom 20%→1.
function _percentileScore(value, sortedAsc, cuts) {
  if (!sortedAsc.length) return 1;
  let below = 0;
  for (let i = 0; i < sortedAsc.length; i++) { if (sortedAsc[i] < value) below++; else break; }
  const pct = below / sortedAsc.length;
  for (let i = 0; i < cuts.length; i++) { if (pct >= cuts[i]) return 5 - i; }
  return 1;
}

// Demand engine v3 — "demand konsisten": (1) WINSORIZE tiap pesanan ke persentil WINSOR_PCT →
// buang one-time hit (pesanan abnormal besar dari pembeli sekali-beli), pola batch normal tetap;
// (2) rata-rata harian winsorized atas hari aktif (robust + fail-safe); (3) GROWTH: rate
// GROWTH_RECENT_WEEKS terakhir vs sebelumnya → proyeksi NAIK dibatasi GROWTH_CAP. σ utk safety stock.
// BUKAN EWMA (overreact ke batch terakhir). Menangani SKU baru (minggu sejak first-sale).
function _demandStats(rows, today) {
  const R = CONFIG.RESTOCK;
  const weeks = R.RECENT_WEEKS || 12;
  const horizon = stripTime(new Date(today.getFullYear(), today.getMonth(), today.getDate() - weeks * 7));

  // baris pesanan dalam window + first-sale
  let firstSale = null;
  const lines = [];                             // { idx (minggu, 0=terbaru), qty }
  rows.forEach(function(r) {
    if (r.transDate && (firstSale == null || r.transDate < firstSale)) firstSale = r.transDate;
    if (!r.transDate || r.transDate < horizon) return;
    let idx = Math.floor(Math.floor((today - r.transDate) / DAY_MS) / 7);
    if (idx < 0) idx = 0;
    if (idx < weeks && num(r.qty) > 0) lines.push({ idx: idx, qty: num(r.qty) });
  });

  // (1) WINSORIZE — cap tiap pesanan di persentil WINSOR_PCT ukuran pesanan SKU ini. One-time hit
  // (1 pesanan jumbo) ke-trim ke level normal; kalau memang sering batch besar, persentil tinggi → cap longgar.
  let cap = Infinity;
  const sortedQ = lines.map(function(l) { return l.qty; }).sort(function(a, b) { return a - b; });
  if (sortedQ.length >= 5) {
    const pi = Math.min(sortedQ.length - 1, Math.floor((R.WINSOR_PCT || 0.9) * (sortedQ.length - 1)));
    cap = sortedQ[pi];
  }

  // minggu "hidup" sejak first-sale (SKU baru tidak diencerkan nol)
  let liveWeeks = weeks;
  if (firstSale) {
    const ageFirst = Math.floor((today - firstSale) / DAY_MS);
    liveWeeks = Math.min(weeks, Math.max(1, Math.ceil((ageFirst + 1) / 7)));
  }
  const wk = [];                                // index 0 = minggu terbaru (winsorized)
  for (let i = 0; i < liveWeeks; i++) wk.push(0);
  lines.forEach(function(l) { if (l.idx < liveWeeks) wk[l.idx] += Math.min(l.qty, cap); });

  // (2) demand harian "rutin" = rata-rata winsorized atas hari aktif
  const ageDays = firstSale ? (Math.floor((today - firstSale) / DAY_MS) + 1) : (weeks * 7);
  const activeDays = Math.max(7, Math.min(liveWeeks * 7, ageDays));
  const totalQ = wk.reduce(function(s, v) { return s + v; }, 0);
  let d = totalQ / activeDays;

  // (3) GROWTH — rate GROWTH_RECENT_WEEKS terakhir vs sebelumnya. Faktor cuma NAIK (≥1) & dibatasi
  // GROWTH_CAP → nangkep tren tumbuh tanpa over-extrapolate. Tren turun TIDAK menurunkan d (konservatif).
  const gw = R.GROWTH_RECENT_WEEKS || 4;
  let growth = 1;
  if (liveWeeks >= gw * 2) {
    let recent = 0, older = 0;
    for (let i = 0; i < liveWeeks; i++) { if (i < gw) recent += wk[i]; else older += wk[i]; }
    const recentRate = recent / (gw * 7);
    const olderRate = older / ((liveWeeks - gw) * 7);
    if (olderRate > 0) growth = Math.max(1, Math.min(recentRate / olderRate, R.GROWTH_CAP || 1.25));
  }
  d = d * growth;

  // σ mingguan (winsorized) + bound CV (floor MIN_CV, plafon MAX_CV)
  const dWeekly = d * 7;
  let sigmaWeekly;
  if (wk.length >= 2) {
    const mean = wk.reduce(function(s, v) { return s + v; }, 0) / wk.length;
    const varr = wk.reduce(function(s, v) { return s + (v - mean) * (v - mean); }, 0) / (wk.length - 1);
    sigmaWeekly = Math.sqrt(varr);
  } else {
    sigmaWeekly = dWeekly;                       // data tipis → asumsi CV 1
  }
  sigmaWeekly = Math.max(sigmaWeekly, dWeekly * (R.MIN_CV || 0.25));
  if (R.MAX_CV) sigmaWeekly = Math.min(sigmaWeekly, dWeekly * R.MAX_CV);

  return { d: d, sigmaWeekly: sigmaWeekly, firstSale: firstSale, growth: growth };
}

function computeRestock(invoices, today, onOrderMap, bankInfo) {
  const R = CONFIG.RESTOCK;
  const W = R.WINDOW_MONTHS || 6;
  const winStart = stripTime(new Date(today.getFullYear(), today.getMonth() - W, today.getDate()));
  const windowDays = Math.max(1, Math.round((today - winStart) / DAY_MS));
  const monthsSpan = Math.max(1 / 30, windowDays / 30);
  const onOrder = onOrderMap || {};

  // 1) group cache rows per SKU (window) — simpan baris untuk demand engine + agg tier/RaR
  const grp = {};            // itemNo → { name, rows, qty, omzet, custSet }
  let totalOmzet = 0;
  _loadSkuSalesCache().forEach(function(r) {
    if (!r.itemNo) return;                                  // sentinel
    if (!r.transDate || r.transDate < winStart) return;     // di luar window
    const g = grp[r.itemNo] || (grp[r.itemNo] = { name: r.itemName || '', rows: [], qty: 0, omzet: 0, custSet: {} });
    g.rows.push(r);
    g.qty += r.qty;
    g.omzet += r.lineTotal;
    if (r.customerId != null && r.customerId !== '') g.custSet[r.customerId] = true;
    if (!g.name && r.itemName) g.name = r.itemName;
    totalOmzet += r.lineTotal;
  });

  const items = _loadItemCache();

  // 2) pre-compute metrik tier + demand stats per SKU
  const pre = Object.keys(grp).map(function(no) {
    const g = grp[no];
    return { no: no, g: g, ds: _demandStats(g.rows, today),
             perMonth: g.qty / monthsSpan, custCount: Object.keys(g.custSet).length };
  });

  // 3) skor velocity + penetrasi (percentile self-calibrating, atau absolute fallback)
  let velSorted = [], penSorted = [];
  if (R.BAND_MODE === 'percentile') {
    velSorted = pre.map(function(p) { return p.perMonth; }).sort(function(a, b) { return a - b; });
    penSorted = pre.map(function(p) { return p.custCount; }).sort(function(a, b) { return a - b; });
  }
  const scoreOf = function(p) {
    let v, pn;
    if (R.BAND_MODE === 'percentile') {
      v  = _percentileScore(p.perMonth, velSorted, R.PERCENTILE_CUTS);
      pn = _percentileScore(p.custCount, penSorted, R.PERCENTILE_CUTS);
    } else {
      v  = _bandScore(p.perMonth, R.VELOCITY_BANDS);
      pn = _bandScore(p.custCount, R.PENETRATION_BANDS);
    }
    return v * R.WEIGHT_VELOCITY + pn * R.WEIGHT_PEN;
  };

  // 4) per SKU — tier + reorder (s,S) statistik + inventory position
  const rows = pre.map(function(p) {
    const no = p.no, g = p.g, ds = p.ds;
    const m = items[no] || null;
    const name = (m && m.name) || g.name || no;
    const onHand = (m && m.onHand != null) ? m.onHand : null;
    const cost = (m && m.cost) ? m.cost : 0;
    const leadTime = (m && m.leadTime > 0) ? m.leadTime : R.LEAD_TIME;
    const onOrd = num(onOrder[no]);

    const score = scoreOf(p);
    const tier = _restockTier(score, R.TIER_CUTOFFS);
    const d = ds.d;                                          // demand harian (recency)

    // safety stock statistik: σ atas lead time (demand var + lead-time var, formula King)
    const sigmaDaily = ds.sigmaWeekly / Math.sqrt(7);
    const sigmaLTdays = leadTime * (R.LT_CV || 0);
    const sigmaLT = Math.sqrt(leadTime * sigmaDaily * sigmaDaily + d * d * sigmaLTdays * sigmaLTdays);
    const z = (R.SERVICE_Z[tier] != null) ? R.SERVICE_Z[tier] : 1.28;
    const SS = z * sigmaLT;
    const ROP = Math.round(d * leadTime + SS);
    // order-up-to = ROP + cycle stock, TAPI diplafon MAX_COVER_DAYS hari-stok (anti over-order
    // dari σ lumpy) — tetap dijaga ≥ ROP supaya order minimal menutup titik reorder.
    let S = Math.round(ROP + d * R.CYCLE_DAYS[tier]);
    if (R.MAX_COVER_DAYS && R.MAX_COVER_DAYS[tier]) {
      S = Math.min(S, Math.max(ROP, Math.round(d * R.MAX_COVER_DAYS[tier])));
    }

    const ip = (onHand == null) ? null : onHand + onOrd;     // inventory position
    const coverNow = (ip != null && d > 0) ? Math.round(ip / d) : null;

    // hitung saran order DULU, status ngikut: 🔴 cuma kalau beneran ada yang diorder (≥1).
    // Menghindari kasus "Order Sekarang" tapi Saran Order 0 (Posisi pas di target tipis).
    let status, orderQty;
    if (onHand == null)      { status = '⚪ Stok tak diketahui'; orderQty = null; }
    else if (d <= 0)         { status = '⚪ Tanpa demand';       orderQty = 0; }
    else {
      orderQty = Math.max(0, Math.ceil(S - ip));
      if (orderQty >= 1)           status = '🔴 Order Sekarang';
      else if (ip <= ROP * 1.2)    status = '🟡 Mendekati';
      else                         status = '🟢 Aman';
    }

    const rar = totalOmzet > 0 ? g.omzet / totalOmzet : 0;
    const estCost = (orderQty && cost) ? Math.round(orderQty * cost) : 0;

    return { no: no, name: name, tier: tier, score: score,
             perMonth: p.perMonth, custCount: p.custCount, growth: ds.growth,
             onHand: onHand, onOrder: onOrd, ip: ip, coverNow: coverNow,
             d: d, leadTime: leadTime, SS: Math.round(SS),
             S: S, ROP: ROP, status: status, orderQty: orderQty, estCost: estCost,
             rar: rar, cost: cost, buyRank: '' };
  });

  // 5) cash rank di antara SKU yang perlu order — Revenue-at-Risk per rupiah biaya.
  // Budget (prioritas): ① cell ketik di sheet → ② Script Property PO_BUDGET → ③ total Kas&Bank (BCA+Jago) → ④ default.
  const manualCell = _readRestockBudget();
  const budgetRaw = _props().getProperty(R.PO_BUDGET_PROP);
  let budget = 0, budgetSrc = '';
  if (manualCell && manualCell > 0) {
    budget = manualCell; budgetSrc = 'manual (ketik di sheet)';
  } else if (budgetRaw && num(budgetRaw) > 0) {
    budget = num(budgetRaw); budgetSrc = 'manual (Script Property PO_BUDGET)';
  } else if (bankInfo && bankInfo.total > 0) {
    budget = Math.round(bankInfo.total);
    budgetSrc = 'auto saldo Kas & Bank (' +
      bankInfo.accounts.map(function(a) { return a.name; }).join(' + ') + ')';
  } else if (R.PO_BUDGET_DEFAULT) {            // fallback terakhir: default CONFIG
    budget = R.PO_BUDGET_DEFAULT; budgetSrc = 'default CONFIG';
  }
  const needers = rows.filter(function(x) { return x.orderQty && x.orderQty > 0; })
    .sort(function(a, b) {
      const ra = a.estCost > 0 ? a.rar / a.estCost : a.rar * 1e-12;   // tanpa cost → urut by RaR saja
      const rb = b.estCost > 0 ? b.rar / b.estCost : b.rar * 1e-12;
      return rb - ra;
    });
  let cum = 0, n = 0, withinTotal = 0;
  needers.forEach(function(x) {
    n += 1;
    if (!budget) { x.buyRank = 'BELI #' + n; return; }               // budget kosong → tampil semua
    if (cum + x.estCost <= budget) { cum += x.estCost; withinTotal += x.estCost; x.buyRank = 'BELI #' + n; }
    else { x.buyRank = 'TUNDA'; }
  });
  const recommendSpend = needers.reduce(function(s, x) { return s + x.estCost; }, 0);
  // daftar belanja (urut prioritas, budget-independent) — dirender sbg section 🛒 + dipakai onEdit live.
  const cartItems = needers.map(function(x) {
    return { no: x.no, name: x.name, qty: x.orderQty, cost: x.cost, estCost: x.estCost,
             rar: x.rar, tier: x.tier };
  });

  // coverage harvest: berapa invoice dalam window yang line-item-nya sudah ketarik. Kalau
  // belum 100%, qty/demand under-count → angka BELUM final (surface ke RINGKAS sbg warning).
  const harvestedSet = _loadHarvestedSet();
  let invWin = 0, invHarv = 0;
  invoices.forEach(function(i) {
    if (i && i.id != null && i.transDate && i.transDate >= winStart) { invWin++; if (harvestedSet[i.id]) invHarv++; }
  });

  // 6) display sort: status (perlu aksi dulu) → RaR desc
  const sp = { '🔴 Order Sekarang': 0, '🟡 Mendekati': 1, '🟢 Aman': 2, '⚪ Stok tak diketahui': 3, '⚪ Tanpa demand': 4 };
  rows.sort(function(a, b) {
    const da = sp[a.status] != null ? sp[a.status] : 9;
    const db = sp[b.status] != null ? sp[b.status] : 9;
    if (da !== db) return da - db;
    return b.rar - a.rar;
  });

  // sembunyikan SKU tak-aktif (⚪ Stok tak diketahui / Tanpa demand) — noise buat daftar beli.
  // Tapi kalau SEMUA baris ⚪ (mis. item master belum ke-load), tetap tampilkan biar warningnya kelihatan.
  let displayRows = rows;
  if (R.HIDE_INACTIVE !== false) {
    const active = rows.filter(function(x) { return !/^⚪/.test(x.status); });
    if (active.length) displayRows = active;
  }

  return {
    rows: displayRows,
    totals: { recommendSpend: recommendSpend, budget: budget, budgetSrc: budgetSrc, manualBudget: manualCell,
              withinBudget: withinTotal, needCount: needers.length,
              harvestDone: invHarv, harvestTotal: invWin, harvestPending: (invWin - invHarv) },
    windowDays: windowDays, totalOmzet: totalOmzet, onOrderKnown: !!onOrderMap,
    bankAccounts: (bankInfo && bankInfo.accounts) || null,
    cartItems: cartItems
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE — tab 📦 Restock Engine (master-only)
// ─────────────────────────────────────────────────────────────────────────────
function writeRestockTab(restock) {
  const R = CONFIG.RESTOCK;
  const sh = uiSheet(CONFIG.TABS.RESTOCK);
  const SPAN = 19;
  const t = (restock && restock.totals) || {};
  const bandLabel = (R.BAND_MODE === 'percentile') ? 'percentile (self-calibrating)' : 'absolute';
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📦 Restock Engine — saran pembelian per SKU',
    'Tier ' + bandLabel + ' (velocity ' + Math.round(R.WEIGHT_VELOCITY * 100) + '% + penetrasi ' +
    Math.round(R.WEIGHT_PEN * 100) + '%) · demand recency-weighted · reorder point statistik (safety Z×σ) · ' +
    'posisi = stok + on-order · prioritas Revenue-at-Risk. Window tier ' + R.WINDOW_MONTHS + ' bln · ' +
    'master-only · update ' + Utilities.formatDate(new Date(), 'GMT+7', 'dd/MM/yyyy HH:mm'),
    UI.INK, UI.BAND);
  r += 1;

  // ── RINGKAS BELANJA ──
  r = uiSection(sh, r, SPAN, 'RINGKAS BELANJA', UI.GREEN);
  const budget = t.budget || 0;
  const dataStatus = (t.harvestTotal == null) ? '—'
    : (t.harvestPending > 0
        ? '⚠ ' + t.harvestDone + '/' + t.harvestTotal + ' invoice ketarik — ' + t.harvestPending +
          ' BELUM. Angka belum final, Run Full Sync lagi sampai lengkap'
        : '✓ lengkap (' + t.harvestTotal + ' invoice)');
  const accounts = (restock && restock.bankAccounts) || [];
  const saldoTotal = accounts.reduce(function(s, a) { return s + a.balance; }, 0);
  const saldoStr = accounts.length
    ? accounts.map(function(a) { return a.name + ' ' + rupiah(a.balance); }).join(' + ') + ' = ' + rupiah(saldoTotal)
    : '⚠ saldo bank belum ketarik (cek scope glaccount_view → forceReauthorize)';

  const writeRow = function(label, value) {
    sh.getRange(r, 1, 1, 4).setValues([[label, value, '', '']]).setVerticalAlignment('middle');
    sh.getRange(r, 1).setFontWeight('bold');
    sh.getRange(r, 2).setFontColor(UI.NOTE);
    r += 1;
  };

  writeRow('Data line-item (harvest)', dataStatus);
  writeRow('SKU perlu order', String(t.needCount || 0));
  writeRow('Total saran belanja', rupiah(t.recommendSpend || 0));

  // Budget restock — CELL EDITABLE 🟡 (user ketik), info saldo Kas&Bank di sampingnya.
  sh.getRange(r, 1).setValue('Budget restock (ketik →)').setFontWeight('bold').setVerticalAlignment('middle');
  const inputCell = sh.getRange(r, 2);
  inputCell.setValue((t.manualBudget && t.manualBudget > 0) ? t.manualBudget : '')
    .setBackground(UI.T_AMBER).setFontWeight('bold').setHorizontalAlignment('right')
    .setNumberFormat('#,##0').setBorder(true, true, true, true, false, false);
  sh.getRange(r, 3, 1, 10).merge()                                  // lebar (col3-12) + no-wrap → 1 baris, row tak melar
    .setValue('Kosongkan → auto pakai saldo: ' + saldoStr)
    .setFontColor(UI.NOTE).setWrap(false).setVerticalAlignment('middle');
  sh.setRowHeight(r, 22);
  r += 1;

  writeRow('Budget dipakai', budget
    ? (rupiah(budget) + '  ·  ' + (t.budgetSrc || ''))
    : '— belum ada → tampil semua SKU, urut RaR');
  writeRow('Belanja dalam budget', budget ? rupiah(t.withinBudget || 0) : '—');
  writeRow('On-order PO', (restock && restock.onOrderKnown) ? 'Dihitung (posisi = stok + PO jalan)' : '⚠ belum (cek scope purchase_order_view)');
  r += 1;

  // ── 🛒 DAFTAR BELANJA (kartu belanja sesuai budget) ──
  // Kolom pakai MERGED block (col money sempit di DAFTAR SKU → ### kalau tak di-merge).
  // Block: [1]# · [2]SKU · [3]Tier · [4]RaR% · [5-9]Nama · [10-11]Qty · [12-13]Harga · [14-15]Subtotal · [16-17]Kumulatif · [18-19]Aksi.
  r = uiSection(sh, r, SPAN, '🛒 DAFTAR BELANJA — beli ini, segini, urut prioritas (ikut budget di atas)', UI.GOLD);
  const CART_BLOCKS = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 9], [10, 11], [12, 13], [14, 15], [16, 17], [18, 19]];
  const cartHdr = ['#', 'SKU', 'Tier', 'RaR%', 'Nama', 'Qty (CTN)', 'Harga/CTN', 'Subtotal', 'Kumulatif', 'Aksi'];
  CART_BLOCKS.forEach(function(b, j) {
    _mblock(sh, r, b[0], b[1], cartHdr[j]).setBackground(UI.INK).setFontColor(UI.WHITE)
      .setFontWeight('bold').setVerticalAlignment('middle');
  });
  r += 1;
  const cartStart = r;
  const allocated = _allocateCart((restock && restock.cartItems) || [], budget);
  if (!allocated.length) {
    sh.getRange(r, 1, 1, SPAN).merge()
      .setValue('Tidak ada SKU yang perlu diorder sekarang (semua 🟢 Aman / stok belum diketahui).')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r += 1;
  } else {
    const cartTierTint = { A: UI.T_GREEN, B: UI.BLUE_SOFT, C: UI.T_AMBER, D: UI.T_GREY };
    allocated.forEach(function(x, i) {
      const row = cartStart + i;
      _mblock(sh, row, 1, 1, i + 1).setHorizontalAlignment('center');
      _mblock(sh, row, 2, 2, x.no);
      _mblock(sh, row, 3, 3, x.tier || '').setFontWeight('bold').setHorizontalAlignment('center')
        .setBackground(cartTierTint[x.tier] || UI.WHITE);
      _mblock(sh, row, 4, 4, x.rar || '').setNumberFormat('0.0%').setHorizontalAlignment('right');
      _mblock(sh, row, 5, 9, x.name);
      _mblock(sh, row, 10, 11, x.qty).setNumberFormat('#,##0').setHorizontalAlignment('right');
      _mblock(sh, row, 12, 13, x.cost || '').setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
      _mblock(sh, row, 14, 15, x.estCost || '').setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
      _mblock(sh, row, 16, 17, x.beli ? x.cumAfter : '').setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
      _mblock(sh, row, 18, 19, x.beli ? '✅ BELI' : '⏸ TUNDA')
        .setBackground(x.beli ? UI.T_GREEN : UI.T_RED).setFontWeight('bold').setHorizontalAlignment('center');
    });
    r = cartStart + allocated.length;
    const totalBeli = allocated.reduce(function(s, x) { return s + (x.beli ? x.estCost : 0); }, 0);
    _mblock(sh, r, 1, 13, 'TOTAL BELANJA (yang ✅ BELI)').setFontWeight('bold').setHorizontalAlignment('right');
    _mblock(sh, r, 14, 15, totalBeli).setNumberFormat('"Rp"#,##0').setFontWeight('bold')
      .setBackground(UI.T_GREEN).setHorizontalAlignment('right');
    _mblock(sh, r, 16, 19, budget ? ('sisa budget ' + rupiah(Math.max(0, budget - totalBeli))) : 'budget tak diset → semua BELI')
      .setFontColor(UI.NOTE);
    r += 1;
  }
  r += 1;

  // ── DAFTAR SKU ──
  r = uiSection(sh, r, SPAN, 'DAFTAR SKU — urut: perlu aksi dulu, lalu Revenue-at-Risk', UI.INK);
  const headers = ['SKU', 'Nama', 'Tier', 'Skor', 'Demand/bln', 'Cust Unik', 'Stok', 'On Order', 'Posisi',
                   'Hari Cover', 'Target Stok', 'Reorder Pt', 'Status', 'Saran Order', 'Est. Biaya', 'RaR %', 'Prioritas Beli'];
  uiHeaderRow(sh, r, headers); r += 1;
  const dataStart = r;

  const rows = (restock && restock.rows) || [];
  if (!rows.length) {
    sh.getRange(r, 1, 1, SPAN).merge()
      .setValue('Belum ada data SKU. Pastikan scope item_view sudah di-grant (forceReauthorize) + jalankan ' +
                '"Refresh Restock", lalu Full Sync beberapa kali untuk drain harvest line-item.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r += 1;
  } else {
    const tierTint = { A: UI.T_GREEN, B: UI.BLUE_SOFT, C: UI.T_AMBER, D: UI.T_GREY };
    const matrix = rows.map(function(x) {
      return [
        x.no, x.name, x.tier, Math.round(x.score * 100) / 100,
        Math.round(x.d * 30), x.custCount,           // demand bulanan basis hitungan (recency 12 mgg), bukan rata-rata 6 bln
        (x.onHand == null ? '—' : Math.round(x.onHand)),
        (x.onOrder > 0 ? Math.round(x.onOrder) : ''),
        (x.ip == null ? '—' : Math.round(x.ip)),
        (x.coverNow == null ? '—' : x.coverNow),
        x.S, x.ROP, x.status,
        (x.orderQty == null ? '—' : (x.orderQty > 0 ? x.orderQty : '')),
        (x.estCost > 0 ? x.estCost : ''),
        x.rar,
        x.buyRank || ''
      ];
    });
    sh.getRange(dataStart, 1, matrix.length, SPAN).setValues(matrix).setVerticalAlignment('middle');

    const statusTint = function(s) {
      if (/^🔴/.test(s)) return UI.T_RED;
      if (/^🟡/.test(s)) return UI.T_AMBER;
      if (/^🟢/.test(s)) return UI.T_GREEN;
      return UI.T_GREY;                       // ⚪ tak diketahui / tanpa demand
    };
    for (let i = 0; i < rows.length; i++) {
      const rr = dataStart + i, x = rows[i];
      sh.getRange(rr, 3).setFontWeight('bold').setHorizontalAlignment('center').setBackground(tierTint[x.tier] || UI.WHITE);
      if (x.growth && x.growth > 1.05) sh.getRange(rr, 5).setBackground(UI.T_GREEN).setFontColor(UI.GREEN);  // tren naik (growth diproyeksi)
      sh.getRange(rr, 13).setBackground(statusTint(x.status));
      if (/BELI/.test(x.buyRank)) sh.getRange(rr, 17).setBackground(UI.T_GREEN).setFontWeight('bold');
      else if (/TUNDA/.test(x.buyRank)) sh.getRange(rr, 17).setBackground(UI.T_RED);
    }

    const n = rows.length;
    sh.getRange(dataStart, 4, n, 1).setNumberFormat('0.00');
    sh.getRange(dataStart, 5, n, 1).setNumberFormat('#,##0');
    sh.getRange(dataStart, 7, n, 6).setNumberFormat('#,##0');     // Stok..Reorder Pt (7-12)
    sh.getRange(dataStart, 14, n, 1).setNumberFormat('#,##0');    // Saran Order
    sh.getRange(dataStart, 15, n, 1).setNumberFormat('"Rp"#,##0');// Est. Biaya
    sh.getRange(dataStart, 16, n, 1).setNumberFormat('0.0%');     // RaR %
    sh.getRange(dataStart, 4, n, 9).setHorizontalAlignment('right');   // Skor..Reorder Pt
    sh.getRange(dataStart, 14, n, 3).setHorizontalAlignment('right');  // Saran..RaR
    r = dataStart + n;
  }
  r += 1;

  r = uiFootnote(sh, r, SPAN,
    'Demand/bln = demand "rutin" ' + R.RECENT_WEEKS + ' minggu terakhir: tiap pesanan di-winsorize ' +
    '(cap persentil ' + Math.round((R.WINSOR_PCT || 0.9) * 100) + ' → buang one-time hit) + proyeksi growth (maks +' +
    Math.round(((R.GROWTH_CAP || 1.25) - 1) * 100) + '%). Sel hijau = tren naik terdeteksi. SKU baru dibagi hari sejak jual pertama. ' +
    'Reorder Point = demand×leadTime + safety; safety = Z[tier]×σ ' +
    '(service level A~97.5%/B~95%/C~90%/D~85%, σ ikut volatilitas demand + variasi lead time ' + Math.round((R.LT_CV || 0) * 100) + '%). ' +
    'Lead time per item dari Accurate (deliveryLeadTime), fallback ' + R.LEAD_TIME + ' hari. ' +
    'Target Stok = Reorder Point + demand × cycle/tier (A ' + R.CYCLE_DAYS.A + '/B ' + R.CYCLE_DAYS.B + '/C ' + R.CYCLE_DAYS.C + '/D ' + R.CYCLE_DAYS.D + ' hari), ' +
    'diplafon MAX_COVER (A ' + R.MAX_COVER_DAYS.A + '/B ' + R.MAX_COVER_DAYS.B + '/C ' + R.MAX_COVER_DAYS.C + '/D ' + R.MAX_COVER_DAYS.D + ' hari) + σ di-cap CV ' + R.MAX_CV + ' → anti over-order demand lumpy. ' +
    'Posisi = Stok (availableToSell) + On Order (PO jalan). Posisi ≤ Reorder Point → 🔴 order (Target − Posisi). ' +
    'Tier ' + bandLabel + '. Satuan CTN. Prioritas Beli = Revenue-at-Risk ÷ harga beli; set "' + R.PO_BUDGET_PROP + '" (Rp) untuk cap modal.');
  r += 1;

  // ── CARA BACA (buat partner) ──
  r = uiSection(sh, r, SPAN, '📖 CARA BACA — arti tiap kolom', UI.GOLD);
  sh.getRange(r, 1, 1, SPAN).merge()
    .setValue('Cara pakai cepat: KETIK budget di cell kuning "Budget restock (ketik →)" di atas → daftar 🛒 DAFTAR BELANJA ' +
              'langsung nge-update sendiri. Baris ✅ BELI = beli SEKARANG (sudah urut paling penting, total ≤ budget); ⏸ TUNDA = ' +
              'penting tapi lewat budget, beli berikutnya. Kolom TOTAL BELANJA = uang yang dikeluarkan + sisa budget.')
    .setWrap(true).setVerticalAlignment('top').setFontStyle('italic').setFontColor(UI.INK).setBackground(UI.GREEN_SOFT);
  sh.setRowHeight(r, 32); r += 1;

  const guide = [
    ['Tier (A–D)', 'Seberapa penting SKU buat bisnis. A = paling penting (laku banyak + dibeli banyak pelanggan beda), D = paling rendah. Tier tinggi sengaja distok lebih aman.'],
    ['Skor', 'Angka 1–5 di balik Tier (gabungan 60% volume jual + 40% jumlah pelanggan). Makin tinggi makin penting.'],
    ['Demand/bln', 'Perkiraan jual per bulan yang RUTIN — lonjakan dari pembeli sekali-beli (one-time) sudah dibuang biar nggak nyesatin. Sel HIJAU = penjualannya lagi tren NAIK.'],
    ['Cust Unik', 'Berapa pelanggan BERBEDA yang beli SKU ini (6 bln). Banyak = kalau kosong, banyak hubungan pelanggan kena.'],
    ['Stok', 'Sisa barang di gudang sekarang (CTN), dari Accurate.'],
    ['On Order', 'Barang yang sudah di-PO ke supplier tapi BELUM datang.'],
    ['Posisi', 'Stok + On Order = yang benar-benar kamu pegang/akan pegang. Dipakai buat keputusan, biar nggak dobel order.'],
    ['Hari Cover', 'Posisi sekarang cukup buat berapa HARI lagi sebelum habis.'],
    ['Target Stok', 'Idealnya distok sampai segini (CTN) — sudah hitung lama nunggu kirim + pengaman.'],
    ['Reorder Pt', 'Batas bawah. Kalau Posisi ≤ angka ini → wajib order sekarang.'],
    ['Status', '🔴 Order Sekarang (Posisi sudah ≤ Reorder Pt) · 🟡 Mendekati (siap-siap) · 🟢 Aman.'],
    ['Saran Order', 'Jumlah CTN yang disarankan dibeli sekarang (= Target − Posisi).'],
    ['Est. Biaya', 'Perkiraan biaya order itu = Saran Order × harga beli.'],
    ['RaR % (Revenue at Risk)', 'Kontribusi SKU ini ke total omzet. Makin besar % → makin besar omzet yang HILANG kalau dia kosong → makin diprioritaskan saat modal terbatas.'],
    ['Prioritas Beli', 'Urutan belanja saat budget terbatas: BELI #1, #2, … = beli sekarang (RaR per rupiah tertinggi dulu) sampai budget habis; TUNDA = tunggu bulan depan.'],
    ['RINGKAS di atas', 'Total saran belanja = semua kebutuhan. Budget restock (ketik →) = KETIK angka modal di cell kuning itu (mis. 80000000) → langsung jadi batas belanja siklus ini; kosongkan = otomatis pakai total saldo Kas & Bank (BCA Roshan + Jago, tampil di sampingnya). Belanja dalam budget = yang masuk hitungan BELI sampai budget habis.']
  ];
  guide.forEach(function(g) {
    sh.getRange(r, 1, 1, 2).merge().setValue(g[0]).setFontWeight('bold').setVerticalAlignment('top').setWrap(true);
    sh.getRange(r, 3, 1, SPAN - 2).merge().setValue(g[1]).setWrap(true).setVerticalAlignment('top').setFontColor(UI.INK);
    sh.setRowHeight(r, 30);
    r += 1;
  });
  r += 1;

  sh.setColumnWidth(1, 90);  sh.setColumnWidth(2, 210); sh.setColumnWidth(3, 48);
  sh.setColumnWidth(4, 52);  sh.setColumnWidth(5, 72);  sh.setColumnWidth(6, 72);
  sh.setColumnWidth(7, 70);  sh.setColumnWidth(8, 72);  sh.setColumnWidth(9, 72);
  sh.setColumnWidth(10, 72); sh.setColumnWidth(11, 88); sh.setColumnWidth(12, 86);
  sh.setColumnWidth(13, 130); sh.setColumnWidth(14, 88); sh.setColumnWidth(15, 105);
  sh.setColumnWidth(16, 64); sh.setColumnWidth(17, 115);
  sh.setColumnWidth(18, 64); sh.setColumnWidth(19, 115);
  sh.setFrozenRows(2);   // pin banner saja (RINGKAS + 🛒 cart sekarang di atas DAFTAR SKU)
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL — refresh penuh dari menu (drain harvest bertahap; klik beberapa kali kalau
// masih ada SKU "stok tak diketahui" / line-item belum lengkap).
// ─────────────────────────────────────────────────────────────────────────────
function refreshSkuSalesNow() {
  SYNC_START = Date.now();
  TARGET_SS = null;                       // pastikan tulis ke master
  const today = stripTime(new Date());
  const invoices = fetchSalesInvoices();
  try { refreshItemMaster(); } catch (e) { Logger.log('Item master dilewati (cek scope item_view): ' + e.message); }
  let onOrder = null;
  try { onOrder = buildOnOrderByItem(today); } catch (e) { Logger.log('On-order dilewati (cek scope purchase_order_view): ' + e.message); }
  let bankInfo = null;
  try { bankInfo = pullBankBalance(); } catch (e) { Logger.log('Saldo bank dilewati (cek scope glaccount_view): ' + e.message); }
  harvestSkuSales(invoices, today);
  const rk = computeRestock(invoices, today, onOrder, bankInfo);
  writeRestockTab(rk);
  try {
    SpreadsheetApp.getUi().alert('Restock diperbarui — cek tab ' + CONFIG.TABS.RESTOCK +
      '.\nKalau masih ada SKU "stok tak diketahui" atau line-item belum lengkap, jalankan lagi (harvest bertahap).');
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE BUDGET — simple onEdit trigger. Begitu user KETIK di cell "Budget restock (ketik →)",
// daftar 🛒 + Prioritas Beli langsung re-rank TANPA sync (murni hitung di sheet, no API).
// Budget cuma mempengaruhi alokasi BELI/TUNDA — qty/biaya/posisi tidak berubah → aman dihitung
// dari angka yang sudah ada di sheet. setValues programatik TIDAK memicu onEdit (no loop).
// ─────────────────────────────────────────────────────────────────────────────
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (!sh || sh.getName() !== CONFIG.TABS.RESTOCK) return;
    if (e.range.getColumn() !== 2 || e.range.getNumRows() !== 1) return;
    const label = String(sh.getRange(e.range.getRow(), 1).getValue() || '');
    if (!/^Budget restock \(ketik/i.test(label)) return;       // bukan cell budget → abaikan
    _applyBudgetLive(sh);
  } catch (err) { /* onEdit tak boleh melempar */ }
}

// Re-rank daftar belanja dari isi sheet pakai budget terbaru. Dipanggil onEdit (live) — no API.
function _applyBudgetLive(sh) {
  const last = sh.getLastRow();
  if (last < 2) return;
  const colA = sh.getRange(1, 1, last, 1).getValues().map(function(r) { return String(r[0]); });
  const findRow = function(re) { for (let i = 0; i < colA.length; i++) { if (re.test(colA[i])) return i + 1; } return 0; };
  const digits = function(v) { return (typeof v === 'number') ? v : (Number(String(v).replace(/[^0-9]/g, '')) || 0); };

  // budget: cell ketik; kalau kosong pakai angka 'Budget dipakai' (auto/last) supaya konsisten
  const budRow = findRow(/^Budget restock \(ketik/i);
  let budget = budRow ? digits(sh.getRange(budRow, 2).getValue()) : 0;
  const usedRow = findRow(/^Budget dipakai/i);
  if (!budget && usedRow) budget = digits(sh.getRange(usedRow, 2).getValue());

  // baca baris cart (urut prioritas) — block: SKU col2, Subtotal col12. Deteksi via marker 🛒.
  const cartSec = findRow(/🛒/);
  if (!cartSec) return;
  const items = [], rowIdx = [];
  let rr = cartSec + 2;                                          // section, header, lalu data
  while (rr <= last) {
    const c1 = sh.getRange(rr, 1).getValue();
    if (typeof c1 !== 'number' || c1 <= 0) break;               // habis cart → ketemu TOTAL/blank
    items.push({ no: String(sh.getRange(rr, 2).getValue() || ''), estCost: num(sh.getRange(rr, 14).getValue()) });
    rowIdx.push(rr);
    rr++;
  }
  if (!items.length) return;
  const totalRow = rr;

  const alloc = _allocateCart(items, budget);
  const labelMap = {};
  let bk = 0;
  for (let i = 0; i < alloc.length; i++) {
    const tr = rowIdx[i], a = alloc[i];
    sh.getRange(tr, 16).setValue(a.beli ? a.cumAfter : '').setNumberFormat('"Rp"#,##0');  // Kumulatif (block 16-17)
    sh.getRange(tr, 18).setValue(a.beli ? '✅ BELI' : '⏸ TUNDA')                            // Aksi (block 18-19)
      .setBackground(a.beli ? UI.T_GREEN : UI.T_RED).setFontWeight('bold');
    labelMap[a.no] = a.beli ? ('BELI #' + (++bk)) : 'TUNDA';
  }
  const totalBeli = alloc.reduce(function(s, x) { return s + (x.beli ? x.estCost : 0); }, 0);

  if (/^TOTAL BELANJA/i.test(String(sh.getRange(totalRow, 1).getValue()))) {
    sh.getRange(totalRow, 14).setValue(totalBeli).setNumberFormat('"Rp"#,##0');
    sh.getRange(totalRow, 16).setValue(budget ? ('sisa budget ' + rupiah(Math.max(0, budget - totalBeli))) : 'budget tak diset → semua BELI');
  }
  if (usedRow) sh.getRange(usedRow, 2).setValue(budget ? (rupiah(budget) + '  ·  manual (ketik di sheet)') : '— belum ada → tampil semua SKU, urut RaR');
  const inbudRow = findRow(/^Belanja dalam budget/i);
  if (inbudRow) sh.getRange(inbudRow, 2).setValue(budget ? rupiah(totalBeli) : '—');

  // relabel kolom Prioritas Beli (17) di DAFTAR SKU ikut alokasi baru
  const skuHdr = findRow(/^SKU$/);
  if (skuHdr) {
    for (let i = skuHdr; i < colA.length; i++) {
      if (/^📖/.test(colA[i]) || /CARA BACA/i.test(colA[i])) break;
      const lbl = labelMap[colA[i]];
      if (!lbl) continue;
      const beli = /BELI/.test(lbl);
      sh.getRange(i + 1, 17).setValue(lbl).setBackground(beli ? UI.T_GREEN : UI.T_RED).setFontWeight(beli ? 'bold' : 'normal');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAG — dump nama field item/list.do + line-item detail.do (jalankan SEBELUM andalkan
// angka stok/cost; field bervariasi antar build Accurate). Butuh scope item_view aktif.
// ─────────────────────────────────────────────────────────────────────────────
function diagItemFields() {
  // Probe A — list.do WITH explicit fields. Accurate sering balas cuma {id} (seperti
  // customer/list.do) → kalau ini juga {id}, kita wajib detail.do per item.
  let firstId = null;
  try {
    const fields = ['id', 'no', 'name', 'availableToSell', 'quantity', 'balance',
                    'unit1Name', 'vendorPrice', 'averageCost', 'lastPurchasePrice'].join(',');
    const res = accApi('/accurate/api/item/list.do', { 'sp.page': 1, 'sp.pageSize': 5, 'fields': fields });
    const rows = (res && res.d) || [];
    Logger.log('A) list.do(+fields) count: ' + rows.length);
    if (rows.length) {
      Logger.log('A) list[0] keys: ' + Object.keys(rows[0]).join(', '));
      Logger.log('A) list[0] JSON: ' + JSON.stringify(rows[0]));
      firstId = rows[0].id;
    }
  } catch (e) {
    Logger.log('A) list.do GAGAL: ' + e.message +
      '\n→ Sudah tambah scope item_view ke CONFIG.OAUTH_SCOPE + jalankan forceReauthorize()?');
  }

  // Probe B — detail.do untuk satu item (di sinilah stok + harga beli biasanya muncul).
  const id = firstId != null ? firstId : 650;
  try {
    const det = accApi('/accurate/api/item/detail.do', { id: id });
    const d = det && det.d;
    if (!d) { Logger.log('B) item/detail.do id=' + id + ' kosong.'); return; }
    Logger.log('B) item/detail.do id=' + id + ' keys: ' + Object.keys(d).join(', '));
    // Sorot kandidat field stok & harga yang kita pakai di refreshItemMaster.
    const peek = ['no', 'name', 'unit1Name', 'unitName', 'unit1',
                  'availableToSell', 'quantity', 'balance', 'totalQuantity',
                  'vendorPrice', 'averageCost', 'lastPurchasePrice', 'unitPrice'];
    peek.forEach(function(k) { if (d[k] !== undefined) Logger.log('   • ' + k + ' = ' + JSON.stringify(d[k])); });
    Logger.log('B) full JSON: ' + JSON.stringify(d));
  } catch (e) {
    Logger.log('B) item/detail.do GAGAL: ' + e.message);
  }
}

// DIAG — konfirmasi endpoint + field purchase-order (status open/closed, line-item, received-qty)
// SEBELUM andalkan on-order. Butuh scope purchase_order_view aktif.
function diagPurchaseFields() {
  let firstId = null;
  try {
    const res = accApi('/accurate/api/purchase-order/list.do',
      { 'sp.page': 1, 'sp.pageSize': 5, 'fields': ['id', 'number', 'statusName', 'transDate'].join(',') });
    const rows = (res && res.d) || [];
    Logger.log('A) purchase-order/list.do count: ' + rows.length);
    if (rows.length) {
      Logger.log('A) list[0] keys: ' + Object.keys(rows[0]).join(', '));
      Logger.log('A) list[0] JSON: ' + JSON.stringify(rows[0]));
      Logger.log('A) statusName contoh: ' + rows.map(function(x) { return x.statusName; }).join(' | '));
      firstId = rows[0].id;
    }
  } catch (e) {
    Logger.log('A) purchase-order/list.do GAGAL: ' + e.message +
      '\n→ Sudah tambah scope purchase_order_view + forceReauthorize()? Atau nama endpoint/scope beda (coba purchase_view).');
  }
  if (firstId == null) return;
  try {
    const det = accApi('/accurate/api/purchase-order/detail.do', { id: firstId });
    const d = det && det.d;
    if (!d) { Logger.log('B) detail.do id=' + firstId + ' kosong.'); return; }
    Logger.log('B) detail.do keys: ' + Object.keys(d).join(', '));
    const items = (d.detailItem || d.detailItems || d.detailExpense) || [];
    Logger.log('B) line-item array len: ' + items.length);
    if (items.length) {
      Logger.log('B) line[0] keys: ' + Object.keys(items[0]).join(', '));
      Logger.log('B) line[0] JSON: ' + JSON.stringify(items[0]));
    }
  } catch (e) {
    Logger.log('B) purchase-order/detail.do GAGAL: ' + e.message);
  }
}
