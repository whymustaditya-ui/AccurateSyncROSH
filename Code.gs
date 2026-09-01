/**
 * ROSH × Accurate Online → Google Sheets
 * Auto-sync sales invoices, compute >14-day overdue handover for AR Officer (Ade),
 * and calculate Sales KPI + AR Officer KPI.
 *
 * Runtime: Google Apps Script (bound to the target Sheet)
 * Auth:    Accurate Open API — OAuth2 (Authorization Code) + open-db session + HMAC signature
 *
 * SETUP: see SETUP.md. Run setupCredentials() once, then authorize() once,
 *        then run fullSync() or install the time trigger via installTrigger().
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  SHEET_ID: '1-BQ3zieAZkaaUVkUIgI8ZQKAZ-x1dLFOuntl8n1aUcw',

  // Accurate endpoints
  // Per official docs (accurate.id/api-integration/api-example, updated Oct 2025):
  //   OAuth, db-list, and open-db all live on account.accurate.id.
  //   The DATA host (e.g. public.accurate.id) is returned dynamically by open-db
  //   and used only for /accurate/api/* calls — do NOT hardcode it.
  ACCOUNT_BASE: 'https://account.accurate.id',          // OAuth + db-list + open-db host
  // Minimal known-valid scope. sales-invoice/list returns customer + salesman
  // embedded, so this alone covers the full sync. If a call later returns 403,
  // add the SPECIFIC valid scope from account.accurate.id/developer/api-docs.do
  // (e.g. 'customer_view') — do NOT use 'sales_view'/'report_view' (not real scopes).
  OAUTH_SCOPE:  'sales_invoice_view customer_view sales_receipt_view item_view purchase_order_view glaccount_view', // space-separated.
  // PO_BUDGET sekarang pakai default CONFIG.RESTOCK.PO_BUDGET_DEFAULT (100jt). Untuk auto dari saldo Bank
  // Jago: scope yang BENAR = 'glaccount_view' (CONFIRMED dari api-docs: /api/glaccount/list.do + get-balance.do;
  // 'gl_account_view' DITOLAK). Tambahkan ' glaccount_view' ke string scope di atas → forceReauthorize() →
  // menu "Diag cash/bank fields", lalu pullBankBalance akan override default. Endpoint balance: get-balance.do. customer_view → customer/list.do + detail.do (Alamat/No. Telp). sales_receipt_view → bulk sales-receipt/list.do (Penerimaan Penjualan, read-only). item_view → item/list.do (stok on-hand + harga beli per SKU untuk Restock Engine, read-only). purchase_order_view → purchase-order/list+detail.do (barang on-order untuk inventory position Restock, read-only). After changing scope you MUST run forceReauthorize() (authorize() reuses the old token). NB kalau item/list.do balas 403, coba ganti item_view → product_view/inventory_view; purchase_order_view → purchase_view (nama scope beda antar build Accurate; cek account.accurate.id/developer/api-docs.do).

  // Per-request HMAC signature. The documented Open API flow needs ONLY
  // Bearer + X-Session-ID. Leave OFF unless your app registration explicitly
  // requires signing; flip to true if you get a signature-related rejection.
  USE_SIGNATURE: false,

  // Business rules
  HANDOVER_GRACE_DAYS: 14,      // overdue > 14 days past due → handover to Ade (Sales handles H+0..H+14)
  HANDOVER_OFFSET_DAYS: 15,     // Tgl Handover (H+15) = dueDate + 15. Ade's clock starts here.
  ADE_ONBOARD_DATE: '2026-06-02', // Ade start date. Pool A snapshot freeze + komisi/bonus accrual start. Before this date the AR KPI defaults to 0. yyyy-MM-dd, GMT+7.
  AR_OFFICER_NAME: 'Ade',       // Confirmed: AR Officer is Ade.
  SALES_NAME: 'Deden Sunandar', // masterSalesmanName attributed to Sales KPI. "" = POS/online (excluded).
  // Invoice Sales tab shows ONLY these salespeople (first-name match, case-insensitive).
  // Tab filters out POS/online and any other salesman. Sales KPI math still keys on SALES_NAME.
  SALES_FILTER: ['Deden', 'Dian'],
  // Arsip THP: berapa hari pertama bulan baru sync masih menghitung ULANG bulan lalu
  // (restampPreviousMonth, ThpHistory.gs). Menangkap bukti transfer yang dientri ke
  // Accurate setelah sync terakhir bulan itu tapi bertanggal bulan itu. Lewat batas ini
  // baris bulan lalu beku permanen — payroll yang sudah ditutup tak bisa berubah diam-diam.
  THP_RESTAMP_DAYS: 7,

  // ── Sales KPI (Memo KPI Sales Deden) ──
  // THP = Base 3.5jt + Tunjangan(TotalScore × 3.5jt, cap 106%) + Komisi(1.25% × MAX(collected−100jt,0))
  SALES_BASE: 3500000,
  SALES_TUNJANGAN_MULT: 3500000,   // tunjangan = score × this
  SALES_TUNJANGAN_CAP: 1.06,       // tunjangan score capped at 106%
  SALES_OMZET_TARGET: 100000000,   // Rp100jt collected → 100% omzet
  SALES_COMMISSION_RATE: 0.0125,   // 1.25% on collected above target
  SALES_COMMISSION_FLOOR: 100000000, // komisi only on collected above Rp100jt
  // BASIS komisi = SELURUH kas masuk bulan itu atas faktur Deden, termasuk kas yang cair
  // setelah faktur pindah ke Ade (H+15). Sempat dipotong ke kas pre-handover saja
  // (2026-08-02), dibatalkan 2026-08-03 — mesinnya dicabut, lihat memo.
  NOO_TARGET: 5,                   // new outlets/month target

  // Sales KPI weights & caps
  W_OMZET: 0.45,   CAP_OMZET: 1.00,
  W_CASHFLOW: 0.25, CAP_CASHFLOW: 1.00,
  W_DISKON: 0.20,  CAP_DISKON: 1.20,
  W_NOO: 0.10,     CAP_NOO: 1.20,

  // ── AR Officer KPI — Offering Letter (2026-05-20, signed) ──
  // THP floor = Gaji Pokok 3jt + Tunjangan Operasional 800rb = 3.8jt (no komisi/bonus).
  // Komisi = % of CASH masuk kas (not invoice value), bucket by aging-since-handover,
  // LOCKED at the aging on the first post-onboard payment (partial → bucket tidak berubah).
  // Komisi accrues from onboard (H+1 kerja). Uncapped.
  AR_BASE:          3000000,   // Gaji Pokok (fixed from day 1)
  AR_TUNJANGAN_OPS: 800000,    // Tunjangan Operasional (bensin/pulsa/makan) — fixed. Penalty deducts from this.
  AR_RATE_REGULAR: 0.015,  // 0–30 hari sejak handover (= 15–45 overdue) → 1.5%
  AR_RATE_AGING1:  0.025,  // 31–75 hari sejak handover (= 46–90 overdue) → 2.5%
  AR_RATE_AGING2:  0.035,  // >75 hari sejak handover (= 91+ overdue) → 3.5%

  // Aging-since-handover bucket cutoffs (days). handover = dueDate + 15.
  AR_BUCKET_REG_MAX:    30,  // 0–30 → regular
  AR_BUCKET_AGING1_MAX: 75,  // 31–75 → aging-1 ; >75 → aging-2

  // ── Probation bonuses (Pool A only — cumulative collected since onboard) ──
  AR_SPRINT_TARGET:     50000000,  AR_SPRINT_BONUS:    2000000,  AR_SPRINT_WINDOW_DAYS: 30, // ≥50jt in 30 days of onboard
  AR_MILESTONE_TARGET:  75000000,  AR_MILESTONE_BONUS: 1500000,  AR_MILESTONE_WINDOW_DAYS: 92, // ≥75jt in 3 months
  AR_CLEANUP_CEILING:   60000000,  AR_CLEANUP_BONUS:   1500000,  // Pool A remaining < 60jt at end of month 3

  // ── Penalty (auto-FLAG only; owner decides). Deduct from Tunjangan Operasional. ──
  // Waived if there is documented follow-up in the yellow tracker columns.
  AR_PENALTY_REG_TO_AGING1:    50000,   // 14–45 → 46–90 bucket worsening, undocumented
  AR_PENALTY_AGING1_TO_AGING2: 100000,  // 46–90 → 91+ bucket worsening, undocumented

  // ── Customer loyalty tier (display-only; for softer penagihan to frequent buyers) ──
  // Tier from invoice COUNT within the trailing window. Shown alongside value (rupiah).
  // Thresholds are Ade's (A>10, B 5–10, C 2–4, D 1) — tune freely; over a 4-month window
  // A(≥11) is demanding so A will be rare. Does NOT affect komisi/penalty/handover.
  CUST_TIER: {
    WINDOW_MONTHS: 4,
    A_MIN: 11, B_MIN: 5, C_MIN: 2   // ≥A_MIN→'A' · ≥B_MIN→'B' · ≥C_MIN→'C' · ≥1→'D' · 0→''
  },

  // ── Rute Penagihan (Route.gs) — Ade's field-collection drive list ──
  // Zona priority = total outstanding × (1 + umur_tertua_hari × AGING_WEIGHT).
  // AGING_WEIGHT 0.02 ⇒ +2%/hari (umur 50 hari ≈ menggandakan bobot zona). Tune freely.
  // MAX_PIN_RESOLVE caps shortened-link (maps.app.goo.gl) lookups per sync; MAX_GEOCODE
  // caps freeform-address geocodes (built-in Maps service) per sync. Both results are
  // cached (hidden _PinCache / _GeoCache) so the caps rarely bite after the first runs.
  ROUTE: {
    AGING_WEIGHT:    0.02,
    MAX_PIN_RESOLVE: 60,
    MAX_GEOCODE:     50
  },

  // ── Flow Penagihan Fase 0 (StopSupply.gs / Route.gs dispatch / Pesan.gs batch) ──
  STOP_SUPPLY_DAYS:    1,   // invoice belum bayar ≥ H+1 (lewat jatuh tempo) → customer flag HOLD (Nathan tahan SO baru)
  PENAGIHAN_WINDOW_MAX: 14, // tab Pesan cakup faktur daysPastDue ∈ [-1,14] (window Deden pra-handover)
  // Aturan dispatch kunjungan (dari diagram flow). Prioritas: Solo > Nearest > Rute > Antri.
  DISPATCH: {
    SOLO_MIN:       2500000,  // outstanding ≥ Rp2,5jt → boleh kunjungan SOLO (jangan nunggu cluster)
    ZONE_MIN_STOPS: 3,        // zona terkumpul ≥ 3 titik → jadwalkan 1 RUTE BATCH
    QUEUE_AGE_DAYS: 21        // umur antri (sejak handover) > 21 hari → WAJIB ikut rute terdekat
  },

  // ── Restock Engine (Restock.gs) — SKU tiering + reorder point + cash-capped PO ──
  // v2 (2026-06-07): demand recency-weighted (EWMA), safety stock statistik (Z×σ), banding
  // percentile self-calibrating, inventory position = stok + on-order PO. Semua tunable di sini.
  RESTOCK: {
    WINDOW_MONTHS: 6,          // window tier (velocity + penetrasi) — stabil
    RECENT_WEEKS:  12,         // window demand sizing (recency) — minggu terakhir
    WINSOR_PCT:    0.90,       // winsorize: cap tiap pesanan di persentil ini → buang one-time hit (pesanan abnormal besar)
    GROWTH_RECENT_WEEKS: 4,    // demand 4 mgg terakhir vs sebelumnya → deteksi tren
    GROWTH_CAP:    1.25,       // proyeksi growth dibatasi (cuma NAIK, maks +25%) — anti over-extrapolate
    EWMA_ALPHA:    0.4,        // (DEPRECATED — demand kini rata-rata winsorized + growth; lihat _demandStats)
    MIN_CV:        0.25,       // lantai koef. variasi demand (SKU flat tetap dapat buffer)
    MAX_CV:        1.25,       // PLAFON koef. variasi — demand B2B lumpy (batch) bikin σ meledak → cap di sini
    LEAD_TIME:     14,         // hari PO→datang, fallback kalau item.deliveryLeadTime kosong
    LT_CV:         0.30,       // variabilitas lead time (supply acak): σ_LT_hari = LT × LT_CV
    WEIGHT_VELOCITY: 0.60,     // bobot velocity di skor tier
    WEIGHT_PEN:      0.40,     // bobot penetrasi di skor tier
    BAND_MODE: 'percentile',   // 'percentile' (self-calibrating) | 'absolute' (pakai *_BANDS)
    PERCENTILE_CUTS: [0.80, 0.60, 0.40, 0.20],  // ≥cut → skor 5/4/3/2 · else 1 (top 20% = 5)
    VELOCITY_BANDS:    [[500, 5], [300, 4], [150, 3], [50, 2], [0, 1]],  // fallback BAND_MODE='absolute'
    PENETRATION_BANDS: [[30, 5], [20, 4], [10, 3], [5, 2], [0, 1]],      // (karton/bln · customer/window)
    TIER_CUTOFFS:  { A: 4.5, B: 3.5, C: 2.5 },                  // skor → tier (else D)
    SERVICE_Z:     { A: 1.96, B: 1.65, C: 1.28, D: 1.04 },      // service level z: A~97.5% … D~85%
    CYCLE_DAYS:    { A: 14, B: 10, C: 7,  D: 5  },              // cycle stock di ATAS reorder point (LEAN ~2-3 mgg)
    MAX_COVER_DAYS:{ A: 35, B: 28, C: 21, D: 18 },             // PLAFON keras target stok (hari) — posture tipis (lead time 1-2 mgg)
    PO_BUDGET_PROP: 'PO_BUDGET',  // Script Property (Rp). Override programatik; di bawah cell ketik-di-sheet.
    // Resolusi budget restock (prioritas atas→bawah): ① cell "Budget restock (ketik →)" 🟡 di tab Restock
    // (user ketik di sheet) → ② Script Property PO_BUDGET → ③ auto total saldo Kas & Bank (akun CASH_BANK
    // yang namanya cocok BANK_MATCH, mis. BCA Roshan + Jago — read-only, scope glaccount_view) → ④ default.
    // Verifikasi field saldo via diagCashBankFields() (field = `balance`, type = `accountType`=CASH_BANK).
    BANK_MATCH:     ['bca roshan', 'jago'],  // substring nama akun kas/bank yg DIJUMLAH (case-insensitive); only CASH_BANK
    PO_BUDGET_DEFAULT: 100000000 // fallback budget (Rp) kalau cell, Script Property, & saldo bank semua kosong
  },

  // ── Rapor Customer (Customer.gs) — gate order baru + saran limit & tempo per customer ──
  // Dua sumbu: (1) SKOR BAYAR 0..100 dari SELURUH riwayat pembayaran, makin tinggi makin baik
  // (searah skor lain di repo), perilaku lama luruh (half-life); (2) NILAI EKONOMI = margin
  // kotor (vendorPrice) dikurangi biaya modal piutang.
  //
  // Ambang di sini ABSOLUT, bukan percentile seperti RESTOCK. Alasannya beda pertanyaan:
  // Restock nanya "siapa duluan dengan budget tetap" (ranking murni, tak ada kebenaran luar),
  // di sini nanya "boleh kirim atau tidak" — dan itu punya jangkar nyata (rupiah, hari, biaya
  // modal). Kalau SELURUH buku memburuk, percentile tetap mencap AMAN ke 20% teratas dari buku
  // busuk; justru itu yang sedang dihindari. Percentile cuma dipakai sebagai PRIOR shrinkage.
  //
  // Semua keluaran = SARAN. OAuth read-only; Nathan yang menerapkan di Accurate.
  CUSTOMER: {
    // — sisi bayar (window: SEMUA faktur yang ditarik sync) —
    HALF_LIFE_DAYS:     180,   // bobot perilaku separuh tiap 6 bln → customer yang tobat tak dihukum selamanya
    GRACE_DAYS:         3,     // telat ≤3 hari dianggap tepat waktu (lag admin/bank)
    LATE_ZERO_DAYS:     45,    // telat ≥45 hari → skor kecepatan 0
    POSISI_ZERO_DAYS:   60,    // faktur terbuka terlama 60 hari → skor posisi 0
    BEBAN_GRACE_DAYS:   30,    // eksposur setara ≤1 bulan belanja = wajar
    BEBAN_ZERO_DAYS:    90,    // eksposur setara ≥3 bulan belanja → skor beban 0
    BEBAN_HARD_MONTHS:  3,     // >3 bulan belanja tertahan → band dicap RISIKO

    W_KECEPATAN: 0.35, W_DISIPLIN: 0.15, W_POSISI: 0.35, W_BEBAN: 0.15,  // jumlah 1.00

    SHRINK_K:           3,     // data tipis ditarik ke rata-rata buku: bobot sendiri n/(n+K)
    MIN_INVOICES_SCORE: 3,     // ≥ini baru ikut MEMBENTUK prior buku

    BAND_CUTS: { AMAN: 75, HATI: 60, RISIKO: 40 },   // <RISIKO → BAHAYA

    // Override keras — rata-rata tertimbang TIDAK boleh menutupi keadaan darurat hari ini.
    STOP_DPD:           45,        // ada faktur terbuka ≥45 hari lewat JT → BAHAYA, apa pun skornya
    STOP_OVERDUE_RP:    25000000,  // overdue ≥Rp25jt DAN ≥STOP_OVERDUE_DPD hari → BAHAYA
    STOP_OVERDUE_DPD:   15,

    // — kelas khusus (tidak ikut dirangking / tidak diberi limit) —
    COD_TEMPO_MAX:      1,     // (dueDate−transDate) ≤1 hari di SEMUA faktur → kelas TUNAI (belum pernah diuji kredit)
    DORMANT_MONTHS:     6,     // tak ada faktur dalam 6 bln → DORMAN
    LIMIT_BARU:         5000000,
    TEMPO_BARU:         0,     // customer baru: COD dulu

    // — sisi margin (window dibatasi _SkuSalesCache, maks RESTOCK.WINDOW_MONTHS) —
    // DIBUKA 2026-09-02 setelah diagVendorPrice(): cek ΣlineTotal vs subTotal 10/10 selisih Rp0
    // (pemetaan totalPrice BENAR), besaran qty×cost vs jual sepadan (tak ada salah satuan PCS/CTN),
    // costRatio buku 0.8438, SKU tanpa harga beli cuma 0.6% omzet.
    MARGIN_ENABLED:       true,

    // Item NON-DAGANGAN: bukan barang yang dibeli-lalu-dijual, jadi TIDAK punya harga pokok yang
    // sebanding. Dikeluarkan dari perhitungan margin (dua sisi: omzet & hpp) supaya tidak
    // mencemari. Ketahuan dari diag: kode 1/2/100005 = Pembelian Aset, Jasa Pengiriman, Inventaris
    // Kantor — semuanya cost 0 sehingga tanpa aturan ini akan kena imputasi rasio HPP buku (~84%),
    // yang jelas salah untuk ongkos kirim. Cocokkan dengan KODE persis atau pola NAMA.
    NON_INVENTORY_CODES:  ['1', '2', '100005'],
    NON_INVENTORY_RE:     /pembelian aset|jasa pengiriman|inventaris|biaya kirim|ongkos kirim/i,

    // Bulan yang basis harga belinya TIDAK bisa dipercaya dikeluarkan dari perhitungan margin.
    // Deteksinya otomatis: kalau di satu bulan porsi omzet "di bawah modal" melompat melewati
    // ambang ini PADAHAL barisnya masih memakai harga beli snapshot (belum ada unitCost), yang
    // terjadi hampir pasti bukan jualan rugi massal melainkan harga beli yang sudah berubah
    // sejak bulan itu. Diag 2026-09-02 memperlihatkan lompatan itu telanjang: Maret 87,1% lalu
    // April & Mei 0,0%, Juni-Agustus 0,2-2,1%. Pergeseran harga bertahap tidak membentuk tangga
    // seperti itu; kenaikan harga beli sekitar April membentuknya persis.
    MONTH_DISTRUST_PCT:   0.25,
    // Ambang "dijual di bawah modal" (rasio hpp/jual). 1.0 = pas modal. Dipakai untuk MENGHITUNG
    // porsi omzet yang dijual rugi + daftar diagBelowCost(). Diag 2026-09-02 menemukan 167 baris
    // seperti ini — entah harga beli di Accurate sudah basi, atau harga jualnya memang perlu naik.
    BELOW_COST_RATIO:     1.0,
    MARGIN_WINDOW_MONTHS: 6,     // di-clamp ke RESTOCK.WINDOW_MONTHS saat runtime (_pruneSkuSales)
    MIN_COVERAGE:         0.70,  // <ini → margin "belum bisa dihitung", vonis dari sisi bayar saja
    MIN_COST_COVERAGE:    0.85,  // share omzet baris yang punya harga beli ASLI (bukan imputasi)
    MIN_OMZET_RP:         10000000,
    FALLBACK_COST_RATIO:  0.80,  // dipakai kalau _ItemCache kosong (scope item_view belum grant)
    TARGET_MARGIN_PCT:    0.12,  // margin bersih sehat setelah biaya modal
    NAIK_HARGA_MAX:       0.25,  // saran kenaikan harga diplafon 25%

    // Biaya modal piutang. 24%/th = 2%/bln, angka yang lazim dipakai anjak piutang di Indonesia
    // dan gampang dibela kalau ditanya customer. NB: biaya SEBENARNYA lebih tinggi — restock ROSH
    // didanai dari AR masuk (cash ~30jt vs saran belanja ~99jt), jadi ongkosnya = margin yang
    // hilang karena tak bisa belanja, bukan bunga bank. Naikkan ke 0.30–0.36 kalau mau galak.
    COST_OF_CAPITAL_ANNUAL: 0.24,

    PD: { LANCAR: 0.01, D30: 0.03, D60: 0.08, D90: 0.18, D180: 0.35, D180PLUS: 0.60 },  // cadangan risiko

    // — saran limit & tempo —
    LIMIT_WINDOW_MONTHS: 6,
    HEADROOM:   { AMAN: 1.5, HATI: 1.2, RISIKO: 1.0, BAHAYA: 0 },
    TEMPO_BAND: { AMAN: 30,  HATI: 21,  RISIKO: 14,  BAHAYA: 0 },
    TEMPO_ONLY_TIGHTEN: true,  // mesin cuma boleh MEMPERKETAT tempo; melonggarkan = keputusan orang
    TEMPO_MAX:   30,
    LIMIT_MIN:   2000000,
    LIMIT_MAX:   150000000,
    LIMIT_ROUND: 500000,
    CONC_PCT:    0.10          // satu customer maks 10% total piutang buku (aturan konsentrasi)
  },

  // ── Program Turun Buku Piutang (TurunBuku.gs) ──
  // Target: outstanding turun ke TARGET_AR dalam MONTHS bulan, bertahap. Dua tuas: (1) cabut
  // tempo → COD penuh, (2) tagih lebih keras. NPL_DAYS 60 dipilih karena _MetricSnapshots SUDAH
  // menyimpan bucket 61–90 & 90+ harian sejak lama → tren NPL bisa ditarik mundur, gratis.
  TURUN_BUKU: {
    TARGET_AR:     150000000,   // buku sehat yang dituju (Rp)
    MONTHS:        6,           // lama program (glide path garis lurus)
    PROGRAM_START: '2026-09',   // 'yyyy-MM' bulan pertama. Buku awal dikunci dari snapshot bulan ini.
    NPL_DAYS:      60,          // tagihan lewat >60 hari dianggap NPL (berpotensi tak tertagih)
    BUDGET_PROP:   'CREDIT_BUDGET',  // Script Property (Rp) override plafon kredit bulan berjalan
    MIN_WAVE:      3            // gelombang cabut tempo minimal segini customer, biar tidak recehan
  },

  // Sheet tab names (relabeled 2026-05-30; see TAB_MIGRATION for old→new in-place rename)
  TABS: {
    CARA_BACA:     '📖 Cara Baca',          // onboarding guide (static, rebuilt each sync)
    TODO:          '📌 To-Do — Peringatan', // daily action list: penagihan JT (H-1→H+14, 4-touch) + follow-up reaktivasi (dormancy)
    PESAN:         '✉️ Pesan Penagihan',     // ready-to-send WA collection messages, group-by-customer (Pesan.gs, master-only)
    STOP_SUPPLY:   '⛔ Stop Supply (HOLD)',   // customer lewat jatuh tempo belum bayar → Nathan tahan SO baru (StopSupply.gs; master + file Deden discoped)
    KONTAK:        '📇 Kontak Customer',      // directory semua customer: nama + No WA + No Bisnis (Kontak.gs, master-only)
    CUSTOMER:      '🧭 Rapor Customer',       // gate order baru + saran limit & tempo per customer (Customer.gs, master-only)
    TURUN_BUKU:    '📉 Turun Buku Piutang',   // program turun AR ke target + NPL + gelombang cabut tempo (TurunBuku.gs, master-only)
    POOL_A:        '🔴 Pool A — Stuck AR',   // FROZEN legacy AR (handover ≤ onboard, unpaid at onboard)
    POOL_B:        '🔵 Pool B — Ongoing AR', // ongoing AR (handover > onboard)
    RUTE:          '🗺️ Rute Penagihan',      // Ade's field drive list: zona priority + nearest-neighbour route (Route.gs)
    THP_ADE:       '📊 KPI Matriks AR',      // AR Officer KPI + take-home pay + bonuses + penalty flags
    THP_SALES:     '📊 KPI Matriks Sales',   // Sales KPI + take-home pay
    THP_HISTORY:   '📈 Riwayat THP',         // monthly payroll/KPI archive per person (ThpHistory.gs, master-only)
    INVOICE_SALES: '🧾 Tagihan Sales',       // unpaid & overdue ≤14d (still with Sales, pre-handover) — Deden & Dian only
    COLLECTED:     '💰 Faktur Collected',    // rincian faktur per bulan uang masuk (Collected.gs, file Deden saja)
    TAGIHAN_LAIN:  '🧾 Tagihan Lain',         // pre-handover unpaid for everyone NOT in SALES_FILTER (Nathan/partner, POS, others)
    SUMMARY:       '📋 Ringkasan',           // overview
    RESTOCK:       '📦 Restock Engine',      // SKU tiering + reorder point + cash-capped PO (Restock.gs, master-only)
    HEALTH:        '📊 Business Health',     // strategic dashboard: AR aging, DSO, collection, trends (Health.gs, master-only)
    LOG:           '⚙️ Sync Log',
    TAGIHAN_ADE:   'Tagihan Ade'           // DEPRECATED → auto-deleted by fullSync (replaced by Pool A/B)
  },

  // One-time in-place rename map (old live tab name → CONFIG.TABS key). migrateTabNames()
  // renames existing sheets BEFORE writers run so Pool A/B keep Ade's 🟡 hand-filled columns
  // instead of spawning empty duplicates. Safe to leave in place — it no-ops once renamed.
  TAB_MIGRATION: [
    ['Pool A',         'POOL_A'],
    ['Pool B',         'POOL_B'],
    ['THP Ade',        'THP_ADE'],
    ['THP Sales',      'THP_SALES'],
    ['Invoice Sales',  'INVOICE_SALES'],
    ['Summary',        'SUMMARY'],
    ['Sync Log',       'LOG']
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// NAMA TAB DI FILE DEDEN (alias tampilan)
// ─────────────────────────────────────────────────────────────────────────────
// Nama tab di CONFIG.TABS ditulis dari sudut pandang operator AR ("Pool B — Ongoing AR",
// "KPI Matriks Sales", "THP"). Deden bukan orang AR — dia butuh nama yang langsung
// menjawab "isi tab ini apa buat gue". Peta ini cuma dipakai saat fullSync menulis ke
// FILE DEDEN (TAB_ALIAS di Sync.gs); master & file Ade tetap pakai nama aslinya, jadi
// dokumentasi, collectPoolYellow, dan kebiasaan Ade tidak terganggu.
//
// AMAN DIEDIT: ganti sisi kanan kapan saja. Sync berikutnya me-RENAME tab yang sudah ada
// di tempat (_applyTabAlias), bukan bikin tab baru. Kunci = nama master, jangan diubah.
var TABS_DEDEN = {};
TABS_DEDEN[CONFIG.TABS.SUMMARY]       = '📋 Ringkasan';            // tetap — sudah jelas
TABS_DEDEN[CONFIG.TABS.INVOICE_SALES] = '🧾 Tagihan Kamu';         // yang masih jadi tugas dia (H+0 s/d H+14)
TABS_DEDEN[CONFIG.TABS.POOL_B]        = '🔵 Faktur Ongoing AR';    // sudah lewat H+14, ditangani Ade, dia pantau
TABS_DEDEN[CONFIG.TABS.THP_SALES]     = '📊 KPI & Gaji Bulan Ini';
TABS_DEDEN[CONFIG.TABS.THP_HISTORY]   = '📈 Riwayat Gaji';
TABS_DEDEN[CONFIG.TABS.STOP_SUPPLY]   = '⛔ Customer Ditahan';       // customer kamu yang order barunya di-HOLD
// CONFIG.TABS.COLLECTED sengaja TIDAK di-alias — '💰 Faktur Collected' dipakai apa adanya.

// Migrasi nama yang sempat dipakai lalu diganti. _applyTabAlias me-rename tab lama ini di
// tempat, jadi tak ada tab yatim tertinggal di file Deden. Boleh dihapus setelah satu sync.
TABS_DEDEN['⏰ Lewat ke Ade'] = '🔵 Faktur Ongoing AR';
TABS_DEDEN['💰 Uang Masuk']   = CONFIG.TABS.COLLECTED;

// ─────────────────────────────────────────────────────────────────────────────
// MENU
// ─────────────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ROSH Accurate')
    .addItem('1. Authorize Accurate', 'authorize')
    .addItem('2. Run Full Sync now', 'fullSync')
    .addSeparator()
    .addItem('Install daily 5am trigger', 'installTrigger')
    .addItem('Remove triggers', 'removeTriggers')
    .addItem('Reset auth', 'logout')
    .addSeparator()
    .addItem('Setup Faktur folder', 'setupFakturFolder')
    .addItem('Generate Faktur PDFs (batch)', 'generateFakturPdfs')
    .addItem('Auto catch-up Faktur (sampai lengkap)', 'catchUpFakturPdfs')
    .addItem('Prune Faktur PDFs (hapus lunas)', 'pruneFakturPdfs')
    .addItem('Set Faktur web app URL', 'setFakturWebAppUrl')
    .addItem('Clear Faktur PDF cache', 'clearFakturCache')
    .addSeparator()
    .addItem('Hitung ulang Riwayat THP bulan lalu', 'restampPreviousMonthNow')
    .addItem('Refresh Restock (item + SKU sales)', 'refreshSkuSalesNow')
    .addItem('Refresh Kontak Customer', 'refreshKontakNow')
    .addItem('Rebuild Kontak cache (wipe + refetch)', 'rebuildKontakCacheNow')
    .addItem('Refresh Rapor Customer + Turun Buku', 'refreshCustomerNow')
    .addItem('Diag vendorPrice (cek sebelum buka margin)', 'diagVendorPrice')
    .addItem('Diag jual di bawah modal', 'diagBelowCost')
    .addItem('Diag kontak fields (WA/telp)', 'diagKontakFields')
    .addItem('Diag item fields', 'diagItemFields')
    .addItem('Diag purchase fields', 'diagPurchaseFields')
    .addItem('Diag cash/bank fields', 'diagCashBankFields')
    .addSeparator()
    .addItem('Setup role sheets (Ade/Deden)', 'setupRoleSheetsOnce')
    .addToUi();
}


// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME CREDENTIAL SETUP
// Run this ONCE from the editor, then DELETE the literal values below and re-save.
// Credentials are stored in Script Properties (not in the sheet, not in version history).
// ─────────────────────────────────────────────────────────────────────────────
function setupCredentials() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    CLIENT_ID:        'YOUR_CLIENT_ID',
    CLIENT_SECRET:    'YOUR_CLIENT_SECRET',
    APP_KEY:          'YOUR_APP_KEY',
    SIGNATURE_SECRET: 'YOUR_SIGNATURE_SECRET'
  }, false);
  Logger.log('Credentials stored in Script Properties. Now delete the literals above and re-save this file.');
}

function _props() { return PropertiesService.getScriptProperties(); }
function _cred(k) {
  const v = _props().getProperty(k);
  if (!v) throw new Error('Missing credential ' + k + '. Run setupCredentials() first.');
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH2  (uses apps-script-oauth2 library — add via Libraries: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF)
// ─────────────────────────────────────────────────────────────────────────────
function getAccurateService() {
  return OAuth2.createService('accurate')
    .setAuthorizationBaseUrl(CONFIG.ACCOUNT_BASE + '/oauth/authorize')
    .setTokenUrl(CONFIG.ACCOUNT_BASE + '/oauth/token')
    .setClientId(_cred('CLIENT_ID'))
    .setClientSecret(_cred('CLIENT_SECRET'))
    .setScope(CONFIG.OAUTH_SCOPE)
    // Force Accurate to show the consent screen again so a scope change (e.g. adding
    // customer_view) actually re-grants — otherwise it silently reissues the old scope.
    .setParam('prompt', 'consent')
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setCache(CacheService.getUserCache())
    // Accurate token endpoint expects HTTP Basic auth (base64 client_id:client_secret)
    .setTokenHeaders({
      'Authorization': 'Basic ' + Utilities.base64Encode(_cred('CLIENT_ID') + ':' + _cred('CLIENT_SECRET')),
      'Content-Type':  'application/x-www-form-urlencoded'
    });
}

function authorize() {
  const service = getAccurateService();
  if (service.hasAccess()) {
    SpreadsheetApp.getUi().alert('Already authorized. You can run Full Sync.');
    return;
  }
  const url = service.getAuthorizationUrl();
  const html = HtmlService.createHtmlOutput(
    '<p>Open this URL to authorize Accurate, then close this window:</p>' +
    '<p><a href="' + url + '" target="_blank">Authorize Accurate</a></p>'
  ).setWidth(420).setHeight(140);
  SpreadsheetApp.getUi().showModalDialog(html, 'Authorize Accurate');
}

function authCallback(request) {
  const service = getAccurateService();
  const ok = service.handleCallback(request);
  return HtmlService.createHtmlOutput(ok
    ? 'Success. You can close this tab and run Full Sync.'
    : 'Denied. Try again.');
}

function logout() {
  getAccurateService().reset();
  _clearSession(); // also drop the cached open-db session so re-auth gets a fresh one
  Logger.log('Auth reset.');
}

/** Force a clean re-consent: wipes the cached token + session, then opens the consent
 *  dialog regardless of hasAccess. Use after changing OAUTH_SCOPE so the new scope
 *  (customer_view) is actually granted. */
