# Restock Engine — Metodologi, Trade-off & Rating

*Dokumentasi cara kerja perhitungan stok di tab `📦 Restock Engine`. Dibuat 2026-06-07 (algoritma v2).
Tujuan: supaya keputusan restock bisa diaudit, dikalibrasi, dan tidak jadi black-box saat ROSH tumbuh.*

---

## 1. Kenapa ini ada

Sebelum ini, order restock berbasis "feeling". Tiga risiko: **overorder** (cash mati di gudang),
**overspend** (beli yang salah duluan saat modal terbatas), **kurang order** (stockout → kehilangan
omzet + customer kabur), semuanya diperparah **supply acak** (pabrik telat random ~1–2 minggu).

Prinsip desain: pisahkan satu pertanyaan besar "beli apa?" jadi tiga pertanyaan kecil yang masing-masing
punya jawaban berbasis data:

1. **SKU mana yang penting?** → *Tier*
2. **Kapan harus order & berapa?** → *Reorder point (s, S)*
3. **Modal terbatas, dahulukan yang mana?** → *Cash cap (Revenue-at-Risk)*

Semua angka ditarik otomatis dari Accurate (penjualan, stok, harga beli, PO jalan). Tidak ada input
manual → tidak ada celah lupa update. Semua konstanta tunable di `CONFIG.RESTOCK` (Code.gs).

---

## 2. Cara kerja (the math)

### Layer 1 — Tier (seberapa penting SKU)

Dua sinyal, digabung jadi skor 1–5, lalu dipetakan ke A/B/C/D:

| Sinyal | Bobot | Kenapa |
|---|---|---|
| **Sales velocity** (CTN/bulan, window 6 bln) | 60% | Volume = nyawa omzet |
| **Customer penetration** (jumlah customer unik beli SKU itu) | 40% | SKU yang dibeli banyak customer = kalau kosong, banyak hubungan rusak, bukan cuma 1 transaksi |

**Banding = percentile (self-calibrating).** Skor bukan dari ambang tetap (">500 CTN = 5"), tapi dari
**peringkat relatif terhadap katalog ROSH sendiri**: top 20% velocity → skor 5, 20% berikutnya → 4, dst.
Artinya tier selalu membedakan SKU **berapa pun skala bisnismu** — penting karena ROSH tumbuh pelan dan
ambang absolut akan cepat basi.

`skor = 0.6 × velocityScore + 0.4 × penetrationScore` → Tier **A** ≥4.5 · **B** ≥3.5 · **C** ≥2.5 · **D** sisanya.

Tier menentukan *seberapa agresif kita jaga stok*: A boleh tebal (jangan sampai kosong), D tipis.

### Layer 2 — Reorder point (kapan & berapa), model (s, S) statistik

**Demand harian `d` — "demand konsisten" (winsorized + growth).** Tujuan: baca demand yang **rutin**, bukan
ke-trigger lonjakan dari pembeli sekali-beli (one-time hit). Tiga langkah:
1. **Winsorize** — tiap pesanan di-cap ke persentil ke-90 ukuran pesanan SKU itu. Satu order jumbo dari
   pembeli one-time ke-trim ke level normal; kalau SKU memang sering batch besar, persentil-nya tinggi →
   cap longgar (otomatis adaptif, bukan ambang tetap).
2. **Rata-rata harian** winsorized atas hari aktif (12 minggu terakhir; SKU baru dibagi hari sejak jual pertama).
3. **Proyeksi growth** — bandingkan rate 4 minggu terakhir vs sebelumnya; kalau naik, `d` dinaikkan
   (faktor **cuma ke atas**, plafon **+25%**) → nangkep tren tumbuh tanpa over-extrapolate. Tren turun
   TIDAK menurunkan `d` (konservatif, jaga service). SKU yang tumbuh ditandai **sel hijau** di kolom Demand/bln.

> **Kenapa bukan EWMA / rata-rata polos:** EWMA (versi awal) overreact ke batch terakhir → satu order besar
> bikin `d` melonjak ~6× → over-order parah (OTG60 sempat Target 575 CTN utk SKU ~48/bln). Rata-rata polos
> stabil tapi nggak mbedain order rutin vs one-time hit. Winsorize + growth = baca **baseline rutin + arah tren**,
> dan tetap **fail-safe** saat harvest belum lengkap (cenderung under, bukan over).
> *Keterbatasan:* belum pakai analisis repeat-customer eksplisit (Croston dll) — winsorize adalah proxy
> ukuran-pesanan, bukan frekuensi-pelanggan. Cukup untuk skala ROSH; bisa ditingkatkan nanti.

