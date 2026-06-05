/**
 * ROSH × Accurate — On-demand Faktur Penjualan PDF.
 *
 * Accurate's Open API is data-only (list/detail/save/delete) — it has NO print/PDF
 * endpoint. So we regenerate the ROSH-branded faktur ourselves from sales-invoice
 * detail.do and serve it as a one-tap link inside the collection tabs.
 *
 * Flow (DIRECT links + server-side generation — fakturLinkFormula):
 *   • Cached  → Sheet cell links DIRECT to drive.google.com/file/d/<id>/view → 1-tap open.
 *                A top-level nav to an anyone-with-link Drive file is the ONE render proven
 *                reliable in this team's multi-account browsers.
 *   • Uncached→ blank, until a server-side pass generates it (generateFakturPdfs /
 *                catchUpFakturPdfs / daily trigger — all run AS THE OWNER, no browser).
 *   WHY NOT generate-on-click via the web app? When doGet touches Drive during a click from a
 *   multi-account browser, Google serves its "Sorry, unable to open the file" page instead of
 *   our response (confirmed even with &dbg=1, Execute-as-Me + Anyone). So the /exec generator
 *   path is a dead end here; generation lives server-side and the sheet only uses direct links.
 *   doGet() is kept for owner/manual access + diagnostics, not wired into the sheet anymore.
 *
 * Deploy:  Deploy ▸ New deployment ▸ Web app, Execute as ME, Access ANYONE.
 *          Then run setFakturWebAppUrl() (or it auto-resolves), setupFakturFolder(),
 *          setFakturAssets(signFileId, logoFileId). See CLAUDE.md.
 *
 * Reuses globals from Sync.gs: num(), parseAccDate(), _custAddress(); and _props() from Code.gs.
 * Requires Drive scope (appsscript.json: .../auth/drive).
 */

// ─────────────────────────────────────────────────────────────────────────────
// STATIC TEMPLATE DATA  (hardcoded per Bro — see CLAUDE.md "Faktur")
// ─────────────────────────────────────────────────────────────────────────────
var FAKTUR = {
  COMPANY:  'Roshan Strategi Nusantara',
  ADDRESS:  'Jalan Kamal Lama No.49 Blok A18, Kamal Muara, Penjaringan, DKI Jakarta 11810',
  COUNTRY:  'Indonesia',
  VA_BCA:   '15903614617',          // Virtual Account BCA (default/company — fallback bila customer tak punya VA)
  VA_PREFIX:'15903',                // biller prefix BCA; VA penuh customer = VA_PREFIX + customerNoVa
  REK_BCA:  '6560380435',           // rekening BCA
  ACC_NAME: 'Roshan Strategi Nusantara',
  DIRECTOR: 'Jonathan Owen',
  DIR_TITLE:'Direktur Utama',
  FOOTER:   '*Harga pada invoice ini bersifat nett dan telah termasuk PPN',
  DISCLAIMER:'Dokumen ini bukan merupakan tanda bukti pelunasan. Pembayaran dianggap sah ' +
             'setelah diterima & tercatat oleh PT Roshan Strategi Nusantara.',
  FOLDER:   'ROSH Faktur PDF'
};