function forceReauthorize() {
  const service = getAccurateService();
  service.reset();
  _clearSession();
  const url = service.getAuthorizationUrl();
  Logger.log('Token cleared. Open this URL in a browser to re-consent (will request Customer access):\n' + url);
  try {
    const html = HtmlService.createHtmlOutput(
      '<p>Token lama sudah dihapus. Klik untuk consent ULANG (akan minta izin Customer), lalu tutup tab ini:</p>' +
      '<p><a href="' + url + '" target="_blank">Authorize Accurate (fresh)</a></p>'
    ).setWidth(460).setHeight(150);
    SpreadsheetApp.getUi().showModalDialog(html, 'Force Re-Authorize');
  } catch (e) {
    // No UI context (run from editor) — the URL above in the log is enough.
  }
}

/** Drop the cached open-db session (host + X-Session-ID). Forces a fresh open-db next call. */
function _clearSession() {
  CacheService.getUserCache().remove('ACC_SESSION');
}

/** DIAG — logs the exact OAuth consent URL + scope actually being requested.
 *  If 'customer_view' is missing from the logged scope, the deployed Code.gs is stale.
 *  If it IS present but the token still 403s, Accurate is reusing an old consent →
 *  revoke the app inside Accurate Online (connected apps) and Authorize again. */
