# AccurateSync — ROSH Automation Hub

Google Apps Script project bound to a Google Sheet. Pulls data from **Accurate Online** (accounting system) via its Open API and turns it into ROSH's operating layer: AR tracking, KPI payroll math, penagihan (collection) workflows, and business health dashboards.

**Runtime:** Apps Script (V8), timezone `Asia/Jakarta`
**Auth:** Accurate OAuth2 + open-db session
**OAuth scopes required:** `sales_invoice_view`, `customer_view`, `sales_receipt_view`, Google Drive

---

## Files

| File | Role |
|------|------|
| `Code.gs` | OAuth2, credentials (Script Properties), db-list/open-db session, HTTP+308 helper, `onOpen` menu, `CONFIG` constants |
| `Sync.gs` | Invoice fetch + `normalizeInvoice`, customer-contact lookup, bulk receipts (`buildReceiptsByInvoice`), Pool A/B classify, handover logic, sheet writers, sync trigger |
| `Kpi.gs` | Sales KPI + AR Officer KPI math — take-home pay, bonuses, penalty flags |
| `Health.gs` | Business health dashboard: AR aging waterfall, DSO, collected-vs-billed MTD, top debtors, daily trend snapshots (`_MetricSnapshots`) driving SPARKLINE trends. Folded into `📋 Ringkasan` tab (master-only) |
| `Route.gs` | `🗺️ Rute Penagihan` — aggregate open AR by customer, zona grouping, zona priority ranking, nearest-neighbour stop ordering from Maps pins / geocoded coords, `Tipe Dispatch` column |
| `Pesan.gs` | `✉️ Pesan Penagihan` — ready-to-send WA messages grouped by customer, covering all invoices in window H-1→H+14, 4-touch tone buckets, `wa.me` prefill links |
| `StopSupply.gs` | `⛔ Stop Supply (HOLD)` — flags customers with ≥1 unpaid invoice ≥H+7. Flag-only; holds are applied manually in Accurate |
| `Faktur.gs` | Faktur Penjualan PDF — HTML→PDF generation, Drive cache, `📄 PDF` direct link column, `terbilang` spell-out, `doGet` web app for owner/diagnostics |
| `Style.gs` | Formatting helpers |
| `Diag.gs` | Diagnostics (`diagFakturFields`, `diagCustomerFields`, `diagReceiptReconcile`, etc.) |
| `appsscript.json` | Manifest — OAuth scopes, timezone, runtime |

---

## Setup

### 1. Credentials

All credentials live in **Script Properties** — never in source or the sheet.

Open the Apps Script editor → **Run `setupCredentials()`** once with your real values, then delete the literals from the function body and re-save:

```js
CLIENT_ID        // Accurate OAuth2 client ID
CLIENT_SECRET    // Accurate OAuth2 client secret
APP_KEY          // Accurate app key
SIGNATURE_SECRET // HMAC signing secret (currently off, kept for future use)
```

Additional properties used at runtime:

```
ADE_SHEET_ID       // Google Sheet ID for Ade's file
DEDEN_SHEET_ID     // Google Sheet ID for Deden's file
FAKTUR_SIGN_FILE_ID  // Drive file ID of signature PNG
FAKTUR_LOGO_FILE_ID  // Drive file ID of logo PNG
FAKTUR_WEB_APP_URL   // /exec URL of the deployed web app (or auto-resolved)
```

### 2. OAuth authorization

After adding credentials, open the sidebar via **ROSH Accurate ▸ Authorize Accurate** and complete the OAuth2 consent flow. If you added `sales_receipt_view` scope after initial setup, run `forceReauthorize()` to re-grant.

### 3. Role sheets (Ade / Deden)

Edit the two Gmail addresses in `setupRoleSheetsOnce` → **ROSH Accurate ▸ Setup role sheets (Ade/Deden)**. This creates and shares both role-scoped Sheet files. File IDs are saved to Script Properties automatically.

### 4. Faktur PDF

1. Upload signature + logo PNGs to Drive, then run `setFakturAssets(signId, logoId)` from the editor.
2. **ROSH Accurate ▸ Setup Faktur folder** — creates the `ROSH Faktur PDF` Drive folder.
3. **Deploy ▸ New deployment ▸ Web app** — Execute as **Me**, Access **Anyone**.
4. **ROSH Accurate ▸ Set Faktur web app URL** — paste the `/exec` URL (or it auto-resolves).
5. **ROSH Accurate ▸ Auto catch-up Faktur** — drain the backlog.
6. **ROSH Accurate ▸ Run Full Sync now** — direct `📄 PDF` links appear in all pool tabs.

Verify field names first with `diagFakturFields(<invoiceId>)`.

### 5. Run a full sync

**ROSH Accurate ▸ Run Full Sync now**

---

## Business Rules

### AR Pools & Handover

- **Pool A** — frozen legacy AR (invoices handed over ≤ AR Officer onboard date, unpaid at onboard).
- **Pool B** — ongoing AR.
- **Handover threshold:** invoice unpaid >14 days past due → handed to AR Officer Ade. `handoverDate = dueDate + 15`. Sales (Deden, Dian) own H+0…H+14.

