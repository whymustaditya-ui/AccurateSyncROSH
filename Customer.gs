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
 * writer Ade atau Deden, dan jangan masuk TABS_DEDEN.
 *
 * Depends: Sync.gs (_custKey, num, stripTime, DAY_MS, parseAccDate), Kpi.gs (rupiah, clamp),
 * Style.gs (UI helpers), Restock.gs (_loadSkuSalesCache, _loadItemCache, _mblock).
 */

var CUST_HEADERS = [
  'Customer', 'Sales', 'Tier (4bln)', 'Keputusan', 'Skor Bayar', 'Risiko',
  'Rata2 Telat (hari)', 'Lewat H+15', 'Nunggak Sekarang', 'Telat Terlama (hari)',
  'Belanja / bln', 'Cakupan Data', 'Omzet Tercakup', 'Margin Kotor', 'Margin Kotor %',
  'Biaya Modal', 'Margin Bersih', 'Margin Bersih %', 'Cadangan Risiko',
  'Saran Limit', 'Jatah Plafon', 'Saran Tempo (hari)', 'Saran Naik Harga', 'Alasan',
  'Limit Disetujui', 'Catatan Nathan'
];
var CUST_SPAN     = CUST_HEADERS.length;   // 26
var CUST_COL_YEL1 = 25;                    // 🟡 Limit Disetujui
var CUST_COL_YEL2 = 26;                    // 🟡 Catatan Nathan
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

  const winStart = _monthsBack(today, C.LIMIT_WINDOW_MONTHS);

  invs.forEach(function(i) {
    invCount++;
    if (i.transDate) {
      if (!lastTrans || i.transDate > lastTrans) lastTrans = i.transDate;
      if (i.transDate >= winStart) belanjaWin += i.total;
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
    cadangan: cadangan, belanjaBulanan: belanjaBulanan, bulanTertahan: bulanTertahan,
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
function _custMarginStats(g, ctx) {
  const C = CONFIG.CUSTOMER;
  const out = { ok: false, cakupan: 0, cakupanBiaya: 0, omzetTercakup: 0, lineRevenue: 0,
                hpp: 0, diskon: 0, marginKotor: 0, marginKotorPct: null, biayaModal: 0,
                marginBersih: 0, marginBersihPct: null, naikPct: 0, rugiRp: 0, rugiPct: 0,
                costHist: 0, costSnap: 0, histPct: 0 };
  if (!ctx || !ctx.enabled) return out;

  let totWin = 0, totCovered = 0, costKnown = 0, costAll = 0;
  const coveredInvs = [];

  g.invs.forEach(function(i) {
    if (!i.transDate || i.transDate < ctx.winStart) return;
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
  out.ok = (out.cakupan >= C.MIN_COVERAGE && out.cakupanBiaya >= C.MIN_COST_COVERAGE &&
            out.omzetTercakup >= C.MIN_OMZET_RP && out.lineRevenue > 0);

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
function _custVerdict(p, m, sc, arBook) {
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
      return { verdict: '🆕 BARU', alasan: 'Faktur pertama, belum ada riwayat bayar. Mulai dari COD dulu.',
               limit: C.LIMIT_BARU, tempo: C.TEMPO_BARU, rank: true };
    }
    if (p.nPaid === 0 && p.outstanding <= 0) {
      return { verdict: '⚪ BELUM DINILAI', alasan: 'Belum ada pembayaran yang bisa dinilai.',
               limit: 0, tempo: 0, rank: false };
    }
  }

  // Tempo: mesin hanya boleh MEMPERKETAT. Melonggarkan tetap keputusan orang.
  let tempo = C.TEMPO_BAND[sc.band];
  if (C.TEMPO_ONLY_TIGHTEN && p.tempoModus != null) tempo = Math.min(tempo, p.tempoModus);
  tempo = clamp(tempo, 0, C.TEMPO_MAX);

  // Limit mentah: belanja sebulan × panjang tempo × kelonggaran sesuai risiko.
  // Kalimat yang bisa diucapkan ke customer: "cukup untuk satu siklus tempo penuh, plus cadangan".
  let limit = p.belanjaBulanan * (tempo / 30) * C.HEADROOM[sc.band];
  limit = Math.floor(limit / C.LIMIT_ROUND) * C.LIMIT_ROUND;
  if (limit > 0) limit = clamp(limit, C.LIMIT_MIN, C.LIMIT_MAX);
  // Aturan konsentrasi: tak boleh ada satu customer yang bisa menjatuhkan ROSH sendirian.
  if (arBook > 0) limit = Math.min(limit, Math.floor(arBook * C.CONC_PCT / C.LIMIT_ROUND) * C.LIMIT_ROUND);

  const marginTipis = m.ok && m.marginBersihPct != null && m.marginBersihPct < C.TARGET_MARGIN_PCT;

  let verdict, alasan;
  if (sc.band === 'BAHAYA') {
    verdict = '🔴 STOP-COD';
    alasan = 'Skor bayar ' + sc.skor + (sc.override ? ', ' + sc.override : '') +
             '. Jangan proses order baru sampai lunas, kalau mau lanjut minta bayar di muka.';
    limit = 0; tempo = 0;                       // invariant: STOP ⇒ limit 0, tempo 0
  } else if (marginTipis) {
    verdict = '🟠 NAIKKAN HARGA';
    alasan = 'Bayarnya ' + (sc.band === 'AMAN' ? 'rapi' : 'lumayan') + ' (skor ' + sc.skor +
             ') tapi margin bersihnya cuma ' + (m.marginBersihPct * 100).toFixed(1) +
             '% setelah biaya modal. Naikkan harga ' + (m.naikPct * 100).toFixed(1) +
             '% dulu sebelum order berikutnya.';
  } else if (sc.band === 'AMAN') {
    verdict = '🟢 GAS';
    alasan = 'Bayar rapi (skor ' + sc.skor + '). Order baru jalan normal.';
  } else {
    verdict = '🟡 GAS TERBATAS';
    alasan = 'Skor bayar ' + sc.skor + (sc.override ? ', ' + sc.override : '') +
             '. Boleh jalan tapi jangan lewat Saran Limit, dan pakai tempo ' + tempo + ' hari.';
  }
  if (!m.ok && CONFIG.CUSTOMER.MARGIN_ENABLED) {
    alasan += ' Data margin belum lengkap (cakupan ' + Math.round(m.cakupan * 100) +
              '%), keputusan dari sisi bayar saja.';
  }
  return { verdict: verdict, alasan: alasan, limit: limit, tempo: tempo, rank: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALOKASI PLAFON — pola _allocateCart (Restock): rangking, lalu bagi budget top-down.
// Item kecil di belakang tetap bisa masuk kalau sisa budget cukup.
// ─────────────────────────────────────────────────────────────────────────────
function _allocateCredit(rows, budget) {
  const eligible = rows.filter(function(r) { return r.rank && r.limit > 0; })
    .sort(function(a, b) {
      // Kualitas per rupiah kredit: yang memberi nilai terbesar per rupiah yang kita tanggung.
      const qa = (a.margin.ok ? a.margin.marginBersih : 0) / Math.max(1, a.limit);
      const qb = (b.margin.ok ? b.margin.marginBersih : 0) / Math.max(1, b.limit);
      if (qb !== qa) return qb - qa;
      if (b.skor !== a.skor) return b.skor - a.skor;
      return b.belanjaBulanan - a.belanjaBulanan;
    });

  let sisa = budget;
  eligible.forEach(function(r) {
    if (r.limit <= sisa) { r.jatah = r.limit; sisa -= r.limit; }
    else { r.jatah = 0; }
  });
  return { terpakai: budget - sisa, sisa: sisa };
}

// Plafon kredit bulan berjalan. Prioritas: ① cell 🟡 yang diketik di sheet → ② Script Property
// → ③ target glide path bulan ini (TurunBuku.gs) → ④ TARGET_AR.
function _readCreditBudget() {
  try {
    const sh = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TABS.CUSTOMER);
    if (!sh) return null;
    const last = Math.min(sh.getLastRow(), 20);
    if (last < 1) return null;
    const vals = sh.getRange(1, 1, last, 5).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!/^Plafon kredit bulan ini \(ketik/i.test(String(vals[i][0]))) continue;
      for (let c = 1; c < 5; c++) {
        const v = vals[i][c];
        if (v === '' || v == null) continue;
        if (typeof v === 'number') return v > 0 ? v : null;
        const digits = String(v).replace(/[^0-9]/g, '');
        if (digits) return Number(digits);
      }
      return null;
    }
  } catch (e) { Logger.log('Baca plafon kredit manual gagal: ' + e.message); }
  return null;
}

function _resolveCreditBudget(today, arBook) {
  const cell = _readCreditBudget();
  if (cell && cell > 0) return { budget: cell, src: 'manual (ketik di sheet)' };
  const prop = _props().getProperty(CONFIG.TURUN_BUKU.BUDGET_PROP);
  if (prop && num(prop) > 0) return { budget: num(prop), src: 'Script Property ' + CONFIG.TURUN_BUKU.BUDGET_PROP };
  if (typeof _glideTargetFor === 'function') {
    const t = _glideTargetFor(today, arBook);
    if (t && t > 0) return { budget: Math.round(t), src: 'target glide path bulan ini' };
  }
  return { budget: CONFIG.TURUN_BUKU.TARGET_AR, src: 'target akhir program' };
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
                      fakturTercakup: 0, fakturTotal: 0 };
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
    const v  = _custVerdict(p, m, sc, arBook);
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
      margin: m, limit: v.limit, tempo: v.tempo, jatah: 0,
      limitDisetujui: y.limit || '', catatan: y.catatan || ''
    });
  });

  const bud = _resolveCreditBudget(today, arBook);
  const alloc = _allocateCredit(list, bud.budget);

  list.sort(function(a, b) {
    const ra = CUST_VERDICT_RANK[a.verdict] || 9, rb = CUST_VERDICT_RANK[b.verdict] || 9;
    if (ra !== rb) return ra - rb;
    const va = Math.max(a.outstanding, Math.abs(a.margin.ok ? a.margin.marginBersih : 0));
    const vb = Math.max(b.outstanding, Math.abs(b.margin.ok ? b.margin.marginBersih : 0));
    return vb - va;
  });

  const totals = { arBook: arBook, budget: bud.budget, budgetSrc: bud.src,
                   terpakai: alloc.terpakai, sisa: alloc.sisa,
                   priorBuku: priorBuku, marginCtx: marginCtx,
                   dinilai: list.filter(function(r) { return r.rank; }).length,
                   jumlah: list.length,
                   perVerdict: {}, cadangan: 0, marginBersih: 0, biayaModal: 0,
                   lineRevenue: 0, rugiRp: 0, costHist: 0, costSnap: 0, tempoCount: 0 };
  list.forEach(function(r) {
    const b = totals.perVerdict[r.verdict] = totals.perVerdict[r.verdict] || { n: 0, rp: 0 };
    b.n++; b.rp += r.outstanding;
    totals.cadangan += r.cadangan;
    if (r.margin.ok) {
      totals.marginBersih += r.margin.marginBersih;
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
  (files || []).forEach(function(ss) {
    if (!ss) return;
    try {
      const sh = ss.getSheetByName(CONFIG.TABS.CUSTOMER);
      if (!sh) return;
      const last = sh.getLastRow();
      if (last < 2) return;
      const vals = sh.getRange(1, 1, last, CUST_SPAN).getValues();
      vals.forEach(function(row) {
        const nama = String(row[0] || '').trim();
        if (!nama || nama === 'Customer') return;
        const lim = row[CUST_COL_YEL1 - 1], cat = row[CUST_COL_YEL2 - 1];
        if (lim === '' && cat === '') return;
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
  const SPAN = CUST_SPAN;
  const t = report.totals;
  const mc = t.marginCtx;

  let r = uiBanner(sh, 1, SPAN, '🧭 Rapor Customer — boleh kasih order baru atau tidak',
    'Dua sudut pandang: SKOR BAYAR dari seluruh riwayat pembayaran (kelakuan lama luntur separuh ' +
    'tiap 6 bulan) dan MARGIN BERSIH setelah biaya modal piutang. Semua kolom Saran bersifat ' +
    'usulan; penerapannya manual di Accurate oleh Nathan. Dibuat ulang otomatis tiap jam 5 pagi.',
    UI.INK, UI.BAND);

  // ── RINGKAS ──
  r = uiSection(sh, r, SPAN, 'RINGKAS PORTOFOLIO', UI.GREEN);
  const ringkas = [
    ['Plafon kredit bulan ini (ketik →)', t.budget, 'Sumber: ' + t.budgetSrc +
      '. Kosongkan untuk ikut target program otomatis.'],
    ['Terpakai oleh saran limit', t.terpakai, t.sisa >= 0
      ? 'Sisa ' + rupiah(t.sisa) : 'KELEBIHAN ' + rupiah(-t.sisa)],
    ['Piutang berjalan sekarang', t.arBook, 'Total outstanding seluruh customer'],
    ['Customer pegang tempo', t.tempoCount + ' customer', 'Ini angka yang harus turun, bukan cuma rupiahnya'],
    ['Customer dinilai', t.dinilai + ' dari ' + t.jumlah,
      'Sisanya tunai, dorman, atau belum cukup data'],
    ['Cadangan risiko', t.cadangan, 'Perkiraan bagian piutang yang berpotensi tidak tertagih']
  ];
  ['🟢 GAS', '🟡 GAS TERBATAS', '🟠 NAIKKAN HARGA', '🔴 STOP-COD'].forEach(function(v) {
    const b = t.perVerdict[v];
    if (b) ringkas.push([v, b.n + ' customer', 'nunggak ' + rupiah(b.rp)]);
  });
  if (mc.enabled) {
    ringkas.push(['Kualitas data margin',
      mc.fakturTercakup + ' / ' + mc.fakturTotal + ' faktur ketarik',
      mc.fakturTercakup < mc.fakturTotal
        ? '⚠ Belum lengkap. Run Full Sync lagi sampai penuh.' : '✓ lengkap']);
    ringkas.push(['Margin bersih buku', t.marginBersih,
      'setelah biaya modal ' + rupiah(t.biayaModal) + ' (' +
      Math.round(CONFIG.CUSTOMER.COST_OF_CAPITAL_ANNUAL * 100) + '% per tahun) atas omzet ' +
      rupiah(t.lineRevenue)]);
    if (t.rugiRp > 0) {
      const rp = t.lineRevenue > 0 ? t.rugiRp / t.lineRevenue : 0;
      const hist = (t.costHist + t.costSnap) > 0 ? t.costHist / (t.costHist + t.costSnap) : 0;
      ringkas.push(['⚠ Dijual di bawah modal', t.rugiRp,
        (rp * 100).toFixed(1) + '% dari omzet. ' +
        (hist < 0.5
          ? 'HATI-HATI membacanya: baru ' + Math.round(hist * 100) + '% omzet yang punya harga beli ' +
            'historis, sisanya dibandingkan dengan harga beli HARI INI, padahal harga beli naik-turun. ' +
            'Faktur lama bisa kelihatan rugi padahal saat itu untung. Jalankan menu Diag jual di bawah modal ' +
            'dan lihat sebaran per bulan.'
          : 'Harga beli historis sudah menutup ' + Math.round(hist * 100) + '% omzet, jadi angka ini ' +
            'sudah cukup bisa dipercaya. Jalankan menu Diag jual di bawah modal untuk rinciannya.')]);
    }
  } else {
    ringkas.push(['Sisi margin', 'BELUM AKTIF',
      'Jalankan menu Diag vendorPrice dulu, baru nyalakan CONFIG.CUSTOMER.MARGIN_ENABLED']);
  }
  const budgetRow = r;
  ringkas.forEach(function(row, idx) {
    _mblock(sh, r, 1, 3, row[0]).setFontWeight(idx === 0 ? 'bold' : 'normal');
    const cell = _mblock(sh, r, 4, 6, row[1]);
    if (typeof row[1] === 'number') cell.setNumberFormat('"Rp"#,##0');
    if (idx === 0) cell.setBackground(UI.AMBER_BODY).setFontWeight('bold')
                       .setBorder(true, true, true, true, false, false, UI.GOLD,
                                  SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    _mblock(sh, r, 7, SPAN, row[2]).setFontColor(UI.NOTE).setFontStyle('italic');
    r++;
  });
  r++;

  // Tiap blok baris data dicatat supaya format angka DAN conditional format kena ke dua-duanya.
  // Bug 2026-09-02: seksi PERLU AKSI SEKARANG sama sekali tak terformat (rasio tampil sebagai
  // 0.4881874098, rupiah sebagai 20331182.17) karena format cuma dipasang ke blok terakhir.
  const blocks = [];

  // ── PERLU AKSI SEKARANG ──
  const urgent = report.list.filter(function(x) {
    return x.verdict === '🔴 STOP-COD' || x.verdict === '🟠 NAIKKAN HARGA';
  }).slice(0, 25);
  r = uiSection(sh, r, SPAN, '⚠️ PERLU AKSI SEKARANG', UI.RED);
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
  r = uiSection(sh, r, SPAN, '📋 SEMUA CUSTOMER', UI.INK);
  const hrow = r;
  uiHeaderRow(sh, r, CUST_HEADERS); r++;
  const first = r;
  blocks.push({ first: r, n: report.list.length });
  r = _custWriteRows(sh, r, report.list);

  // pita TOTAL
  const totOut = report.list.reduce(function(s, x) { return s + x.outstanding; }, 0);
  const totJatah = report.list.reduce(function(s, x) { return s + (x.jatah || 0); }, 0);
  sh.getRange(r, 1, 1, SPAN).setBackground(UI.INK).setFontColor(UI.WHITE).setFontWeight('bold');
  sh.getRange(r, 1).setValue('TOTAL — ' + report.list.length + ' customer');
  sh.getRange(r, 9).setValue(totOut).setNumberFormat('"Rp"#,##0');
  sh.getRange(r, 21).setValue(totJatah).setNumberFormat('"Rp"#,##0');
  const totRow = r; r++;

  // WAJIB sekali untuk semua blok: setConditionalFormatRules mengganti SELURUH aturan sheet,
  // jadi memanggilnya per blok akan menghapus aturan blok sebelumnya.
  _custCondFormats(sh, blocks);
  sh.setFrozenRows(hrow);
  sh.setFrozenColumns(1);

  r = uiFootnote(sh, r, SPAN,
    '◆ Sisi bayar memakai SELURUH riwayat faktur; sisi margin maksimal ' +
    CONFIG.CUSTOMER.MARGIN_WINDOW_MONTHS + ' bulan karena data rincian barang lebih tua dari itu ' +
    'sudah dihapus otomatis. Harga beli memakai harga TERAKHIR di Accurate, jadi margin bersifat ' +
    'indikatif untuk membandingkan antar customer, bukan angka pembukuan. Retur barang belum ' +
    'terhitung (tidak ada sumbernya di API), jadi margin customer yang sering retur agak ' +
    'kelebihan. Kolom Limit Disetujui dan Catatan Nathan diisi manual dan tidak akan tertimpa sync.');
  r++;

  _custCaraBaca(sh, r, SPAN);

  const w = [220, 120, 150, 140, 90, 95, 110, 90, 130, 110, 130, 100, 130, 130, 105, 120,
             130, 110, 120, 130, 120, 110, 110, 380, 130, 220];
  w.forEach(function(px, i) { sh.setColumnWidth(i + 1, px); });
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
      x.rank ? x.skor : '', x.rank ? x.band : '',
      x.wadl == null ? '' : Math.round(x.wadl),
      x.shareH15 == null ? '' : x.shareH15,
      x.outstanding, x.maxOpenDpd == null ? '' : x.maxOpenDpd,
      x.belanjaBulanan,
      M ? m.cakupan : '',
      showM ? m.omzetTercakup : (M ? CUST_NO_MARGIN : ''),
      showM ? m.marginKotor : (M ? CUST_NO_MARGIN : ''),
      showM && m.marginKotorPct != null ? m.marginKotorPct : '',
      showM ? m.biayaModal : '',
      showM ? m.marginBersih : '',
      showM && m.marginBersihPct != null ? m.marginBersihPct : '',
      x.cadangan,
      x.limit, x.jatah, x.tempo,
      showM && m.naikPct > 0 ? m.naikPct : '',
      x.alasan, x.limitDisetujui, x.catatan
    ];
  });
  sh.getRange(row, 1, matrix.length, CUST_SPAN).setValues(matrix).setVerticalAlignment('middle');
  sh.getRange(row, 1, matrix.length, CUST_SPAN)
    .setBorder(true, true, true, true, true, true, UI.BORDER, SpreadsheetApp.BorderStyle.SOLID);
  _custNumberFormats(sh, row, matrix.length);
  return row + matrix.length;
}

// Format angka SATU blok baris. Dipanggil dari _custWriteRows sehingga berlaku untuk setiap
// seksi yang menulis baris customer, bukan cuma yang terakhir.
function _custNumberFormats(sh, first, n) {
  if (n <= 0) return;
  [9, 11, 13, 14, 16, 17, 19, 20, 21, 25].forEach(function(c) {      // rupiah, tanpa desimal
    sh.getRange(first, c, n, 1).setNumberFormat('"Rp"#,##0').setHorizontalAlignment('right');
  });
  [8, 12, 15, 18, 23].forEach(function(c) {                          // persen, 1 desimal
    sh.getRange(first, c, n, 1).setNumberFormat('0.0%').setHorizontalAlignment('center');
  });
  [5, 7, 10, 22].forEach(function(c) {                               // bilangan bulat
    sh.getRange(first, c, n, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
  });
  sh.getRange(first, 1, n, 4).setHorizontalAlignment('left');
  sh.getRange(first, 6, n, 1).setHorizontalAlignment('center');
  sh.getRange(first, 24, n, 1).setWrap(true).setVerticalAlignment('top');
  sh.getRange(first, 26, n, 1).setWrap(true).setVerticalAlignment('top');
  sh.getRange(first, CUST_COL_YEL1, n, 2).setBackground(UI.AMBER_BODY);
}

// Conditional format untuk SEMUA blok sekaligus (lihat catatan di writeCustomerTab).
function _custCondFormats(sh, blocks) {
  const use = (blocks || []).filter(function(b) { return b && b.n > 0; });
  if (!use.length) return;
  const rng = function(col) {
    return use.map(function(b) { return sh.getRange(b.first, col, b.n, 1); });
  };
  const kep = rng(4), skor = rng(5), telat = rng(10), cak = rng(12);
  const mb = rng(17), mbPct = rng(18), naik = rng(23), tier = rng(3);
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
    R().whenNumberLessThan(CONFIG.CUSTOMER.MIN_COVERAGE).setBackground(UI.T_AMBER).setRanges(cak).build(),
    R().whenNumberLessThan(0).setBackground(UI.T_RED).setRanges(mb).build(),
    R().whenNumberLessThan(CONFIG.CUSTOMER.TARGET_MARGIN_PCT).setBackground(UI.T_AMBER).setRanges(mbPct).build(),
    R().whenNumberGreaterThan(0).setBackground('#fed7aa').setRanges(naik).build(),
    R().whenTextStartsWith('A').setBackground(UI.T_GREEN).setRanges(tier).build(),
    R().whenTextStartsWith('B').setBackground(UI.BLUE_SOFT).setRanges(tier).build(),
    R().whenTextStartsWith('C').setBackground(UI.T_AMBER).setRanges(tier).build(),
    R().whenTextStartsWith('D').setBackground(UI.T_GREY).setRanges(tier).build()
  ]);
}

function _custCaraBaca(sh, row, SPAN) {
  let r = uiSection(sh, row, SPAN, '📖 CARA BACA', UI.GOLD);
  sh.getRange(r, 1, 1, SPAN).merge().setValue(
    'Cara pakai cepat: baca kolom Keputusan saja. 🟢 GAS berarti aman, order baru jalan. ' +
    '🟡 GAS TERBATAS berarti boleh jalan tapi jangan lewat Saran Limit dan pakai tempo yang lebih ' +
    'pendek. 🟠 NAIKKAN HARGA berarti dia bayar oke tapi kita nyaris tidak untung, naikkan harga ' +
    'sebesar kolom Saran Naik Harga sebelum order berikutnya. 🔴 STOP-COD berarti jangan proses ' +
    'order baru sampai lunas, kalau mau lanjut minta bayar di muka.')
    .setBackground(UI.GREEN_SOFT).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(r, 56); r++;

  const rows = [
    ['Keputusan', 'Kesimpulan gabungan dua hal: seberapa rapi dia bayar, dan seberapa untung kita dari dia setelah dikurangi biaya modal.'],
    ['Skor Bayar', '0 sampai 100, makin tinggi makin rapi bayarnya. Dihitung dari SELURUH riwayat pembayaran, tapi kelakuan lama luntur separuh tiap 6 bulan sehingga customer yang sudah memperbaiki diri tidak dihukum selamanya. Ditimbang rupiah: telat di faktur besar lebih berat daripada telat di faktur kecil. Faktur yang masih terbuka hari ini ikut dihitung, jadi orang yang sedang macet tidak bisa sembunyi di balik riwayat lama yang bersih.'],
    ['Risiko', 'Terjemahan Skor Bayar jadi kata: AMAN, HATI, RISIKO, BAHAYA. Ambangnya angka tetap, bukan peringkat, supaya kalau seluruh pelanggan memburuk tidak ada yang lolos hanya karena paling bagus di antara yang jelek.'],
    ['Rata2 Telat', 'Rata rata berapa hari lewat jatuh tempo uangnya baru masuk, ditimbang nilai rupiah. Hanya menghitung yang SUDAH dibayar, jadi bacanya: kalau dia bayar, telatnya sekian.'],
    ['Lewat H+15', 'Berapa persen rupiah dia yang sampai harus diambil alih ' + CONFIG.AR_OFFICER_NAME + '. Ini ukuran ekor, bukan rata rata: ada customer yang rata ratanya bagus tapi sesekali menghilang lama.'],
    ['Nunggak Sekarang', 'Sisa tagihan yang belum dibayar hari ini. Angka ini sama persis dengan TOP DEBITUR di tab Ringkasan.'],
    ['Telat Terlama', 'Faktur terbuka paling lama, dihitung dari jatuh tempo. Kalau lewat ' + CONFIG.CUSTOMER.STOP_DPD + ' hari, Keputusan langsung merah berapa pun skornya.'],
    ['Belanja / bln', 'Rata rata nilai faktur per bulan selama ' + CONFIG.CUSTOMER.LIMIT_WINDOW_MONTHS + ' bulan terakhir. Ini dasar hitungan Saran Limit.'],
    ['Cakupan Data', 'Berapa persen faktur customer ini yang rincian barangnya sudah ketarik dari Accurate. Di bawah ' + Math.round(CONFIG.CUSTOMER.MIN_COVERAGE * 100) + '% berwarna kuning dan semua kolom margin ditulis belum bisa dihitung, karena menebak margin dari data separuh lebih berbahaya daripada tidak menampilkannya.'],
    ['Margin Kotor', 'Nilai jual barang dikurangi harga beli, sudah dikurangi diskon faktur. Harga beli memakai harga beli TERAKHIR di Accurate, jadi angka ini indikatif untuk membandingkan antar customer, bukan angka pembukuan.'],
    ['Biaya Modal', 'Harga dari uang yang nongkrong di customer. Dihitung sejak faktur terbit sampai uang benar benar masuk, bukan cuma hari telatnya, karena tempo yang kita berikan juga ada biayanya. Tarif ' + Math.round(CONFIG.CUSTOMER.COST_OF_CAPITAL_ANNUAL * 100) + '% per tahun.'],
    ['Margin Bersih', 'Margin Kotor dikurangi Biaya Modal. Inilah angka yang membongkar pola omzet besar margin tipis: kalau dia bayarnya lambat, biaya modal memakan habis marginnya dan kolom ini jadi merah walaupun omzetnya kelihatan mantap.'],
    ['Cadangan Risiko', 'Perkiraan bagian tagihan yang berpotensi tidak tertagih, dihitung dari umur tunggakannya.'],
    ['Saran Limit', 'Belanja per bulan dikali panjang tempo dibagi 30, dikali kelonggaran sesuai risiko. Artinya cukup untuk satu siklus tempo penuh plus cadangan. Dibatasi maksimal ' + Math.round(CONFIG.CUSTOMER.CONC_PCT * 100) + '% dari total piutang ROSH supaya tidak ada satu customer pun yang bisa menjatuhkan kita sendirian.'],
    ['Jatah Plafon', 'Saran Limit setelah dibagi rata dari plafon kredit bulan ini. Kalau plafon tidak cukup untuk semua, yang memberi nilai terbesar per rupiah kredit dapat duluan, sisanya kebagian nol dan sementara dilayani COD.'],
    ['Saran Tempo', 'Tempo yang disarankan. Mesin hanya boleh MEMPERPENDEK tempo, tidak pernah memperpanjang sendiri. Melonggarkan tempo tetap keputusan orang.'],
    ['Saran Naik Harga', 'Kenaikan harga yang dibutuhkan supaya customer ini mencapai margin bersih ' + Math.round(CONFIG.CUSTOMER.TARGET_MARGIN_PCT * 100) + '%. Muncul hanya kalau margin bersihnya tipis. Naikkan harga dulu, lepas belakangan.'],
    ['Kelas khusus', '💵 TUNAI berarti dia belum pernah diberi tempo sama sekali, jadi catatan bayarnya yang sempurna itu belum membuktikan apa apa. 🆕 BARU berarti faktur pertama. ⚪ BELUM DINILAI berarti data belum cukup. 😴 DORMAN berarti tidak ada order ' + CONFIG.CUSTOMER.DORMANT_MONTHS + ' bulan terakhir.'],
    ['Dua kolom kuning', 'Limit Disetujui dan Catatan Nathan diisi tangan dan tidak akan tertimpa sync. Kalau Limit Disetujui diisi, angka itulah yang berlaku, bukan Saran Limit.']
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
  Logger.log('Rapor Customer selesai · ' + rapor.list.length + ' customer · ' +
    ((new Date() - t0) / 1000).toFixed(1) + 's');
}