**Safety stock `SS` — statistik.** Inilah peredam "supply acak":

```
SS  = Z[tier] × σ_LT
σ_LT = √( leadTime × σ_harian²  +  d² × σ_leadtime² )
```

- `σ_harian` = deviasi demand harian (dari volatilitas penjualan nyata SKU itu).
- `σ_leadtime` = `leadTime × LT_CV` (LT_CV 0.3 → lead time 14 hari bisa meleset ±~4 hari). Ini yang
  menangkap **ketidakpastian kedatangan barang**.
- `Z[tier]` = service level: **A 97,5% · B 95% · C 90% · D 85%**. SKU penting dijaga lebih ketat.

Makin naik-turun demand-nya, atau makin random supply-nya → buffer otomatis makin tebal. SKU yang
demand-nya stabil dapat buffer tipis. Tidak ada lagi "safety days" yang asal pukul rata.

> **Penting (fix 2026-06-07):** demand B2B itu *lumpy* — pelanggan nge-batch (minggu ini 0, minggu
> depan borong banyak). Tanpa pengaman, pola batch ini kebaca sebagai "demand super tidak stabil" → σ
> meledak (CV bisa 15–20×) → safety stock jadi ratusan CTN → target 10–12 bulan stok → over-order.
> Karena itu σ **dibatasi**: lantai `MIN_CV` 0,25 dan **plafon `MAX_CV` 1,25** (σ ≤ 1,25 × demand).

**Reorder point & order-up-to:**

```
ROP = d × leadTime + SS                 ← stok di titik ini = saatnya order
S   = ROP + d × cycle[tier]             ← order sampai level ini (cycle LEAN: A14/B10/C7/D5 hari)
S   = min(S, MAX_COVER_DAYS[tier] × d)  ← PLAFON keras (A35/B28/C21/D18 hari) — posture tipis ~2–3 mgg
```

> **Posture (2026-06-07):** karena lead time cuma 1–2 minggu, target dibikin **tipis** (cycle pendek +
> plafon ~3–5 minggu peak, rata-rata ~2–3 minggu stok). Hemat cash & sering order kecil; safety stock
> (Z×σ) tetap jaga saat pabrik ngadat. Tunable di `CYCLE_DAYS` / `MAX_COVER_DAYS`.

Lead time diambil **per item** dari Accurate (`deliveryLeadTime`), fallback 14 hari kalau kosong.

**Inventory position (anti double-order):**

```
IP = stok (availableToSell) + on-order PO
```

Keputusan:

| Kondisi | Status | Aksi |
|---|---|---|
| IP ≤ ROP | 🔴 Order Sekarang | order `S − IP` CTN |
| IP ≤ ROP × 1,2 | 🟡 Mendekati | siap-siap |
| IP > ROP × 1,2 | 🟢 Aman | diam |

Karena pakai **IP (sudah termasuk barang yang lagi di-PO)**, SKU yang sudah dipesan tidak akan disuruh
beli lagi.

### Layer 3 — Cash cap (prioritas saat modal terbatas)

Untuk tiap SKU dihitung **Revenue-at-Risk** = `omzet SKU ÷ total omzet`. Lalu SKU yang 🔴 di-rank by
**RaR ÷ harga beli** (bang-for-buck: omzet terlindungi per rupiah modal), dan dialokasi dari atas sampai
budget habis → sisanya ditandai `TUNDA`. Budget kosong = tampilkan semua, urut RaR.

**Sumber budget:** Script Property `PO_BUDGET` (manual) menang; kalau kosong → **otomatis = saldo akun Bank
Jago − `OPEX_BUFFER` (30jt)** (saldo ditarik dari Accurate `glaccount/list.do`, akun namanya cocok
`BANK_MATCH`); kalau dua-duanya kosong → **default `PO_BUDGET_DEFAULT` 100jt**. Buffer opex disisihkan supaya
cash buat gaji/operasional aman. Catch-up besar otomatis kecicil antar bulan ngikut cash, bukan sekali tembak.

### Contoh nyata (SKU OT750, ilustrasi)