// ─────────────────────────────────────────────────────────────────────────────
// WEB APP ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  var id = p.id;
  var number = p.n || '';
  var custId = p.c || '';                 // customer id dari link → resolve VA per customer
  if (!id && !number) {
    return _htmlPage('Faktur', '✅ FAKTUR v8 (hybrid: direct + generator) — link 📄 PDF yang sudah ter-cache buka Drive langsung; yang belum, generate on-demand lalu antar ke Drive. Buka via link 📄 PDF (butuh ?id & ?n).');
  }
  try {
    var file = getOrCreateFaktur(id, number, custId);
    var name = file.getName();
    var fileId = file.getId();

    // DEBUG isolation (append &dbg=1). Returns a TINY text page — proves the param path +
    // Drive access work without serving any heavy payload. Handy if a link ever errors again.
    if (p.dbg) {
      return _htmlPage('DBG', '✅ DBG OK — file=' + _esc(name) + ' · id=' + _esc(fileId) +
        ' · size=' + file.getSize() + ' bytes');
    }
    // Render strategy = GENERATE (above), then hand off to a TOP-LEVEL Drive /view link.
    // We deliberately do NOT inline the PDF bytes (base64 data: URI) anymore: that ~1.3MB
    // response fails to load inside Apps Script's sandboxed iframe during multi-account Google
    // sessions — the exact "Sorry, unable to open the file" page Bro hit at the /exec URL
    // (small pages and single-account/incognito sessions were fine). A direct Drive /view link
    // opened as a TOP navigation is the one path proven reliable in deep multi-account browsers,
    // and this page is tiny so it always loads. The file is already anyone-with-link
    // (getOrCreateFaktur → _ensureShared), so /view opens for Ade/Deden/anyone.
    var viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
    var label   = _esc(name.replace(/\.pdf$/i, ''));
    var html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + _esc(name) + '</title>' +
      '<style>html,body{margin:0;height:100%;font-family:Arial,Helvetica,sans-serif;color:#1f2937;' +
      'display:flex;align-items:center;justify-content:center;background:#f3f4f6}' +
      '.card{text-align:center;padding:32px 28px;background:#fff;border:1px solid #e5e7eb;' +
      'border-radius:14px;max-width:420px;box-shadow:0 1px 4px rgba(0,0,0,.06)}' +
      '.nm{font-size:13px;color:#6b7280;margin-bottom:4px}' +
      '.ttl{font-size:17px;font-weight:bold;margin-bottom:18px}' +
      '.btn{display:inline-block;text-decoration:none;font-weight:bold;font-size:16px;' +
      'padding:13px 22px;border-radius:9px;background:#0d9488;color:#fff}' +
      '.hint{font-size:12px;color:#6b7280;margin-top:14px}</style></head><body>' +
      '<div class="card">' +
        '<div class="nm">Faktur Penjualan</div>' +
        '<div class="ttl">📄 ' + label + '</div>' +
        '<a id="go" class="btn" href="' + viewUrl + '" target="_top" rel="noopener">Buka Faktur ›</a>' +
        '<div class="hint">Faktur siap. Klik tombol di atas kalau tidak terbuka otomatis.</div>' +
      '</div>' +
      // Best-effort auto-open: TOP window only. NEVER window.location — that would load Drive
      // INSIDE the sandbox iframe (= the old "unable to open" bug). If the sandbox blocks
      // top-nav without a user gesture, this no-ops and the button above takes over (1 tap).
      '<script>try{window.top.location.href=' + JSON.stringify(viewUrl) + ';}catch(e){}</script>' +
      '</body></html>';
    return HtmlService.createHtmlOutput(html)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setTitle(name)
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
  } catch (err) {
    return _htmlPage('Faktur — Gagal', '❌ ' + _esc(err.message || String(err)));
  }
}

function _htmlPage(title, body) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + _esc(title) + '</title>' +
    '<style>body{font-family:Arial,sans-serif;padding:40px;color:#1f2937;text-align:center}</style>' +
    '</head><body><h3>' + _esc(title) + '</h3><p>' + body + '</p></body></html>');
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE + BUILD  — one Drive file per invoice, named "<number>.pdf"
// ─────────────────────────────────────────────────────────────────────────────
function getOrCreateFaktur(id, number, custId) {
  var folder = _fakturFolder();

  // Cache hit by invoice number (passed in the link → no API call needed).
  // Skip trashed files so "Clear Faktur PDF cache" actually forces a rebuild.
  // Re-assert sharing on every hit — old cached files (or a prior run where the
  // share call failed) would otherwise stay private to the owner account and
  // throw the Drive "unable to open" page for anyone else who taps the link.
  if (number) {
    var hit = folder.getFilesByName(number + '.pdf');
    while (hit.hasNext()) { var f = hit.next(); if (!f.isTrashed()) return _ensureShared(f); }
  }

  if (id == null) throw new Error('Butuh id invoice untuk membuat faktur baru.');
  var det = accApi('/accurate/api/sales-invoice/detail.do', { id: id });
  var d = det && det.d;
  if (!d) throw new Error('Invoice id ' + id + ' tidak ditemukan di Accurate.');

  number = number || String(d.number || ('INV-' + id));
  // Re-check cache now that we know the number (link may not have carried it).
  var hit2 = folder.getFilesByName(number + '.pdf');
  while (hit2.hasNext()) { var f2 = hit2.next(); if (!f2.isTrashed()) return _ensureShared(f2); }

  var html = buildFakturHtml(d, custId);
  return htmlToPdf(html, number + '.pdf', folder);
}

function htmlToPdf(html, name, folder) {
  var pdf = Utilities.newBlob(html, 'text/html', name).getAs('application/pdf').setName(name);
  var file = folder.createFile(pdf);
  return _ensureShared(file);
}

