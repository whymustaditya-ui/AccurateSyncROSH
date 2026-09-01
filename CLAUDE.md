# AccurateSync — ROSH automation hub

Google Apps Script project bound to a Google Sheet. Pulls data from **Accurate Online**
(accounting system) via its Open API and turns it into ROSH's operating layer: AR
tracking and KPI payroll math. This folder is the source
of truth — the live script lives in the Sheet's bound Apps Script editor; these files are
the versioned copies.

**Target Sheet ID:** `1-BQ3zieAZkaaUVkUIgI8ZQKAZ-x1dLFOuntl8n1aUcw`
**Runtime:** Apps Script (V8), timezone Asia/Jakarta. Auth = Accurate OAuth2 + open-db session.

---

## Files

| File | Role |
|------|------|
| `Code.gs` | OAuth2, credentials (Script Properties), db-list/open-db session, HMAC signing (off), HTTP+308 helper, `onOpen` menu |
| `Sync.gs` | Invoice fetch + `normalizeInvoice`, customer-contact lookup, **bulk receipts** (`buildReceiptsByInvoice` → index by invoice id; `enrichReceipts` consumes the map, no per-invoice `detail.do`), Pool A/B classify, handover (>14d), sheet writers, sync trigger |
| `Kpi.gs` | Sales KPI + AR Officer KPI math (take-home pay, bonuses, penalty flags) |
| `ThpHistory.gs` | 📈 Riwayat THP (master + **Deden**, lihat catatan per-role di bawah): monthly payroll/KPI **archive** — fixes "every sync overwrites, no history". Hidden ledger `_ThpHistory` **upsert-by-(periode,role)** (`recordThpHistory` ← `sales`/`ar` structs, AR skipped pre-onboard via `notStarted`): current month = live re-stamp each sync, prior months **auto-freeze** once the calendar rolls over (no extra trigger, no period-parameterised KPI). `writeThpHistoryTab` renders two stacked tables (Sales: skor/collected/NOO/THP · AR: masuk kas/komisi/THP), newest-first + inline-array column SPARKLINE THP trend. NOT redundant with `_MetricSnapshots` (that = daily AR-health; this = monthly per-person pay). Zero new Accurate calls/scope. `_thpHistorySheet`/`_upsertThpRow`/`_readThpHistory`/`writeThpHistoryTab`. **RE-STAMP bulan lalu (2026-08-02):** "auto-freeze saat kalender berganti" ternyata membekukan angka TERLALU CEPAT — baris bulan itu terkunci di sync terakhir bulan tsb, jadi bukti transfer yang dientri ke Accurate SETELAH sync itu tapi BERTANGGAL bulan itu hilang diam-diam (Juli 2026: ledger Rp114.525.773 beku 31/07 11:31 vs live Rp123.589.733 → komisi Deden Rp181.572, seharusnya Rp294.872). Sekarang `restampPreviousMonth` (dipanggil di master block sebelum `recordThpHistory`, fail-soft) menghitung ULANG bulan lalu tiap sync selama **`CONFIG.THP_RESTAMP_DAYS` (7) hari pertama** bulan baru, lalu beku permanen (payroll tertutup tak boleh berubah diam-diam). Butuh `computeSalesKpi(invoices, monthStart)` yang kini **period-parameterised** (baca `i.receipts` langsung, bukan `receiptsThisMonth` — identik utk bulan berjalan) + `_arMonthFigures` (komisi Ade per bulan sembarang dari `bucketLock` + window Ade, rounding per-invoice biar sama persis dgn `adeKomisiThisMonth`). Koreksi manual setelah window tutup: menu **Hitung ulang Riwayat THP bulan lalu** (`restampPreviousMonthNow`) |
| `Collected.gs` | 💰 Faktur Collected (**file Deden saja**): rincian faktur di balik angka agregat Collected. Dua section newest-first (bulan berjalan + bulan lalu), dikelompokkan per **bulan uang masuk** (tanggal receipt), bukan bulan terbit. Keanggotaan bulan M = ada receipt di M **ATAU** `transDate` di M (terbit bulan itu, belum cair → `⚪ Belum bayar`) → faktur bisa muncul di dua bulan (disengaja, dijelaskan di footnote). 12 kolom, view-only, tampilan sekeluarga Pool B + link 📄 Faktur + Tier. Scope ke Deden pakai `_bySalesman`. `buildCollectedMonths`/`writeCollectedTab`. Proyeksi murni — nol call Accurate, nol scope. **Prasyarat:** `enrichReceipts` kini memasang `inv.receipts` untuk SEMUA faktur (bukan cuma yang lolos gate `needsDetail`) — tanpa itu section bulan lalu kosong karena faktur yang lunas pra-handover tak pernah lolos gate. Nol biaya (peta bulk sudah ada di memori); gate tetap utuh untuk perhitungan pool/komisi |
| `Customer.gs` | 🧭 Rapor Customer (master-only): gate order baru + saran limit & tempo per customer. Dua sumbu — (1) **Skor Bayar 0..100** (makin tinggi makin baik) dari SELURUH riwayat: kecepatan .35 / disiplin .15 / posisi .35 / beban .15, ditimbang rupiah + luruh half-life 180 hr, **shrinkage Bayesian** (K=3) ke prior buku untuk data tipis; (2) **margin bersih** = margin kotor (`vendorPrice`) − **biaya modal** (24%/th, dihitung SEJAK `transDate` bukan sejak telat). Observasi wajib bertiga: receipt + residual PPh + **faktur masih terbuka** (tanpa yang ketiga, pemacet bisa sembunyi di balik riwayat bersih). Band **ABSOLUT bukan percentile** (kalau seluruh buku busuk, percentile tetap meloloskan 20% teratas) + override keras (≥45 hr / ≥Rp25jt×≥15 hr / beban >3 bln belanja). Kelas khusus TUNAI / BARU / BELUM DINILAI / DORMAN. Vonis 🟢 GAS · 🟡 GAS TERBATAS · 🟠 NAIKKAN HARGA · 🔴 STOP-COD (invariant: STOP ⇒ limit 0 & tempo 0). Limit = belanja/bln × tempo/30 × headroom, dicap **10% total buku** (aturan konsentrasi); tempo **satu arah** (hanya boleh diperketat). `_allocateCredit` membagi **plafon bulan berjalan** top-down (pola `_allocateCart`). Margin di belakang flag **`MARGIN_ENABLED` (default false)** — nyalakan HANYA setelah `diagVendorPrice()` cek ΣlineTotal vs subTotal. Kolom 🟡 Limit Disetujui + Catatan Nathan (`collectCustomerYellow`). Nol call Accurate, nol scope |
| `TurunBuku.gs` | 📉 Turun Buku Piutang (master-only): program menurunkan AR ke `TARGET_AR` (Rp150jt) dalam `MONTHS` (6) bulan. **Riwayat GRATIS** — `_MetricSnapshots` sudah menyimpan `totalAR` + bucket umur harian sejak lama, jadi glide path & tren NPL bisa ditarik MUNDUR (juga alasan `NPL_DAYS` 60: bucket 61-90 & 90+ sudah ada). `_glidePath` garis lurus dari snapshot bulan `PROGRAM_START`; `_glideTargetFor` dipakai Customer.gs sebagai **plafon kredit bulan ini** → pengetatan mengencang otomatis tiap bulan. `_codWaves` = gelombang cabut tempo → COD penuh, **hanya 🔴 STOP-COD dan 🟡 GAS TERBATAS** (🟢 GAS sengaja dilindungi; 🟠 urusannya harga bukan tempo). Kolom **Omzet Berisiko** wajib ada: mencabut tempo itu ada harganya. Kalau kandidat tak cukup menutup kebutuhan, tab **mengatakannya terus terang**. Plus daftar "tarik dulu bulan ini" (nunggak × umur × peluang cair). 🟡 Status gelombang (`collectTurunYellow`) |
| `Health.gs` | Business Health (master-only): AR aging waterfall, DSO, collected-vs-billed MTD, top debtors + **daily trend snapshots** (hidden `_MetricSnapshots`, upsert-by-date) driving SPARKLINE trends. `computeBusinessHealth`/`recordMetricSnapshot`/`writeHealthSections`. **Folded into the `📋 Ringkasan` tab (no separate tab since 2026-06-05)** — `writeHealthSections(sh,row,m,span)` appends RINGKAS/AGING/TREN/TOP DEBITUR below the Summary, master only. Pure projection of the enriched `invoices`+`ctx` — zero new Accurate calls/scope |
| `Route.gs` | Rute Penagihan: aggregate Ade's open AR by customer, zona grouping (`Zona (auto)` from address-text regex `_zonaFromAddress`, geocode fallback + Ade override), zona priority (Σ Rp × umur), nearest-neighbour stop ordering from Maps pins / geocoded coords, `Tier (4bln)` + `Tipe Dispatch` (`_dispatchType`: Solo/Nearest/Rute/Antri) cols, `🗺️ Rute Penagihan` writer. Built-in Maps geocoder + `_PinCache`/`_GeoCache` |
| `Pesan.gs` | Pesan Penagihan: ready-to-send WA messages **group-by-customer** (1 pesan gabung faktur window H-1→H+14) via `buildPenagihanBatch`. `_waPhone` normalize, `_penagihanMessageBatch` (tone semi-formal per bucket H-1/H+3/H+7/H+14, direvisi 2026-07-28 pasca komplain partner + tier A/B soften + bank instr + CTA bukti transfer), `_waLinkFormula` (wa.me prefill), `✉️ Pesan Penagihan` writer. Master-only |
| `StopSupply.gs` | ⛔ Stop Supply (HOLD): `buildStopSupply` (customer dengan invoice belum bayar yang sudah lewat jatuh tempo, ambang `CONFIG.STOP_SUPPLY_DAYS` **1** sejak 2026-09-01, dulu 7), `writeStopSupplyTab(list, role)`. Flag-only — Nathan tahan SO baru manual di Accurate (OAuth read-only). Ditulis di **master** (semua customer) **dan file Deden** (input di-scope `_bySalesman` dulu → agregat per customer cuma outstanding dia; alias tab `⛔ Customer Ditahan`, banner/footnote versi sales) |
| `Kontak.gs` | 📇 Kontak Customer (master-only): directory SEMUA customer master — `Nama Customer \| No WA \| No Bisnis`. `harvestAllCustomerContacts` = page `customer/list.do` (id saja) → `customer/detail.do` per id TIME-BUDGETED (3 min / 300 per run, drain bertahap) → simpan ke `_ContactCache` 7-kolom; `writeKontakTab` murni baca cache (nol API); `refreshKontakNow` = menu manual drain. No WA = `_custWa` — **CONFIRMED via diag 2026-07-06: field API "No. WhatsApp" = `bbmPin`** (legacy BBM Pin di-recycle; `mobilePhone` = Handphone, sering null) → kandidat lain + regex-scan camel→snake sebagai jaga-jaga → fallback Handphone. No Bisnis = `_custBiz` (`workPhone\|phone\|fax`; UI "No. Telp. Bisnis" = `workPhone`). Verify via `diagKontakFields()` (dump key phone-like + hasil mapping); habis ganti mapping jalankan `rebuildKontakCacheNow` (wipe cache — entry ber-`nama` di-skip harvest, wipe = satu-satunya jalan refill `noWa`). Scope `customer_view` (sudah ada) |
| `Restock.gs` | 📦 Restock Engine (master-only) **v2**: SKU tier **percentile self-calibrating** (velocity 60% + penetration 40% → A/B/C/D) → reorder point **statistik** (demand recency-weighted EWMA + safety `Z[tier]×σ_LT`, lead-time per item) → order-up-to `ROP + d×cycle[tier]` → **inventory position = stok + on-order PO** → **cash-capped PO** (rank Revenue-at-Risk ÷ harga beli, `PO_BUDGET`). Hidden caches: `_ItemCache` (`refreshItemMaster` ← `item/list.do`: `availableToSell`/`vendorPrice`/`deliveryLeadTime`, scope **`item_view`**, skip `suspended`) + `_SkuSalesCache` (`harvestSkuSales` ← per-invoice `sales-invoice/detail.do`, time-budgeted, prune>window). On-order: `buildOnOrderByItem` ← `purchase-order/list+detail.do` (scope **`purchase_order_view`**, no cache). Budget `PO_BUDGET` manual atau auto `PO_BUDGET_PCT`×saldo Bank Jago (`pullBankBalance` ← `glaccount/list.do`, scope **`gl_account_view`**). Demand v3 winsorized+growth. `_demandStats`/`_percentileScore`/`computeRestock`/`writeRestockTab`/`diag{Item,Purchase,CashBank}Fields`. Const `CONFIG.RESTOCK` |
| `Faktur.gs` | Faktur Penjualan PDF: `buildFakturHtml`→HTML→PDF, Drive cache, `terbilang`, `fakturLinkFormula` = **DIRECT Drive `/view` link if cached, else blank** (generation is server-side: `generateFakturPdfs`/`catchUpFakturPdfs`/daily trigger). `doGet` web app kept for owner/diag only — **generate-on-click via /exec is a dead end in multi-account browsers**, see Faktur section. setup/diag |
| `Style.gs` / `Diag.gs` | Formatting helpers / diagnostics |
| `SETUP.md` | Accurate sync setup |