### Collection Flow (Fase 0)

Stages relative to `daysPastDue`:

| Stage | Owner | Action |
|-------|-------|--------|
| H-1 | System | Reminder message |
| H+3 | Deden | Nudge |
| H+7 | Nathan | **STOP SUPPLY** — hold new orders in Accurate |
| H+8–14 | Deden | Final collection push |
| >H+14 | Ade | Handover — field visits + weekly follow-up |

Thresholds configurable in `CONFIG`: `STOP_SUPPLY_DAYS`, `PENAGIHAN_WINDOW_MAX`, `DISPATCH.*`.

### Customer Tiers (A/B/C/D)

Computed from invoice COUNT in a trailing 4-month window (`CONFIG.CUST_TIER`):
- **A** ≥11 invoices · **B** 5–10 · **C** 2–4 · **D** 1

Display-only — does not affect komisi, penalty, or handover logic.

### KPI Payroll

**Sales THP:** base 3.5jt + tunjangan (score × 3.5jt, cap 106%) + komisi (1.25% on collected >100jt). Weights: omzet .45 / cashflow .25 / diskon .20 / NOO .10.

**AR Officer THP:** floor 3.8jt (pokok 3jt + ops 800rb). Komisi on cash collected, bucketed by aging-since-handover: 1.5% / 2.5% / 3.5%. One-time bonuses added AFTER monthly-floor × N — never bundled into the floor.

---

## Per-Role Sheet Access

Google Sheets can't hide tabs per collaborator (protection blocks editing, not viewing). KPI tabs expose take-home pay, so isolation is enforced via **separate Sheet files** fed by the same sync:

| File | Shared with | Tabs included |
|------|-------------|---------------|
| Master `Tracker Invoice` | Owner only | All tabs |
| `ROSH AR — Ade` | Ade (Editor) | Summary (AR-scoped), Pool A, Pool B, KPI Matriks AR |
| `ROSH Tagihan — Deden` | Deden (Viewer) | Summary (Sales-scoped), Tagihan Sales, KPI Matriks Sales |

`fullSync` computes once, then writes to each file by swapping `TARGET_SS`. Ade's file is the **🟡 source of truth** for editable columns — her entries win on merge and are replicated back to master each sync.

---

## Faktur PDF — Key Constraints

- **Accurate's Open API has no print/PDF endpoint.** PDFs are regenerated from `sales-invoice/detail.do` and cached permanently in Drive (`ROSH Faktur PDF/<number>.pdf`).
- **Nightly trigger is bounded by design** — `generateFakturPdfs` runs at 03:00 (max 80 PDFs, ≤5 min). Consumer Gmail has a 90-min/day trigger quota; the bounded batch protects the 04:00 prune and 05:00 sync from being starved. `catchUpFakturPdfs` is **manual-only** (menu "Auto catch-up Faktur").
- **Generate-on-click via `/exec` does not work in multi-account browsers.** When `doGet` touches Drive during a click from a multi-account Google session, the browser renders Google's error page before the script response. The solution is direct `drive.google.com/file/d/<id>/view` links — no `/exec` involved. `doGet` is retained for owner access and diagnostics only.

---

## Conventions

- **Credentials in Script Properties only.** Never commit real values.
- **`outstanding` = total − received.** Partial payments shrink amounts; it's not the original invoice total.
- **Receipts via one bulk sweep.** `buildReceiptsByInvoice` calls `sales-receipt/list.do` once (paged), indexed by invoice id. Do not revert to per-invoice `sales-invoice/detail.do` — that approach hit scale limits.
- **Customer contacts cached** in hidden sheet `_ContactCache`. Cache is time-budgeted (≤4 min per sync) so large first runs don't time out. Clear the tab or run `clearCaches()` to rebuild from scratch.
- **Virtual Account per customer.** `customerNoVa` stores a 6-digit code; full VA = `FAKTUR.VA_PREFIX` (`15903`) + code. Use `_fullVaBca()` to assemble — it guards against double-prefix.
- **Reuse `Sync.gs` helpers** — `fetchSalesInvoices`, `normalizeInvoice`, `fetchCustomerDetail`, `fmtDate`, `num`. Don't re-implement.

---

## Roadmap

1. **Faktur Coretax from Accurate invoice** — separate Node app (`../rosh-faktur/`) already generates `TaxInvoiceBulk` XML. Backlog: faktur ledger dedup, PKP filter, TIN pre-validation, merge into Sheet flow. *Coretax has no public POST API — ceiling is validated bulk XML + manual portal import unless a PJAP is signed.*
2. **Record customer payments from chat + bukti transfer** — not built. Needs write scope + `sales-receipt/save.do`, OCR of proof, invoice match, and a human-approve gate before posting.
3. **WA penagihan reminders (auto-send)** — removed 2026-05-31. `Pesan.gs` handles message drafting and `wa.me` prefill; actual sending is manual. Fase 1–3 Qontak integration is the planned path for auto-send.