```
demand harian d        = 10 CTN/hari      (EWMA 12 minggu)
σ harian               ≈ 9,5 CTN
lead time              = 14 hari, LT_CV 0,3 → σ_leadtime ≈ 4,2 hari
σ_LT                   = √(14×9,5² + 10²×4,2²) ≈ 55 CTN
Tier A → Z 1,96        → SS ≈ 108 CTN
ROP                    = 10×14 + 108 = 248 CTN
S (cycle A 45 hr)      = 248 + 10×45 = 698 CTN
stok 120, on-order 0   → IP 120 ≤ ROP 248 → 🔴 ORDER 698 − 120 = 578 CTN
est. biaya             = 578 × harga beli
```

---

## 3. Data & asumsi

| Hal | Sumber | Asumsi / catatan |
|---|---|---|
| Penjualan per SKU | `sales-invoice/detail.do` (cache `_SkuSalesCache`) | window tier 6 bln, sizing 12 minggu |
| Stok on-hand | `item/list.do` → `availableToSell` | sudah dikurangi SO yang sudah masuk; **belum** termasuk PO masuk → makanya ditambah on-order |
| Harga beli | `item/list.do` → `vendorPrice` | dipakai untuk est. biaya & ranking cash |
| Lead time | `item/list.do` → `deliveryLeadTime` | sering 0 (belum diisi) → fallback 14 hari |
| On-order | `purchase-order/detail.do` | PO yang belum "selesai/penuh" (`remainingQuantity`) |
| Saldo bank (budget) | `glaccount/list.do` (akun ~`BANK_MATCH`) | PO_BUDGET auto = 50% saldo, kalau manual kosong |
| Satuan | Accurate | diasumsikan **CTN** konsisten (sudah dicek) |

Asumsi statistik: demand mendekati normal (cukup untuk barang fast-moving; untuk SKU lumpy/jarang,
σ di-floor + service level jadi konservatif).

---

## 4. Pros

- **Berbasis data, bukan feeling** — tiap angka bisa ditelusuri ke transaksi Accurate.
- **Self-calibrating (percentile)** — tidak perlu re-tuning ambang tiap volume naik; cocok untuk bisnis
  yang tumbuh pelan.
- **Reaktif ke tren (EWMA)** — SKU naik daun ke-detect lebih cepat daripada rata-rata datar.
- **Buffer pintar (Z×σ)** — stok pengaman menyesuaikan volatilitas nyata + ketidakpastian supply, bukan
  pukul rata. Langsung menyerang pain "supply acak".
- **Anti double-order** — inventory position memperhitungkan PO yang sudah jalan.
- **Disiplin cash** — saat modal terbatas, modal mengalir ke SKU dengan omzet-terlindungi-per-rupiah
  tertinggi, bukan ke yang teriak paling keras.
- **Zero maintenance harian** — jalan tiap sync, tidak ada input manual.
- **Fully tunable** — semua parameter di `CONFIG.RESTOCK`, gampang dikalibrasi sambil belajar.

---

## 5. Cons / keterbatasan

- **Garbage in, garbage out.** Kalau stok di Accurate tidak akurat (selisih fisik vs sistem), semua
  rekomendasi salah. Ini risiko #1 — lihat moral hazard.
- **Tidak ada MOQ / kelipatan PO.** Saran order belum dibulatkan ke minimum order / pallet supplier.
- **Lead time sering tebakan.** Kalau `deliveryLeadTime` di Accurate kosong, semua pakai 14 hari — padahal
  supplier beda-beda.
- **Tidak musiman.** EWMA nangkep tren, tapi belum nangkep pola musiman (mis. lonjakan Lebaran) sampai
  lonjakannya mulai kejadian.
- **Asumsi normal lemah untuk SKU jarang/lumpy.** Barang yang lakunya nge-batch bikin σ kurang andal
  (cenderung overstate). Ditambal dengan **bound CV (MIN_CV 0,25–MAX_CV 1,25)** + **plafon hari-stok
  (MAX_COVER_DAYS)**, bukan metode intermittent khusus (Croston) — cukup untuk skala ROSH, belum optimal.
- **Lebih kompleks = lebih susah dijelaskan.** Versi awal (coverage-days flat) gampang dipahami siapa saja;
  versi statistik butuh sedikit literasi. Transparansi turun.