---

## Business rules baked in

- **Handover:** invoice unpaid >14 days past due → handed to AR Officer **Ade** (onboard 2026-06-02). `handoverDate = dueDate + 15`. Sales (Deden, Dian) own H+0…H+14.
- **Pools:** Pool A = frozen legacy AR (handover ≤ onboard, unpaid at onboard). Pool B = ongoing AR.
- **Sales KPI:** THP = base 3.5jt + tunjangan(score×3.5jt, cap 106%) + komisi(1.25% on basis >100jt). Weights: omzet .45 / cashflow .25 / diskon .20 / NOO .10.
  - **Basis komisi = SELURUH kas masuk bulan itu** atas faktur Deden, floor 100jt. Kas yang cair setelah `handoverDate` (H+15), yaitu yang ditagih Ade, **tetap dihitung** — basis komisi = basis omzet, satu angka `collected` saja di `computeSalesKpi`. **Riwayat:** 2026-08-02 basis sempat dipotong ke kas pre-handover (`SALES_COMMISSION_PREHANDOVER_FROM`) untuk menutup celah bayar-dua-kali (Deden 1,25% + Ade 1,5–3,5% atas rupiah yang sama); **dibatalkan Bro 2026-08-03** karena floor 100jt tidak ikut turun sehingga komisi praktis hilang (kas pre-handover Juli Rp98,3jt → komisi Rp0 vs Rp294.872 aturan lama). Konstanta, cabang `preHandoverRule`/`commissionBase`, dan menu diag `diagKomisiPreHandover` sudah dicabut dari kode. Analisis + angka + opsi floor 75jt/80jt disimpan di `ROSH Finance/2026-08-02_MEMO_Komisi-Sales-Kas-Post-Handover.html` (memo sudah diberi catatan pembatalan di kepala). Kalau isunya dibuka lagi, **turunkan floor bareng basis** — itu penyebab pembatalannya.