// Make a faktur file anyone-with-link viewable, and SURFACE failures instead of
// swallowing them. If the share can't be applied the file is private to the owner
// account → other Google accounts (or a different PC/login on the same shared
// account) get Drive's "Sorry, unable to open the file" page. Skips the write when
// the file is already public so cache hits stay cheap.
function _ensureShared(file) {
  try {
    if (file.getSharingAccess() === DriveApp.Access.ANYONE_WITH_LINK) return file;
  } catch (e) { /* getSharingAccess unsupported on some drives → just try to set */ }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    throw new Error('File faktur "' + file.getName() + '" tidak bisa di-share publik ' +
      '(anyone-with-link). Akun yang menjalankan web app tidak punya hak share file ini, ' +
      'atau kebijakan Drive memblokirnya. Detail: ' + (e && e.message ? e.message : e));
  }
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML TEMPLATE  (mirrors the Accurate Faktur Penjualan print layout)
// ─────────────────────────────────────────────────────────────────────────────
function buildFakturHtml(d, custId) {
  var number  = d.number || '';
  var tgl     = _fLong(d.transDate);
  var kirim   = _fLong(d.shipDate || d.transDate);
  var jt      = _fLong(d.dueDate);
  var po      = d.poNumber || d.poNo || '';
  var term    = (d.paymentTerm && d.paymentTerm.name) || d.termName || d.paymentTermName || '';
  var custNm  = (d.customer && d.customer.name) || d.customerName || '';
  var custAd  = _cleanAddr(d.toAddress || (d.customer ? _custAddress(d.customer) : '') || '');
  var ket     = d.description || d.detailNotes || d.note || '';
  var total   = num(d.totalAmount);
  var vaCode  = _fakturVa(d, custId);                  // raw customerNoVa code (or '')
  var va      = vaCode ? _fullVaBca(vaCode) : FAKTUR.VA_BCA;  // full VA (prefix+code); static fallback

  // Line items — field names vary across Accurate builds (see diagFakturFields()).
  var items = d.detailItem || d.detailItems || d.detailExpense || [];
  var rowsHtml = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var kode  = (it.item && (it.item.no || it.item.code)) || it.itemNo || it.no || '';
    var nama  = (it.item && it.item.name) || it.detailName || it.itemName || it.name || '';
    var qty   = num(it.quantity != null ? it.quantity : it.qty);
    var harga = num(it.unitPrice != null ? it.unitPrice : it.price);
    var disc  = num(it.cashDiscount != null ? it.cashDiscount :
                   (it.itemCashDiscount != null ? it.itemCashDiscount : it.discount));
    var ltot  = num(it.totalPrice != null ? it.totalPrice :
                   (it.amount != null ? it.amount : (qty * harga - disc)));
    rowsHtml +=
      '<tr>' +
      '<td>' + _esc(kode) + '</td>' +
      '<td>' + _esc(nama) + '</td>' +
      '<td class="num">' + _money(qty) + '</td>' +
      '<td class="num">' + _money(harga) + '</td>' +
      '<td class="num">' + _money(disc) + '</td>' +
      '<td class="num">' + _money(ltot) + '</td>' +
      '</tr>';
  }

  var logo = _fakturImg('FAKTUR_LOGO_FILE_ID', 'class="logo"');
  var sign = _fakturImg('FAKTUR_SIGN_FILE_ID', 'class="sign"');

  return '' +
'<!doctype html><html><head><meta charset="utf-8"><style>' +
'@page{size:A4;margin:1.1cm}' +
'*{box-sizing:border-box}' +
'body{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:11px;margin:0}' +
'table{border-collapse:collapse}' +
'.hd{width:100%}.hd td{vertical-align:middle}' +
'.logo{height:96px;display:block}' +
'.hdL{padding-right:14px}' +
'.co{font-size:20px;font-weight:bold;line-height:1.05}' +
'.addr{font-size:9.5px;color:#000;line-height:1.35}' +
'.ttl{font-size:22px;font-weight:bold;text-align:right;vertical-align:middle}' +
'.kp{width:100%;margin-top:8px}.kp>tbody>tr>td{vertical-align:top}' +
'.kpL{width:53%;padding-right:16px}' +
'.line{border-top:1px solid #000;margin-bottom:5px}' +
'.lbl{color:#555;font-size:9px}' +
'.cust{font-size:12px;font-weight:bold}' +
'.meta{width:100%;border:1px solid #000}' +
'.meta td{border:1px dashed #999;padding:4px 8px;width:50%;vertical-align:top}' +
'.meta .v{font-weight:bold;font-size:10.5px}' +
'.it{width:100%;margin-top:12px;border:1px solid #333}' +
'.it th{border:1px solid #333;padding:5px 7px;font-size:10px;text-align:left;font-weight:bold}' +
'.it td{border:1px solid #333;padding:5px 7px;font-size:10px}' +
'.num{text-align:right}' +
'.tb{width:100%;margin-top:8px;border:1px solid #333}' +
'.tb td{padding:5px 8px}' +
'.blue{color:#1d4ed8}' +
'.kt{width:100%;margin-top:8px}.kt>tbody>tr>td{vertical-align:top}' +
'.ketbox{border:1px solid #333;height:84px;padding:5px 8px;width:60%}' +
'.totwrap{width:40%;padding-left:12px}' +
'.tot{width:100%;border:1px solid #000}' +
'.tot td{border:1px solid #000;padding:8px;font-weight:bold;font-size:13px}' +
'.note{font-size:8.5px;color:#000;margin-top:5px}' +
'.ft{width:100%;margin-top:26px}.ft td{vertical-align:top;width:33%;font-size:9.5px}' +
'.sign{height:88px}' +
'.sline{border-bottom:1px solid #000;width:160px;margin:2px auto 3px}' +
'.muted{color:#333}' +
'</style></head><body>' +