- **On-order PO sudah akurat per-baris** (terkonfirmasi: `percentShipped` untuk filter PO jalan +
  `remainingQuantity` per line yang sudah hitung partial receipt). Bukan lagi keterbatasan.

---

## 6. Moral hazard & cara sistem bisa menyesatkan

*Bagian terpenting untuk dibaca berulang. Sistem yang kelihatan "pintar" justru berbahaya kalau dipercaya
buta.*

1. **Autopilot trap.** Angka yang rapi memancing orang berhenti berpikir. Engine ini **decision-support,
   bukan decision-maker.** Saran order tetap harus lewat akal sehat manusia (info pasar, rumor harga bahan,
   promo, dll) yang tidak ada di data.
2. **Akurasi stok = fondasi.** Kalau ops/partner malas update stok atau ada barang hilang/selisih,
   engine "yakin" padahal salah. Moral hazard: orang menyalahkan "sistemnya ngaco" padahal input-nya yang
   bolong. **Stock opname rutin wajib** — engine tidak bisa menggantikannya.
3. **Gaming angka.** Siapa pun yang bisa edit Accurate (stok, harga beli, status PO) bisa — sengaja atau
   tidak — menggeser rekomendasi. Mis. `vendorPrice` digelembungkan → SKU itu turun prioritas beli. Perlu
   kontrol akses + sesekali cross-check.
4. **Percentile menyembunyikan masalah absolut.** Karena tier relatif, **akan selalu ada SKU "Tier A"
   walaupun semua SKU sebenarnya jualannya lesu.** Tier menjawab "mana yang relatif penting", bukan "apakah
   bisnis lagi sehat". Jangan pakai tier untuk menilai kesehatan absolut — itu tugas Business Health.
5. **EWMA bisa overreact ke noise.** Satu minggu lonjakan (mis. 1 customer borong) bisa mengangkat demand
   sesaat → over-order. α=0.4 sudah meredam, tapi waspadai SKU yang barusan ada pesanan jumbo sekali.
6. **Safety stock besar terasa "aman" tapi mahal.** Service level tinggi (Tier A 97,5%) artinya sengaja
   numpuk buffer. Itu cash mati. Trade-off ini eksplisit di `SERVICE_Z` — jangan diam-diam naikkan semua ke
   99% "biar aman", itu menghukum cashflow.
7. **Anchoring.** Begitu lihat "ORDER 578 CTN", otak nempel ke angka itu. Perlakukan sebagai titik awal
   negosiasi dengan realita, bukan vonis.
8. **Lead time optimistis → telat sistemik.** Kalau 14 hari ternyata realnya 21, ROP selalu kependekan dan
   sering telat. Begitu punya data PO historis, **kalibrasi lead time** — jangan biarkan default.
9. **Winsorize bisa "menyembunyikan" demand asli.** Kalau satu pelanggan besar memang rutin pesan jumbo
   (bukan one-time), winsorize akan meng-underestimate dia → bisa kurang order untuk pelanggan kunci itu.
   Cross-check SKU bersel-hijau / yang punya 1 pembeli dominan secara manual.
10. **Growth projection = ekstrapolasi.** Proyeksi naik (maks +25%) menebak masa depan dari 4 minggu
   terakhir. Lonjakan sesaat (musiman/promo) bisa kebaca sebagai "growth" → over-order. Plafon +25%
   meredam, tapi tetap: sel hijau itu **sinyal buat dicek**, bukan kebenaran.
11. **PO_BUDGET auto dari saldo bank = pisau bermata dua.** Saldo bank naik (mis. abis nagih AR) → budget
   ikut naik → bisa kebablasan belanja padahal uang itu buat opex. PO_BUDGET_PCT 50% meredam; tetap pantau,
   atau set PO_BUDGET manual saat bulan berat.

---

## 7. Implikasi saat ROSH tumbuh pelan tiap bulan

Ini dirancang untuk pertumbuhan bertahap, dan beberapa sifatnya justru makin bagus seiring waktu:

- **Percentile auto-adapt.** Volume naik 2x setahun? Tier nggak perlu disetel ulang — peringkat relatif
  jalan terus. Inilah alasan utama pilih percentile, bukan absolut.
- **EWMA nangkep tren naik.** Bulan-bulan pertumbuhan langsung terbaca sebagai demand naik → ROP & order
  ikut naik otomatis, tidak ketinggalan.