- **AR KPI:** floor 3.8jt (pokok 3jt + ops 800rb). Komisi on CASH collected, bucket by aging-since-handover (1.5% / 2.5% / 3.5%), locked at first post-onboard payment. Probation bonuses + penalty flags. **Probation bonuses (Sprint 2jt / Milestone 1.5jt / Cleanup 1.5jt = 5jt max, Pool A one-time) pay ON HIT, not at deadline** — targets are monotonic (collected only grows; Pool A backlog only burns down) so a met bonus can't un-achieve → `_bonusStatus` shows `✅ Cair — bisa dibayar` the moment target is met. The window is a FORFEIT deadline only: still-not-met when it closes → `❌ Window tutup` (gugur).
- **Customer tier (A/B/C/D):** loyalty signal computed from invoice COUNT in a trailing window (`CONFIG.CUST_TIER`, default 4 months: A≥11 · B 5–10 · C 2–4 · D 1). `computeCustomerTiers` (Sync.gs) stamps `custTierText` (`B · 7× · Rp45.000.000`) onto every invoice; shown as the **`Tier (4bln)`** column on Pool A/B, Tagihan Sales/Lain, To-Do, and Rute Penagihan, colour-coded by letter. **Display-only** — does NOT touch komisi/penalty/handover (softer penagihan is the human's call). Threshold over 4mo makes A rare; tune in CONFIG.
- Full constants live in `CONFIG` (Code.gs). Salary calc note: one-time bonuses are added separately AFTER the monthly-floor × N multiply — never bundled into the floor.

---

## Three automation goals (the roadmap)

1. **Faktur Coretax from Accurate invoice** — separate Node app `../rosh-faktur/` already
   generates Coretax `TaxInvoiceBulk` XML from Accurate invoices. Polish backlog: faktur
   ledger (dedup), PKP filter, TIN pre-validation, merge into the Sheet flow. *Coretax has
   no open public POST API for taxpayers — realistic ceiling is validated bulk XML + the
   portal import stays manual unless a PJAP is signed.*
2. **Record customer payments from chat + bukti transfer** — NOT built. Needs write scope
   (current OAuth is read-only: `sales_invoice_view customer_view sales_receipt_view`) + `sales-receipt/save.do`,
   OCR of proof, invoice match, and a human-approve gate before posting. ⚠ Bro labeled it
   "Pembayaran Pembelian" but source is customer chat → it's a **sales receipt**, not buy-side.
   Confirm before building.
3. **WA penagihan reminders** — ❌ REMOVED (2026-05-31). `Reminders.gs` deleted from script editor; WA menu items removed from `Code.gs`.

---

## Faktur PDF for penagihan (`Faktur.gs`) — BUILT 2026-06-02

Sales/Ade need the ROSH faktur PDF when collecting. **Accurate's Open API has no print/PDF/share
endpoint** (data-only), so we regenerate the faktur ourselves from `sales-invoice/detail.do` and drop
a one-tap `📄 PDF` HYPERLINK column into **Pool A, Pool B, Tagihan Sales, Tagihan Lain**.

- **DIRECT links + server-side generation (`fakturLinkFormula`, 2026-06-04):** the `📄 PDF` cell is a
  DIRECT `drive.google.com/file/d/<id>/view` link when the PDF is cached (1-tap open), else **blank**
  until a server-side pass generates it. Faktur is static per invoice → cached permanently in Drive
  folder `ROSH Faktur PDF` (filename `<number>.pdf`); partial payments don't change it. Generation is
  done by `generateFakturPdfs` / `catchUpFakturPdfs` / the daily trigger — all run AS THE OWNER
  (Roshan), no browser. Run **Auto catch-up Faktur** once to drain the backlog, then **Run Full Sync**
  so every open invoice shows a direct link; the daily trigger keeps new ones current.
  - **Nightly generate = single-batch BY DESIGN (do not change to auto-catch-up).** The 03:00 trigger
    is the BOUNDED `generateFakturPdfs` (≤5 min, max 80) — NOT `catchUpFakturPdfs`. Reason: owner is a
    **consumer Gmail** → **90-min/day total trigger-runtime quota**; a long nightly catch-up (many
    continuation batches) can exhaust it and starve/overlap the 04:00 prune + 05:00 sync. Daily NEW
    invoices are few, so one bounded batch covers them; a rare spike just fills over the next day(s).
    **`catchUpFakturPdfs` (menu "Auto catch-up Faktur") is MANUAL-ONLY** — for watched backlog drains.
  - **⚠️ Generate-on-click via the web app is a DEAD END here — do not rebuild it.** Tried & failed
    across many rounds (inline base64 → redirect-to-Drive → `&dbg=1`): the moment `doGet` touches Drive
    during a click from a **multi-account** Google browser, Google serves its "Sorry, unable to open the
    file" page at the `/exec` URL **before** our response renders. Confirmed with deployment on
    Execute-as-**Me** + access **Anyone**, and even `&dbg=1` (a tiny text response) fails once `doGet` has
    hit Drive. Bare `/exec` (no Drive touch) and single-account/incognito are fine — it's specifically
    Drive-op-during-request × multi-account. So a top-level nav to an anyone-with-link Drive `/view` (the
    direct link, no `/exec`) is the only reliable render. `doGet` stays for owner/manual + diagnostics.
- **No new OAuth scope** — `sales_invoice_view` + `customer_view` already cover detail.do + bill address.
  Did add the Google **Drive** scope (`appsscript.json`) for `DriveApp` → re-authorize the Apps Script
  project (Google consent, not Accurate) after pushing.
- **Static template data** lives in the `FAKTUR` const (company/address, VA BCA `15903614617`, BCA
  `6560380435`, director Jonathan Owen, footer). Signature + logo PNGs are stored in Drive and
  referenced by Script Properties `FAKTUR_SIGN_FILE_ID` / `FAKTUR_LOGO_FILE_ID` (base64-inlined at render).

**One-time deploy:** ① upload signature+logo PNGs to Drive, run `setFakturAssets(signId, logoId)` from
the editor · ② menu **ROSH Accurate ▸ Setup Faktur folder** · ③ **Deploy ▸ New deployment ▸ Web app**,
Execute as **Me**, Access **Anyone** · ④ menu **Set Faktur web app URL** (paste `/exec`, or it
auto-resolves via `ScriptApp.getService().getUrl()`) · ⑤ **Run Full Sync now** → links appear. Verify
line-item field names first with `diagFakturFields(<invoiceId>)`. Generated PDFs are shared
**anyone-with-link** (low sensitivity — same faktur the customer already gets).

---

## Flow Penagihan Fase 0 (manual di sheet, pra-Qontak) — BUILT 2026-06-04

Fase 0 dari roadmap migrasi WhatsApp BSP/Mekari Qontak (proposal v3): **buktikan flow penagihan
jalan manual di sheet dulu sebelum bayar Qontak.** Pure projection — no API, no new scope.
Stages flow (relatif `daysPastDue`): H-1 reminder · Tahap 1 Deden H+3 · **STOP-SUPPLY begitu lewat jatuh tempo** ·
Tahap 2 Deden H+8–14 · handover Ade >H+14 (`handoverDate=dueDate+15`, **sudah cocok**) · Tahap 3
Ade weekly + antrian kunjungan. Thresholds di `CONFIG` (`STOP_SUPPLY_DAYS 1`, `PENAGIHAN_WINDOW_MAX 14`,
`DISPATCH.{SOLO_MIN 2.5jt, ZONE_MIN_STOPS 3, QUEUE_AGE_DAYS 21}`). Tiga deliverable, semua master-only:

### ✉️ Pesan Penagihan (`Pesan.gs`) — group-by-customer
Tab **`✉️ Pesan Penagihan`**. **1 pesan per pelanggan** menggabungkan semua faktur dalam window
**H-1 → H+14** (`buildPenagihanBatch`). **Window-only**: faktur belum jatuh tempo (jauh dari H-1)
TIDAK disebut; "gabung" hanya bila ≥2 faktur customer sama-sama di window. Bucket 4-touch
(`_penagihanBucket`, **dipakai bersama** oleh To-Do section Penagihan via `buildDueReminders` → segmen
konsisten): nada ikut faktur paling overdue: H-1 / H+3 Nudge / H+7 Stop-supply / H+14 Terakhir (label kolom
`Reminder` internal, TIDAK muncul di teks customer); tier A/B di-soften; daftar faktur + total + instruksi bank
(`FAKTUR`) + CTA bukti transfer (set up window Qontak).
Kolom **Pesan** (copy) + **📲 Kirim WA** (`_waLinkFormula` → `wa.me/<62…>?text=`, prefill, manual Send —
bukan auto-send). `_waPhone` normalisasi `62…`.
**⚠ Tone direvisi 2026-07-28** setelah komplain partner: versi lama terlalu keras (H+7 ancam "order baru kami
tahan sampai pelunasan", H+14 "sebelum kami tindak lanjuti lebih jauh") sampai beberapa toko plastik MEMBLOKIR
nomor WA ROSH. Sekarang **semi-formal**: sapaan WA "Halo Bapak/Ibu" tetap, badan pesan gaya korespondensi sopan
("mohon izin menindaklanjuti", "kami akan sangat menghargai bila..."). Stop-supply masih disinggung di H+7 tapi
sebagai enabler ("agar order berikutnya dapat langsung kami proses"), bukan sanksi — leverage sebenarnya tetap di
tab ⛔ Stop Supply (HOLD) + hold manual Nathan. Semua copy customer-facing ada di `_penagihanMessageBatch` saja.

### ⛔ Stop Supply (HOLD) (`StopSupply.gs`)
Tab **`⛔ Stop Supply (HOLD)`**. `buildStopSupply` = customer yang punya ≥1 invoice belum bayar
yang **sudah lewat jatuh tempo** (`CONFIG.STOP_SUPPLY_DAYS`, diturunkan 7 → **1** pada 2026-09-01 atas
permintaan Bro). Agregat per customer: begitu satu faktur lewat JT, SELURUH outstanding customer itu
ikut terhitung di kolom Total. Flag-only — **Nathan tahan SO/order baru manual di Accurate** (OAuth read-only, sheet tak bisa
tulis hold). Leverage utama flow. Kolom: Customer · Telp · Sales · Jml Invoice · Total · Umur Tertua · Tier.

### 🗺️ Rute Penagihan +Tipe Dispatch (`Route.gs`)
Kolom baru **`Tipe Dispatch`** (`_dispatchType`, prioritas Solo>Nearest>Rute>Antri): Solo (outstanding ≥2,5jt,
kunjungi sendiri) · Nearest (umur antri >21 hr, wajib ikut rute terdekat) · Rute (zona ≥3 titik) · Antri (tunggu cluster).

**Roadmap lanjut (di luar Fase 0):** Fase 1 pilot Qontak (shared inbox, kirim manual) → Fase 2 integrasi
API (outbound 08:00 push template Utility + `doPost` webhook balasan→sheet, pakai pola web-app `doGet` Faktur)
→ Fase 3 reaktivasi Marketing (cap budget) + strike counter. Qontak memecahkan auto-send + sensing balasan;
Accurate tetap otak/sumber data.

---

## Rute Penagihan (`Route.gs`) — BUILT 2026-06-04

Ade's weekly field drive list. Tab **`🗺️ Rute Penagihan`** (master + Ade's file; NOT Deden's),
written in `fullSync` after Pool B. Aggregates Ade's open AR (Pool A + B, `outstanding > 0`)
**by customer** (1 visit = 1 location), groups by zona, ranks zonas, orders stops.

- **Zona priority** = `total outstanding × (1 + umur_tertua_hari × CONFIG.ROUTE.AGING_WEIGHT)`
  (default 0.02) → many small-but-old tunggakan still float a zona up on accumulation. Side
  panel "Prioritas Zona" ranks them; unzoned customers parked at the bottom.
- **Zona (auto)** 🔴 = kecamatan parsed straight from the freeform address text (`_zonaFromAddress`,
  regex on "Kecamatan X" / DKI city) — free + instant + reliable for ROSH's detailed addresses.
  Geocode (`Maps.newGeocoder`) is the **fallback** for zona AND the source of **coordinates**.
- **Stop ordering** = greedy nearest-neighbour from coords (Maps pin 🟡 wins; else geocoded coords).
  No coords → appended by outstanding desc. Coords fill in progressively (geocode is capped +
  time-budgeted + cached in `_GeoCache`; short `maps.app.goo.gl` pins resolved + cached in `_PinCache`).
- **13-col schema:** 1 Zona🟡 2 Zona(auto)🔴 3 Urutan🔴 4 Customer🔴(KEY) 5 Alamat🔴 6 Pin Maps🟡
  7 Outstanding🔴 8 Umur Tertua🔴 9 No.Telp🔴 10 Status Kunjungan🟡 11 Tgl Kunjungan🟡 12 Hasil🟡
  13 Tier(4bln)🔴. 🟡 UPSERTED **by customer name** (`collectRouteYellow`, master↔Ade merge, Ade wins)
  — same pattern as Pool tabs upserting by invoice number. 🔴 locked warning-only.
- **No new Accurate scope.** First run uses the built-in **Maps service** (geocoder) + `UrlFetchApp`
  → Google may prompt re-authorization (Google consent, not Accurate). Tune `CONFIG.ROUTE`
  (AGING_WEIGHT / MAX_PIN_RESOLVE / MAX_GEOCODE). Clear `_GeoCache` / `_PinCache` to force refresh.

---

## Restock Engine (`Restock.gs`) — BUILT 2026-06-07 · v2 2026-06-07

Tujuan: restock berhenti pakai "feeling" → hindari overorder / overspend / kurang order, di
tengah **supply acak** (pabrik telat random ~1–2 minggu). Tab **`📦 Restock Engine`** (master-only,
`fullSync` blok master setelah Stop Supply). Diag konfirmasi data Accurate: `item/list.do` honor
`fields` (stok=`availableToSell` CTN · cost=`vendorPrice` · `deliveryLeadTime` per item · skip `suspended`).
Tiga layer:

1. **Tier (importance)** — skor `WEIGHT_VELOCITY 0.6 × velocity + WEIGHT_PEN 0.4 × penetration` → A/B/C/D
   (`TIER_CUTOFFS`). **`BAND_MODE='percentile'`** = self-calibrating (rank vs katalog ROSH sendiri via
   `_percentileScore` + `PERCENTILE_CUTS` [.8/.6/.4/.2] → top 20%=5). `'absolute'` (`VELOCITY_BANDS`/
   `PENETRATION_BANDS`) tinggal fallback. Window tier `WINDOW_MONTHS` 6 bln (stabil).
2. **Kapan & berapa (reorder s,S statistik)** — demand harian `d` **"konsisten"** (`_demandStats` v3):
   tiap pesanan di-**winsorize** ke persentil `WINSOR_PCT` 0.9 (buang one-time hit / pesanan abnormal besar)
   → rata-rata harian winsorized → **proyeksi growth** (rate `GROWTH_RECENT_WEEKS` 4 mgg terakhir vs
   sebelumnya, cuma NAIK, plafon `GROWTH_CAP` +25%). **BUKAN EWMA** (overreact ke batch terakhir → d meledak
   6×; fix 2026-06-07). SKU baru dibagi hari sejak first-sale; fail-safe saat harvest belum lengkap. Safety
   stock **statistik**: `SS = SERVICE_Z[tier] × σ_LT`, `σ_LT = √(LT·σ_daily² + d²·σ_LTdays²)` (`LT_CV` 0.3),
   service level A~97.5%/B~95%/C~90%/D~85%. **σ di-bound `MIN_CV` 0.25–`MAX_CV` 1.25**. `ROP = d×LT + SS`;
   lead time per item (`deliveryLeadTime`, fallback `LEAD_TIME` 14). **`S = ROP + d×CYCLE_DAYS[tier]`**
   (LEAN A14/B10/C7/D5) **diplafon `MAX_COVER_DAYS`** (A35/B28/C21/D18 hari — posture tipis ~2–3 mgg, lead
   time pendek). **Inventory position `IP = stok + on-order`**; IP ≤ ROP → 🔴 order `S−IP` · ≤ROP×1.2 → 🟡 · else 🟢.
3. **Cash cap** — `RaR%` = omzet SKU ÷ total. Rank 🔴 by **RaR ÷ harga beli**, alokasi budget top-down →
   `BELI #n` vs `TUNDA`. **Budget resolusi (2026-06-08, prioritas):** ① **cell `Budget restock (ketik →)` 🟡**
   di RINGKAS tab — user KETIK angka di sheet (`_readRestockBudget` baca cell sebelum tab ditulis ulang, pola
   upsert) → ② Script Property **`PO_BUDGET`** → ③ auto **total saldo Kas & Bank** (`pullBankBalance` JUMLAH akun
   CASH_BANK yg namanya cocok `BANK_MATCH` `['bca roshan','jago']` ← `glaccount/list.do`, scope **`glaccount_view`**
   CONFIRMED+granted) → ④ `PO_BUDGET_DEFAULT` 100jt. Cell editable dirender ulang tiap sync (info saldo Jago+BCA di
   sampingnya); kosong → pakai fallback. **NB realita 2026-06: total cash cuma ~30jt (Jago 7jt + BCA 23jt) vs saran belanja ~99jt → restock didanai dari AR masuk, bukan cash; makanya cell manual jadi jalur utama.**
   - **🛒 DAFTAR BELANJA + live re-rank (2026-06-08):** section **`🛒 DAFTAR BELANJA`** (di atas DAFTAR SKU) =
     kartu belanja bersih — cuma SKU yg perlu order, urut prioritas, kolom Qty·Harga·Subtotal·Kumulatif·✅BELI/⏸TUNDA
     + baris TOTAL BELANJA & sisa budget. Kolom pakai **merged block** (`_mblock`, `CART_BLOCKS`) krn col money DAFTAR SKU
     sempit (### kalau tak merge). **Budget cuma mengubah alokasi BELI/TUNDA — qty/biaya/posisi tetap** → bisa dihitung dari
     angka di sheet tanpa API. `computeRestock` return `cartItems` (needers urut prioritas, budget-independent); `_allocateCart`
     greedy isi budget (skip overflow, item murah di belakang masih masuk). **Simple `onEdit(e)` → `_applyBudgetLive(sh)`**:
     begitu user KETIK cell budget, daftar 🛒 + kolom Prioritas Beli + RINGKAS re-rank **INSTAN tanpa sync** (murni sheet,
     no API; deteksi cart via marker `🛒`, Subtotal col12/Kumulatif col14/Aksi col16). setValues programatik tak memicu onEdit (no loop). Tetap apply otomatis di sync harian 05:00 juga.

**Data:**
- **`_ItemCache`** (`refreshItemMaster`, scope **`item_view`**) — stok/cost/leadTime per SKU; cheap, tiap
  sync. Schema 6 kolom (`+leadTime`) — **auto-migrate** kalau header lama (pola `_contactCacheSheet`).
- **`_SkuSalesCache`** (`harvestSkuSales`, `sales_invoice_view`) — line-item per invoice, time-budgeted
  via `SYNC_START` (`SKU_HARVEST_BUDGET_MS` 5min/`SKU_HARVEST_MAX` 250) + sentinel + prune>window.
  **Jangan ubah ke fetch-all-per-run.**
- **On-order PO** (`buildOnOrderByItem`, scope **`purchase_order_view`**) — CONFIRMED via diag: `list.do`
  honor `fields` + balikin **`percentShipped`** (open = `_poIsOpen`: <100, bebas-bahasa) → `detail.do` → Σ
  **`remainingQuantity`** per line (barang belum datang, sudah hitung partial; fallback qty−received). Item
  code `item.no`. Tanpa cache (PO terbuka sedikit), bounded (`PO_MAX_DETAIL` 150 / `PO_BUDGET_MS` 5,5min). **Anti double-order.**
- **Saldo bank** (`pullBankBalance`, scope **`glaccount_view`**) — `glaccount/list.do`, **JUMLAH saldo semua akun
  `accountType==='CASH_BANK'`** yg namanya cocok salah satu di `BANK_MATCH` (array, mis. `['bca roshan','jago']`)
  → return `{total, accounts:[{name,balance}]}` (dipakai utk fallback budget + info saldo di RINGKAS). Field saldo
  = **`balance`** (CONFIRMED diag 2026-06-08); guard CASH_BANK biar parent rollup "Setara Kas"/piutang tak ke-jumlah.

**FAIL-SOFT:** `fullSync` bungkus refresh/onOrder/harvest/compute di try/catch (onOrder & item punya
try sendiri). Sebelum scope di-grant tab tetap tampil tier+velocity (stok "⚪ tak diketahui" / on-order
kosong), nyusul setelah re-consent. **Master-only** — JANGAN tambah ke blok writer Ade/Deden.
Tab punya section **📖 CARA BACA** (glossary kolom buat partner). **`HIDE_INACTIVE`** (default true)
sembunyikan SKU ⚪ "Stok tak diketahui" (disetop/tak di item master, mis. lini LIBRA) & "Tanpa demand"
(kalau SEMUA ⚪ → tetap ditampilkan biar warning kelihatan).

**Deploy v2:** ① push · ② scope `item_view`+`purchase_order_view`+`glaccount_view` (sudah di CONFIG) →
`forceReauthorize()` · ③ menu **Diag item/purchase/cash-bank fields** → cek nama field di Log (saldo CONFIRMED `balance`),
sesuaikan `refreshItemMaster`/`buildOnOrderByItem`/`pullBankBalance` kalau beda · ④ **Refresh Restock** + **Run Full
Sync** 2–3× sampai RINGKAS "Data line-item ✓ lengkap" · ⑤ budget: **KETIK angka di cell `Budget restock (ketik →)` 🟡**
di tab Restock (jalur utama); kosongkan → auto total Kas&Bank (BCA+Jago) → default 100jt. Semua angka tunable di `CONFIG.RESTOCK`; satuan CTN. Caveat: `deliveryLeadTime` mungkin 0
(fallback 14); received-qty per line PO mungkin absen → fallback full qty; saldo bank endpoint perlu verifikasi diag.

---

## Per-role access — separate Sheet files (BUILT 2026-06-02)

Google Sheets can't hide tabs per-collaborator inside one file (protection only blocks *editing*;
hidden tabs can be unhidden/copied). The KPI tabs expose take-home pay, so real isolation = **one
Sheet file per person**, fed by the same sync:

- **Master `Tracker Invoice`** (owner = Roshan, never shared to staff) — all tabs.
- **Ade file** (`ROSH AR — Ade`, shared **Editor**) — Summary (AR-scoped) + Pool A + Pool B + KPI Matriks AR.
- **Deden file** (`ROSH Tagihan — Deden`, shared **Viewer**) — Summary (Sales-scoped) + Tagihan Sales + **Pool B (scoped to his own customers)** + **💰 Faktur Collected** + KPI Matriks Sales + **📈 Riwayat THP (section SALES saja)**.

**💰 Faktur Collected di file Deden (2026-08-02):** semua tab lain di file-nya berorientasi tagihan yang
BELUM lunas; angka *collected* cuma ada sebagai skalar (KPI Matriks Sales + kolom Collected di Riwayat THP).
Tab ini memecahnya jadi daftar faktur untuk **bulan lalu + bulan berjalan**. Lihat baris `Collected.gs` di
tabel Files. Uji rekonsiliasi: TOTAL "Dibayar (bln ini)" tiap section **harus sama persis** dengan kolom
Collected bulan itu di 📈 Riwayat THP (dan bulan berjalan = baris "Omzet (collected bln ini)" di KPI Matriks).
Selisih ⇒ jalankan `diagCollectedReconcile('yyyy-MM')` (Collected.gs): dia memisahkan sebab **matcher salesman**
(fuzzy `_bySalesman` vs strict `===SALES_NAME` di KPI) dari **ledger beku** (bandingkan `_ThpHistory` vs hitung
ulang live + daftar receipt di 2 hari terakhir bulan). Selisih Juli 2026 pertama kali (Rp9.063.960) terbukti
100% ledger beku, nol matcher → lahirlah re-stamp di ThpHistory.gs. **Deden-only** — jangan tambahkan ke blok writer master/Ade.

**📈 Riwayat THP di file Deden (2026-08-01):** `writeThpHistoryTab(invoices, role)` sekarang bertanda tangan
dua argumen. `role='deden'` **melewati section THP AR sepenuhnya** — isolasi gaji, dia tak boleh lihat THP Ade.
Dua hal yang membuat ini bisa jalan di file role: (a) `_thpHistorySheet()` sekarang **selalu**
`openById(CONFIG.SHEET_ID)`, bukan `_ss()` — kalau relatif, render di file Deden akan bikin ledger `_ThpHistory`
kosong baru di sana dan tabnya tampil "belum ada riwayat"; (b) `SPAN` naik 9 → **10**.
Kolom baru **`Invoice Terbit`** (kolom 3) = `buildMonthlyIssued(invoices, CONFIG.SALES_NAME)`, dihitung
**live dari `transDate` tiap sync, TIDAK disimpan di ledger** — sengaja, supaya bulan-bulan lama (Juni/Juli)
ikut terisi, bukan blank karena kolomnya belum ada waktu baris itu dibekukan. Teks `"62 faktur · Rp215.400.000"`.
Ini **nilai tagihan terbit, bukan uang masuk** — tak akan pernah sama dengan Collected di bulan yang sama.

**Pool B di file Deden (2026-08-01):** `_poolBySalesman(poolB, CONFIG.SALES_NAME)` menyaring Pool B ke
invoice yang salesman-nya Deden (match case-insensitive full name ATAU first name; `""` = POS/online tak
pernah ikut) — `poolRow` sekarang membawa `salesman` khusus untuk ini (bukan kolom, tidak muncul di sheet).
Ditulis pakai `writePoolTab` yang sama + map `yB` yang sama, jadi Deden ikut lihat 🟡 follow-up Ade. Banner
pakai `subtitleOverride` (param ke-5 `writePoolTab`) supaya jelas ini **pantau saja** — penagihan tetap Ade.
Deden = Viewer di file-nya, jadi 🟡 tetap tak bisa dia isi. Pool A **tidak** ikut (legacy, pra-onboard, bukan urusan sales).
⚠️ **`orderTabs()` (Style.gs) diperbaiki bareng ini:** dulu posisi tujuan = INDEKS di array 16 tab → di file
role (Deden cuma ~4 sheet) `moveActiveSheet(14)` melempar **"Invalid argument"** dan meng-abort `fullSync`
di ujung. Sekarang pakai counter `pos` yang cuma menghitung tab yang benar-benar ada → hasil identik di
master, aman dipanggil di file role mana pun.

**Nama tab versi Deden (2026-08-02):** `CONFIG.TABS` ditulis dari sudut pandang operator AR (`Pool B — Ongoing AR`,
`KPI Matriks Sales`, `Riwayat THP`) — buat Deden itu jargon. Peta **`TABS_DEDEN`** (Code.gs, key = nama master)
memberi file dia nama sendiri: `🧾 Tagihan Kamu` · `🔵 Faktur Ongoing AR` · `📊 KPI & Gaji Bulan Ini` ·
`📈 Riwayat Gaji` · `⛔ Customer Ditahan` (`💰 Faktur Collected` sengaja tidak di-alias). Mekanismenya global `TAB_ALIAS` + `_tabName()` (Sync.gs) yang dipasang di **tiga chokepoint saja**
— `uiSheet` (Style.gs), `_tab` (Sync.gs), `writePoolTab` — plus `orderTabs`, jadi **nol writer diubah** dan
master/Ade tetap pakai nama asli (dokumentasi + `collectPoolYellow` + kebiasaan Ade aman). `_applyTabAlias(ss, map)`
dipanggil di AWAL blok Deden untuk **rename tab lama di tempat** (kalau tidak, writer bikin tab baru dan yang lama
jadi sampah); idempoten, skip kalau nama tujuan sudah dipakai. `TAB_ALIAS` di-reset ke null di akhir blok DAN di
catch `fullSync` biar tak bocor ke `_log`/master. Judul banner Pool B ikut nama alias supaya tab dan isinya tak
bilang dua hal berbeda. Mau ganti nama? Edit sisi kanan `TABS_DEDEN` saja, sync berikutnya rename otomatis.

**How:** `fullSync` computes once, then writes to each file by swapping `TARGET_SS` (Sync.gs) — `_ss()`
returns `TARGET_SS || master`, so every writer (incl. `uiSheet`/`orderTabs`) redirects with no rewrite.
File ids live in Script Properties `ADE_SHEET_ID` / `DEDEN_SHEET_ID`.

- **🟡 source of truth = Ade's file.** `collectPoolYellow([master, adeSS], …)` merges Channel/Hasil/
  Tgl Follow-up/Bukti by invoice number (Ade's non-empty wins), then writes IDENTICAL 🟡 to both →
  Ade edits in her file, master picks them up next sync (reconciles per run, not real-time).
- **Salary isolation:** `writeThpAdeTab`/`writeThpSalesTab` only run for their own file; `writeSummaryTab(ctx, role)`
  hides the other role's THP block (`'ade'` skips THP Sales, `'deden'` skips THP AR).
  `writeThpSalesTab(k, role)` — `role='deden'` mengganti keterangan baris **Komisi 1.25%** (D17) jadi rumus
  pendek `(Basis − Rp100.000.000) × 1,25%, hanya kelebihannya` + satu footnote contoh angka (Rp120jt → Rp250.000)
  di bawah tab, karena D17 cuma 280px. Paragraf aturan pre-handover tetap master-only.
- **🔴 lock is warning-only** (avoids the userinfo.email scope error) — Ade *can* override a 🔴 cell
  past a popup, but the next sync overwrites it.

**One-time setup:** edit the two Gmail addresses in `setupRoleSheetsOnce` → menu **ROSH Accurate ▸
Setup role sheets (Ade/Deden)** (or Run it) → it creates + shares both files → run **Run Full Sync now**.

---

## Conventions

- **Satu global scope.** Apps Script menggabung semua `.gs` — fungsi bernama sama saling menimpa DIAM-DIAM.
  Sudah pernah kejadian: `_monthLabel()` di TurunBuku.gs sempat menimpa milik Kpi.gs (dipakai 3 banner KPI + Health),
  makanya helper bulan di sana diberi awalan `_tb`. Sebelum menambah helper, cek dulu:
  `grep -hoE "^function [A-Za-z_][A-Za-z0-9_]*" *.gs | sort | uniq -d`.

- Credentials live in **Script Properties**, never in source or the sheet. Setup functions hold literals temporarily, then get wiped.
- Money: `outstanding` = current balance (total − received), not original invoice total. Partial payments shrink amounts.
- Reuse `Sync.gs` helpers (`fetchSalesInvoices`, `normalizeInvoice`, `fetchCustomerDetail`, `fmtDate`, `num`) — don't re-implement.
- **Receipts come from ONE bulk sweep** (`buildReceiptsByInvoice` → `sales-receipt/list.do`, paged, indexed by invoice id; single-invoice receipts use `totalPayment`, multi-invoice fall back to `sales-receipt/detail.do` for per-line `paymentAmount` excl. PPh). `enrichReceipts` consumes that map — **do NOT revert to per-invoice `sales-invoice/detail.do`** (one call per paid invoice → "scales badly toward month-end"). Validated identical to the old path by `diagReceiptReconcile` (40/40, 0 diff). Requires the **`sales_receipt_view`** OAuth scope (added 2026-06-04 → `forceReauthorize` once). If receipt math ever looks off, re-run `diagReceiptReconcile`.
- **Customer contacts are cached** in hidden sheet `_ContactCache` (`attachCustomerContacts`). Per-customer `detail.do` is time-budgeted (≤4 min) so a big first run never times out the whole sync — unfetched customers fill in over the next few syncs. Don't revert to fetching every customer every run (that 208-call loop hit the 6-min limit and aborted the writers). To rebuild contacts from scratch, clear the `_ContactCache` tab (or run the throwaway `clearCaches` helper).
  - **Cache schema = `customerId | nama | alamat | noTlp | noWa | noBisnis | noVa`** (7 kolom sejak 2026-07-06, feed tab 📇 Kontak Customer). `_contactCacheSheet` AUTO-MIGRATES any older header (3-col/4-col) by wiping it once → rebuilds bertahap via detail.do. `noTlp` tetap nomor GABUNGAN (`_custPhone`) untuk konsumen lama (Pesan/Route/StopSupply/Pool); `noWa`/`noBisnis` adalah split mobile vs kantor untuk tab Kontak.
  - **Alamat + VA live only in `customer/detail.do`.** `customer/list.do` returns just `{id}` even with `fields` requested → the bulk layer contributes nothing; every contact needs detail.do. `_custAddress` (`billStreet`/`shipStreet` + wide fallback), `_custVa` (**`customerNoVa`** = customer's own VA), `_custPhone`. Layer-3 **re-fetches when a cached entry has phone but no `alamat`**. Verify field names with `diagCustomerFields()` (dumps full detail.do JSON).
  - **VA per customer:** both the WA pesan (`Pesan.gs`, via `inv.noVa`) and the Faktur PDF (`Faktur.gs` `_fakturVa(d)` → embedded `customer.customerNoVa` else `customer/detail.do`) use the customer's own `customerNoVa`, NOT the static `FAKTUR.VA_BCA`. **`customerNoVa` stores only the 6-digit customer code; the full VA = `FAKTUR.VA_PREFIX` (`15903`) + code** via `_fullVaBca()` (guards double-prefix / already-full). e.g. code `648718` → `15903648718`. Pesan: no VA → line omitted (BCA `6560380435` still shown). Faktur: no VA → falls back to static `FAKTUR.VA_BCA` (formal doc always shows a VA). Cached faktur PDFs keep the old VA until the file in Drive `ROSH Faktur PDF` is deleted (rebuild).

## Memory note
Folder-level MEMORY.md is at the ROSH Finance root (one entry: salary calc method). Write to it only on Bro's explicit trigger ("remember this" etc.).