// header — logo beside company (left) · Faktur Penjualan (right)
'<table class="hd"><tr>' +
  (logo ? '<td class="hdL" style="width:1px;white-space:nowrap">' + logo + '</td>' : '') +
  '<td>' +
    '<div class="co">' + _esc(FAKTUR.COMPANY) + '</div>' +
    '<div class="addr">' + _esc(FAKTUR.ADDRESS) + '<br>' + _esc(FAKTUR.COUNTRY) + '</div></td>' +
  '<td class="ttl">Faktur Penjualan</td>' +
'</tr></table>' +

// kepada (left) + meta box (right), side by side
'<table class="kp"><tr>' +
  '<td class="kpL"><div class="line"></div>' +
    '<div class="lbl">Kepada :</div>' +
    '<div class="cust">' + _esc(custNm) + '</div>' +
    '<div class="addr">' + _esc(custAd) + '</div></td>' +
  '<td><table class="meta">' +
    '<tr><td><div class="lbl">Tanggal</div><div class="v">' + _esc(tgl) + '</div></td>' +
        '<td><div class="lbl">Nomor</div><div class="v">' + _esc(number) + '</div></td></tr>' +
    '<tr><td><div class="lbl">Syarat Pembayaran</div><div class="v">' + _esc(term) + '</div></td>' +
        '<td><div class="lbl">Tanggal Pengiriman</div><div class="v">' + _esc(kirim) + '</div></td></tr>' +
    '<tr><td><div class="lbl">PO No</div><div class="v">' + _esc(po) + '</div></td>' +
        '<td><div class="lbl">Jatuh Tempo</div><div class="v">' + _esc(jt) + '</div></td></tr>' +
  '</table></td>' +
'</tr></table>' +

// items
'<table class="it"><thead><tr>' +
  '<th>Kode Barang</th><th>Nama Barang</th><th class="num">Kts.</th>' +
  '<th class="num">@Harga</th><th class="num">Diskon</th><th class="num">Total Harga</th>' +
'</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +

// terbilang
'<table class="tb"><tr><td><b>Terbilang :</b> <span class="blue">' + _esc(terbilang(total)) + '</span></td></tr></table>' +

// keterangan (left) + total (right)
'<table class="kt"><tr>' +
  '<td class="ketbox"><span class="lbl">Keterangan :</span><br>' + _esc(ket) + '</td>' +
  '<td class="totwrap">' +
    '<table class="tot"><tr><td>Total</td><td class="num">' + _money(total) + '</td></tr></table>' +
    '<div class="note">' + _esc(FAKTUR.FOOTER) + '</div></td>' +
'</tr></table>' +

// footer: signature (left) · payment (mid) · disclaimer (right)
'<table class="ft"><tr>' +
  '<td style="text-align:center"><div class="muted">Hormat Kami,</div>' +
    '<div class="muted">PT ' + _esc(FAKTUR.COMPANY.toUpperCase()) + '</div>' +
    (sign ? '<div>' + sign + '</div>' : '<div style="height:88px"></div>') +
    '<div class="sline"></div>' +
    '<div><b>' + _esc(FAKTUR.DIRECTOR) + '</b></div>' +
    '<div class="muted">' + _esc(FAKTUR.DIR_TITLE) + '</div></td>' +
  '<td><div><b>Metode Pembayaran:</b></div>' +
    '<div style="margin-top:3px">Virtual Account BCA:</div><div><b>' + _esc(va) + '</b></div>' +
    '<div class="muted">a/n: ' + _esc(FAKTUR.ACC_NAME) + '</div>' +
    '<div style="margin-top:4px">atau</div>' +
    '<div>BCA:</div><div><b>' + _esc(FAKTUR.REK_BCA) + '</b></div>' +
    '<div class="muted">a/n: ' + _esc(FAKTUR.ACC_NAME) + '</div></td>' +
  '<td><div class="muted">' + _esc(FAKTUR.DISCLAIMER) + '</div></td>' +
'</tr></table>' +

'</body></html>';
}