- **Data history makin kaya → σ makin akurat.** Makin lama jalan, estimasi volatilitas makin andal, safety
  stock makin presisi (tidak over/under). Sistem ini "matang" seiring waktu.
- **SKU baru tertangani** (normalisasi first-sale) — penting karena katalog kemungkinan nambah saat tumbuh.

**Yang HARUS dipantau manual saat tumbuh** (engine tidak otomatis kasih tahu):

- **Kapan tambah modal / gudang.** Tier relatif tidak teriak saat *semua* SKU naik. Pantau **total saran
  belanja vs PO_BUDGET** dan **DSO/aging di Business Health** untuk sinyal "saatnya naik kelas".
- **Naikkan `PO_BUDGET`** seiring cashflow tumbuh — kalau dibiarkan kecil, makin banyak SKU `TUNDA` palsu.
- **Kalibrasi `LEAD_TIME` & `deliveryLeadTime`** begitu ada data PO nyata.
- **Tinjau ulang parameter tiap kuartal** (`SERVICE_Z`, `CYCLE_DAYS`, `EWMA_ALPHA`) — angka default ini
  tebakan awal yang masuk akal, bukan kebenaran.

---

## 8. Panduan tuning — gejala → knob

Semua angka hidup di `CONFIG.RESTOCK` (Code.gs). **Aturan emas: ubah SATU knob, ±20–30%, amati 1–2
minggu, baru lanjut.** Jangan geser banyak sekaligus — nanti nggak tahu mana yang ngefek.

| Gejala yang kamu lihat | Knob | Arah | Efek |
|---|---|---|---|
| Order kebanyakan / cash kebakar | `CYCLE_DAYS`, `MAX_COVER_DAYS` | ↓ turunin | target stok lebih tipis |
| Cash mau dijaga lebih ketat | `SERVICE_Z` | ↓ turunin | safety stock turun (risiko stockout naik) |
| Sisihan opex kurang | `OPEX_BUFFER` | ↑ naikin | budget restock dari saldo bank mengecil |
| Sering kehabisan / stockout | `SERVICE_Z` (tier ybs) | ↑ naikin | safety stock naik (A 1.96→2.33 = 98→99%) |
| Pabrik nyatanya lebih lama dari 14 hr | `LEAD_TIME` | ↑ naikin | ROP naik, order lebih awal |
| Supply makin random / tak terduga | `LT_CV` | ↑ naikin | safety stock nyerap variasi kedatangan |
| Order kekecilan, kesering-seringan PO | `CYCLE_DAYS` | ↑ naikin | order lebih jarang tapi lebih besar |
| Safety stock numpuk (ROP ketinggian) | `MAX_CV` | ↓ turunin | σ dibatasi lebih ketat |
| Demand 1 SKU kegedean gara² 1 borongan | `WINSOR_PCT` | ↓ (mis 0.80) | trim one-time hit lebih agresif |
| Demand kerasa under / SKU besar diabaikan | `WINSOR_PCT` → 1.0 | ↑ | matikan trim (cek dulu harvest "✓ lengkap") |
| SKU naik daun di-over-order | `GROWTH_CAP` → 1.0 | ↓ | matikan proyeksi growth |
| Tier numpuk di C/D atau semua A | `TIER_CUTOFFS` / `WEIGHT_*` | sesuaikan | geser ambang / bobot velocity vs penetrasi |
| Budget kecepetan habis (TUNDA banyak) | `PO_BUDGET` / `PO_BUDGET_DEFAULT` | ↑ naikin | lebih banyak SKU jadi BELI |
| Mau lihat SKU disetop/tanpa-demand lagi | `HIDE_INACTIVE` → false | — | tampilkan baris ⚪ |

**Service level → Z** (buat `SERVICE_Z`): 85%→1.04 · 90%→1.28 · 95%→1.65 · 97.5%→1.96 · 99%→2.33.
Makin tinggi = makin jarang stockout tapi makin banyak stok nganggur.

---

## 9. Audit asumsi & validasi

Setiap angka bersandar pada asumsi. Ini ledger-nya + cara ngecek masih valid:

| Asumsi | Status | Cara validasi |
|---|---|---|
| Stok Accurate = stok fisik | ⚠ **KRITIS** | **Stock opname** rutin; bandingin `availableToSell` vs hitungan gudang. GIGO. |
| Lead time 14 hr (±30%) | ⚠ **tebakan** | Catat tgl PO → tgl barang datang utk 5–10 PO; rata-rata → set `LEAD_TIME`, sebaran → `LT_CV`. (`deliveryLeadTime` Accurate sering 0.) |
| `vendorPrice` = harga beli terkini | sedang | Spot-check vs faktur beli terakhir; update di Accurate kalau naik |
| Demand ~ normal (utk Z×σ) | lemah utk SKU lumpy | Sudah ditambal bound CV; SKU yang lakunya jarang cek manual |
| One-time hit = pesanan abnormal besar | proxy | Winsorize berbasis *ukuran pesanan* — **nggak** nangkep pelanggan churn yang beli normal sekali lalu hilang |
| Window 12 mgg mewakili demand kini | sedang | Cocokin "Demand/bln" vs feeling; perhatikan sel hijau (growth) |
| On-order = `remainingQuantity` PO open | ✓ confirmed | sudah diverifikasi via diag PO |
| Satuan CTN konsisten | ✓ confirmed | sudah dicek |

**Playbook validasi bulanan (checklist):**
1. **Stock opname** 2–3 SKU tier A → cocokin dengan kolom Stok. Kalau meleset → akar masalah di Accurate, bukan engine.
2. **Realisasi lead time**: catat PO terakhir, kalau meleset >3 hari dari 14 → update `LEAD_TIME`.
3. **Stockout bulan lalu**: ada SKU yang sempat kosong & rugi? Naikin `SERVICE_Z` tier itu.
4. **Dead stock**: SKU 🟢 dengan Hari Cover >90 → kemungkinan overstock → turunin coverage / cek tier.
5. **Total saran vs PO_BUDGET**: kalau berbulan-bulan kebutuhan > budget, itu sinyal **naikin modal**, bukan ngecilin order.

**Catatan jujur (titik rapuh terbesar):** (a) akurasi stok Accurate — tanpa opname, semua salah; (b) lead
time masih default 14, belum dikalibrasi data nyata; (c) demand lumpy + winsorize adalah pendekatan, bukan
forecasting penuh. Engine ini **alat bantu keputusan**, angkanya titik-awal yang harus diadu sama akal sehat.

---

## 10. Rating

| Dimensi | Nilai | Catatan |
|---|---|---|
| Akurasi demand (recency) | ★★★★☆ | Winsorized + growth, robust thd one-time hit; belum musiman |
| Penanganan supply acak | ★★★★☆ | Z×σ + LT_CV langsung ke pain; perlu data lead time nyata |
| Skalabilitas (growth) | ★★★★★ | Percentile + winsorize + σ makin matang seiring tumbuh |
| Disiplin cash | ★★★★☆ | RaR/biaya + buffer opex bagus; belum ada MOQ |
| Anti double-order | ★★★★☆ | On-order PO masuk; tergantung field PO Accurate |
| Ketahanan thd data kotor | ★★☆☆☆ | **Titik lemah** — bergantung total pada akurasi stok Accurate |
| Transparansi / mudah dijelaskan | ★★★☆☆ | Lebih kuat tapi lebih kompleks dari v1 |

**Overall: ★★★★☆ (4/5).** Decision-support yang kuat dan tumbuh dewasa bersama bisnis — *bukan* autopilot.
Nilainya akan naik ke 4,5–5 begitu (a) stock opname rutin memastikan input bersih, (b) lead time
dikalibrasi dari data nyata, dan (c) MOQ + musiman ditambahkan. Risiko terbesar bukan di matematikanya,
tapi di **kualitas data + godaan mempercayainya buta**.

---

## 11. Roadmap upgrade (kalau mau naik kelas)

1. **MOQ / kelipatan order** per SKU (bulatkan saran ke minimum supplier).
2. **Lead time nyata per supplier** dari riwayat PO (ganti default 14).
3. **Faktor musiman** (uplift bulan-bulan ramai).
4. **Margin-at-Risk** (bukan revenue) untuk ranking cash — lebih akurat ke profit.
5. **Metode intermittent demand** (Croston) untuk SKU yang lakunya jarang.
6. **Alert "naik kelas"** — auto-flag kalau total kebutuhan order konsisten > PO_BUDGET berbulan-bulan.

*Semua parameter hidup di `CONFIG.RESTOCK` (Code.gs). Kalibrasi, jangan percaya buta.*
