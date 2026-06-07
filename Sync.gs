/**
 * ROSH × Accurate — Sync orchestrator + 2-pass invoice fetch + pool builders.
 *
 * Pass 1: sales-invoice/list.do — ALL invoices, light fields.
 * Pass 2: sales-invoice/detail.do — invoices that (a) were paid this month OR
 *         (b) belong to Ade's pools and have payment history → parse FULL
 *         receiptHistory to split cash before/after onboard & handover, lock
 *         the commission bucket at the first payment in Ade's window, and feed
 *         the probation-bonus windows.
 *
 * Aging reference = HANDOVER (dueDate + 15). Sales owns H+0..H+14; the invoice
 * lands with Ade at H+15. Ade's clock and commission buckets are measured from
 * that handover date.
 *
 * Two pools (separate tabs, Bro's request):
 *   Pool A — FROZEN legacy backlog. Handover ≤ onboard AND unpaid at onboard.
 *            Burn-down list; basis for probation bonuses. List never grows.
 *   Pool B — ONGOING AR. Handover > onboard (crosses H+15 after Ade starts).
 *            Commission applies; NOT counted for probation bonus.
 *
 * Each pool tab mixes 🔴 script-owned columns (overwritten every 5am sync) and
 * 🟡 human-filled columns (Channel / Hasil Negosiasi / Tgl Follow-up / Bukti
 * Transfer). The sync UPSERTS by invoice number so Ade's 🟡 entries survive.
 *
 * Depends on Code.gs (auth/session/accApi) and Kpi.gs (KPI math + THP/Summary).
 */