// Build the FULL BCA Virtual Account from a customer's `customerNoVa` code.
// Accurate stores only the customer code (e.g. 648718); the full VA = biller prefix +
// code (→ 15903648718). Guards against double-prefix / already-full values.
function _fullVaBca(code) {
  var c = String(code || '').replace(/\D/g, '');
  if (!c) return '';
  if (c.indexOf(FAKTUR.VA_PREFIX) === 0) return c;   // already prefixed
  if (c.length >= 11) return c;                       // already a full-length VA
  return FAKTUR.VA_PREFIX + c;
}

// Customer's own Virtual Account CODE for the faktur (raw customerNoVa, pre-prefix).
// Resolution order: (1) embedded on invoice detail · (2) the shared `_ContactCache`
// (already holds noVa per customerId — same source Pesan uses, no API call) ·
// (3) customer/detail.do lookup. Faktur PDFs are cached → this runs once per invoice.
function _fakturVa(d, custId) {
  var va = (d.customer && (d.customer.customerNoVa || d.customer.noVa)) || d.customerNoVa || '';
  if (va) return String(va).trim();

  var cid = (custId != null && custId !== '') ? custId
            : ((d.customer && d.customer.id) || d.customerId || d.toCustomerId || null);
  if (cid != null && cid !== '') {
    try {
      var cache = _loadContactCache();
      if (cache[cid] && cache[cid].noVa) return String(cache[cid].noVa).trim();
    } catch (e) {}
    try { var c = fetchCustomerDetail(cid); if (c && c.noVa) return String(c.noVa).trim(); } catch (e) {}
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK FORMULA  — written into the four collection tabs by Sync.gs
// ─────────────────────────────────────────────────────────────────────────────
function fakturLinkFormula(id, number, customerId) {
  // DIRECT Drive /view link when the PDF is cached — a top-level nav to an anyone-with-link
  // Drive file, the ONE render proven reliable in this team's multi-account browsers (1 tap,
  // no /exec involved).
  //
  // We deliberately DON'T emit a web-app /exec generator link as a fallback. Generate-on-click
  // via /exec is blocked by Google here: the moment doGet touches Drive during a click from a
  // multi-account browser, Google serves its "Sorry, unable to open the file" page instead of
  // our response — confirmed even with &dbg=1 and with the deployment on Execute-as-Me + Anyone.
  // So generation is moved FULLY server-side: generateFakturPdfs / catchUpFakturPdfs / the daily
  // trigger build the PDFs as the owner (no browser, no multi-account), and Full Sync stamps the
  // direct link. An invoice not yet generated → blank until the next generation pass fills it
  // (run "Auto catch-up Faktur" once to drain the backlog; the daily trigger keeps it current).
  if (!number) return '';
  var fid = _fakturFileId(number);
  if (fid) return '=HYPERLINK("https://drive.google.com/file/d/' + fid + '/view","📄 PDF")';
  return '';
}

// Map of cached faktur PDFs (invoice number → Drive fileId), built once per execution.
// Backs the DIRECT-link path in fakturLinkFormula. Reset to null to force a re-scan whenever
// new files are generated mid-run.
var _FAKTUR_FILE_MAP = null;
function _fakturFileId(number) {
  if (!number) return '';
  if (_FAKTUR_FILE_MAP === null) _FAKTUR_FILE_MAP = _scanFakturFolder();
  return _FAKTUR_FILE_MAP[number] || '';
}

// Scan the Drive cache folder → map of invoice number → Drive fileId. Used by _fakturFileId
// (direct-link path) and generateFakturPdfs() (skip invoices that already have a cached PDF).
function _scanFakturFolder() {
  var map = {};
  try {
    var files = _fakturFolder().getFiles();
    while (files.hasNext()) {
      var f = files.next();
      if (f.isTrashed()) continue;
      var nm = f.getName().replace(/\.pdf$/i, '');
      if (!map[nm]) map[nm] = f.getId();
    }
  } catch (e) {}
  return map;
}

// Batch-generate faktur PDFs to PRE-WARM the Drive cache. With the HYBRID link (fakturLinkFormula),
// any invoice that has a cached PDF gets a DIRECT Drive /view link on the next Full Sync → a clean
// single tap. So this run is what flips most 📄 cells from generator-fallback to direct 1-tap.
// Optional — links still work without it (generator path), this just makes them direct. STANDALONE
// on purpose: it does its own light invoice fetch and has its OWN time budget, so it never blocks
// or times out fullSync. Generate only what's actually
// collectible (outstanding > 0); paid/closed invoices are never generated, already-cached ones
// are skipped instantly (faktur is static → cached permanently). Run from the menu ▸ "Generate
// Faktur PDFs" and repeat until the log says LENGKAP; or install a trigger (installFakturTrigger).
var FAKTUR_BATCH_BUDGET_MS = 300000;   // ~5 min of work, then stop cleanly (own 6-min ceiling)
var FAKTUR_BATCH_MAX       = 80;       // safety cap on builds per run
function generateFakturPdfs() {
  var t0 = Date.now();
  var invoices = fetchSalesInvoices();   // Pass 1 (light): id / number / customerId / outstanding
  var open = invoices.filter(function(i) {
    return i && i.number && i.id != null && num(i.outstanding) > 0;   // only actively collectible
  });
  var map = _scanFakturFolder();         // what's already cached → skip
  var built = 0, todo = 0;
  for (var i = 0; i < open.length; i++) {
    var inv = open[i];
    if (map[inv.number]) continue;       // already cached → already a direct 1-tap link
    todo++;
    if (built >= FAKTUR_BATCH_MAX || (Date.now() - t0) > FAKTUR_BATCH_BUDGET_MS) continue; // count remaining
    try { getOrCreateFaktur(inv.id, inv.number, inv.customerId); built++; }
    catch (e) { /* skip; retry next run */ }
  }
  var remaining = Math.max(0, todo - built);
  var msg = 'Faktur PDF: dibuat ' + built + ' baru · sisa ' + remaining +
            (remaining > 0 ? ' (jalankan lagi, atau pakai "Auto catch-up" biar otomatis sampai habis)' : ' — LENGKAP ✅, semua faktur open ter-cache → link 📄 jadi direct 1-tap setelah Run Full Sync') +
            ' · ' + ((Date.now() - t0) / 1000).toFixed(0) + 's';
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'ROSH Faktur', 10); } catch (e) {}
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}   // visible when run from the menu
  return { built: built, remaining: remaining, msg: msg };
}