function diagAuthUrl() {
  const svc = getAccurateService();
  Logger.log('Requested scope: ' + CONFIG.OAUTH_SCOPE);
  Logger.log('hasAccess (token cached?): ' + svc.hasAccess());
  Logger.log('Consent URL:\n' + svc.getAuthorizationUrl());
}

/** Redirect URI to register in your Accurate API app. */
function showRedirectUri() {
  const uri = 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback';
  Logger.log('Register this Redirect URI in Accurate Online at: ' + uri);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Build Authorization + optional extra headers for an Accurate API call. */
function _authHeaders(extra) {
  const token = getAccurateService().getAccessToken();
  if (!token) throw new Error('Not authorized. Run "1. Authorize Accurate" from the menu.');
  const h = { 'Authorization': 'Bearer ' + token };
  if (extra) {
    Object.keys(extra).forEach(function(k) { h[k] = extra[k]; });
  }
  return h;
}

/** Fetch wrapper: auto-follows HTTP 308 redirect (Accurate uses this), mutes
 *  HTTP exceptions, parses JSON, throws on 4xx/5xx. */
function _fetch(url, opts) {
  const options = Object.assign({ muteHttpExceptions: true }, opts || {});
  let resp = UrlFetchApp.fetch(url, options);

  // Follow redirects (Accurate returns 308 Permanent Redirect on host migration)
  let hops = 0;
  while ((resp.getResponseCode() === 308 || resp.getResponseCode() === 301 || resp.getResponseCode() === 302) && hops < 5) {
    const loc = (resp.getHeaders()['Location'] || resp.getHeaders()['location'] || '').trim();
    if (!loc) break;
    url  = loc;
    resp = UrlFetchApp.fetch(loc, options);
    hops++;
    continue;
  }

  const code = resp.getResponseCode();
  if (code >= 400) {
    throw new Error('HTTP ' + code + ': ' + resp.getContentText('UTF-8').slice(0, 300));
  }

  const text = resp.getContentText('UTF-8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Non-JSON response (HTTP ' + code + '): ' + text.slice(0, 200));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION  (db-list -> open-db) -- cached host + session id
// ─────────────────────────────────────────────────────────────────────────────
function _getSession() {
  const cache = CacheService.getUserCache();
  const cached = cache.get('ACC_SESSION');
  if (cached) return JSON.parse(cached);

  // 1) list databases available to this token
  const dbList = _fetch(CONFIG.ACCOUNT_BASE + '/api/db-list.do', {
    method: 'get', headers: _authHeaders()
  });
  const dbs = (dbList && dbList.d) || [];
  if (!dbs.length) throw new Error('No Accurate database found for this account.');

  // default: first DB. If you have multiple companies, set DB_ID in Script Properties.
  const wantId = _props().getProperty('DB_ID');
  const db = wantId ? dbs.find(function(x){ return String(x.id) === String(wantId); }) || dbs[0] : dbs[0];

  // 2) open-db -> returns the data host + session id
  const open = _fetch(CONFIG.ACCOUNT_BASE + '/api/open-db.do?id=' + db.id, {
    method: 'get', headers: _authHeaders()
  });
  const host = open.host.replace(/\/+$/, '');
  const session = open.session;

  const out = { host: host, session: session, dbId: db.id, dbName: db.alias || db.name };
  cache.put('ACC_SESSION', JSON.stringify(out), 600); // 10 min
  return out;
}

/** Authenticated call to a data-host endpoint (auto-injects X-Session-ID).
 *  Auto-recovers from a stale session ("Data Session Key tidak tepat" / 401): clears
 *  the cached open-db session and retries once with a fresh one. */
function accApi(path, params, method, _retried) {
  const s = _getSession();
  let url = s.host + path;
  if (params && method !== 'post') {
    const q = Object.keys(params).map(function(k){
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    if (q) url += (url.indexOf('?') >= 0 ? '&' : '?') + q;
  }
  const opts = {
    method: method || 'get',
    headers: _authHeaders({ 'X-Session-ID': s.session })
  };
  if (method === 'post' && params) {
    opts.payload = params;
  }
  try {
    return _fetch(url, opts);
  } catch (e) {
    // Recover ONCE from the two transient auth failures Accurate throws:
    //   • "Data Session Key tidak tepat" → stale open-db session → just reopen it.
    //   • HTTP 401 `invalid_token` → the OAuth access token was rejected (expired, or
    //     rotated out by a concurrent run). Clearing the session alone can't fix this —
    //     getAccessToken() would hand back the SAME dead cached token. Force a real OAuth
    //     refresh first, THEN reopen the session, then retry.
    if (!_retried && /Session Key|HTTP 401|invalid_token/i.test(e.message)) {
      if (/invalid_token|HTTP 401/i.test(e.message)) {
        try {
          getAccurateService().refresh();   // swap the dead access token for a fresh one
        } catch (re) {
          throw new Error('Token Accurate kedaluwarsa & gagal di-refresh — jalankan menu ' +
            '"1. Authorize Accurate" sekali lagi untuk consent ulang. (' + re.message + ')');
        }
      }
      _clearSession();
      return accApi(path, params, method, true);
    }
    throw e;
  }
}