var DAY_MS = 86400000;
var SYNC_START = 0;   // set in fullSync(); attachCustomerContacts uses it as a wall-clock budget
var TARGET_SS = null; // when set, _ss() points writers at this spreadsheet (role files); null = master

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
function fullSync() {
  const t0 = new Date();
  SYNC_START = Date.now();
  try {
    const onboard = _onboardDate();
    const today   = stripTime(new Date());

    const invoices = fetchSalesInvoices();              // Pass 1
    const enriched = enrichReceipts(invoices, onboard, today); // Pass 2 (mutates)

    // classify every invoice into a pool (needs piutangAtOnboard from enrich)
    invoices.forEach(function(i) { i.pool = classifyPool(i, onboard, today); });

    attachCustomerContacts(invoices);                   // Alamat + No. Telp (Pool A/B only) via detail.do

    // Customer loyalty tier (count + value, trailing window) → stamp every invoice. Display-only.
    const tierMap = computeCustomerTiers(invoices, today);
    invoices.forEach(function(i) {
      const t = tierMap[_custKey(i)];
      i.custTier     = t ? t.tier : '';
      i.custTierText = t ? t.text : '';
    });

    // NOTE: faktur PDFs are NOT generated here — doing so blew the 6-min limit and aborted
    // the writers. fullSync only WRITES links: direct Drive link if the PDF is already cached,
    // else a web-app fallback. Generation runs separately in generateFakturPdfs() (menu /
    // its own trigger), which front-fills the cache so links turn direct over time.

    const poolA        = buildPoolA(invoices, today);
    const poolB        = buildPoolB(invoices, today);
    const invoiceSales = buildInvoiceSales(invoices, today);
    const invoiceLain  = buildInvoiceLain(invoices, today);
    const dueReminders = buildDueReminders(invoices, today);    // penagihan JT (H-1 → H+14, 4-touch)
    const followUps    = buildFollowUpReminders(invoices, today); // reaktivasi (dormancy)
    const penagihanBatch = buildPenagihanBatch(invoices, today);  // pesan WA group-by-customer (H-1 → H+14)
    const stopSupply     = buildStopSupply(invoices, today);      // customer ≥H+7 → HOLD order baru
    const sales        = computeSalesKpi(invoices);
    const ar           = computeArKpi(invoices, onboard, today);

    // Restock Engine (master data: SKU velocity dari line-item + stok/cost dari item master).
    // FAIL-SOFT: refreshItemMaster bisa 403 sampai scope item_view di-grant (forceReauthorize) —
    // jangan abort sync; harvest pakai sales_invoice_view yg sudah ada. Tab tampil tier/velocity
    // dulu, stok on-hand nyusul setelah re-consent. Harvest time-budgeted (drain bertahap).
    let restock = null;
    try {
      try { refreshItemMaster(); } catch (e) { Logger.log('Item master dilewati (cek scope item_view): ' + e.message); }
      let onOrder = null;
      try { onOrder = buildOnOrderByItem(today); } catch (e) { Logger.log('On-order PO dilewati (cek scope purchase_order_view): ' + e.message); }
      let bankInfo = null;
      try { bankInfo = pullBankBalance(); } catch (e) { Logger.log('Saldo bank dilewati (cek scope gl_account_view): ' + e.message); }
      harvestSkuSales(invoices, today);
      restock = computeRestock(invoices, today, onOrder, bankInfo);
    } catch (e) { Logger.log('Restock dilewati: ' + e.message); }

    const ctx = { invoices: invoices, poolA: poolA, poolB: poolB,
                  invoiceSales: invoiceSales, sales: sales, ar: ar };

    // Role files (may be null until setupRoleSheets() is run). Collect 🟡 from master +
    // Ade's file BEFORE any writer clears a tab, so both files get identical Channel/Hasil
    // Negosiasi/Tgl Follow-up/Bukti Transfer (Ade's non-empty value wins → her edits flow back).
    const adeSS   = _roleSS('ADE_SHEET_ID');
    const dedenSS = _roleSS('DEDEN_SHEET_ID');
    const masterSS = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const yA = collectPoolYellow([masterSS, adeSS], CONFIG.TABS.POOL_A);
    const yB = collectPoolYellow([masterSS, adeSS], CONFIG.TABS.POOL_B);
    const yR = collectRouteYellow([masterSS, adeSS], CONFIG.TABS.RUTE); // Zona/Pin/Status/Tgl/Hasil

    // ── MASTER (owner) — every tab ──
    TARGET_SS = null;
    const routePlan = buildRoutePlan(invoices, today, yR); // master context → _PinCache on master
    migrateTabNames();                       // rename old tabs in place (preserve Pool A/B 🟡 data)
    deleteDeprecatedTabs();                  // drop legacy 'Tagihan Ade'
    writeCaraBacaTab();                       // 📖 onboarding guide (static, rebuilt each sync)
    writeTodoTab(dueReminders, followUps);    // 📌 daily action list
    writePesanTab(penagihanBatch);            // ✉️ pesan WA siap kirim, group-by-customer (master-only)
    writeStopSupplyTab(stopSupply);           // ⛔ daftar HOLD order (≥H+7) untuk Nathan (master-only)
    if (restock) writeRestockTab(restock);    // 📦 Restock Engine — saran pembelian per SKU (master-only)
    writePoolTab(CONFIG.TABS.POOL_A, poolA, 'A', yA);
    writePoolTab(CONFIG.TABS.POOL_B, poolB, 'B', yB);
    writeRouteTab(routePlan, yR);             // 🗺️ Rute Penagihan
    writeInvoiceSalesTab(invoiceSales);
    writeInvoiceLainTab(invoiceLain);
    writeThpSalesTab(sales);
    writeThpAdeTab(ar);
    // Business Health (master-only) is now FOLDED INTO the 📋 Ringkasan tab (no separate tab).
    // Compute + record the daily snapshot FIRST (master context, TARGET_SS=null → history on one
    // file) so the Ringkasan's TREN sparkline can read the freshly-stamped snapshot ledger.
    const health = computeBusinessHealth(invoices, ctx, today);
    recordMetricSnapshot(health, today);
    writeSummaryTab(ctx, 'master', health);
    orderTabs();                             // arrange tabs L→R for the 3 audiences

    // ── ADE file — Summary (AR-scoped) + Pool A/B (editable 🟡) + KPI Matriks AR ──
    if (adeSS) {
      TARGET_SS = adeSS;
      writeSummaryTab(ctx, 'ade');
      writePoolTab(CONFIG.TABS.POOL_A, poolA, 'A', yA);
      writePoolTab(CONFIG.TABS.POOL_B, poolB, 'B', yB);
      writeRouteTab(routePlan, yR);          // 🗺️ Rute Penagihan (Ade's drive list)
      writeThpAdeTab(ar);
      _dropDefaultSheet();
    }

    // ── DEDEN file — Summary (Sales-scoped) + Tagihan Sales + KPI Matriks Sales (view only) ──
    if (dedenSS) {
      TARGET_SS = dedenSS;
      writeSummaryTab(ctx, 'deden');
      writeInvoiceSalesTab(invoiceSales);
      writeThpSalesTab(sales);
      _dropDefaultSheet();
    }

    TARGET_SS = null;                        // back to master for logging
    _log('OK', 'Synced ' + invoices.length + ' invoices · ' + enriched + ' enriched · ' +
              'Pool A ' + poolA.length + ' · Pool B ' + poolB.length + ' · ' +
              invoiceSales.length + ' di Sales · To-Do ' + dueReminders.length + ' penagihan / ' +
              followUps.length + ' follow-up · role: ' +
              (adeSS ? 'Ade✓' : 'Ade–') + ' ' + (dedenSS ? 'Deden✓' : 'Deden–') + '. ' +
              ((new Date() - t0) / 1000).toFixed(1) + 's');
  } catch (e) {
    TARGET_SS = null;
    _log('ERROR', e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 1 — list all sales invoices (paged), light fields
// ─────────────────────────────────────────────────────────────────────────────
function fetchSalesInvoices() {
  const out = [];
  let page = 1;
  const pageSize = 100;
  // list.do returns only {id} unless fields are requested explicitly.
  //   - list.do does NOT return `outstanding`/`masterSalesmanName`.
  //   - Balance amount = totalAmount − primeReceipt (primeReceipt = total received).
  //   - Salesman is a nested object `masterSalesman` → .name (Deden Sunandar).
  //   - statusName: 'Lunas' = paid, 'Belum Lunas' = unpaid. age = days past due.
  const fieldList = [
    'id', 'number', 'customer', 'transDate', 'dueDate',
    'totalAmount', 'subTotal', 'cashDiscount', 'statusName', 'age',
    'lastPaymentDate', 'primeReceipt', 'totalDownPayment', 'masterSalesman'
  ].join(',');

  while (true) {
    const res = accApi('/accurate/api/sales-invoice/list.do', {
      'sp.page': page,
      'sp.pageSize': pageSize,
      'sp.sort': 'transDate|desc',
      'fields': fieldList
    });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) { out.push(normalizeInvoice(r)); });

    const pageCount = res && res.sp && res.sp.pageCount ? res.sp.pageCount : 1;
    if (page >= pageCount || rows.length === 0) break;
    page++;
    if (page > 100) break; // safety
  }
  return out;
}

function normalizeInvoice(r) {
  const total = num(r.totalAmount);
  const isPaid = (r.statusName === 'Lunas');
  const received = num(r.primeReceipt);
  const outstanding = isPaid ? 0 : Math.max(total - received, 0);
  const paid = Math.min(received, total);

  const trans = parseAccDate(r.transDate);
  const due   = parseAccDate(r.dueDate);
  const lastPay = parseAccDate(r.lastPaymentDate);
  const today = stripTime(new Date());
  const daysPastDue = (typeof r.age === 'number') ? r.age
                    : (due ? Math.floor((today - due) / DAY_MS) : null);
  const handoverDate = due ? addDays(due, CONFIG.HANDOVER_OFFSET_DAYS) : null;

  return {
    id: r.id,
    number: r.number,
    customer: r.customer ? (r.customer.name || r.customer) : '',
    customerId: (r.customer && r.customer.id) ? r.customer.id : null,  // → contact lookup (Alamat / No. Telp)
    alamat: '',                    // filled by attachCustomerContacts()
    noTlp: '',                     // filled by attachCustomerContacts()
    noVa: '',                      // filled by attachCustomerContacts() — customer's own Virtual Account (customerNoVa)
    custTier: '',                  // filled by computeCustomerTiers()  (A/B/C/D)
    custTierText: '',              // 'B · 7× · Rp45.000.000'
    salesman: (r.masterSalesman && r.masterSalesman.name) ? r.masterSalesman.name : '',  // "" = POS / online
    transDate: trans,
    dueDate: due,
    handoverDate: handoverDate,              // dueDate + 15 → Ade's clock starts here
    lastPaymentDate: lastPay,
    total: total,
    paid: paid,
    outstanding: outstanding,
    isPaid: isPaid,
    daysPastDue: daysPastDue,                // positive = overdue (from due date)
    subTotal: num(r.subTotal),
    cashDiscount: num(r.cashDiscount),
    status: r.statusName || '',

    // ── filled by enrichReceipts() ──
    receipts: [],                  // full approved cash receipts {date, amount}
    receiptsThisMonth: [],         // subset this month, bucketed from DUE date (Sales KPI)
    collectedThisMonth: 0,
    pool: null,                    // 'A' | 'B' | null (set after enrich)

    // pool / commission fields (defaults; overridden when detail is pulled)
    piutangAtOnboard: 0,           // outstanding the day Ade started (legacy only)
    piutangAtHandover: total,      // outstanding when the invoice landed with Ade
    collectedSinceOnboard: 0,
    collectedSprint: 0,            // collected within onboard..onboard+30
    collectedMilestone: 0,         // collected within onboard..onboard+92
    firstAdePayDate: null,         // first payment in Ade's window (≥ max(handover, onboard))
    agingAtCollect: null,          // days since handover at that first payment
    bucketLock: null,              // 'reg' | 'aging1' | 'aging2' (locked at first pay)
    komisiEligibleThisMonth: 0,    // cash in Ade's window collected this month
    adeKomisiThisMonth: 0          // = komisiEligibleThisMonth × rate(bucketLock)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER CONTACTS — one paged pull of the customer master → Alamat + No. Telp.
// Cheaper than per-invoice detail.do: build an id→{alamat,noTlp} map once, then
// stamp every invoice. Field names vary across Accurate builds, so we read each
// contact field defensively (mobilePhone|phone|workPhone, billStreet|...|address).
// ─────────────────────────────────────────────────────────────────────────────
// Three-layer contact resolver — kept WELL under the 6-min Apps Script limit so the
// writers always run (a timeout here used to abort the whole sync before any tab was
// written). Layers:
//   1) Persistent cache (hidden sheet _ContactCache) — once a customer is known we never
//      re-fetch it on later syncs.
//   2) Bulk customer/list.do with `fields` — fills most contacts in ~3 paged calls.
//   3) Per-customer detail.do fallback for whatever's still missing, CAPPED by a wall-clock
//      budget. Anything not reached this run stays blank and is picked up next sync.
var CONTACT_TIME_BUDGET_MS = 240000;  // stop fetching ~4 min in; leaves ≥2 min for writers
var CONTACT_MAX_DETAIL     = 400;     // hard cap on detail.do fallbacks per run

function attachCustomerContacts(invoices) {
  const cache = _loadContactCache();              // { idStr: { alamat, noTlp } } (persistent)

  // Unique customer ids we actually need this run.
  const needed = {};
  invoices.forEach(function(inv) { if (inv.customerId != null) needed[inv.customerId] = true; });
  const anyMissing = Object.keys(needed).some(function(id) { return !cache[id]; });

  // Layer 2 — one cheap bulk pass (only if something's missing).
  if (anyMissing) {
    try { _bulkLoadContacts(cache); } catch (e) { Logger.log('Bulk kontak dilewati: ' + e.message); }
  }

  // Layer 3 — detail.do fallback, time-budgeted. Runs when a customer is unknown OR
  // cached WITHOUT an address (bulk list.do often returns phone but no alamat). Without
  // this, a phone-only bulk entry would block the detail.do that actually has the alamat.
  let pulls = 0, fails = 0, skipped = 0;
  Object.keys(needed).forEach(function(id) {
    const have = cache[id];
    if (have && have.alamat) return;                // already have alamat (+ telp) — done
    if (pulls >= CONTACT_MAX_DETAIL ||
        (SYNC_START && (Date.now() - SYNC_START) > CONTACT_TIME_BUDGET_MS)) { skipped++; return; }
    try {
      const d = fetchCustomerDetail(id);
      if (d) cache[id] = { alamat: d.alamat || (have && have.alamat) || '',
                           noTlp:  d.noTlp  || (have && have.noTlp)  || '',
                           noVa:   d.noVa   || (have && have.noVa)   || '' };
      else if (!have) cache[id] = { alamat: '', noTlp: '', noVa: '' };
    } catch (e) { fails++; }                         // leave as-is → retried next sync
    pulls++;
    if (pulls % 25 === 0) Utilities.sleep(150);
  });

  // Stamp invoices from whatever we know; unknown → blank (filled in a later sync).
  invoices.forEach(function(inv) {
    const c = (inv.customerId != null) ? cache[inv.customerId] : null;
    inv.alamat = (c && c.alamat) || '';
    inv.noTlp  = (c && c.noTlp)  || '';
    inv.noVa   = (c && c.noVa)   || '';
  });

  _saveContactCache(cache);
  const remaining = Object.keys(needed).filter(function(id) { return !cache[id]; }).length;
  Logger.log('Kontak: ' + Object.keys(cache).length + ' di cache · ' + pulls + ' detail.do' +
             (fails ? (' · ' + fails + ' gagal') : '') +
             (remaining ? (' · ' + remaining + ' belum (lanjut sync berikut)') : ' · lengkap'));
}

// Layer 2 — pull the customer master with explicit fields. If this build returns contact
// fields (like sales-invoice/list.do does), it fills the cache in a few calls. Rows with no
// contact data are NOT cached, so the detail.do fallback can still try them.
function _bulkLoadContacts(cache) {
  const fields = ['id', 'name', 'mobilePhone', 'phone', 'workPhone',
                  'billStreet', 'billCity', 'billProvince'].join(',');
  let page = 1;
  while (true) {
    const res = accApi('/accurate/api/customer/list.do',
      { 'sp.page': page, 'sp.pageSize': 100, 'fields': fields });
    const rows = (res && res.d) || [];
    rows.forEach(function(r) {
      if (r.id == null || cache[r.id]) return;
      const alamat = _custAddress(r), noTlp = _custPhone(r), noVa = _custVa(r);
      if (alamat || noTlp || noVa) cache[r.id] = { alamat: alamat, noTlp: noTlp, noVa: noVa };  // skip empty → fallback tries later
    });
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (page >= pc || rows.length === 0) break;
    page++;
    if (page > 50) break;  // safety
  }
}

// ── Persistent contact cache (hidden sheet) ──────────────────────────────────
// Schema: customerId | alamat | noTlp | noVa. AUTO-MIGRATES an old 3-col cache (tanpa
// kolom noVa) dengan wipe sekali → rebuild membawa Virtual Account per customer.
function _contactCacheSheet() {
  const ss = _ss();
  let sh = ss.getSheetByName('_ContactCache');
  if (!sh) {
    sh = ss.insertSheet('_ContactCache');
    sh.getRange(1, 1, 1, 4).setValues([['customerId', 'alamat', 'noTlp', 'noVa']]);
    sh.hideSheet();
    return sh;
  }
  const hdr = sh.getRange(1, 1, 1, 4).getValues()[0];
  if (String(hdr[3]).trim() !== 'noVa') {           // old 3-col cache → migrate (rebuild w/ VA)
    sh.clearContents();
    sh.getRange(1, 1, 1, 4).setValues([['customerId', 'alamat', 'noTlp', 'noVa']]);
  }
  return sh;
}
function _loadContactCache() {
  const sh = _contactCacheSheet();
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 4).getValues().forEach(function(r) {
      if (r[0] !== '' && r[0] != null) map[r[0]] = { alamat: r[1] || '', noTlp: r[2] || '', noVa: r[3] || '' };
    });
  }
  return map;
}
function _saveContactCache(map) {
  const sh = _contactCacheSheet();
  const rows = Object.keys(map).map(function(id) {
    return [id, map[id].alamat || '', map[id].noTlp || '', map[id].noVa || ''];
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
}

// Per-customer detail.do → { alamat, noTlp, noVa }. Used as fallback when list.do omits contacts.
function fetchCustomerDetail(id) {
  const res = accApi('/accurate/api/customer/detail.do', { id: id });
  const r = (res && res.d) ? res.d : null;
  if (!r) return null;
  return { alamat: _custAddress(r), noTlp: _custPhone(r), noVa: _custVa(r) };
}

// First non-empty phone field (field names vary across Accurate builds).
function _custPhone(r) {
  const v = r.mobilePhone || r.phone || r.workPhone || r.cellularPhone || r.whatsappNo || r.fax || '';
  return String(v).trim();
}

// Customer's own Virtual Account number (Accurate field `customerNoVa`; defensive fallbacks).
function _custVa(r) {
  const v = r.customerNoVa || r.noVa || r.virtualAccount || r.vaNumber || '';
  return String(v).trim();
}

// Compose a readable address from whatever Accurate returns. Field names vary a lot
// across builds and many ROSH customers only have a freeform street with no city —
// so try composed bill* parts, then a wide list of single-field names, then as a last
// resort scan ANY string key that looks address-like (street/alamat/address).
function _custAddress(r) {
  if (!r) return '';
  const parts = [r.billStreet, r.billCity, r.billProvince, r.billProvinsi, r.billDistrict]
    .filter(function(p) { return p && String(p).trim(); })
    .map(function(p) { return String(p).trim(); });
  if (parts.length) return parts.join(', ');

  const single = r.billStreet || r.shipStreet || r.street || r.address || r.billAddress ||
                 r.shipAddress || r.alamat || r.addressLine || r.fullAddress;
  if (single && String(single).trim()) return String(single).trim();

  // last resort: first non-empty string field whose KEY mentions street/alamat/address
  for (var k in r) {
    if (/street|alamat|address/i.test(k) && typeof r[k] === 'string' && r[k].trim()) {
      return r[k].trim();
    }
  }
  return '';
}

// ── DIAG ── Run from the editor if contacts still come back blank. Logs the real
// field names + sample values from list.do AND detail.do so we can lock the parsers.
function diagCustomerFields() {
  const res = accApi('/accurate/api/customer/list.do', { 'sp.page': 1, 'sp.pageSize': 3 });
  const rows = (res && res.d) || [];
  Logger.log('customer/list.do → ' + rows.length + ' rows');
  rows.forEach(function(r, i) {
    Logger.log('── list row ' + i + ' keys: ' + Object.keys(r).join(', '));
    Logger.log('   phone? mobilePhone=' + r.mobilePhone + ' | phone=' + r.phone + ' | workPhone=' + r.workPhone + ' | fax=' + r.fax);
    Logger.log('   addr?  billStreet=' + r.billStreet + ' | billCity=' + r.billCity + ' | billProvince=' + r.billProvince + ' | address=' + r.address);
  });
  if (rows[0] && rows[0].id != null) {
    const d = accApi('/accurate/api/customer/detail.do', { id: rows[0].id });
    const dr = (d && d.d) ? d.d : {};
    Logger.log('── detail.do keys: ' + Object.keys(dr).join(', '));
    Logger.log('   detail phone → mobilePhone=' + dr.mobilePhone + ' | phone=' + dr.phone + ' | workPhone=' + dr.workPhone);
    Logger.log('   detail addr  → billStreet=' + dr.billStreet + ' | billCity=' + dr.billCity + ' | billProvince=' + dr.billProvince);
    Logger.log('   _custAddress() → "' + _custAddress(dr) + '"');
    // Full record so we can spot the real address field if it lives under another name.
    Logger.log('── detail.do FULL JSON:\n' + JSON.stringify(dr, null, 2).slice(0, 4000));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 2 — index all receipts in one bulk sweep, then compute pool fields per invoice
// ─────────────────────────────────────────────────────────────────────────────
function enrichReceipts(invoices, onboard, today) {
  // Receipt source = ONE bulk pull indexed by invoice id (buildReceiptsByInvoice), validated
  // identical to the old per-invoice sales-invoice/detail.do path by diagReceiptReconcile
  // (40/40 match). Replaces N detail.do calls (one per paid invoice — "scales badly toward
  // month-end") with ~one paged sweep. The needsDetail gate below is UNCHANGED: we still
  // compute splits for exactly the same invoices — only the receipts[] SOURCE moved to the map.
  const receiptMap = buildReceiptsByInvoice(null);
  let enriched = 0;

  invoices.forEach(function(inv, idx) {
    const crossed = inv.handoverDate && inv.handoverDate <= today; // already in Ade's hands
    // Default piutang-at-onboard for invoices we won't fetch:
    //   legacy & unpaid (or paid only after onboard) → full balance was open at onboard.
    if (inv.handoverDate && inv.handoverDate <= onboard) {
      inv.piutangAtOnboard = (inv.isPaid && inv.lastPaymentDate && inv.lastPaymentDate < onboard)
        ? 0 : inv.total;
    } else {
      inv.piutangAtOnboard = 0;  // not legacy → irrelevant
    }

    // Decide whether full receipt history is needed.
    //   - paid THIS month (Sales KPI needs exact bucketed receipts), OR
    //   - crossed handover AND (still unpaid, or last payment is on/after onboard)
    const needsDetail = inv.lastPaymentDate != null && (
      _inThisMonth(inv.lastPaymentDate) ||
      (crossed && (!inv.isPaid || inv.lastPaymentDate >= onboard))
    );
    if (!needsDetail) return;

    try {
      // Bulk-indexed receipts: already filtered (APPROVED, cash excl. PPh) + sorted ascending
      // by buildReceiptsByInvoice — same shape the old detail.do parse produced.
      const receipts = receiptMap[inv.id] || [];
      enriched++;
      inv.receipts = receipts;

      // (a) this-month receipts, bucketed from DUE date → feeds Sales KPI (unchanged semantics)
      const rtm = [];
      let collMonth = 0;
      receipts.forEach(function(r) {
        if (!_inThisMonth(r.date)) return;
        const dov = inv.dueDate ? Math.floor((r.date - inv.dueDate) / DAY_MS) : null;
        rtm.push({ date: r.date, amount: r.amount, daysOverdue: dov, bucket: collectionBucket(dov) });
        collMonth += r.amount;
      });
      inv.receiptsThisMonth = rtm;
      inv.collectedThisMonth = collMonth;

      // (b) pool / commission splits (handover-based)
      const onbStart = onboard, sprintEnd = addDays(onboard, CONFIG.AR_SPRINT_WINDOW_DAYS);
      const mileEnd  = addDays(onboard, CONFIG.AR_MILESTONE_WINDOW_DAYS);
      let beforeOnboard = 0, beforeHandover = 0, sinceOnboard = 0, sprint = 0, mile = 0;
      receipts.forEach(function(r) {
        if (r.date < onboard) beforeOnboard += r.amount; else sinceOnboard += r.amount;
        if (inv.handoverDate && r.date < inv.handoverDate) beforeHandover += r.amount;
        if (r.date >= onbStart && r.date <= sprintEnd) sprint += r.amount;
        if (r.date >= onbStart && r.date <= mileEnd)   mile   += r.amount;
      });
      if (inv.handoverDate && inv.handoverDate <= onboard) {
        inv.piutangAtOnboard = Math.max(0, inv.total - beforeOnboard);
      }
      inv.piutangAtHandover   = inv.handoverDate ? Math.max(0, inv.total - beforeHandover) : inv.total;
      inv.collectedSinceOnboard = sinceOnboard;
      inv.collectedSprint     = sprint;
      inv.collectedMilestone  = mile;

      // Ade's window = payments on/after max(handover, onboard). Lock bucket at the first one.
      const adeStart = inv.handoverDate && inv.handoverDate > onboard ? inv.handoverDate : onboard;
      const adeReceipts = receipts.filter(function(r) { return r.date >= adeStart; });
      if (adeReceipts.length) {
        inv.firstAdePayDate = adeReceipts[0].date;
        inv.agingAtCollect = inv.handoverDate
          ? Math.max(0, Math.floor((inv.firstAdePayDate - inv.handoverDate) / DAY_MS)) : null;
        inv.bucketLock = handoverBucket(inv.agingAtCollect);
        let kElig = 0;
        adeReceipts.forEach(function(r) { if (_inThisMonth(r.date)) kElig += r.amount; });
        inv.komisiEligibleThisMonth = kElig;
        inv.adeKomisiThisMonth = Math.round(kElig * rateOf(inv.bucketLock));
      }
    } catch (e) {
      // leave un-enriched on a transient error (pure JS now — no per-invoice API call)
    }
  });

  return enriched;
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK RECEIPTS — pull all approved sales receipts in a few paged calls and index
// them by invoice id. The eventual replacement for the per-invoice detail.do loop
// above (one call per paid invoice → "scales badly toward month-end"). Needs the
// `sales_receipt_view` OAuth scope. sales-receipt/list.do returns `detailInvoice`
// (invoice id+number) inline, so SINGLE-invoice receipts need ZERO detail.do calls;
// only MULTI-invoice receipts fall back to detail.do to split the cash per invoice.
// Returns { invoiceId: [{date, amount}, ...] } sorted ascending — same per-invoice
// shape enrichReceipts builds from receiptHistory.
//
// ⚠ NOT yet wired into enrichReceipts. Validate first with diagReceiptReconcile()
// (Diag.gs) — it compares this against the live detail.do path; switch only on a
// 100% match (this drives KPI / commission = salary).
// ─────────────────────────────────────────────────────────────────────────────
function buildReceiptsByInvoice(sinceDate) {
  const map = {};
  const fields = ['id', 'number', 'transDate', 'totalPayment', 'approvalStatus', 'detailInvoice'].join(',');
  let page = 1, multiFallbacks = 0;
  while (true) {
    const res = accApi('/accurate/api/sales-receipt/list.do', {
      'sp.page': page, 'sp.pageSize': 100, 'sp.sort': 'transDate|desc', 'fields': fields
    });
    const rows = (res && res.d) || [];
    let stop = false;
    for (let i = 0; i < rows.length; i++) {
      const rc = rows[i];
      const pd = parseAccDate(rc.transDate);                                   // receipt transDate = PAYMENT date
      if (sinceDate && pd && pd < sinceDate) { stop = true; break; }           // sorted desc → past cutoff, done
      if (rc.approvalStatus && rc.approvalStatus !== 'APPROVED') continue;     // skip pending/rejected
      const lines = rc.detailInvoice || [];
      if (lines.length === 1) {
        _pushReceipt(map, lines[0].id, pd, num(rc.totalPayment));              // single invoice → totalPayment is its cash
      } else if (lines.length > 1) {
        multiFallbacks += _splitReceiptViaDetail(map, rc.id);                  // rare: per-line cash from detail.do
      }
    }
    const pc = (res && res.sp && res.sp.pageCount) ? res.sp.pageCount : 1;
    if (stop || page >= pc || rows.length === 0) break;
    page++;
    if (page > 300) break;  // safety
  }
  Object.keys(map).forEach(function(k) { map[k].sort(function(a, b) { return a.date - b.date; }); });
  if (multiFallbacks) Logger.log('buildReceiptsByInvoice: ' + multiFallbacks + ' multi-invoice receipt(s) split via detail.do');
  return map;
}

function _pushReceipt(map, invId, date, amount) {
  if (invId == null || !date || !(amount > 0)) return;
  (map[invId] || (map[invId] = [])).push({ date: date, amount: amount });
}

// Multi-invoice receipt → detail.do for the exact per-invoice CASH (paymentAmount,
// which excludes PPh withholding → matches the invoice-side receiptHistory filter).
function _splitReceiptViaDetail(map, receiptId) {
  try {
    const det = accApi('/accurate/api/sales-receipt/detail.do', { id: receiptId });
    const d = det && det.d;
    if (!d) return 0;
    if (d.approvalStatus && d.approvalStatus !== 'APPROVED') return 1;
    const pd = parseAccDate(d.transDate);
    (d.detailInvoice || []).forEach(function(li) {
      const invId = (li.invoiceId != null) ? li.invoiceId : (li.invoice && li.invoice.id);
      const amt = num(li.paymentAmount != null ? li.paymentAmount : li.invoicePayment);  // cash, excl. PPh
      _pushReceipt(map, invId, pd, amt);
    });
    return 1;
  } catch (e) { return 0; }
}

// Overdue-at-payment bucket FROM DUE DATE. ≤14d = on-time (Sales grace, no AR commission).
// Used only by Sales KPI (cashflow component). Ade uses handoverBucket().
function collectionBucket(d) {
  if (d == null || d <= CONFIG.HANDOVER_GRACE_DAYS) return 'ontime'; // ≤14d
  if (d <= 45) return 'reg';      // 15–45d
  if (d <= 90) return 'aging1';   // 46–90d
  return 'aging2';                // >90d
}

// Commission bucket FROM HANDOVER DATE (days since handover). This is Ade's clock.
//   0–30 → reg 1.5% · 31–75 → aging1 2.5% · >75 → aging2 3.5%
function handoverBucket(daysSinceHandover) {
  if (daysSinceHandover == null) return null;
  if (daysSinceHandover <= CONFIG.AR_BUCKET_REG_MAX)    return 'reg';
  if (daysSinceHandover <= CONFIG.AR_BUCKET_AGING1_MAX) return 'aging1';
  return 'aging2';
}
function rateOf(bucket) {
  if (bucket === 'reg')    return CONFIG.AR_RATE_REGULAR;
  if (bucket === 'aging1') return CONFIG.AR_RATE_AGING1;
  if (bucket === 'aging2') return CONFIG.AR_RATE_AGING2;
  return 0;
}
function bucketLabel(bucket) {
  if (bucket === 'reg')    return '0–30 hari (1.5%)';
  if (bucket === 'aging1') return '31–75 hari (2.5%)';
  if (bucket === 'aging2') return '>75 hari (3.5%)';
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// POOL CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────
//   Pool A — handover ≤ onboard AND unpaid at onboard (frozen legacy backlog).
//   Pool B — handover > onboard (ongoing AR that crosses H+15 after Ade starts).
//   null   — no due date, paid before onboard, or still pre-handover (Sales' job).
function classifyPool(inv, onboard, today) {
  if (!inv.handoverDate) return null;
  if (inv.handoverDate <= onboard) {
    return inv.piutangAtOnboard > 0 ? 'A' : null;   // legacy, only if open at onboard
  }
  return 'B';                                        // handover after onboard
}

// ─────────────────────────────────────────────────────────────────────────────
// POOL BUILDERS — row objects for the two collaborative tabs
// ─────────────────────────────────────────────────────────────────────────────
function poolRow(i, pool, today) {
  return {
    id: i.id,                          // → Faktur PDF link
    customerId: i.customerId,          // → Faktur link &c= (resolve VA per customer)
    number: i.number,
    customer: i.customer,
    total: i.total,
    dueDate: i.dueDate,
    handoverDate: i.handoverDate,
    piutangAwal: pool === 'A' ? i.piutangAtOnboard : i.piutangAtHandover,
    outstanding: i.outstanding,
    hariSejakHandover: i.handoverDate ? Math.max(0, Math.floor((today - i.handoverDate) / DAY_MS)) : '',
    tglBayar: i.firstAdePayDate,
    masukKasBln: i.komisiEligibleThisMonth,
    agingAtCollect: i.agingAtCollect,
    bucketLock: i.bucketLock,
    komisi: i.adeKomisiThisMonth,
    // display status from payment state (richer than Accurate's Lunas/Belum Lunas)
    status: i.isPaid ? 'Lunas' : (i.paid > 0 ? 'Partial' : 'Open'),
    alamat: i.alamat || '',        // 🔴 col 18 — from customer master
    noTlp: i.noTlp || '',          // 🔴 col 19 — from customer master
    tierText: i.custTierText || '' // 🔴 col 21 — loyalty tier (count + value, 4bln)
  };
}

// Pool A — frozen list; keep ALL members (paid + unpaid) to show burn-down to Rp0.
function buildPoolA(invoices, today) {
  return invoices
    .filter(function(i) { return i.pool === 'A'; })
    .map(function(i) { return poolRow(i, 'A', today); })
    .sort(function(a, b) { return b.outstanding - a.outstanding; });
}

// Pool B — ongoing; show invoices that have crossed handover and are still open
// OR were collected this month (for commission visibility).
function buildPoolB(invoices, today) {
  return invoices
    .filter(function(i) {
      return i.pool === 'B' && i.handoverDate && i.handoverDate <= today &&
             (i.outstanding > 0 || i.komisiEligibleThisMonth > 0);
    })
    .map(function(i) { return poolRow(i, 'B', today); })
    .sort(function(a, b) {
      return (b.hariSejakHandover === '' ? -1 : b.hariSejakHandover) -
             (a.hariSejakHandover === '' ? -1 : a.hariSejakHandover);
    });
}

// True if a salesman name matches any first-name in CONFIG.SALES_FILTER (case-insensitive).
function _isFilteredSales(name) {
  if (!name) return false;                 // "" = POS / online → excluded
  const n = String(name).toLowerCase();
  return (CONFIG.SALES_FILTER || []).some(function(f) {
    return n.indexOf(String(f).toLowerCase()) >= 0;
  });
}

// Invoice Sales — unpaid, still pre-handover (handover in the future → Sales' job).
// Restricted to CONFIG.SALES_FILTER salespeople (Deden & Dian) — POS/online & others drop out.
function buildInvoiceSales(invoices, today) {
  return invoices
    .filter(function(i) {
      return !i.isPaid && i.outstanding > 0 &&
             (i.handoverDate == null || i.handoverDate > today) &&
             _isFilteredSales(i.salesman);
    })
    .map(function(i) {
      const status = (i.daysPastDue == null || i.daysPastDue < 0)
        ? 'Belum jatuh tempo'
        : (i.daysPastDue === 0 ? 'Jatuh tempo hari ini' : 'Lewat ' + i.daysPastDue + ' hari (grace)');
      return {
        id: i.id, customerId: i.customerId, number: i.number, customer: i.customer, salesman: i.salesman,
        dueDate: i.dueDate, daysPastDue: i.daysPastDue,
        outstanding: i.outstanding, statusLabel: status,
        noTlp: i.noTlp || '', tierText: i.custTierText || ''
      };
    })
    .sort(function(a, b) {
      return (b.daysPastDue == null ? -9999 : b.daysPastDue) -
             (a.daysPastDue == null ? -9999 : a.daysPastDue);
    });
}

// Tagihan Lain — same pre-handover criteria as Tagihan Sales, but the INVERSE filter:
// everyone NOT in SALES_FILTER (Nathan/partner, POS/online, other salesmen). Ensures no
// pre-handover invoice is invisible. Anything that slips past H+14 still lands in Pool B.
function buildInvoiceLain(invoices, today) {
  return invoices
    .filter(function(i) {
      return !i.isPaid && i.outstanding > 0 &&
             (i.handoverDate == null || i.handoverDate > today) &&
             !_isFilteredSales(i.salesman);
    })
    .map(function(i) {
      const status = (i.daysPastDue == null || i.daysPastDue < 0)
        ? 'Belum jatuh tempo'
        : (i.daysPastDue === 0 ? 'Jatuh tempo hari ini' : 'Lewat ' + i.daysPastDue + ' hari (grace)');
      return {
        id: i.id, customerId: i.customerId, number: i.number, customer: i.customer, salesman: i.salesman,
        dueDate: i.dueDate, daysPastDue: i.daysPastDue,
        outstanding: i.outstanding, statusLabel: status,
        noTlp: i.noTlp || '', tierText: i.custTierText || ''
      };
    })
    .sort(function(a, b) {
      return (b.daysPastDue == null ? -9999 : b.daysPastDue) -
             (a.daysPastDue == null ? -9999 : a.daysPastDue);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TO-DO / PERINGATAN — daily action list (rolling worklist, covers EVERYONE)
//   A) Penagihan jatuh tempo  — unpaid invoices in the H-1 → H+14 window (4-touch).
//   B) Follow-up reaktivasi   — customers gone quiet, by days since last invoice.
// Pure projection of Pass-1 data — no extra API calls.
// ─────────────────────────────────────────────────────────────────────────────

// A) Due-date reminders. Unpaid invoices with daysPastDue in [-1, PENAGIHAN_WINDOW_MAX(14)],
//    bucketed to the 4-touch milestones (H-1 / H+3 / H+7 / H+14) — SAMA dengan tab Pesan
//    Penagihan (pakai `_penagihanBucket`). Lewat H+14 → handover Ade / Pool; tidak di sini.
function buildDueReminders(invoices, today) {
  return invoices
    .filter(function(i) {
      return !i.isPaid && i.outstanding > 0 &&
             i.daysPastDue != null && i.daysPastDue >= -1 && i.daysPastDue <= CONFIG.PENAGIHAN_WINDOW_MAX;
    })
    .map(function(i) {
      return {
        number: i.number, customer: i.customer, salesman: i.salesman,
        dueDate: i.dueDate, daysPastDue: i.daysPastDue,
        outstanding: i.outstanding, noTlp: i.noTlp || '',
        tierText: i.custTierText || '',
        bucket: _penagihanBucket(i.daysPastDue)
      };
    })
    .sort(function(a, b) { return b.daysPastDue - a.daysPastDue; }); // paling overdue di atas
}

// B) Follow-up reaktivasi. Group every invoice by customer, find the most recent
//    order (MAX transDate), and bucket by how many days the customer has been quiet.
//    Keep customers dormant ≥7 days. Carries the latest invoice's salesman / phone
//    and the customer's total current outstanding for context.
function _followUpBucket(d) {
  if (d >= 90) return 'H+90+';
  if (d >= 60) return 'H+60';
  if (d >= 45) return 'H+45';
  if (d >= 30) return 'H+30';
  if (d >= 21) return 'H+21';
  if (d >= 14) return 'H+14';
  return 'H+7';
}
function buildFollowUpReminders(invoices, today) {
  const byCust = {}; // key → { customer, salesman, noTlp, lastTransDate, outstanding }
  invoices.forEach(function(i) {
    if (!i.transDate) return;
    const key = (i.customerId != null) ? ('id:' + i.customerId) : ('nm:' + (i.customer || ''));
    let c = byCust[key];
    if (!c) {
      c = byCust[key] = { customer: i.customer, salesman: i.salesman,
                          noTlp: i.noTlp || '', tierText: i.custTierText || '',
                          lastTransDate: i.transDate, outstanding: 0 };
    }
    c.outstanding += i.outstanding;                       // current balance across all their invoices
    c.tierText = i.custTierText || c.tierText;            // same per customer; keep non-empty
    if (i.transDate > c.lastTransDate) {                  // carry latest invoice's attribution
      c.lastTransDate = i.transDate;
      c.customer  = i.customer;
      c.salesman  = i.salesman;
      c.noTlp     = i.noTlp || c.noTlp;
    }
  });

  const out = [];
  Object.keys(byCust).forEach(function(k) {
    const c = byCust[k];
    const daysSince = Math.floor((today - c.lastTransDate) / DAY_MS);
    if (daysSince < 7) return;                            // ordered within the week → active
    out.push({
      customer: c.customer, salesman: c.salesman, lastTransDate: c.lastTransDate,
      daysSince: daysSince, bucket: _followUpBucket(daysSince),
      outstanding: c.outstanding, noTlp: c.noTlp || '', tierText: c.tierText || ''
    });
  });
  return out.sort(function(a, b) { return b.daysSince - a.daysSince; }); // deepest churn on top
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER LOYALTY TIER — count + value of invoices in the trailing window.
// Display-only signal so penagihan can be softer for frequent buyers. No API calls
// (pure projection of Pass-1 invoices); does NOT touch komisi/penalty/handover.
// ─────────────────────────────────────────────────────────────────────────────
function _custKey(i) {
  return (i.customerId != null) ? ('id:' + i.customerId) : ('nm:' + (i.customer || ''));
}

function tierOf(n) {
  const T = CONFIG.CUST_TIER;
  if (n >= T.A_MIN) return 'A';
  if (n >= T.B_MIN) return 'B';
  if (n >= T.C_MIN) return 'C';
  if (n >= 1)       return 'D';
  return '';
}

function computeCustomerTiers(invoices, today) {
  const ws = new Date(today.getFullYear(), today.getMonth() - CONFIG.CUST_TIER.WINDOW_MONTHS, today.getDate());
  const agg = {}; // key → { count, value }
  invoices.forEach(function(i) {
    if (!i.transDate || i.transDate < ws) return;   // only invoices inside the window
    const k = _custKey(i);
    const a = agg[k] || (agg[k] = { count: 0, value: 0 });
    a.count += 1;
    a.value += i.total;
  });
  const map = {};
  Object.keys(agg).forEach(function(k) {
    const a = agg[k];
    const tier = tierOf(a.count);
    map[k] = { tier: tier, count: a.count, value: a.value,
               text: tier ? (tier + ' · ' + a.count + '× · ' + rupiah(a.value)) : '' };
  });
  return map;
}

// Writer — one tab, two sections, built with the shared UI helpers (Style.gs).
function writeTodoTab(due, followup) {
  const sh = uiSheet(CONFIG.TABS.TODO);
  const SPAN = 8;
  let r = 1;

  r = uiBanner(sh, r, SPAN,
    '📌 To-Do — Peringatan Harian',
    'Daftar aksi harian — siapa yang harus ditagih & di-follow-up hari ini. ' +
    'Dibuat ulang otomatis tiap jam 5 pagi dari data Accurate. Jangan edit manual.',
    UI.INK, UI.BAND);
  r += 1;

  // ── SECTION A — PENAGIHAN JATUH TEMPO ──
  r = uiSection(sh, r, SPAN, 'PENAGIHAN — Jatuh Tempo (H-1 → H+14, belum bayar)', UI.RED);
  uiHeaderRow(sh, r, ['No. Invoice', 'Customer', 'Sales', 'Jatuh Tempo', 'Reminder', 'Outstanding', 'No. Telp', 'Tier (4bln)']);
  r += 1;
  if (due.length) {
    const aStart = r;
    const aRows = due.map(function(i) {
      return [i.number, i.customer, i.salesman || '(POS / online)', fmtDate(i.dueDate),
              i.bucket, i.outstanding, i.noTlp || '', i.tierText || ''];
    });
    sh.getRange(aStart, 1, aRows.length, SPAN).setValues(aRows).setVerticalAlignment('middle');
    sh.getRange(aStart, 6, aRows.length, 1).setNumberFormat('"Rp"#,##0');
    const aRem = sh.getRange(aStart, 5, aRows.length, 1);
    sh.setConditionalFormatRules((sh.getConditionalFormatRules() || []).concat([
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H-1').setBackground(UI.T_AMBER).setRanges([aRem]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+3').setBackground('#fed7aa').setRanges([aRem]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+7').setBackground(UI.T_RED).setRanges([aRem]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('H+14').setBackground('#fecaca').setRanges([aRem]).build()
    ]));
    r += aRows.length;
  } else {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Tidak ada invoice jatuh tempo di window H-1 → H+14.')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    r += 1;
  }
  r += 1; // gap

  // ── SECTION B — FOLLOW-UP REAKTIVASI ──
  r = uiSection(sh, r, SPAN, 'FOLLOW-UP — Reaktivasi Customer (sejak order terakhir)', UI.BLUE);
  uiHeaderRow(sh, r, ['Customer', 'Sales', 'Order Terakhir', 'Hari Sejak Order', 'Bucket', 'Outstanding', 'No. Telp', 'Tier (4bln)']);
  r += 1;
  if (followup.length) {
    const bStart = r;
    const bRows = followup.map(function(c) {
      return [c.customer, c.salesman || '(POS / online)', fmtDate(c.lastTransDate),
              c.daysSince, c.bucket, c.outstanding, c.noTlp || '', c.tierText || ''];
    });
    sh.getRange(bStart, 1, bRows.length, SPAN).setValues(bRows).setVerticalAlignment('middle');
    sh.getRange(bStart, 6, bRows.length, 1).setNumberFormat('"Rp"#,##0');
    const bDays = sh.getRange(bStart, 4, bRows.length, 1);
    sh.setConditionalFormatRules((sh.getConditionalFormatRules() || []).concat([
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(90)
        .setBackground(UI.T_RED).setRanges([bDays]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(30, 89)
        .setBackground('#fed7aa').setRanges([bDays]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(7, 29)
        .setBackground(UI.T_AMBER).setRanges([bDays]).build()
    ]));
    r += bRows.length;
  } else {
    sh.getRange(r, 1, 1, SPAN).merge().setValue('✅ Tidak ada customer yang perlu di-follow-up (semua order < 7 hari).')
      .setFontColor(UI.NOTE).setFontStyle('italic').setVerticalAlignment('middle');
    r += 1;
  }
  r += 1; // gap

  uiFootnote(sh, r, SPAN,
    '◆ Cara baca: PENAGIHAN = invoice belum lunas, di-bucket 4-touch dari Tgl Jatuh Tempo (H-1 jatuh tempo, ' +
    'H+3 nudge, H+7 stop-supply, H+14 terakhir) — sama dengan tab ✉️ Pesan Penagihan; lewat H+14 handover ke Ade. ' +
    'FOLLOW-UP = customer di-bucket dari hari sejak ORDER terakhir (transaksi terakhir di Accurate); ' +
    'makin lama makin perlu di-reaktivasi.');

  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 130);
  sh.setColumnWidth(4, 130);
  sh.setColumnWidth(5, 150);
  sh.setColumnWidth(6, 130);
  sh.setColumnWidth(7, 140);
  sh.setColumnWidth(8, 190); // Tier (4bln)
  sh.setFrozenRows(2); // banner + subtitle
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// POOL WRITERS — UPSERT (preserve 🟡 human columns 9–12 by invoice number)
// ─────────────────────────────────────────────────────────────────────────────
// 19-column unified schema:
//   1 No. Invoice🔴 2 Customer🔴 3 Nilai Invoice🔴 4 Tgl JT🔴 5 Tgl Handover🔴
//   6 Piutang Awal🔴 7 Outstanding🔴 8 Hari Sejak Handover🔴
//   9 Channel🟡 10 Hasil Negosiasi🟡 11 Tgl Follow-up Terakhir🟡 12 Bukti Transfer🟡
//   13 Tgl Bayar🔴 14 Masuk Kas (bln ini)🔴 15 Aging saat Collect🔴 16 Komisi (auto)🔴 17 Status🔴
//   18 Alamat Customer🔴 19 No. Telp🔴  (from Accurate customer master)
//   20 📄 Invoice🔴  (HYPERLINK to the Faktur PDF web app — Faktur.gs)
//   21 Tier (4bln)🔴  (loyalty tier A–D · count · value — computeCustomerTiers)
var POOL_HEADERS = [
  'No. Invoice', 'Customer', 'Nilai Invoice', 'Tgl JT', 'Tgl Handover (H+15)',
  'Piutang Awal', 'Outstanding', 'Hari Sejak Handover',
  'Channel', 'Hasil Negosiasi', 'Tgl Follow-up Terakhir', 'Bukti Transfer',
  'Tgl Bayar', 'Masuk Kas (bln ini)', 'Aging saat Collect', 'Komisi (auto)', 'Status',
  'Alamat Customer', 'No. Telp', '📄 Invoice', 'Tier (4bln)'
];
var POOL_YELLOW_COLS = [9, 10, 11, 12]; // human-filled, preserved across syncs

var POOL_HROW = 3;  // column-header row (banner=1, subtitle=2)
var POOL_DROW = 4;  // first data row

function writePoolTab(name, rows, pool, preservedOverride) {
  const ss = _ss();
  let sh = ss.getSheetByName(name);
  const SPAN = POOL_HEADERS.length;

  // 1) Preserve 🟡 columns (Channel/Hasil/Tgl Follow-up/Bukti) keyed by invoice number.
  //    With multiple target files (master + Ade), the caller passes a pre-merged map so every
  //    file writes IDENTICAL 🟡; without it, fall back to reading this tab's own cols 9–12.
  let preserved = preservedOverride || {};
  if (!preservedOverride && sh && sh.getLastRow() >= 2) {
    const old = sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues();
    old.forEach(function(r) {
      const key = r[0];
      if (key) preserved[key] = [r[8], r[9], r[10], r[11]]; // cols 9–12 (0-indexed 8–11)
    });
  }

  // 2) Rebuild the sheet.
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  // sh.clear() does NOT reset frozen panes — a leftover frozenColumns from a
  // prior run makes the full-width banner merge straddle the boundary and throw
  // ("can't merge frozen and non-frozen columns"). Reset both axes first.
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  sh.getRange(1, 1, sh.getMaxRows(), SPAN).breakApart();              // drop stale merges
  sh.getRange(1, 1, sh.getMaxRows(), SPAN).clearDataValidations();
  // drop any prior protections so they don't stack across runs
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(p) { if (p.canEdit()) p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(p) { if (p.canEdit()) p.remove(); });

  // banner + narrative subtitle (Pool A = brick red, Pool B = royal blue)
  const isA = pool === 'A';
  uiBanner(sh, 1, SPAN,
    (isA ? '🔴 Pool A — Stuck AR (Legacy Backlog)' : '🔵 Pool B — Ongoing AR'),
    (isA
      ? 'Snapshot FROZEN per ' + CONFIG.ADE_ONBOARD_DATE + '. Aging bucket dikunci, list tidak bertambah — burn-down ke Rp0.'
      : 'Invoice yang lewat ke ' + CONFIG.AR_OFFICER_NAME + ' di H+15 setelah onboard. Terus bertambah seiring waktu.'),
    (isA ? UI.RED : UI.BLUE), (isA ? UI.RED_SOFT : UI.BLUE_SOFT));

  // column headers at row 3
  uiHeaderRow(sh, POOL_HROW, POOL_HEADERS);
  sh.getRange(POOL_HROW, 9, 1, 4).setBackground(UI.AMBER).setFontColor(UI.WHITE); // 🟡 cols
  sh.setFrozenRows(POOL_HROW);
  // NB: no frozen columns — the full-width banner merge (row 1, cols 1–SPAN)
  // straddles any column-freeze boundary, which Sheets rejects ("can't merge
  // frozen and non-frozen columns"). Frozen header rows handle the key axis.

  // 3) Merge system columns with preserved 🟡 columns.
  const matrix = rows.map(function(r) {
    const y = preserved[r.number] || ['', '', '', ''];
    return [
      r.number, r.customer, r.total, fmtDate(r.dueDate), fmtDate(r.handoverDate),
      r.piutangAwal, r.outstanding, r.hariSejakHandover,
      y[0], y[1], y[2], y[3],
      fmtDate(r.tglBayar), r.masukKasBln,
      (r.agingAtCollect == null ? '' : r.agingAtCollect + ' hari (' + (bucketLabel(r.bucketLock) || '-') + ')'),
      r.komisi, r.status,
      r.alamat, r.noTlp,
      fakturLinkFormula(r.id, r.number, r.customerId),  // col 20 — 📄 PDF link (blank pre-deploy)
      r.tierText                          // col 21 — Tier (4bln)
    ];
  });
  if (matrix.length) {
    sh.getRange(POOL_DROW, 1, matrix.length, SPAN).setValues(matrix);
    sh.getRange(POOL_DROW, 1, matrix.length, SPAN)
      .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);

    // rupiah formats: 3 Nilai, 6 Piutang Awal, 7 Outstanding, 14 Masuk Kas, 16 Komisi
    [3, 6, 7, 14, 16].forEach(function(c) {
      sh.getRange(POOL_DROW, c, matrix.length, 1).setNumberFormat('"Rp"#,##0');
    });

    // 🟡 dropdowns
    const chanRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['WA', 'Telp', 'Visit'], true).setAllowInvalid(true).build();
    sh.getRange(POOL_DROW, 9, matrix.length, 1).setDataValidation(chanRule);
    const hasilRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Cicil', 'Payment', 'Komitmen Bayar', '-'], true).setAllowInvalid(true).build();
    sh.getRange(POOL_DROW, 10, matrix.length, 1).setDataValidation(hasilRule);

    // tint 🟡 body cells light amber so Ade knows what's hers to fill
    sh.getRange(POOL_DROW, 9, matrix.length, 4).setBackground(UI.AMBER_BODY);

    // status highlight: Lunas green · Partial amber · Open red · tier (col 21) by letter
    const statusRange = sh.getRange(POOL_DROW, 17, matrix.length, 1);
    const tierRange   = sh.getRange(POOL_DROW, 21, matrix.length, 1);
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Lunas').setBackground(UI.T_GREEN).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Partial').setBackground(UI.T_AMBER).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Open').setBackground(UI.T_RED).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Belum Lunas').setBackground(UI.T_RED).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Bad Debt').setBackground(UI.T_GREY).setRanges([statusRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRange]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRange]).build()
    ]);
  }

  // 4) In-table TOTAL row (black band) right under the data.
  const totRow  = POOL_DROW + matrix.length;
  const totNilai = rows.reduce(function(s, r) { return s + r.total; }, 0);
  const totOut   = rows.reduce(function(s, r) { return s + r.outstanding; }, 0);
  const totKas   = rows.reduce(function(s, r) { return s + r.masukKasBln; }, 0);
  const totKom   = rows.reduce(function(s, r) { return s + r.komisi; }, 0);
  sh.getRange(totRow, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(totRow, 2).setValue('TOTAL');
  sh.getRange(totRow, 3).setValue(totNilai).setNumberFormat('"Rp"#,##0');
  sh.getRange(totRow, 7).setValue(totOut).setNumberFormat('"Rp"#,##0');
  sh.getRange(totRow, 14).setValue(totKas).setNumberFormat('"Rp"#,##0');
  sh.getRange(totRow, 16).setValue(totKom).setNumberFormat('"Rp"#,##0');

  // footnote
  uiFootnote(sh, totRow + 1, SPAN, isA
    ? '◆ Cara baca: Aging bucket FROZEN — tidak berubah meski waktu berjalan. Komisi = Masuk Kas × rate bucket asli. List tidak bertambah; hanya berkurang saat lunas.'
    : '🔵 Cara baca: Aging saat Collect = selisih hari Tgl Handover (H+15) → Tgl Bayar; itu yang mengunci bucket komisi. Invoice baru masuk otomatis tiap sync.');

  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(18, 280);  // Alamat Customer
  sh.setColumnWidth(19, 140);  // No. Telp
  sh.setColumnWidth(20, 90);   // 📄 Invoice
  sh.setColumnWidth(21, 190);  // Tier (4bln)

  // 5) Range protection — lock the 🔴 script-owned columns; leave only the
  //    four 🟡 columns (9–12, data rows) editable for Ade. Owner keeps full access.
  const prot = sh.protect()
    .setDescription('ROSH AccurateSync — kolom 🔴 dikunci. Hanya 🟡 (Channel, Hasil Negosiasi, Tgl Follow-up, Bukti Transfer) yang bisa diedit.');
  // setWarningOnly(true): shows a warning popup on protected cells without needing
  // userinfo.email scope (getEditors/removeEditor required that scope and caused
  // "Specified permissions are not sufficient" errors on every sync).
  const yRows = Math.max(rows.length, 1);
  prot.setUnprotectedRanges([sh.getRange(POOL_DROW, 9, yRows, 4)]);
  prot.setWarningOnly(true);

  return sh;
}

function writeInvoiceSalesTab(list) {
  const sh = _tab(CONFIG.TABS.INVOICE_SALES,
    ['No. Invoice', 'Customer', 'Sales', 'Jatuh Tempo', 'Hari Lewat JT',
     'Outstanding', 'Status', 'No. Telp', '📄 Invoice', 'Tier (4bln)']);
  const rows = list.map(function(i) {
    return [i.number, i.customer, i.salesman || '(POS)', fmtDate(i.dueDate),
            i.daysPastDue == null ? '' : i.daysPastDue, i.outstanding, i.statusLabel,
            i.noTlp || '', fakturLinkFormula(i.id, i.number, i.customerId), i.tierText || ''];
  });
  _write(sh, rows);
  fmtRupiah(sh, 6, 6, rows.length);
  const cfRangeSales = sh.getRange(2, 5, Math.max(rows.length, 1), 1);
  const tierRangeSales = sh.getRange(2, 10, Math.max(rows.length, 1), 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setBackground('#fef9c3').setRanges([cfRangeSales]).build(),    // Yellow  — belum JT
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0, 6)
      .setBackground('#fed7aa').setRanges([cfRangeSales]).build(),    // Orange  — 0–6 hari
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(7)
      .setBackground('#fecaca').setRanges([cfRangeSales]).build(),    // Light red — 7–14 hari
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRangeSales]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRangeSales]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRangeSales]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRangeSales]).build()
  ]);
  sh.setColumnWidth(8, 130);
  sh.setColumnWidth(9, 90);    // 📄 Invoice
  sh.setColumnWidth(10, 190);  // Tier (4bln)
  _writeSidePanel(sh, 12, list, '📊 Ringkasan Tagihan Sales');  // sc=12; col 9 link, 10 tier, 11 spacer
}

// Tagihan Lain — pre-handover invoices outside SALES_FILTER (Nathan/partner, POS, others).
function writeInvoiceLainTab(list) {
  const sh = _tab(CONFIG.TABS.TAGIHAN_LAIN,
    ['No. Invoice', 'Customer', 'Sales / Sumber', 'Jatuh Tempo', 'Hari Lewat JT',
     'Outstanding', 'Status', 'No. Telp', '📄 Invoice', 'Tier (4bln)']);
  const rows = list.map(function(i) {
    return [i.number, i.customer, i.salesman || '(POS / online)', fmtDate(i.dueDate),
            i.daysPastDue == null ? '' : i.daysPastDue, i.outstanding, i.statusLabel,
            i.noTlp || '', fakturLinkFormula(i.id, i.number, i.customerId), i.tierText || ''];
  });
  _write(sh, rows);
  fmtRupiah(sh, 6, 6, rows.length);
  const cfRangeLain = sh.getRange(2, 5, Math.max(rows.length, 1), 1);
  const tierRangeLain = sh.getRange(2, 10, Math.max(rows.length, 1), 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setBackground('#fef9c3').setRanges([cfRangeLain]).build(),     // Yellow  — belum JT
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0, 6)
      .setBackground('#fed7aa').setRanges([cfRangeLain]).build(),     // Orange  — 0–6 hari
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(7)
      .setBackground('#fecaca').setRanges([cfRangeLain]).build(),     // Light red — 7–14 hari
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges([tierRangeLain]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges([tierRangeLain]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges([tierRangeLain]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges([tierRangeLain]).build()
  ]);
  sh.setColumnWidth(8, 130);
  sh.setColumnWidth(9, 90);    // 📄 Invoice
  sh.setColumnWidth(10, 190);  // Tier (4bln)
  _writeSidePanel(sh, 12, list, '📊 Ringkasan Tagihan Lain');  // sc=12; col 9 link, 10 tier, 11 spacer
}

// Side-panel summary written to the right of the list table (col sc = 10, spacer at 9).
// Shows stats, Top 5 customers by outstanding, and breakdown by salesman/source.
function _writeSidePanel(sh, sc, list, title) {
  const total    = list.reduce(function(s, i) { return s + i.outstanding; }, 0);
  const overdueN = list.filter(function(i) { return i.daysPastDue != null && i.daysPastDue > 0; }).length;

  // ── Stats block ──
  sh.getRange(1, sc, 1, 2).merge().setValue(title)
    .setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  const stats = [
    ['Total Outstanding', total],
    ['Jumlah Invoice',    list.length],
    ['Lewat JT',          overdueN + ' invoice'],
    ['Belum Jatuh Tempo', (list.length - overdueN) + ' invoice']
  ];
  sh.getRange(2, sc, stats.length, 2).setValues(stats);
  sh.getRange(2, sc + 1).setNumberFormat('"Rp"#,##0');
  sh.getRange(2, sc, stats.length, 1).setFontWeight('bold');

  // ── Top 5 customers ──
  const custMap = {};
  list.forEach(function(i) { custMap[i.customer] = (custMap[i.customer] || 0) + i.outstanding; });
  const top5 = Object.keys(custMap)
    .map(function(n) { return [n, custMap[n]]; })
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 5);

  const t5r = 7;
  sh.getRange(t5r, sc, 1, 2).merge().setValue('🏆 Top 5 Customer')
    .setBackground('#374151').setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(t5r + 1, sc, 1, 2).setValues([['Customer', 'Outstanding']])
    .setBackground(UI.BAND).setFontWeight('bold');
  if (top5.length) {
    sh.getRange(t5r + 2, sc, top5.length, 2).setValues(top5);
    sh.getRange(t5r + 2, sc + 1, top5.length, 1).setNumberFormat('"Rp"#,##0');
  }

  // ── By salesman / source ──
  const salesMap = {};
  list.forEach(function(i) {
    const k = i.salesman || '(POS / online)';
    salesMap[k] = (salesMap[k] || 0) + i.outstanding;
  });
  const salesRows = Object.keys(salesMap)
    .map(function(k) { return [k, salesMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; });

  const byr = t5r + 2 + top5.length + 2;
  sh.getRange(byr, sc, 1, 2).merge().setValue('👤 By Salesman / Sumber')
    .setBackground('#374151').setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(byr + 1, sc, 1, 2).setValues([['Salesman', 'Outstanding']])
    .setBackground(UI.BAND).setFontWeight('bold');
  if (salesRows.length) {
    sh.getRange(byr + 2, sc, salesRows.length, 2).setValues(salesRows);
    sh.getRange(byr + 2, sc + 1, salesRows.length, 1).setNumberFormat('"Rp"#,##0');
  }

  sh.setColumnWidth(sc, 180);
  sh.setColumnWidth(sc + 1, 130);
}

// Rename existing live tabs to the new CONFIG.TABS names IN PLACE, so Pool A/B keep
// Ade's 🟡 hand-filled columns (a fresh insertSheet by the new name would lose them).
// Runs before any writer. No-ops once renamed; drops a stale old tab if the new one
// already exists (e.g. a partial prior run).
function migrateTabNames() {
  const ss = _ss();
  (CONFIG.TAB_MIGRATION || []).forEach(function(pair) {
    const oldName = pair[0];
    const newName = CONFIG.TABS[pair[1]];
    if (!newName || oldName === newName) return;
    const oldSh = ss.getSheetByName(oldName);
    if (!oldSh) return;
    const newSh = ss.getSheetByName(newName);
    if (!newSh) {
      oldSh.setName(newName);
    } else if (oldSh.getSheetId() !== newSh.getSheetId()) {
      ss.deleteSheet(oldSh); // new tab already present — old one is stale
    }
  });
}

// Remove deprecated tabs: legacy single 'Tagihan Ade' (replaced by Pool A/B) and the old
// '📊 Business Health' tab (folded into 📋 Ringkasan 2026-06-05). _MetricSnapshots stays.
function deleteDeprecatedTabs() {
  const ss = _ss();
  [CONFIG.TABS.TAGIHAN_ADE, CONFIG.TABS.HEALTH].forEach(function(n) {
    const sh = ss.getSheetByName(n);
    if (sh) ss.deleteSheet(sh);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-ROLE FILES — separate Sheets for Ade & Deden (real tab isolation; Google can't
// hide tabs per-user inside one file). fullSync writes each role's subset into its file.
// ─────────────────────────────────────────────────────────────────────────────

// Merge 🟡 (Channel/Hasil Negosiasi/Tgl Follow-up/Bukti Transfer) across files, keyed by
// invoice number. Later files in the list override non-empty cells → pass [master, adeSS]
// so Ade's entries (her working copy) win and flow back to master.
function collectPoolYellow(ssList, tabName) {
  const map = {};
  ssList.forEach(function(ss) {
    if (!ss) return;
    const sh = ss.getSheetByName(tabName);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues().forEach(function(r) {
      const key = r[0];
      if (!key) return;
      const y = [r[8], r[9], r[10], r[11]];          // cols 9–12
      const ex = map[key] || ['', '', '', ''];
      for (var i = 0; i < 4; i++) { if (y[i] !== '' && y[i] != null) ex[i] = y[i]; }
      map[key] = ex;
    });
  });
  return map;
}

// Open a role file by its stored Script Property id; null (logged) if unset/inaccessible.
function _roleSS(propKey) {
  const id = _props().getProperty(propKey);
  if (!id) return null;
  try { return SpreadsheetApp.openById(id); }
  catch (e) { Logger.log('Role sheet ' + propKey + ' tak terbuka: ' + e.message); return null; }
}

// Return the stored role Sheet, or create one and store its id.
function _ensureRoleSheet(propKey, name) {
  const id = _props().getProperty(propKey);
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate */ } }
  const ss = SpreadsheetApp.create(name);
  _props().setProperty(propKey, ss.getId());
  return ss;
}

/** One-time: create (or reuse) Ade & Deden files and share to their Gmail.
 *  Ade = Editor (fills 🟡); Deden = Viewer. Then run fullSync() to populate. */
function setupRoleSheets(adeEmail, dedenEmail) {
  const ade   = _ensureRoleSheet('ADE_SHEET_ID',   'ROSH AR — Ade');
  const deden = _ensureRoleSheet('DEDEN_SHEET_ID', 'ROSH Tagihan — Deden');
  if (adeEmail)   { try { DriveApp.getFileById(ade.getId()).addEditor(adeEmail); }   catch (e) { Logger.log('Share Ade gagal: ' + e.message); } }
  if (dedenEmail) { try { DriveApp.getFileById(deden.getId()).addViewer(dedenEmail); } catch (e) { Logger.log('Share Deden gagal: ' + e.message); } }
  Logger.log('Ade   sheet (' + (adeEmail   || 'belum di-share') + '): ' + ade.getUrl());
  Logger.log('Deden sheet (' + (dedenEmail || 'belum di-share') + '): ' + deden.getUrl());
  Logger.log('Sekarang jalankan fullSync() untuk mengisi kedua file.');
}

/** Wrapper — isi email Ade & Deden, lalu Run sekali (tombol Run tak bisa kirim argumen). */
function setupRoleSheetsOnce() {
  setupRoleSheets(
    'EMAIL_ADE@gmail.com',    // Ade (AR Officer) → Editor (boleh isi kolom 🟡)
    'EMAIL_DEDEN@gmail.com'   // Deden (Sales)    → Viewer (lihat saja)
  );
}

// Drop the empty default "Sheet1" left by SpreadsheetApp.create once real tabs exist.
function _dropDefaultSheet() {
  const ss = _ss();
  ['Sheet1', 'Sheet 1', 'Sheet'].forEach(function(n) {
    const sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHEET HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _ss() { return TARGET_SS || SpreadsheetApp.openById(CONFIG.SHEET_ID); }
function _tab(name, headers) {
  const ss = _ss();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  if (headers) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}
function _write(sh, rows, startRow) {
  if (!rows.length) return;
  sh.getRange(startRow || 2, 1, rows.length, rows[0].length).setValues(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTIL
// ─────────────────────────────────────────────────────────────────────────────
function num(v) { v = parseFloat(v); return isNaN(v) ? 0 : v; }
function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function _onboardDate() {
  const m = String(CONFIG.ADE_ONBOARD_DATE).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : stripTime(new Date());
}

// Accurate returns dates as "dd/MM/yyyy" (sometimes with time "dd/MM/yyyy HH:mm:ss").
function parseAccDate(s) {
  if (!s) return null;
  if (s instanceof Date) return stripTime(s);
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : stripTime(d);
}
function fmtDate(d) { return d ? Utilities.formatDate(d, 'GMT+7', 'dd/MM/yyyy') : ''; }
function fmtRupiah(sh, colStart, colEnd, n) {
  if (!n) return;
  sh.getRange(2, colStart, n, colEnd - colStart + 1).setNumberFormat('"Rp"#,##0');
}

function _log(level, msg) {
  const sh = _ss().getSheetByName(CONFIG.TABS.LOG) ||
             _tab(CONFIG.TABS.LOG, ['Waktu', 'Level', 'Pesan']);
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd HH:mm:ss'), level, msg]]);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGERS — daily at 05:00 (GMT+7 per project settings)
// ─────────────────────────────────────────────────────────────────────────────
function installTrigger() {
  removeTriggers();
  // Full daily automation chain (Asia/Jakarta), spaced 1 hour apart so no single run nears
  // the 6-min limit and they execute in order:
  //   03:00 generate faktur PDFs → front-fill cache so 📄 links are DIRECT Drive links
  //   04:00 prune faktur PDFs    → trash paid/closed so Drive holds only open invoices
  //   05:00 full sync            → write all tabs + direct links from the fresh cache
  // ⚠️ DO NOT swap the 03:00 handler to catchUpFakturPdfs. The owner account
  // (roshanstrateginusantara@gmail.com) is a CONSUMER Gmail → 90-min/day TOTAL trigger-runtime
  // quota. A long auto-catch-up (many 5-min continuation batches) can exhaust that quota and
  // starve the 04:00 prune + 05:00 sync (they fail), and overlap them in time. Keep 03:00 as the
  // BOUNDED single-batch generateFakturPdfs (≤5 min → done ~03:05, clean handoff). For a big
  // backlog, run "Auto catch-up Faktur" MANUALLY from the menu (watched), like the initial drain.
  ScriptApp.newTrigger('generateFakturPdfs').timeBased().everyDays(1).atHour(3).inTimezone('Asia/Jakarta').create();
  ScriptApp.newTrigger('pruneFakturPdfs').timeBased().everyDays(1).atHour(4).inTimezone('Asia/Jakarta').create();
  ScriptApp.newTrigger('fullSync').timeBased().everyDays(1).atHour(5).inTimezone('Asia/Jakarta').create();
  SpreadsheetApp.getUi().alert(
    'Otomatis harian terpasang (WIB):\n' +
    '• 03:00 Generate Faktur PDF (link 📄 jadi direct)\n' +
    '• 04:00 Prune Faktur (hapus yang lunas)\n' +
    '• 05:00 Full Sync\n\n' +
    'Catatan: kalau backlog faktur masih banyak, jalankan "Generate Faktur PDFs (batch)" ' +
    'manual beberapa kali hari ini biar cepat penuh — sisanya nanti otomatis tiap jam 3 pagi.');
}
function removeTriggers() {
  var FNS = { fullSync: 1, generateFakturPdfs: 1, pruneFakturPdfs: 1, catchUpFakturPdfs: 1 };
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (FNS[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });
}