// Auto catch-up — drains the WHOLE faktur backlog hands-off. Each pass builds a batch (5-min
// budget); if any remain it schedules ONE one-time trigger ~2 min later to continue, and stops
// itself once LENGKAP. Start once from menu ▸ "Auto catch-up Faktur (sampai lengkap)" — then
// walk away; it keeps going in the background until every open invoice has a PDF.
function catchUpFakturPdfs() {
  _clearCatchUpTriggers();                         // never stack continuation triggers
  var res = generateFakturPdfs();
  if (res.remaining > 0) {
    ScriptApp.newTrigger('catchUpFakturPdfs').timeBased().after(120 * 1000).create();  // ~2 min
    Logger.log('Catch-up faktur: sisa ' + res.remaining + ' → lanjut otomatis ~2 menit lagi.');
  } else {
    Logger.log('Catch-up faktur LENGKAP ✅ — semua faktur open ter-cache → jalankan Run Full Sync agar link 📄 jadi direct 1-tap.');
  }
}
function _clearCatchUpTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'catchUpFakturPdfs') ScriptApp.deleteTrigger(t);
  });
}

// Prune the Drive cache so it holds ONLY fakturs that are still needed (invoice currently
// open / outstanding > 0). Trashes the PDF of any invoice that's been paid/closed or no
// longer appears in Accurate. Run from the menu ▸ "Prune Faktur PDFs (hapus lunas)".
// Trashed (not hard-deleted) → recoverable from Drive Trash for ~30 days if needed.
function pruneFakturPdfs() {
  var invoices = fetchSalesInvoices();
  var keep = {};                                  // invoice numbers still needing a faktur
  invoices.forEach(function(i) {
    if (i && i.number && num(i.outstanding) > 0) keep[String(i.number)] = true;
  });

  var folder = _fakturFolder();
  var files = folder.getFiles();
  var pruned = 0, kept = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.isTrashed()) continue;
    var nm = f.getName().replace(/\.pdf$/i, '');
    if (keep[nm]) { kept++; continue; }
    f.setTrashed(true);                           // paid/closed/unknown → remove
    pruned++;
  }
  var msg = 'Prune Faktur: ' + pruned + ' PDF dibuang (lunas/tidak terpakai) · ' +
            kept + ' disimpan (masih open). Cek Drive Trash kalau perlu balikin.';
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'ROSH Faktur', 10); } catch (e) {}
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

// NOTE: faktur automation (daily generate 03:00 + prune 04:00) is installed together with
// the 05:00 sync by installTrigger() in Sync.gs — menu ▸ "Install daily trigger". Manage all
// triggers there; removeTriggers() clears generate, prune, and fullSync in one go.

