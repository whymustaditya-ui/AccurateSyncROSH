/**
 * ROSH × Accurate — 🧭 Rapor Customer.
 *
 * Menjawab pertanyaan yang belum pernah bisa dijawab sheet ini: "customer ini boleh dikasih
 * order baru atau tidak, dan berapa banyak". Tab lain cuma bisa bilang siapa yang NUNGGAK.
 *
 * Dua sumbu:
 *   1. SKOR BAYAR 0..100 (makin tinggi makin baik, searah skor lain di repo) dari SELURUH
 *      riwayat pembayaran. Perilaku lama luruh (half-life 180 hari) supaya customer yang sudah
 *      memperbaiki diri tidak dihukum selamanya.
 *   2. NILAI EKONOMI = margin kotor dikurangi BIAYA MODAL piutang. Ini yang membongkar pola
 *      "omzet besar margin tipis": kalau dia bayarnya lambat, biaya modal memakan habis
 *      marginnya. (Fase 3 — aktif hanya kalau CONFIG.CUSTOMER.MARGIN_ENABLED true.)
 *
 * Proyeksi MURNI: nol call Accurate, nol scope baru. Sisi bayar dari `inv.receipts` (dipasang
 * ke SETIAP faktur oleh enrichReceipts), sisi margin dari _SkuSalesCache × _ItemCache milik
 * Restock. Semua keluaran = SARAN; OAuth read-only, Nathan yang menerapkan di Accurate.
 *
 * MASTER-ONLY. Tab ini membawa margin turunan vendorPrice — jangan pernah ditambahkan ke blok
 * writer Ade atau Deden, dan jangan masuk TABS_DEDEN. Sisi bayar + limit-nya diproyeksikan ke
 * 🚦 Status Customer (Status.gs) untuk sales, tanpa margin.
 *
 * Depends: Sync.gs (_custKey, num, stripTime, DAY_MS, parseAccDate), Kpi.gs (rupiah, clamp),
 * Style.gs (UI helpers), Restock.gs (_loadSkuSalesCache, _loadItemCache, _mblock).
 */

// 17 kolom sejak 2026-09-05 (dulu 26). Yang dibuang: Risiko (sudah tersirat warna Skor), Lewat H+15,
// Cakupan Data, Omzet Tercakup, Margin Kotor Rp, Biaya Modal, Margin Bersih Rp, Potensi Gagal Bayar
// (angka buku ada di Turun Buku), Jatah Plafon (alokasi plafon dicabut), Saran Tempo (selalu 14/0).
// Aturan: satu kolom = satu keputusan yang bisa diambil dari membacanya. Angka antara → RINGKAS/diag.
var CUST_HEADERS = [
  'Customer', 'Sales', 'Loyalitas (4bln)', 'Keputusan', 'Skor Bayar', 'Rata2 Telat (hari)',
  'Nunggak Sekarang', 'Telat Terlama (hari)', 'Belanja / bln', 'Order Rata2 (median)',
  'Margin Kotor %', 'Margin Bersih %', 'Saran Naik Harga', 'Saran Limit', 'Alasan',
  'Limit Disetujui', 'Catatan Nathan'
];
var CUST_SPAN     = CUST_HEADERS.length;   // 17
var CUST_COL      = {};                    // nama header → nomor kolom (1-based)
CUST_HEADERS.forEach(function(h, i) { CUST_COL[h] = i + 1; });
var CUST_COL_YEL1 = CUST_COL['Limit Disetujui'];
var CUST_COL_YEL2 = CUST_COL['Catatan Nathan'];
var CUST_NO_MARGIN = 'belum bisa dihitung';

// Urutan tampil: yang paling butuh keputusan di atas.
var CUST_VERDICT_RANK = {
  '🔴 STOP-COD': 1, '🟠 NAIKKAN HARGA': 2, '🟡 GAS TERBATAS': 3, '🟢 GAS': 4,
  '🆕 BARU': 5, '💵 TUNAI': 6, '⚪ BELUM DINILAI': 7, '😴 DORMAN': 8
};

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIF
// ─────────────────────────────────────────────────────────────────────────────

// Bobot recency: 1.0 hari ini, 0.5 setelah satu half-life. Perilaku lama LUNTUR.
function _decayW(ageDays, halfLifeDays) {
  return Math.pow(0.5, Math.max(0, ageDays) / Math.max(1, halfLifeDays));
}

// Skor 100..0 dari "hari telat". Bertingkat, bukan lulus/gagal: telat 1 hari tidak boleh
// disamakan dengan telat 60 hari.
function _lateScore(days, zeroAt, grace) {
  if (days == null || isNaN(days)) return 100;
  if (days <= grace)  return 100;
  if (days >= zeroAt) return 0;
  return 100 * (1 - (days - grace) / (zeroAt - grace));
}

// Probability of default per umur tunggakan → dipakai untuk cadangan risiko.
function _pdOf(dpd) {
  const P = CONFIG.CUSTOMER.PD;
  if (dpd == null || dpd <= 0) return P.LANCAR;
  if (dpd <= 30)  return P.D30;
  if (dpd <= 60)  return P.D60;
  if (dpd <= 90)  return P.D90;
  if (dpd <= 180) return P.D180;
  return P.D180PLUS;
}

// Tempo yang PALING SERING dipakai customer ini (modus (dueDate − transDate) dalam hari).
// Dipakai untuk mendeteksi kelas TUNAI dan sebagai plafon "hanya boleh memperketat".
function _custTempoModus(invs) {
  const tally = {};
  let best = null, bestN = 0;
  invs.forEach(function(i) {
    if (!i.dueDate || !i.transDate) return;
    const d = Math.round((i.dueDate - i.transDate) / DAY_MS);
    if (d < 0) return;
    tally[d] = (tally[d] || 0) + 1;
    if (tally[d] > bestN) { bestN = tally[d]; best = d; }
  });
  return best;
}

function _monthsBack(today, n) {
  return new Date(today.getFullYear(), today.getMonth() - n, today.getDate());
}

// Item NON-DAGANGAN (Pembelian Aset / Jasa Pengiriman / Inventaris) — bukan barang beli-jual,
// jadi tak punya harga pokok yang sebanding. Dikeluarkan dari DUA sisi perhitungan margin.
// Tanpa ini mereka kena imputasi rasio HPP buku (~84%), yang jelas salah untuk ongkos kirim.
function _isNonInventory(itemNo, itemName) {
  const C = CONFIG.CUSTOMER;
  const code = String(itemNo || '');
  if ((C.NON_INVENTORY_CODES || []).indexOf(code) >= 0) return true;
  return C.NON_INVENTORY_RE ? C.NON_INVENTORY_RE.test(String(itemName || '')) : false;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUPING — satu baris per customer.
// ─────────────────────────────────────────────────────────────────────────────
function _custGroupInvoices(invoices) {
  const map = {};
  invoices.forEach(function(i) {
    const name = String(i.customer || '').trim();
    if (!name) return;
    const k = _custKey(i);
    let g = map[k];
    if (!g) g = map[k] = { key: k, name: name, salesman: '', tierText: '', noTlp: '',
                           customerId: i.customerId || null, invs: [] };
    g.invs.push(i);
    if (i.custTierText) g.tierText = i.custTierText;
    if (!g.noTlp && i.noTlp) g.noTlp = i.noTlp;
    // Salesman diambil dari faktur TERBARU yang punya salesman — bukan yang tertua, karena
    // pemegang akun bisa berpindah dan yang relevan adalah siapa yang memegang sekarang.
    if (i.salesman) {
      if (!g._salesDate || (i.transDate && i.transDate > g._salesDate)) {
        g.salesman = i.salesman; g._salesDate = i.transDate;
      }
    }
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SISI BAYAR — empat komponen + eksposur + kelas khusus.
//
// Observasi dibentuk dari tiga sumber, dan ketiganya WAJIB:
//   a. tiap receipt        → kapan uang benar-benar masuk
//   b. residual PPh        → sisa (total − Σreceipts) di faktur yang statusnya sudah Lunas.
//      Amount receipt sudah dipotong PPh, jadi tanpa ini faktur ber-PPh sistematis kurang bobot.
//   c. faktur masih terbuka → keadaan HARI INI. Tanpa ini, orang yang sedang macet Rp80jt bisa
//      sembunyi di balik riwayat bersih bertahun-tahun.
// ─────────────────────────────────────────────────────────────────────────────
function _custPaymentStats(g, today) {
  const C = CONFIG.CUSTOMER;
  const invs = g.invs;

  let wSum = 0, wLateScore = 0, wLateDays = 0, wH15 = 0;   // tertimbang, SEMUA observasi
  let pSum = 0, pLateDays = 0;                              // tertimbang, observasi PEMBAYARAN saja
  let nPaid = 0;                                            // faktur yang pernah menerima pembayaran
  let outstanding = 0, overdueRp = 0, maxOpenDpd = null, cadangan = 0;
  let lastTrans = null, belanjaWin = 0, invCount = 0;
  let allCod = true, hasTempoInfo = false;
  const orderVals = [];                                     // nilai tiap faktur di window → median

  const winStart = _monthsBack(today, C.LIMIT_WINDOW_MONTHS);

  invs.forEach(function(i) {
    invCount++;
    if (i.transDate) {
      if (!lastTrans || i.transDate > lastTrans) lastTrans = i.transDate;
      if (i.transDate >= winStart) { belanjaWin += i.total; if (i.total > 0) orderVals.push(i.total); }
    }
    // Deteksi kelas TUNAI: SEMUA faktur bertempo ≤ COD_TEMPO_MAX hari.
    if (i.dueDate && i.transDate) {
      hasTempoInfo = true;
      if (Math.round((i.dueDate - i.transDate) / DAY_MS) > C.COD_TEMPO_MAX) allCod = false;
    }

    const receipts = i.receipts || [];
    let sumR = 0;

    // (a) observasi per pembayaran
    receipts.forEach(function(r) {
      if (!r.date || !(r.amount > 0)) return;
      sumR += r.amount;
      if (!i.dueDate) return;
      const late = Math.floor((r.date - i.dueDate) / DAY_MS);
      const w = r.amount * _decayW((today - r.date) / DAY_MS, C.HALF_LIFE_DAYS);
      wSum += w;
      wLateScore += w * _lateScore(late, C.LATE_ZERO_DAYS, C.GRACE_DAYS);
      wLateDays  += w * Math.max(0, late);
      if (late > CONFIG.HANDOVER_OFFSET_DAYS) wH15 += w;
      pSum += w; pLateDays += w * Math.max(0, late);
    });
    if (receipts.length) nPaid++;

    // (b) residual PPh pada faktur yang sudah lunas
    if (i.isPaid) {
      const resid = Math.max(0, i.total - sumR);
      if (resid > 0 && i.dueDate && i.lastPaymentDate) {
        const late = Math.floor((i.lastPaymentDate - i.dueDate) / DAY_MS);
        const w = resid * _decayW((today - i.lastPaymentDate) / DAY_MS, C.HALF_LIFE_DAYS);
        wSum += w;
        wLateScore += w * _lateScore(late, C.LATE_ZERO_DAYS, C.GRACE_DAYS);
        wLateDays  += w * Math.max(0, late);
        if (late > CONFIG.HANDOVER_OFFSET_DAYS) wH15 += w;
        pSum += w; pLateDays += w * Math.max(0, late);
        if (!receipts.length) nPaid++;   // lunas via PPh/potongan penuh, tetap bukti pelunasan
      }
    }

    // (c) faktur masih terbuka — TANPA decay, ini sedang terjadi sekarang
    if (!i.isPaid && i.outstanding > 0) {
      outstanding += i.outstanding;
      const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : null;
      cadangan += i.outstanding * _pdOf(dpd);
      if (dpd != null) {
        if (dpd > 0) overdueRp += i.outstanding;
        if (maxOpenDpd == null || dpd > maxOpenDpd) maxOpenDpd = dpd;
        const w = i.outstanding;
        wSum += w;
        wLateScore += w * _lateScore(dpd, C.LATE_ZERO_DAYS, C.GRACE_DAYS);
        wLateDays  += w * Math.max(0, dpd);
        if (dpd > CONFIG.HANDOVER_OFFSET_DAYS) wH15 += w;
      }
    }
  });

  const belanjaBulanan = belanjaWin / C.LIMIT_WINDOW_MONTHS;
  // Median nilai order: dasar Saran Limit. Tahan terhadap satu order besar sekali lewat.
  orderVals.sort(function(a, b) { return a - b; });
  const nOrd = orderVals.length;
  const medianOrder = nOrd === 0 ? 0
    : (nOrd % 2 ? orderVals[(nOrd - 1) / 2] : (orderVals[nOrd / 2 - 1] + orderVals[nOrd / 2]) / 2);
  const bulanTertahan  = belanjaBulanan > 0 ? outstanding / belanjaBulanan : (outstanding > 0 ? 99 : 0);
  const overdueShare   = outstanding > 0 ? overdueRp / outstanding : 0;

  // Empat komponen 0..100
  const A = wSum > 0 ? wLateScore / wSum : null;
  const B = wSum > 0 ? 100 * (1 - wH15 / wSum) : null;
  const C_posisi = 0.7 * _lateScore(maxOpenDpd == null ? 0 : maxOpenDpd, C.POSISI_ZERO_DAYS, 0)
                 + 0.3 * 100 * (1 - overdueShare);
  const D_beban  = outstanding <= 0 ? 100
                 : _lateScore(bulanTertahan * 30, C.BEBAN_ZERO_DAYS, C.BEBAN_GRACE_DAYS);

  const dormantCut = _monthsBack(today, C.DORMANT_MONTHS);

  return {
    A: A, B: B, C: C_posisi, D: D_beban,
    nPaid: nPaid, invCount: invCount,
    wadl: pSum > 0 ? pLateDays / pSum : null,          // rata2 telat SAAT BAYAR (tampilan)
    shareH15: wSum > 0 ? wH15 / wSum : null,
    outstanding: outstanding, overdueRp: overdueRp, maxOpenDpd: maxOpenDpd,
    cadangan: cadangan, belanjaBulanan: belanjaBulanan, medianOrder: medianOrder,
    nOrder: nOrd, bulanTertahan: bulanTertahan,
    tempoModus: _custTempoModus(invs),
    isCod: hasTempoInfo && allCod,
    isDormant: !lastTrans || lastTrans < dormantCut,
    lastTrans: lastTrans
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SKOR + BAND. Shrinkage hanya untuk PARUH RIWAYAT (A & B); C & D teramati penuh hari ini
// sehingga tidak butuh prior.
// ─────────────────────────────────────────────────────────────────────────────
function _custHistRaw(p) {
  const C = CONFIG.CUSTOMER;
  if (p.A == null || p.B == null) return null;
  return (C.W_KECEPATAN * p.A + C.W_DISIPLIN * p.B) / (C.W_KECEPATAN + C.W_DISIPLIN);
}

function _custRiskScore(p, priorBuku) {
  const C = CONFIG.CUSTOMER;
  const raw = _custHistRaw(p);
  const prior = (priorBuku == null) ? 60 : priorBuku;      // buku kosong → asumsi netral
  const n = p.nPaid;
  const hist = (raw == null) ? prior : (n * raw + C.SHRINK_K * prior) / (n + C.SHRINK_K);

  let skor = Math.round((C.W_KECEPATAN + C.W_DISIPLIN) * hist
                      + C.W_POSISI * p.C + C.W_BEBAN * p.D);
  skor = clamp(skor, 0, 100);

  let band = skor >= C.BAND_CUTS.AMAN   ? 'AMAN'
           : skor >= C.BAND_CUTS.HATI   ? 'HATI'
           : skor >= C.BAND_CUTS.RISIKO ? 'RISIKO' : 'BAHAYA';

  // Override keras: rata-rata tertimbang TIDAK boleh menutupi keadaan darurat hari ini.
  let override = '';
  if (p.maxOpenDpd != null && p.maxOpenDpd >= C.STOP_DPD) {
    band = 'BAHAYA'; override = 'ada faktur lewat ' + p.maxOpenDpd + ' hari';
  } else if (p.overdueRp >= C.STOP_OVERDUE_RP && p.maxOpenDpd != null &&
             p.maxOpenDpd >= C.STOP_OVERDUE_DPD) {
    band = 'BAHAYA'; override = 'nunggak ' + rupiah(p.overdueRp) + ' lewat ' + p.maxOpenDpd + ' hari';
  } else if (p.bulanTertahan > C.BEBAN_HARD_MONTHS && band === 'AMAN') {
    band = 'RISIKO'; override = 'tertahan ' + p.bulanTertahan.toFixed(1) + ' bulan belanja';
  }
  return { skor: skor, band: band, override: override };
}

// ─────────────────────────────────────────────────────────────────────────────
// SISI MARGIN (Fase 3). Dipanggil hanya kalau CONFIG.CUSTOMER.MARGIN_ENABLED true.
//
// Cakupan diukur PER FAKTUR, bukan per rupiah baris: `Σ lineTotal / Σ total` mentok ~89%
// karena lineTotal pra-PPN sedangkan total pasca-PPN, jadi tab yang sehat pun akan selamanya
// kelihatan kuning. Harvest menulis faktur utuh atau tidak sama sekali, jadi granularitas
// faktur adalah ukuran yang benar — DAN membuat diskon faktur bisa di-netto secara EKSAK,
// bukan dialokasikan ke baris.
// ─────────────────────────────────────────────────────────────────────────────
function _custBadMonth(ctx, d) {
  if (!d || !ctx.badMonths) return false;
  return !!ctx.badMonths[Utilities.formatDate(d, 'GMT+7', 'yyyy-MM')];
}

function _custMarginStats(g, ctx) {
  const C = CONFIG.CUSTOMER;
  const out = { ok: false, cakupan: 0, cakupanBiaya: 0, omzetTercakup: 0, lineRevenue: 0,
                hpp: 0, diskon: 0, marginKotor: 0, marginKotorPct: null, biayaModal: 0,
                marginBersih: 0, marginBersihPct: null, naikPct: 0, rugiRp: 0, rugiPct: 0,
                costHist: 0, costSnap: 0, histPct: 0, sebab: '', cukupUntukVonis: false };
  if (!ctx || !ctx.enabled) return out;

  let totWin = 0, totCovered = 0, costKnown = 0, costAll = 0;
  const coveredInvs = [];

  g.invs.forEach(function(i) {
    if (!i.transDate || i.transDate < ctx.winStart) return;
    if (_custBadMonth(ctx, i.transDate)) return;   // basis harga beli bulan itu tak dipercaya
    totWin += i.total;
    if (ctx.coveredIds[i.id]) { totCovered += i.total; coveredInvs.push(i); }
  });
  out.cakupan = totWin > 0 ? totCovered / totWin : 0;
  out.omzetTercakup = totCovered;

  coveredInvs.forEach(function(i) {
    out.diskon += i.cashDiscount || 0;
    (ctx.linesByInv[i.id] || []).forEach(function(L) {
      if (!L.itemNo || !(L.lineTotal > 0)) return;
      if (_isNonInventory(L.itemNo, L.itemName)) return;   // bukan barang beli-jual
      out.lineRevenue += L.lineTotal;
      costAll += L.lineTotal;
      // Harga beli historis (distempel saat panen) DIUTAMAKAN di atas snapshot hari ini.
      // Harga beli naik-turun; tanpa ini faktur lama dibandingkan dengan modal terbaru dan
      // ikut terhitung rugi padahal saat itu untung.
      const m = ctx.items[L.itemNo];
      let hppLine;
      if (L.unitCost > 0) {
        hppLine = L.qty * L.unitCost;
        costKnown += L.lineTotal;
        out.costHist += L.lineTotal;
      } else if (m && m.cost > 0) {
        hppLine = L.qty * m.cost;
        costKnown += L.lineTotal;
        out.costSnap += L.lineTotal;
      } else {
        // Item suspended / belum masuk item master → JANGAN dianggap gratis. Imputasi pakai
        // rasio HPP buku, dan porsinya dilaporkan lewat cakupanBiaya.
        hppLine = L.lineTotal * ctx.costRatio;
      }
      out.hpp += hppLine;
      // Dijual di bawah modal. Sengaja TIDAK dikoreksi: kalau harga beli di Accurate basi, itu
      // masalah data yang harus dibereskan di sumbernya; kalau harganya memang kurang, itu
      // masalah harga yang harus dinaikkan. Dua-duanya perlu kelihatan, bukan ditambal.
      if (hppLine / L.lineTotal >= CONFIG.CUSTOMER.BELOW_COST_RATIO) out.rugiRp += L.lineTotal;
    });
  });
  out.cakupanBiaya = costAll > 0 ? costKnown / costAll : 0;
  out.rugiPct = out.lineRevenue > 0 ? out.rugiRp / out.lineRevenue : 0;
  const costTot = out.costHist + out.costSnap;
  out.histPct = costTot > 0 ? out.costHist / costTot : 0;   // share omzet berharga beli historis

  // Biaya modal: dihitung SEJAK FAKTUR TERBIT, bukan sejak telat. Tempo yang kita berikan juga
  // ada harganya — customer yang selalu bayar tepat hari ke-30 tetap memakan modal.
  const harian = C.COST_OF_CAPITAL_ANNUAL / 365;
  coveredInvs.forEach(function(i) {
    if (!i.transDate) return;
    let sumR = 0;
    (i.receipts || []).forEach(function(r) {
      if (!r.date || !(r.amount > 0)) return;
      sumR += r.amount;
      out.biayaModal += r.amount * Math.max(0, (r.date - i.transDate) / DAY_MS) * harian;
    });
    if (i.isPaid) {
      const resid = Math.max(0, i.total - sumR);
      if (resid > 0 && i.lastPaymentDate) {
        out.biayaModal += resid * Math.max(0, (i.lastPaymentDate - i.transDate) / DAY_MS) * harian;
      }
    } else if (i.outstanding > 0) {
      out.biayaModal += i.outstanding * Math.max(0, (ctx.today - i.transDate) / DAY_MS) * harian;
    }
  });

  out.marginKotor = out.lineRevenue - out.hpp - out.diskon;
  out.marginBersih = out.marginKotor - out.biayaModal;
  if (out.lineRevenue > 0) {
    out.marginKotorPct  = out.marginKotor / out.lineRevenue;
    out.marginBersihPct = out.marginBersih / out.lineRevenue;
  }
  // Syarat MENAMPILKAN margin dan syarat MEMAKAINYA UNTUK MEMVONIS sengaja dipisah.
  // Angkanya sendiri eksak (baris faktur nyata x harga beli nyata), jadi menyembunyikannya dari
  // pembeli kecil cuma membuang informasi. Yang berbahaya bukan menampilkan, melainkan menjatuhkan
  // vonis "naikkan harga" dari basis omzet sekecil sejuta: satu pesanan aneh saja sudah bisa
  // menjungkirkan persentasenya. Jadi tampil = cakupan cukup; vonis = cakupan cukup DAN omzet
  // melewati lantai.
  out.ok = (out.cakupan >= C.MIN_COVERAGE && out.cakupanBiaya >= C.MIN_COST_COVERAGE &&
            out.lineRevenue > 0);
  out.cukupUntukVonis = out.ok && out.omzetTercakup >= C.MIN_OMZET_RP;
  // Sebab SPESIFIK kenapa margin tidak bisa dihitung. Sebelumnya alasannya selalu berbunyi
  // "cakupan sekian persen" walau cakupannya 100%, dan itu membingungkan: penyebab tersering
  // sebenarnya omzet di bawah lantai, bukan data yang kurang.
  if (!out.ok) {
    if (totWin <= 0) {
      out.sebab = 'tidak ada pembelian dalam ' + C.MARGIN_WINDOW_MONTHS + ' bulan terakhir';
    } else if (out.lineRevenue <= 0 || out.cakupan < C.MIN_COVERAGE) {
      out.sebab = 'rincian barangnya baru ' + Math.round(out.cakupan * 100) + '% ketarik dari Accurate';
    } else {
      out.sebab = 'harga beli baru menutup ' + Math.round(out.cakupanBiaya * 100) + '% omzetnya';
    }
  }

  // Kenaikan harga yang membuat customer ini sehat. Skip adalah langkah KEDUA, bukan pertama:
  // melepas volume juga melepas kontribusi ke biaya tetap dan daya tawar ke pabrik.
  if (out.ok && out.marginBersihPct != null && out.marginBersihPct < C.TARGET_MARGIN_PCT) {
    const sehat = (out.hpp + out.diskon + out.biayaModal) / (1 - C.TARGET_MARGIN_PCT);
    out.naikPct = clamp(sehat / out.lineRevenue - 1, 0, C.NAIK_HARGA_MAX);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// VONIS + SARAN LIMIT & TEMPO
// ─────────────────────────────────────────────────────────────────────────────
function _custVerdict(p, m, sc) {
  const C = CONFIG.CUSTOMER;

  // Kelas khusus dulu — tapi customer yang SUDAH overdue tidak boleh lolos ke "belum dinilai".
  const daruratOpen = (p.maxOpenDpd != null && p.maxOpenDpd > 0);
  if (!daruratOpen) {
    if (p.isDormant && p.outstanding <= 0) {
      return { verdict: '😴 DORMAN', alasan: 'Tidak ada order dalam ' + C.DORMANT_MONTHS +
               ' bulan terakhir. Tidak diberi limit sampai dia order lagi.',
               limit: 0, tempo: 0, rank: true };
    }
    if (p.isCod) {
      return { verdict: '💵 TUNAI', alasan: 'Selalu bayar tunai, belum pernah diberi tempo. ' +
               'Catatan bayarnya bagus tapi belum membuktikan apa apa soal kredit.',
               limit: 0, tempo: 0, rank: false };
    }
    if (p.nPaid === 0 && p.invCount <= 1) {
      return { verdict: '🆕 BARU', alasan: 'Faktur pertama, belum ada riwayat bayar. Bayar dulu sampai 3 transaksi lancar, baru boleh diajukan tempo.',
               limit: C.LIMIT_BARU, tempo: C.TEMPO_BARU, rank: true };
    }
    if (p.nPaid === 0 && p.outstanding <= 0) {
      return { verdict: '⚪ BELUM DINILAI', alasan: 'Belum ada pembayaran yang bisa dinilai.',
               limit: 0, tempo: 0, rank: false };
    }
  }

  // Tempo: satu angka untuk semua customer kredit (TEMPO_MAX 14 hari). Mesin hanya boleh
  // MEMPERKETAT: customer yang selama ini bertempo 7 hari tidak otomatis naik ke 14.
  // Melonggarkan tetap keputusan orang.
  let tempo = C.TEMPO_BAND[sc.band];
  if (C.TEMPO_ONLY_TIGHTEN && p.tempoModus != null) tempo = Math.min(tempo, p.tempoModus);
  tempo = clamp(tempo, 0, C.TEMPO_MAX);

  // Limit = LIMIT_ORDER_MULT × median nilai order, lantai LIMIT_MIN, plafon LIMIT_CAP (alasan di
  // CONFIG). Kalimat ke customer: "dua kali order rata-rata Bapak". Band tanpa tempo → limit 0.
  let limit = tempo > 0 ? p.medianOrder * C.LIMIT_ORDER_MULT : 0;
  limit = Math.floor(limit / C.LIMIT_ROUND) * C.LIMIT_ROUND;
  if (limit > 0) limit = clamp(limit, C.LIMIT_MIN, C.LIMIT_CAP);

  const marginTipis = m.ok && m.cukupUntukVonis &&
                      m.marginBersihPct != null && m.marginBersihPct < C.TARGET_MARGIN_PCT;

  let verdict, alasan;
  if (sc.band === 'BAHAYA') {
    verdict = '🔴 STOP-COD';
    alasan = 'Skor bayar ' + sc.skor + (sc.override ? ', ' + sc.override : '') +
             '. Jangan proses order baru sampai lunas, kalau mau lanjut minta bayar di muka.';
    limit = 0; tempo = 0;                       // invariant: STOP ⇒ limit 0, tempo 0
  } else if (marginTipis) {
    verdict = '🟠 NAIKKAN HARGA';
    const bandLo = Math.round(C.MARGIN_BAND_LOW * 100);
    alasan = 'Bayarnya ' + (sc.band === 'AMAN' ? 'rapi' : 'lumayan') + ' (skor ' + sc.skor +
             ') tapi margin bersihnya cuma ' + (m.marginBersihPct * 100).toFixed(1) +
             '% setelah biaya modal' +
             (m.marginKotorPct != null && m.marginKotorPct < C.MARGIN_BAND_LOW
               ? ', dan margin kotornya ' + (m.marginKotorPct * 100).toFixed(1) +
                 '% sudah di bawah band normal ' + bandLo + '%'
               : '') +
             '. Naikkan harga ' + (m.naikPct * 100).toFixed(1) + '% dulu sebelum order berikutnya.';
  } else if (sc.band === 'AMAN') {
    verdict = '🟢 GAS';
    alasan = 'Bayar rapi (skor ' + sc.skor + '). Order baru jalan normal.';
  } else {
    verdict = '🟡 GAS TERBATAS';
    alasan = 'Skor bayar ' + sc.skor + (sc.override ? ', ' + sc.override : '') +
             (tempo > 0
               ? '. Boleh jalan tapi jangan lewat Saran Limit, tempo ' + tempo + ' hari.'
               : '. Boleh jalan tapi BAYAR DULU (tanpa tempo) sampai catatan bayarnya membaik.');
  }
  if (CONFIG.CUSTOMER.MARGIN_ENABLED) {
    if (!m.ok) {
      alasan += ' Margin belum bisa dihitung karena ' + (m.sebab || 'data belum cukup') +
                ', jadi keputusan ini murni dari sisi bayar.';
    } else if (!m.cukupUntukVonis && m.marginBersihPct != null &&
               m.marginBersihPct < C.TARGET_MARGIN_PCT) {
      // Marginnya tipis TAPI basisnya terlalu kecil untuk dijadikan dasar menaikkan harga.
      alasan += ' Margin bersihnya tipis (' + (m.marginBersihPct * 100).toFixed(1) +
                '%) tapi belanjanya baru ' + rupiah(m.omzetTercakup) + ', terlalu kecil untuk ' +
                'dijadikan dasar menaikkan harga. Pantau dulu.';
    }
  }
  return { verdict: verdict, alasan: alasan, limit: limit, tempo: tempo, rank: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORKESTRATOR — DUA LINTASAN.
// Lintasan 1 mengumpulkan tiga angka level BUKU yang jadi input skor: priorBuku (shrinkage),
// costRatio (imputasi harga beli), arBook (cap konsentrasi). Jangan digabung jadi satu loop.
// ─────────────────────────────────────────────────────────────────────────────
function buildCustomerReport(invoices, today, yMap) {
  const C = CONFIG.CUSTOMER;
  const groups = _custGroupInvoices(invoices);
  const keys = Object.keys(groups);

  // ── konteks margin (Fase 3) ──
  const marginCtx = { enabled: !!C.MARGIN_ENABLED, today: today, coveredIds: {}, linesByInv: {},
                      items: {}, costRatio: C.FALLBACK_COST_RATIO, winStart: null,
                      fakturTercakup: 0, fakturTotal: 0, badMonths: {} };
  if (marginCtx.enabled) {
    try {
      const winMonths = Math.min(C.MARGIN_WINDOW_MONTHS, CONFIG.RESTOCK.WINDOW_MONTHS);
      marginCtx.winStart = _monthsBack(today, winMonths);
      marginCtx.items = _loadItemCache();
      const rows = _loadSkuSalesCache();
      let cKnown = 0, cAll = 0;
      rows.forEach(function(r) {
        if (!r.itemNo) return;                       // baris sentinel = TIDAK tercakup (konservatif)
        marginCtx.coveredIds[r.invoiceId] = true;
        (marginCtx.linesByInv[r.invoiceId] = marginCtx.linesByInv[r.invoiceId] || []).push(r);
        if (_isNonInventory(r.itemNo, r.itemName)) return;   // jangan cemari rasio HPP buku
        const m = marginCtx.items[r.itemNo];
        const uc = r.unitCost > 0 ? r.unitCost : ((m && m.cost > 0) ? m.cost : 0);
        if (uc > 0 && r.lineTotal > 0) { cKnown += r.qty * uc; cAll += r.lineTotal; }
      });
      if (cAll > 0) marginCtx.costRatio = clamp(cKnown / cAll, 0.2, 0.98);

      // Bulan yang basis harga belinya tidak dipercaya (lihat CONFIG.MONTH_DISTRUST_PCT).
      // Dikeluarkan SEPENUHNYA dari margin: omzet, cakupan, hpp, dan biaya modal.
      const perBulan = {};
      rows.forEach(function(r) {
        if (!r.itemNo || !(r.lineTotal > 0) || !(r.qty > 0)) return;
        if (_isNonInventory(r.itemNo, r.itemName)) return;
        const it = marginCtx.items[r.itemNo];
        const cost = r.unitCost > 0 ? r.unitCost : ((it && it.cost > 0) ? it.cost : 0);
        if (!(cost > 0) || !r.transDate) return;
        const bln = Utilities.formatDate(r.transDate, 'GMT+7', 'yyyy-MM');
        const bb = perBulan[bln] || (perBulan[bln] = { omzet: 0, rugi: 0, hist: 0, hpp: 0 });
        const hpp = r.qty * cost;
        bb.omzet += r.lineTotal;
        bb.hpp += hpp;
        if (r.unitCost > 0) bb.hist += r.lineTotal;
        if (hpp / r.lineTotal >= CONFIG.CUSTOMER.BELOW_COST_RATIO) bb.rugi += r.lineTotal;
      });
      Object.keys(perBulan).forEach(function(k) {
        const b = perBulan[k];
        if (!(b.omzet > 0)) return;
        const share = b.rugi / b.omzet;
        const histShare = b.hist / b.omzet;
        // Hanya curigai bulan yang MASIH bergantung harga snapshot. Kalau harga historis sudah
        // menutup mayoritas barisnya, angka rugi di situ memang nyata dan harus ditampilkan.
        if (histShare >= 0.5) return;          // sudah pakai harga historis → angkanya nyata
        const gross = (b.omzet - b.hpp) / b.omzet;
        if (share > CONFIG.CUSTOMER.MONTH_DISTRUST_PCT) {
          marginCtx.badMonths[k] = { arah: 'rugi', nilai: Math.round(share * 100) };
        } else if (gross > CONFIG.CUSTOMER.MONTH_DISTRUST_HIGH_PCT) {
          marginCtx.badMonths[k] = { arah: 'untung', nilai: Math.round(gross * 100) };
        }
      });
    } catch (e) {
      Logger.log('Konteks margin dilewati: ' + e.message);
      marginCtx.enabled = false;
    }
  }

  // ── LINTASAN 1 — statistik per customer + tiga angka buku ──
  const stage = [];
  let arBook = 0, priorNum = 0, priorDen = 0;
  keys.forEach(function(k) {
    const g = groups[k];
    const p = _custPaymentStats(g, today);
    arBook += p.outstanding;
    const raw = _custHistRaw(p);
    if (raw != null && p.nPaid >= C.MIN_INVOICES_SCORE) {
      const w = Math.max(1, p.belanjaBulanan);       // ditimbang rupiah: buku besar lebih menentukan
      priorNum += raw * w; priorDen += w;
    }
    stage.push({ g: g, p: p });
  });
  const priorBuku = priorDen > 0 ? priorNum / priorDen : null;

  if (marginCtx.enabled) {
    invoices.forEach(function(i) {
      if (!i.transDate || i.transDate < marginCtx.winStart) return;
      if (_custBadMonth(marginCtx, i.transDate)) return;
      marginCtx.fakturTotal++;
      if (marginCtx.coveredIds[i.id]) marginCtx.fakturTercakup++;
    });
  }

  // ── LINTASAN 2 — skor, margin, vonis ──
  const list = [];
  stage.forEach(function(s) {
    const p = s.p;
    const sc = _custRiskScore(p, priorBuku);
    const m  = _custMarginStats(s.g, marginCtx);
    const v  = _custVerdict(p, m, sc);
    const y  = (yMap && yMap[s.g.name]) || {};
    list.push({
      key: s.g.key, customer: s.g.name, salesman: s.g.salesman || '(POS / online)',
      tierText: s.g.tierText || '', noTlp: s.g.noTlp || '',
      verdict: v.verdict, alasan: v.alasan, rank: v.rank,
      skor: sc.skor, band: sc.band, override: sc.override,
      wadl: p.wadl, shareH15: p.shareH15, outstanding: p.outstanding,
      maxOpenDpd: p.maxOpenDpd, belanjaBulanan: p.belanjaBulanan, cadangan: p.cadangan,
      bulanTertahan: p.bulanTertahan, tempoModus: p.tempoModus, isCod: p.isCod,
      isDormant: p.isDormant, nPaid: p.nPaid, invCount: p.invCount,
      medianOrder: p.medianOrder, nOrder: p.nOrder,
      margin: m, limit: v.limit, tempo: v.tempo,
      limitDisetujui: y.limit || '', catatan: y.catatan || ''
    });
  });

  list.sort(function(a, b) {
    const ra = CUST_VERDICT_RANK[a.verdict] || 9, rb = CUST_VERDICT_RANK[b.verdict] || 9;
    if (ra !== rb) return ra - rb;
    const va = Math.max(a.outstanding, Math.abs(a.margin.ok ? a.margin.marginBersih : 0));
    const vb = Math.max(b.outstanding, Math.abs(b.margin.ok ? b.margin.marginBersih : 0));
    return vb - va;
  });

  // Σ limit berlaku (Limit Disetujui menang, else Saran Limit) untuk customer yang memegang
  // tempo. Ini pagar total kredit vs target buku; dibandingkan di RINGKAS, bukan dialokasikan.
  let limitSum = 0, limitCount = 0;
  list.forEach(function(r) {
    if (r.tempo > 0) { const l = _limitBerlaku(r); if (l > 0) { limitSum += l; limitCount++; } }
  });
  const totals = { arBook: arBook, limitSum: limitSum, limitCount: limitCount,
                   priorBuku: priorBuku, marginCtx: marginCtx,
                   dinilai: list.filter(function(r) { return r.rank; }).length,
                   jumlah: list.length,
                   perVerdict: {}, cadangan: 0, marginBersih: 0, marginKotor: 0, biayaModal: 0,
                   lineRevenue: 0, rugiRp: 0, costHist: 0, costSnap: 0, tempoCount: 0 };
  list.forEach(function(r) {
    const b = totals.perVerdict[r.verdict] = totals.perVerdict[r.verdict] || { n: 0, rp: 0 };
    b.n++; b.rp += r.outstanding;
    totals.cadangan += r.cadangan;
    if (r.margin.ok) {
      totals.marginBersih += r.margin.marginBersih;
      totals.marginKotor += r.margin.marginKotor;
      totals.biayaModal  += r.margin.biayaModal;
      totals.lineRevenue += r.margin.lineRevenue;
      totals.rugiRp      += r.margin.rugiRp;
      totals.costHist    += r.margin.costHist;
      totals.costSnap    += r.margin.costSnap;
    }
    if (!r.isCod && r.tempoModus != null && r.tempoModus > CONFIG.CUSTOMER.COD_TEMPO_MAX) totals.tempoCount++;
  });

  return { list: list, totals: totals };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🟡 UPSERT — kolom Nathan (Limit Disetujui / Catatan) dikumpulkan SEBELUM tab dibersihkan.
// Pola identik collectRouteYellow: kunci = nama customer.
// ─────────────────────────────────────────────────────────────────────────────
function collectCustomerYellow(files) {
  const map = {};
  const minLimit = CONFIG.CUSTOMER.LIMIT_MIN;
  (files || []).forEach(function(ss) {
    if (!ss) return;
    try {
      const sh = ss.getSheetByName(CONFIG.TABS.CUSTOMER);
      if (!sh) return;
      const last = sh.getLastRow(), lastCol = sh.getLastColumn();
      if (last < 2) return;
      const vals = sh.getRange(1, 1, last, lastCol).getValues();
      // Cari kolom LEWAT NAMA HEADER, bukan nomor tetap. Bug 2026-09-05: layout berubah 26 → 17
      // kolom, pembaca lama membaca kolom 16/17 yang di layout lama = Biaya Modal / Margin Bersih,
      // jadi angka biaya modal terbaca sebagai "limit disetujui" dan semua customer kena LIM.
      let cLim = -1, cCat = -1;
      vals.forEach(function(row) {
        if (cLim >= 0) return;
        if (String(row[0]).trim() !== 'Customer') return;
        cLim = row.indexOf('Limit Disetujui'); cCat = row.indexOf('Catatan Nathan');
      });
      if (cLim < 0 || cCat < 0) return;            // header belum layout ini → tidak ada 🟡 yang sah
      vals.forEach(function(row) {
        const nama = String(row[0] || '').trim();
        if (!nama || nama === 'Customer') return;
        let lim = row[cLim], cat = row[cCat];
        // Sanitasi: limit di bawah LIMIT_MIN bukan limit (sisa angka layout lama), catatan berupa
        // angka juga bukan catatan. Diabaikan supaya sampah tidak mengabadikan diri lewat upsert.
        if (typeof lim === 'number' && lim < minLimit) lim = '';
        if (typeof cat === 'number') cat = '';
        if ((lim === '' || lim == null) && (cat === '' || cat == null)) return;
        const cur = map[nama] || (map[nama] = { limit: '', catatan: '' });
        if (lim !== '' && lim != null) cur.limit = lim;
        if (cat !== '' && cat != null) cur.catatan = cat;
      });
    } catch (e) { Logger.log('collectCustomerYellow: ' + e.message); }
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITER
// ─────────────────────────────────────────────────────────────────────────────
function writeCustomerTab(report) {
  const sh = uiSheet(CONFIG.TABS.CUSTOMER);
  // uiSheet memanggil clear(), dan clear() TIDAK melepas pembekuan baris/kolom. Tanpa pelepasan
  // eksplisit ini, pembekuan dari versi tab sebelumnya tetap menempel selamanya (kejadian 2026-09-02).
  sh.setFrozenColumns(0);
  sh.setFrozenRows(0);
  const SPAN = CUST_SPAN;
  const C = CUST_COL;
  const t = report.totals;
  const mc = t.marginCtx;
  const CC = CONFIG.CUSTOMER;
  const targetAr = CONFIG.TURUN_BUKU.TARGET_AR;

  let r = uiBanner(sh, 1, SPAN, '🧭 Rapor Customer — boleh kasih order baru atau tidak',
    'Dua sudut pandang: SKOR BAYAR dari seluruh riwayat pembayaran (kelakuan lama luntur separuh ' +
    'tiap 6 bulan) dan MARGIN BERSIH setelah biaya modal piutang. Saran Limit = ' + CC.LIMIT_ORDER_MULT +
    ' × order rata-rata, maks ' + rupiah(CC.LIMIT_CAP) + '; tempo ' + CC.TEMPO_MAX + ' hari untuk semua. ' +
    'Semua kolom Saran bersifat usulan; penerapannya manual di Accurate oleh Nathan. Dibuat ulang tiap jam 5 pagi.',
    UI.INK, UI.BAND);

  // ── RINGKAS: hanya angka yang mengubah keputusan ──
  r = uiSection(sh, r, SPAN, 'RINGKAS', UI.GREEN);
  const lewat = t.limitSum > targetAr;
  const ringkas = [
    ['Piutang berjalan', t.arBook, 'Total outstanding seluruh customer · target buku ' + rupiah(targetAr)],
    ['Σ limit kredit berlaku', t.limitSum,
      t.limitCount + ' customer pegang tempo. ' +
      (lewat
        ? '⚠ LEWAT target buku ' + rupiah(targetAr) + ' sebesar ' + rupiah(t.limitSum - targetAr) +
          '. Turunkan LIMIT_ORDER_MULT di CONFIG (2 → 1,5) atau pangkas Limit Disetujui terbesar.'
        : '✓ di bawah target buku ' + rupiah(targetAr) + ', sisa ruang ' + rupiah(targetAr - t.limitSum) + '.')],
    ['Customer dinilai', t.dinilai + ' dari ' + t.jumlah, 'Sisanya tunai, dorman, atau belum cukup data']
  ];
  ['🟢 GAS', '🟡 GAS TERBATAS', '🟠 NAIKKAN HARGA', '🔴 STOP-COD'].forEach(function(v) {
    const b = t.perVerdict[v];
    if (b) ringkas.push([v, b.n + ' customer', 'nunggak ' + rupiah(b.rp)]);
  });
  if (mc.enabled) {
    const gpm = t.lineRevenue > 0 ? t.marginKotor / t.lineRevenue : null;
    ringkas.push(['Margin kotor buku', gpm == null ? '-' : (gpm * 100).toFixed(1) + '%',
      'COCOKKAN tiap bulan dengan Gross Profit Margin di Accurate (Laporan › Rasio Keuangan Per Bulan). ' +
      'Selisih >2 poin = harga beli di master barang salah, margin per customer belum layak dipakai. ' +
      'Band normal ' + Math.round(CC.MARGIN_BAND_LOW * 100) + '-' + Math.round(CC.MARGIN_BAND_HIGH * 100) + '%.']);
    ringkas.push(['Margin bersih buku', t.marginBersih,
      'setelah biaya modal ' + rupiah(t.biayaModal) + ' (' + Math.round(CC.COST_OF_CAPITAL_ANNUAL * 100) +
      '% per tahun) atas omzet ' + rupiah(t.lineRevenue)]);
    const bad = Object.keys(mc.badMonths || {}).sort();
    if (bad.length) {
      ringkas.push(['Bulan dikecualikan dari margin',
        bad.map(function(k) { const x = mc.badMonths[k]; return k + ' (' + x.arah + ' ' + x.nilai + '%)'; }).join(', '),
        'Harga beli sudah berubah sejak bulan itu; angkanya tidak dipercaya dan tidak ikut dihitung. Pulih sendiri begitu harga beli historis terkumpul.']);
    }
    if (mc.fakturTercakup < mc.fakturTotal) {
      ringkas.push(['⚠ Data margin belum lengkap', mc.fakturTercakup + ' / ' + mc.fakturTotal + ' faktur',
        'Run Full Sync lagi sampai penuh; margin customer bisa bergeser.']);
    }
    if (t.rugiRp > 0) {
      const rp = t.lineRevenue > 0 ? t.rugiRp / t.lineRevenue : 0;
      ringkas.push(['⚠ Dijual di bawah modal', t.rugiRp,
        (rp * 100).toFixed(1) + '% dari omzet. Rincian per SKU dan per bulan: menu Diag jual di bawah modal.']);
    }
  } else {
    ringkas.push(['Sisi margin', 'BELUM AKTIF', 'Jalankan menu Diag vendorPrice dulu, baru nyalakan CONFIG.CUSTOMER.MARGIN_ENABLED']);
  }
  ringkas.forEach(function(row) {
    _mblock(sh, r, 1, 3, row[0]).setFontWeight('bold');
    const cell = _mblock(sh, r, 4, 5, row[1]);
    if (typeof row[1] === 'number') cell.setNumberFormat('"Rp"#,##0');
    if (row[0].indexOf('Σ limit') === 0) cell.setBackground(lewat ? UI.T_RED : UI.T_GREEN).setFontWeight('bold');
    _mblock(sh, r, 6, SPAN, row[2]).setFontColor(UI.NOTE).setFontStyle('italic').setWrap(true);
    r++;
  });
  r++;

  // Tiap blok baris data dicatat supaya format angka DAN conditional format kena ke semuanya.
  const blocks = [];

  // ── PERLU AKSI SEKARANG ──
  const urgent = report.list.filter(function(x) {
    return x.verdict === '🔴 STOP-COD' || x.verdict === '🟠 NAIKKAN HARGA';
  }).slice(0, 25);
  r = uiSection(sh, r, SPAN, '⚠️ PERLU AKSI SEKARANG  ·  ' + urgent.length + ' customer', UI.RED);
  if (!urgent.length) {
    sh.getRange(r, 1, 1, SPAN).merge()
      .setValue('✅ Tidak ada customer yang perlu dihentikan atau dinaikkan harganya.')
      .setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  } else {
    uiHeaderRow(sh, r, CUST_HEADERS); r++;
    blocks.push({ first: r, n: urgent.length });
    r = _custWriteRows(sh, r, urgent);
  }
  r++;

  // ── SEMUA CUSTOMER ──
  r = uiSection(sh, r, SPAN, '📋 SEMUA CUSTOMER  ·  ' + report.list.length + ' customer', UI.INK);
  uiHeaderRow(sh, r, CUST_HEADERS); r++;
  blocks.push({ first: r, n: report.list.length });
  r = _custWriteRows(sh, r, report.list);

  // pita TOTAL
  const totOut = report.list.reduce(function(s, x) { return s + x.outstanding; }, 0);
  sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(r, 1).setValue('TOTAL — ' + report.list.length + ' customer');
  sh.getRange(r, C['Nunggak Sekarang']).setValue(totOut).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, C['Saran Limit']).setValue(t.limitSum).setNumberFormat('"Rp"#,##0');
  r++;

  // WAJIB sekali untuk semua blok: setConditionalFormatRules mengganti SELURUH aturan sheet.
  _custCondFormats(sh, blocks);
  // JANGAN bekukan baris/kolom di tab ini: banner & pita seksi di-merge selebar tab (Sheets menolak
  // freeze kolom yang memotong merge, dan errornya baru melempar SETELAH baris ditulis).

  r = uiFootnote(sh, r, SPAN,
    '◆ Sisi bayar memakai SELURUH riwayat faktur; sisi margin maksimal ' + CC.MARGIN_WINDOW_MONTHS +
    ' bulan (rincian barang lebih tua sudah dihapus otomatis). Margin indikatif untuk membandingkan antar ' +
    'customer, bukan angka pembukuan; retur belum terhitung. Limit Disetujui dan Catatan Nathan diisi ' +
    'manual dan tidak tertimpa sync; kalau Limit Disetujui diisi, itu yang berlaku di Status Customer dan Stop Supply.');
  r++;

  _custCaraBaca(sh, r, SPAN);

  const widths = { 'Customer': 220, 'Sales': 110, 'Loyalitas (4bln)': 170, 'Keputusan': 150, 'Skor Bayar': 80,
                   'Rata2 Telat (hari)': 95, 'Nunggak Sekarang': 130, 'Telat Terlama (hari)': 95,
                   'Belanja / bln': 125, 'Order Rata2 (median)': 125, 'Margin Kotor %': 95, 'Margin Bersih %': 95,
                   'Saran Naik Harga': 100, 'Saran Limit': 120, 'Alasan': 420, 'Limit Disetujui': 130, 'Catatan Nathan': 220 };
  CUST_HEADERS.forEach(function(h, i) { sh.setColumnWidth(i + 1, widths[h] || 110); });
  return sh;
}

function _custWriteRows(sh, row, rows) {
  if (!rows.length) return row;
  const M = CONFIG.CUSTOMER.MARGIN_ENABLED;
  const matrix = rows.map(function(x) {
    const m = x.margin;
    const showM = M && m.ok;
    return [
      x.customer, x.salesman, x.tierText, x.verdict,
      x.rank ? x.skor : '',
      x.wadl == null ? '' : Math.round(x.wadl),
      x.outstanding, x.maxOpenDpd == null ? '' : x.maxOpenDpd,
      x.belanjaBulanan, x.medianOrder > 0 ? x.medianOrder : '',
      showM && m.marginKotorPct != null ? m.marginKotorPct : (M && !m.ok ? CUST_NO_MARGIN : ''),
      showM && m.marginBersihPct != null ? m.marginBersihPct : '',
      showM && m.naikPct > 0 ? m.naikPct : '',
      x.limit > 0 ? x.limit : '',
      x.alasan, x.limitDisetujui, x.catatan
    ];
  });
  sh.getRange(row, 1, matrix.length, CUST_SPAN).setValues(matrix).setVerticalAlignment('middle');
  sh.getRange(row, 1, matrix.length, CUST_SPAN)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  _custNumberFormats(sh, row, matrix.length);
  return row + matrix.length;
}

// Format angka SATU blok baris. Dipanggil dari _custWriteRows sehingga berlaku untuk setiap seksi.
function _custNumberFormats(sh, first, n) {
  if (n <= 0) return;
  const C = CUST_COL;
  ['Nunggak Sekarang', 'Belanja / bln', 'Order Rata2 (median)', 'Saran Limit', 'Limit Disetujui'].forEach(function(h) {
    sh.getRange(first, C[h], n, 1).setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
  });
  ['Margin Kotor %', 'Margin Bersih %', 'Saran Naik Harga'].forEach(function(h) {
    sh.getRange(first, C[h], n, 1).setNumberFormat('0.0%').setHorizontalAlignment('center');
  });
  ['Skor Bayar', 'Rata2 Telat (hari)', 'Telat Terlama (hari)'].forEach(function(h) {
    sh.getRange(first, C[h], n, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
  });
  sh.getRange(first, 1, n, 4).setHorizontalAlignment('left');
  sh.getRange(first, C['Alasan'], n, 1).setWrap(true).setVerticalAlignment('top');
  sh.getRange(first, C['Catatan Nathan'], n, 1).setWrap(true).setVerticalAlignment('top');
  sh.getRange(first, CUST_COL_YEL1, n, 2).setBackground(UI.AMBER_BODY);
}

// Conditional format untuk SEMUA blok sekaligus (lihat catatan di writeCustomerTab).
function _custCondFormats(sh, blocks) {
  const use = (blocks || []).filter(function(b) { return b && b.n > 0; });
  if (!use.length) return;
  const C = CUST_COL;
  const rng = function(h) { return use.map(function(b) { return sh.getRange(b.first, C[h], b.n, 1); }); };
  const kep = rng('Keputusan'), skor = rng('Skor Bayar'), telat = rng('Telat Terlama (hari)');
  const mbPct = rng('Margin Bersih %'), naik = rng('Saran Naik Harga'), tier = rng('Loyalitas (4bln)');
  const B = CONFIG.CUSTOMER.BAND_CUTS;
  const R = SpreadsheetApp.newConditionalFormatRule;
  sh.setConditionalFormatRules([
    R().whenTextStartsWith('🔴').setBackground(UI.T_RED).setRanges(kep).build(),
    R().whenTextStartsWith('🟠').setBackground('#fed7aa').setRanges(kep).build(),
    R().whenTextStartsWith('🟡').setBackground(UI.T_AMBER).setRanges(kep).build(),
    R().whenTextStartsWith('🟢').setBackground(UI.T_GREEN).setRanges(kep).build(),
    R().whenTextStartsWith('💵').setBackground(UI.BLUE_SOFT).setRanges(kep).build(),
    R().whenTextStartsWith('🆕').setBackground(UI.BLUE_SOFT).setRanges(kep).build(),
    R().whenTextStartsWith('⚪').setBackground(UI.T_GREY).setRanges(kep).build(),
    R().whenTextStartsWith('😴').setBackground(UI.T_GREY).setRanges(kep).build(),
    R().whenNumberGreaterThanOrEqualTo(B.AMAN).setBackground(UI.T_GREEN).setRanges(skor).build(),
    R().whenNumberBetween(B.HATI, B.AMAN - 1).setBackground(UI.T_AMBER).setRanges(skor).build(),
    R().whenNumberBetween(B.RISIKO, B.HATI - 1).setBackground('#fed7aa').setRanges(skor).build(),
    R().whenNumberLessThan(B.RISIKO).setBackground(UI.T_RED).setRanges(skor).build(),
    R().whenNumberGreaterThanOrEqualTo(CONFIG.CUSTOMER.STOP_DPD).setBackground(UI.T_RED).setRanges(telat).build(),
    R().whenNumberBetween(15, CONFIG.CUSTOMER.STOP_DPD - 1).setBackground('#fed7aa').setRanges(telat).build(),
    R().whenNumberBetween(1, 14).setBackground(UI.T_AMBER).setRanges(telat).build(),
    R().whenNumberLessThan(CONFIG.CUSTOMER.TARGET_MARGIN_PCT).setBackground(UI.T_AMBER).setRanges(mbPct).build(),
    R().whenNumberGreaterThan(0).setBackground('#fed7aa').setRanges(naik).build(),
    R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges(tier).build(),
    R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges(tier).build(),
    R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges(tier).build(),
    R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges(tier).build()
  ]);
}

function _custCaraBaca(sh, row, SPAN) {
  const CC = CONFIG.CUSTOMER;
  let r = uiSection(sh, row, SPAN, '📖 CARA BACA', UI.GOLD);
  sh.getRange(r, 1, 1, SPAN).merge().setValue(
    'Cara pakai cepat: baca kolom Keputusan saja. 🟢 GAS = order baru jalan, tempo ' + CC.TEMPO_MAX + ' hari sampai Saran Limit. ' +
    '🟡 GAS TERBATAS = boleh jalan tapi jangan lewat Saran Limit; kalau limitnya kosong berarti bayar dulu. ' +
    '🟠 NAIKKAN HARGA = bayarnya oke tapi kita nyaris tidak untung, naikkan harga sebesar kolom Saran Naik Harga dulu. ' +
    '🔴 STOP-COD = jangan proses order baru sampai lunas; kalau mau lanjut bayar di muka.')
    .setBackground(UI.GREEN_SOFT).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(r, 56); r++;

  const rows = [
    ['Skor Bayar', '0 sampai 100, makin tinggi makin rapi. Dari SELURUH riwayat pembayaran, kelakuan lama luntur separuh tiap 6 bulan, ditimbang rupiah. Faktur yang masih terbuka ikut dihitung, jadi yang sedang macet tidak bisa sembunyi di balik riwayat lama. Warna: hijau ≥' + CC.BAND_CUTS.AMAN + ' (AMAN), kuning ≥' + CC.BAND_CUTS.HATI + ' (HATI), oranye ≥' + CC.BAND_CUTS.RISIKO + ' (RISIKO), merah di bawahnya (BAHAYA).'],
    ['Rata2 Telat', 'Rata rata berapa hari lewat jatuh tempo uangnya baru masuk, ditimbang rupiah. Hanya menghitung yang SUDAH dibayar: kalau dia bayar, telatnya sekian.'],
    ['Nunggak Sekarang · Telat Terlama', 'Sisa tagihan hari ini dan umur faktur terbuka paling lama (dari jatuh tempo). Telat ≥' + CC.STOP_DPD + ' hari = Keputusan langsung merah berapa pun skornya.'],
    ['Belanja / bln · Order Rata2', 'Rata rata nilai faktur per bulan dan MEDIAN nilai satu order, keduanya ' + CC.LIMIT_WINDOW_MONTHS + ' bulan terakhir. Median dipakai untuk limit supaya satu order besar sekali lewat tidak membuka limit permanen.'],
    ['Saran Limit', CC.LIMIT_ORDER_MULT + ' kali Order Rata2, dibulatkan ' + rupiah(CC.LIMIT_ROUND) + ', minimal ' + rupiah(CC.LIMIT_MIN) + ', maksimal ' + rupiah(CC.LIMIT_CAP) + '. Dua kali karena customer mingguan punya dua faktur terbuka dalam satu siklus tempo ' + CC.TEMPO_MAX + ' hari. Di atas ' + rupiah(CC.LIMIT_CAP) + ' hanya lewat Limit Disetujui (keputusan owner). Kosong = tidak diberi tempo, bayar dulu.'],
    ['Margin Kotor % · Margin Bersih %', 'Kotor = jual dikurangi beli, sudah dikurangi diskon faktur; band normal ROSH ' + Math.round(CC.MARGIN_BAND_LOW * 100) + '-' + Math.round(CC.MARGIN_BAND_HIGH * 100) + '%. Bersih = kotor dikurangi biaya modal (' + Math.round(CC.COST_OF_CAPITAL_ANNUAL * 100) + '% per tahun, dihitung sejak faktur terbit sampai uang masuk). Bersih di bawah ' + Math.round(CC.TARGET_MARGIN_PCT * 100) + '% berwarna kuning: omzet besar tapi kita nyaris tidak untung karena dia bayar lambat.'],
    ['Kenapa margin kosong', 'Rincian barangnya belum ketarik minimal ' + Math.round(CC.MIN_COVERAGE * 100) + '%, harga beli belum diketahui, atau belanjanya di bawah ' + rupiah(CC.MIN_OMZET_RP) + ' dalam ' + CC.MARGIN_WINDOW_MONTHS + ' bulan. Sebab persisnya ditulis di kolom Alasan. Vonis NAIKKAN HARGA hanya keluar kalau belanjanya cukup besar untuk dipercaya.'],
    ['Saran Naik Harga', 'Kenaikan harga supaya customer ini mencapai margin bersih ' + Math.round(CC.TARGET_MARGIN_PCT * 100) + '%. Muncul hanya kalau marginnya tipis. Naikkan harga dulu, lepas belakangan.'],
    ['Kelas khusus', '💵 TUNAI = belum pernah diberi tempo, catatan sempurnanya belum membuktikan apa apa. 🆕 BARU = faktur pertama, bayar dulu sampai 3 transaksi. ⚪ BELUM DINILAI = data belum cukup. 😴 DORMAN = tidak ada order ' + CC.DORMANT_MONTHS + ' bulan.'],
    ['Dua kolom kuning', 'Limit Disetujui dan Catatan Nathan diisi tangan, tidak tertimpa sync. Kalau Limit Disetujui diisi, angka itulah yang dipakai Status Customer dan Stop Supply, bukan Saran Limit. Catatan Nathan juga tempat mencatat alasan SOP yang belum otomatis: SKK belum tanda tangan, giro ditolak, HP duplikat, blacklist.'],
    ['Cek kewajaran bulanan', 'Margin kotor buku di RINGKAS harus mendekati Gross Profit Margin di laporan Accurate. Kalau berjauhan, yang salah kemungkinan besar harga beli di master barang, bukan cara customer membayar.']
  ];
  rows.forEach(function(pair) {
    _mblock(sh, r, 1, 3, pair[0]).setFontWeight('bold').setVerticalAlignment('top');
    _mblock(sh, r, 4, SPAN, pair[1]).setWrap(true).setVerticalAlignment('top');
    sh.setRowHeight(r, Math.max(30, Math.ceil(pair[1].length / 115) * 18 + 12));
    r++;
  });
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAG — WAJIB dibaca sebelum CONFIG.CUSTOMER.MARGIN_ENABLED dinyalakan.
// Cek paling penting adalah nomor 7: memvalidasi bahwa `totalPrice` yang dipanen
// harvestSkuSales memang nilai baris yang kita kira. Kalau ini gagal, SELURUH angka margin
// tidak sah dan tidak boleh ditampilkan.
// ─────────────────────────────────────────────────────────────────────────────
function diagVendorPrice() {
  const items = _loadItemCache();
  const codes = Object.keys(items);
  let zero = 0;
  codes.forEach(function(c) { if (!(items[c].cost > 0)) zero++; });
  Logger.log('=== 1. ITEM MASTER ===');
  Logger.log('SKU di _ItemCache: ' + codes.length + ' · cost 0 / kosong: ' + zero);
  codes.slice(0, 20).forEach(function(c) {
    Logger.log('  ' + c + ' · ' + items[c].name + ' · cost ' + items[c].cost + ' · ' + items[c].unit);
  });

  const rows = _loadSkuSalesCache();
  let cKnown = 0, cAll = 0;
  const ratios = [], overOne = [], missing = {}, bad = [];
  rows.forEach(function(r) {
    if (!r.itemNo || !(r.lineTotal > 0) || !(r.qty > 0)) {
      if (r.itemNo) bad.push(r.itemNo + ' qty ' + r.qty + ' total ' + r.lineTotal);
      return;
    }
    const m = items[r.itemNo];
    if (!m || !(m.cost > 0)) { missing[r.itemNo] = (missing[r.itemNo] || 0) + r.lineTotal; return; }
    const hpp = r.qty * m.cost;
    cKnown += hpp; cAll += r.lineTotal;
    const ratio = hpp / r.lineTotal;
    ratios.push(ratio);
    if (ratio > 1.0) overOne.push(r.itemNo + ' · rasio ' + ratio.toFixed(2) +
      ' (qty ' + r.qty + ' × cost ' + m.cost + ' vs jual ' + r.lineTotal + ')');
  });
  ratios.sort(function(a, b) { return a - b; });
  const pct = function(p) { return ratios.length ? ratios[Math.floor(ratios.length * p)] : null; };

  Logger.log('=== 2. RASIO HPP BUKU ===');
  Logger.log('costRatio = ' + (cAll > 0 ? (cKnown / cAll).toFixed(4) : 'n/a') +
    '   (SEHAT kalau 0.55 sampai 0.85)');
  Logger.log('=== 3. SEBARAN RASIO PER BARIS ===');
  Logger.log('p10 ' + (pct(0.10) || 0).toFixed(3) + ' · median ' + (pct(0.50) || 0).toFixed(3) +
    ' · p90 ' + (pct(0.90) || 0).toFixed(3));
  Logger.log('=== 4. RED FLAG A — harga beli DI ATAS harga jual (' + overOne.length + ' baris) ===');
  overOne.slice(0, 20).forEach(function(s) { Logger.log('  ' + s); });
  const missKeys = Object.keys(missing);
  let missRp = 0; missKeys.forEach(function(k) { missRp += missing[k]; });
  Logger.log('=== 5. RED FLAG B — SKU terjual tapi tak ada harga belinya (' + missKeys.length + ' SKU) ===');
  Logger.log('  porsi omzet: ' + (cAll + missRp > 0 ? (missRp / (cAll + missRp) * 100).toFixed(1) : 0) +
    '% · nilai ' + rupiah(missRp));
  missKeys.slice(0, 15).forEach(function(k) { Logger.log('  ' + k + ' · ' + rupiah(missing[k])); });
  Logger.log('=== 6. RED FLAG C — baris qty/nilai tidak wajar (' + bad.length + ') ===');
  bad.slice(0, 10).forEach(function(s) { Logger.log('  ' + s); });

  // (7) yang paling menentukan: Σ lineTotal per faktur vs subTotal faktur.
  Logger.log('=== 7. CEK PALING PENTING — Σ lineTotal vs subTotal per faktur ===');
  const byInv = {};
  rows.forEach(function(r) {
    if (!r.itemNo) return;
    byInv[r.invoiceId] = (byInv[r.invoiceId] || 0) + r.lineTotal;
  });
  try {
    const invs = fetchSalesInvoices();
    const sample = invs.filter(function(i) { return byInv[i.id] > 0 && i.subTotal > 0; }).slice(0, 10);
    if (!sample.length) Logger.log('  Belum ada faktur yang line-item-nya ketarik. Jalankan Refresh Restock dulu.');
    sample.forEach(function(i) {
      const s = byInv[i.id], d = s - i.subTotal;
      Logger.log('  ' + i.number + ' · Σbaris ' + rupiah(s) + ' vs subTotal ' + rupiah(i.subTotal) +
        ' · selisih ' + rupiah(d) + ' (' + (i.subTotal > 0 ? (d / i.subTotal * 100).toFixed(1) : '0') + '%)');
    });
    Logger.log('  PUTUSAN: kalau selisihnya kecil (di bawah 1-2%), pemetaan field BENAR dan ' +
      'CONFIG.CUSTOMER.MARGIN_ENABLED boleh dinyalakan. Kalau selisihnya besar dan sistematis, ' +
      'JANGAN nyalakan — perbaiki dulu pembacaan totalPrice di harvestSkuSales.');
  } catch (e) {
    Logger.log('  Gagal ambil faktur untuk pembanding: ' + e.message);
  }
}

// Bongkar hitungan margin satu customer, faktur per faktur.
function diagCustomerMargin(customerName) {
  const nama = String(customerName || '').toLowerCase();
  if (!nama) { Logger.log('Pakai: diagCustomerMargin("Nama Customer")'); return; }
  const invs = fetchSalesInvoices();
  const items = _loadItemCache();
  const rows = _loadSkuSalesCache();
  const lines = {};
  rows.forEach(function(r) {
    if (!r.itemNo) return;
    (lines[r.invoiceId] = lines[r.invoiceId] || []).push(r);
  });
  const mine = invs.filter(function(i) {
    return String(i.customer || '').toLowerCase().indexOf(nama) >= 0;
  });
  Logger.log('Faktur cocok: ' + mine.length);
  let sJual = 0, sHpp = 0, sDisk = 0;
  mine.forEach(function(i) {
    const L = lines[i.id] || [];
    let jual = 0, hpp = 0;
    L.forEach(function(x) {
      const m = items[x.itemNo];
      jual += x.lineTotal;
      hpp += (m && m.cost > 0) ? x.qty * m.cost : x.lineTotal * CONFIG.CUSTOMER.FALLBACK_COST_RATIO;
    });
    sJual += jual; sHpp += hpp; sDisk += i.cashDiscount || 0;
    Logger.log(i.number + ' · ' + fmtDate(i.transDate) + ' · tercakup ' + (L.length ? 'YA' : 'TIDAK') +
      ' · total ' + rupiah(i.total) + ' · Σbaris ' + rupiah(jual) + ' · hpp ' + rupiah(hpp) +
      ' · diskon ' + rupiah(i.cashDiscount || 0));
  });
  Logger.log('TOTAL jual ' + rupiah(sJual) + ' · hpp ' + rupiah(sHpp) + ' · diskon ' + rupiah(sDisk) +
    ' · margin kotor ' + rupiah(sJual - sHpp - sDisk));
}

// DIAG — daftar SKU yang dijual DI BAWAH MODAL, diurutkan dari nilai terbesar. Temuan diag
// 2026-09-02: 167 baris seperti ini. Dua kemungkinan dan keduanya perlu tindakan berbeda:
// (a) vendorPrice di Accurate sudah basi / salah input  → betulkan di master item;
// (b) harga jualnya memang di bawah modal               → naikkan harga atau lepas SKU-nya.
// Kolom "beda" = selisih rupiah yang hilang di baris itu.
function diagBelowCost() {
  const items = _loadItemCache();
  const rows = _loadSkuSalesCache();
  const perSku = {}, perBulan = {};
  let totalOmzet = 0, totalRugi = 0, nBaris = 0, omzetHist = 0, omzetSnap = 0;

  rows.forEach(function(r) {
    if (!r.itemNo || !(r.lineTotal > 0) || !(r.qty > 0)) return;
    if (_isNonInventory(r.itemNo, r.itemName)) return;
    const m = items[r.itemNo];
    // Harga beli historis diutamakan; kalau baris ini dipanen sebelum kolom unitCost ada,
    // terpaksa pakai snapshot hari ini DAN itu ditandai supaya tidak salah dibaca.
    const hist = r.unitCost > 0;
    const cost = hist ? r.unitCost : ((m && m.cost > 0) ? m.cost : 0);
    if (!(cost > 0)) return;
    const hpp = r.qty * cost;
    totalOmzet += r.lineTotal;
    if (hist) omzetHist += r.lineTotal; else omzetSnap += r.lineTotal;

    const bln = r.transDate ? Utilities.formatDate(r.transDate, 'GMT+7', 'yyyy-MM') : '(tanpa tanggal)';
    const bb = perBulan[bln] || (perBulan[bln] = { omzet: 0, rugi: 0, n: 0, nRugi: 0, hist: 0 });
    bb.omzet += r.lineTotal; bb.n++;
    if (hist) bb.hist += r.lineTotal;

    if (hpp / r.lineTotal < CONFIG.CUSTOMER.BELOW_COST_RATIO) return;
    nBaris++; totalRugi += r.lineTotal;
    bb.rugi += r.lineTotal; bb.nRugi++;
    const a = perSku[r.itemNo] || (perSku[r.itemNo] = {
      nama: r.itemName || (m ? m.name : ''), costNow: m ? m.cost : 0,
      n: 0, omzet: 0, hpp: 0, qty: 0, nHist: 0 });
    a.n++; a.omzet += r.lineTotal; a.hpp += hpp; a.qty += r.qty;
    if (hist) a.nHist++;
  });

  Logger.log('=== SEBARAN PER BULAN — ini yang menjawab "apa ini faktur-faktur lama?" ===');
  Logger.log('Kalau porsi rugi MENGECIL di bulan-bulan terakhir, penyebabnya harga beli yang naik');
  Logger.log('(faktur lama dibandingkan modal baru). Kalau RATA termasuk bulan terakhir, berarti');
  Logger.log('diskon di lapangan memang menembus modal. Kolom "hist" = share omzet yang sudah');
  Logger.log('memakai harga beli historis; makin tinggi makin bisa dipercaya barisnya.');
  Object.keys(perBulan).sort().forEach(function(k) {
    const b = perBulan[k];
    Logger.log('  ' + k + ' · omzet ' + rupiah(b.omzet) +
      ' · rugi ' + rupiah(b.rugi) +
      ' (' + (b.omzet > 0 ? (b.rugi / b.omzet * 100).toFixed(1) : '0') + '%)' +
      ' · ' + b.nRugi + '/' + b.n + ' baris' +
      ' · hist ' + (b.omzet > 0 ? Math.round(b.hist / b.omzet * 100) : 0) + '%');
  });

  Logger.log('=== RINGKAS ===');
  Logger.log(nBaris + ' baris di bawah modal · nilai ' + rupiah(totalRugi) +
    ' dari omzet ' + rupiah(totalOmzet) +
    ' (' + (totalOmzet > 0 ? (totalRugi / totalOmzet * 100).toFixed(1) : 0) + '%)');
  Logger.log('Harga beli historis menutup ' +
    (totalOmzet > 0 ? Math.round(omzetHist / totalOmzet * 100) : 0) + '% omzet; sisanya (' +
    rupiah(omzetSnap) + ') masih dibandingkan dengan harga beli HARI INI.');

  Logger.log('=== PER SKU (urut selisih terbesar) ===');
  Object.keys(perSku)
    .map(function(k) { var a = perSku[k]; a.kode = k; a.beda = a.hpp - a.omzet; return a; })
    .sort(function(a, b) { return b.beda - a.beda; })
    .forEach(function(a) {
      Logger.log('  ' + a.kode + ' · ' + a.nama + ' · ' + a.n + ' baris (' + a.nHist +
        ' pakai harga historis) · qty ' + a.qty +
        ' · jual ' + rupiah(a.omzet) + ' vs modal ' + rupiah(a.hpp) +
        ' · SELISIH ' + rupiah(a.beda) +
        ' · jual rata2 ' + rupiah(a.qty > 0 ? a.omzet / a.qty : 0) + '/CTN' +
        ' vs harga beli sekarang ' + rupiah(a.costNow) + '/CTN');
    });
  Logger.log('Baris yang BELUM pakai harga historis akan terisi sendiri seiring faktur baru dipanen. ' +
    'Untuk baris lama, bandingkan "jual rata2" dengan harga beli pada PERIODE faktur itu, bukan hari ini.');
}

// Menu manual: hitung ulang kedua tab tanpa menunggu sync jam 5 pagi.
function refreshCustomerNow() {
  const t0 = new Date();
  SYNC_START = Date.now();
  const today   = stripTime(new Date());
  const onboard = _onboardDate();
  const invoices = fetchSalesInvoices();               // sudah ter-normalisasi
  enrichReceipts(invoices, onboard, today);
  invoices.forEach(function(i) { i.pool = classifyPool(i, onboard, today); });
  attachCustomerContacts(invoices);
  const tierMap = computeCustomerTiers(invoices, today);
  invoices.forEach(function(i) {
    const t = tierMap[_custKey(i)];
    i.custTier = t ? t.tier : '';
    i.custTierText = t ? t.text : '';
  });

  const masterSS = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const yCust = collectCustomerYellow([masterSS]);
  const yTurun = (typeof collectTurunYellow === 'function') ? collectTurunYellow([masterSS]) : {};
  const rapor = buildCustomerReport(invoices, today, yCust);
  writeCustomerTab(rapor);
  if (typeof writeTurunBukuTab === 'function') {
    const health = computeBusinessHealth(invoices, { invoices: invoices }, today);
    writeTurunBukuTab(buildTurunBuku(rapor, health, today, yTurun));
  }
  // Dua tab turunan rapor di master. File Deden tetap menunggu sync penuh (butuh TARGET_SS swap).
  writeStopSupplyTab(buildStopSupply(invoices, today, rapor));
  writeCustomerStatusTab(buildCustomerStatus(rapor), 'master');
  Logger.log('Rapor Customer selesai · ' + rapor.list.length + ' customer · ' +
    ((new Date() - t0) / 1000).toFixed(1) + 's');
}