function _webAppUrl() {
  var u = _props().getProperty('WEBAPP_URL');
  if (u) return u;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT / IMAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _money(n) { return Math.round(num(n)).toLocaleString('id-ID'); }

function _fLong(s) {
  var d = parseAccDate(s);
  if (!d) return '';
  var bln = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus',
             'September','Oktober','November','Desember'];
  return d.getDate() + ' ' + bln[d.getMonth()] + ' ' + d.getFullYear();
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Strip Google Plus Codes (e.g. "PXFC+94F") that Accurate sometimes prepends to an
// address, plus any leftover leading separators. Leaves the real street address intact.
function _cleanAddr(s) {
  return String(s || '')
    .replace(/\b[A-Z0-9]{4,8}\+[A-Z0-9]{2,7}\b[\s,]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+/, '')
    .trim();
}

// Inline a Drive image as a base64 data-URI <img>. Returns '' if the file id isn't set.
function _fakturImg(propKey, attrs) {
  try {
    var id = _props().getProperty(propKey);
    if (!id) return '';
    var blob = DriveApp.getFileById(id).getBlob();
    var b64 = Utilities.base64Encode(blob.getBytes());
    return '<img ' + (attrs || '') + ' src="data:' + blob.getContentType() + ';base64,' + b64 + '"/>';
  } catch (e) { return ''; }
}

// Indonesian number-to-words. e.g. 5232600 → "Lima juta dua ratus tiga puluh dua ribu enam ratus".
function terbilang(n) {
  n = Math.floor(Math.abs(num(n)));
  if (n === 0) return 'Nol';
  var sat = ['','satu','dua','tiga','empat','lima','enam','tujuh','delapan','sembilan','sepuluh','sebelas'];
  function w(x) {
    var s = '';
    if (x < 12)            s = sat[x];
    else if (x < 20)       s = w(x - 10) + ' belas';
    else if (x < 100)      s = w(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + w(x % 10) : '');
    else if (x < 200)      s = 'seratus' + (x % 100 ? ' ' + w(x % 100) : '');
    else if (x < 1000)     s = w(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + w(x % 100) : '');
    else if (x < 2000)     s = 'seribu' + (x % 1000 ? ' ' + w(x % 1000) : '');
    else if (x < 1e6)      s = w(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + w(x % 1000) : '');
    else if (x < 1e9)      s = w(Math.floor(x / 1e6)) + ' juta' + (x % 1e6 ? ' ' + w(x % 1e6) : '');
    else if (x < 1e12)     s = w(Math.floor(x / 1e9)) + ' milyar' + (x % 1e9 ? ' ' + w(x % 1e9) : '');
    else                   s = w(Math.floor(x / 1e12)) + ' triliun' + (x % 1e12 ? ' ' + w(x % 1e12) : '');
    return s.trim();
  }
  var r = w(n).replace(/\s+/g, ' ').trim();
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP / ADMIN  (run once from the editor or the ROSH Accurate menu)
// ─────────────────────────────────────────────────────────────────────────────
function _fakturFolder() {
  var id = _props().getProperty('FAKTUR_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* fall through to recreate */ }
  }
  return setupFakturFolder();
}

function setupFakturFolder() {
  var it = DriveApp.getFoldersByName(FAKTUR.FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FAKTUR.FOLDER);
  _props().setProperty('FAKTUR_FOLDER_ID', folder.getId());
  Logger.log('Faktur folder: ' + folder.getName() + ' (' + folder.getId() + ')');
  return folder;
}

/** Trash all cached faktur PDFs so the next tap regenerates with the latest template.
 *  Run this after any change to buildFakturHtml / FAKTUR constants. */
function clearFakturCache() {
  var folder = _fakturFolder();
  var files = folder.getFilesByType('application/pdf');
  var n = 0;
  while (files.hasNext()) { files.next().setTrashed(true); n++; }
  Logger.log('Faktur cache cleared: ' + n + ' PDF di-trash. Tap ulang link → regenerate.');
  return n;
}

/** DIAG — jalankan dari editor lalu lihat Execution log. Membuktikan apakah build faktur
 *  sukses + VA per-customer ke-resolve + file URL valid (isolasi build vs Drive-serving).
 *  Ganti id/number/custId sesuai link yang error (dari URL ?id=..&n=..&c=..). */
function diagFaktur() {
  var id = '17001', number = 'SI.2026.05.00061', custId = '1250';  // ← ganti sesuai link error
  try {
    var det = accApi('/accurate/api/sales-invoice/detail.do', { id: id });
    var d = det && det.d;
    Logger.log('detail.do ok? ' + !!d);
    Logger.log('d.customer keys: ' + (d && d.customer ? Object.keys(d.customer).join(', ') : 'NONE'));
    Logger.log('d.customer.id = ' + (d && d.customer ? d.customer.id : '-') + ' | custId(link) = ' + custId);
    var code = _fakturVa(d, custId);
    Logger.log('_fakturVa = "' + code + '" → VA penuh = ' + (code ? _fullVaBca(code) : '(fallback statis ' + FAKTUR.VA_BCA + ')'));
    var f = getOrCreateFaktur(id, number, custId);
    Logger.log('FILE → name=' + f.getName() + ' | trashed=' + f.isTrashed() + ' | id=' + f.getId());
    Logger.log('SIZE → ' + f.getSize() + ' bytes | mime=' + f.getMimeType() +
               ' | access=' + f.getSharingAccess() + '/' + f.getSharingPermission());
    Logger.log('URL  → ' + f.getUrl());
    // Prove the blob is a real PDF: a valid PDF starts with the bytes "%PDF-".
    try {
      var head = f.getBlob().getDataAsString().slice(0, 8);
      Logger.log('HEAD → "' + head + '" (valid PDF harus diawali %PDF-)');
    } catch (e) { Logger.log('HEAD → gagal baca blob: ' + (e && e.message)); }
  } catch (e) {
    Logger.log('❌ ERROR: ' + (e && e.message) + '\n' + (e && e.stack));
  }
}

/** Store the deployed web-app /exec URL. Prompts when run from the sheet menu. */
function setFakturWebAppUrl() {
  var fallback = '';
  try { fallback = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  try {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.prompt('Faktur Web App URL',
      'Tempel URL /exec hasil Deploy (kosongkan untuk pakai default otomatis):',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    var url = (resp.getResponseText() || '').trim() || fallback;
    if (!url) { ui.alert('URL kosong dan belum ada deployment. Deploy dulu sebagai Web app.'); return; }
    _props().setProperty('WEBAPP_URL', url);
    ui.alert('Tersimpan:\n' + url + '\n\nJalankan "Run Full Sync now" agar link 📄 PDF muncul.');
  } catch (e) {
    // No UI (run from editor) — persist the auto-resolved URL if present.
    if (fallback) { _props().setProperty('WEBAPP_URL', fallback); Logger.log('WEBAPP_URL = ' + fallback); }
    else Logger.log('No UI and no deployment URL. Deploy as Web app first.');
  }
}

/**
 * ONE-SHOT — run this once from the editor (Run button can't pass args, so we wrap it).
 * IDs come from the Drive share links Bro uploaded (2026-06-02). Safe to keep; not secret.
 */
function setupFakturAssetsOnce() {
  setFakturAssets(
    '1tzoi_zwbMjHejftPfMbD5fKuDPcYs0cb',  // TTD Jonathan Owen (signature)
    '1YFu94-UNzUWJXn92FIipvtBT6vHpISF2'   // logo ROSH
  );
}

/** Store the Drive file IDs of the director signature + logo PNGs. Run from the editor. */
function setFakturAssets(signFileId, logoFileId) {
  var props = {};
  if (signFileId) props.FAKTUR_SIGN_FILE_ID = signFileId;
  if (logoFileId) props.FAKTUR_LOGO_FILE_ID = logoFileId;
  _props().setProperties(props, false);
  Logger.log('Faktur assets set: ' + JSON.stringify(props));
}

/** DIAG — cek apakah file logo & TTD bisa dibaca oleh akun yang menjalankan script.
 *  Kalau "TIDAK BISA DIBACA", berarti ID-nya nunjuk file yang tidak diakses akun ini
 *  (mis. masih file Drive pribadi) → jalankan setupFakturAssetsOnce dgn ID Drive Roshan. */
function diagFakturAssets() {
  ['FAKTUR_LOGO_FILE_ID', 'FAKTUR_SIGN_FILE_ID'].forEach(function(k) {
    var id = _props().getProperty(k);
    if (!id) { Logger.log(k + ' = (belum di-set)'); return; }
    try {
      var f = DriveApp.getFileById(id);
      Logger.log(k + ' = ' + id + ' ✅ ' + f.getName() + ' · ' + f.getBlob().getContentType() + ' · ' + f.getSize() + ' bytes');
    } catch (e) {
      Logger.log(k + ' = ' + id + ' ❌ TIDAK BISA DIBACA: ' + e.message);
    }
  });
}

/** DIAG — log the real detail.do field names so the line-item parsers stay correct. */
function diagFakturFields(id) {
  var det = accApi('/accurate/api/sales-invoice/detail.do', { id: id });
  var d = (det && det.d) || {};
  Logger.log('detail.do keys: ' + Object.keys(d).join(', '));
  Logger.log('number=' + d.number + ' | transDate=' + d.transDate + ' | dueDate=' + d.dueDate +
             ' | shipDate=' + d.shipDate + ' | poNumber=' + d.poNumber +
             ' | paymentTerm=' + JSON.stringify(d.paymentTerm) + ' | toAddress=' + d.toAddress);
  var items = d.detailItem || d.detailItems || [];
  Logger.log('detailItem count: ' + items.length);
  if (items[0]) {
    Logger.log('detailItem[0] keys: ' + Object.keys(items[0]).join(', '));
    Logger.log('detailItem[0] sample: ' + JSON.stringify(items[0]).slice(0, 500));
  }
}
