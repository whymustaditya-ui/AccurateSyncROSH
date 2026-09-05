/**
 * ROSH × Accurate — Pesan Penagihan (ready-to-send WhatsApp collection messages).
 *
 * Group-by-CUSTOMER: 1 pesan per pelanggan menggabungkan semua faktur-nya yang ada di
 * window penagihan H-3 → H+CONFIG.PENAGIHAN_WINDOW_MAX (14), mengikuti jadwal tagih Panduan
 * Sales v1.0 bagian 6: H-3 & H0 reminder kantor, H+3 dan H+7 tindak lanjut, H+14 terakhir
 * sebelum handover Ade (H+1 telepon dan H+3 kunjungan adalah tugas sales, bukan pesan WA).
 * Nathan/Deden tinggal COPY teks atau TAP link wa.me yang pesannya sudah terisi (manual Send,
 * BUKAN auto-send; lihat catatan Reminders.gs yang dihapus 2026-05-31).
 *
 * Scope = WINDOW-ONLY: hanya faktur dengan daysPastDue ∈ [WINDOW_MIN, WINDOW_MAX] yang masuk
 * pesan & total. Faktur yang belum jatuh tempo (jauh dari H-3) TIDAK disebut. "Gabung" hanya
 * terjadi bila ≥2 faktur customer sama-sama di window.
 *
 * Sejak 2026-09-05 file ini hanya BUILDER + TEKS PESAN: penagihan (_penagihanMessageBatch) dan
 * sapa jualan (_sapaMessage). Writer-nya ada di Todo.gs (tab 📌 To-Do Harian, master + Deden),
 * menggantikan tab ✉️ Pesan Penagihan. Semua copy customer-facing tetap terkumpul di sini.
 *
 * Pure projection — no Accurate call, no new OAuth scope. Depends on Sync.gs (fields, fmtDate)
 * + Kpi.gs (rupiah) + Faktur.gs (FAKTUR const).
 */

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER — group faktur belum lunas (daysPastDue ∈ [-1, WINDOW_MAX]) per customer.
// ─────────────────────────────────────────────────────────────────────────────
function buildPenagihanBatch(invoices, today) {
  const lo = CONFIG.PENAGIHAN_WINDOW_MIN, hi = CONFIG.PENAGIHAN_WINDOW_MAX;
  const byCust = {};
  invoices.forEach(function(i) {
    if (i.isPaid || !(i.outstanding > 0)) return;
    const dpd = (typeof i.daysPastDue === 'number') ? i.daysPastDue : null;
    if (dpd == null || dpd < lo || dpd > hi) return;       // window-only
    const name = String(i.customer || '').trim();
    if (!name) return;
    let c = byCust[name];
    if (!c) c = byCust[name] = { customer: name, noTlp: '', noVa: '', tierText: '', salesman: '',
                                 invoices: [], totalOutstanding: 0, maxDaysPastDue: -Infinity };
    c.invoices.push({ number: i.number, outstanding: i.outstanding, dueDate: i.dueDate, daysPastDue: dpd });
    c.totalOutstanding += i.outstanding;
    if (!c.noTlp && i.noTlp) c.noTlp = i.noTlp;
    if (!c.noVa  && i.noVa)  c.noVa  = i.noVa;          // VA milik customer (sama per customer)
    if (i.custTierText) c.tierText = i.custTierText;
    if (dpd > c.maxDaysPastDue) { c.maxDaysPastDue = dpd; c.salesman = i.salesman || c.salesman; }
  });

  return Object.keys(byCust).map(function(k) {
    const c = byCust[k];
    c.bucket = _penagihanBucket(c.maxDaysPastDue);
    c.invoices.sort(function(a, b) { return b.daysPastDue - a.daysPastDue; }); // paling overdue dulu
    return c;
  }).sort(function(a, b) { return b.maxDaysPastDue - a.maxDaysPastDue; });
}

// Bucket jadwal SOP (H-3 / H0 / H+3 / H+7 / H+14). Label internal untuk warna & filter;
// TIDAK muncul di teks customer. Ambang atas tiap bucket = hari terakhir bucket itu.
function _penagihanBucket(dpd) {
  if (dpd < 0)   return 'H-3 · Sebelum jatuh tempo';
  if (dpd <= 2)  return 'H0 · Jatuh tempo';
  if (dpd <= 6)  return 'H+3 · Tindak lanjut';
  if (dpd <= 13) return 'H+7 · Stop-supply';
  return 'H+14 · Terakhir';
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE — normalise to digit-only international (62…) for wa.me. Handles ROSH's
// messy stored formats: "085…", "8…", "+62 822-9853-6306", "(POS / online)" → blank.
// ─────────────────────────────────────────────────────────────────────────────
function _waPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('62') === 0)      d = d;                 // already international
  else if (d.charAt(0) === '0')   d = '62' + d.slice(1); // local 0-prefix
  else if (d.charAt(0) === '8')   d = '62' + d;          // bare mobile
  else                            d = '62' + d;          // fallback
  return d.length >= 9 ? d : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE — natural Bahasa, group-by-customer. Semua copy customer-facing terkumpul di
// fungsi ini biar Bro gampang tune. Tier A/B di-soften; daftar semua faktur in-window +
// total; CTA bukti transfer (set up window Qontak).
//
// ⚠ Copy DIREVISI 2026-07-28 setelah komplain partner: nada lama terlalu keras (H+7 ancam
// "order baru kami tahan sampai pelunasan", H+14 "sebelum kami tindak lanjuti lebih jauh")
// sampai beberapa toko plastik MEMBLOKIR nomor WA ROSH. Nada baru semi-formal: sapaan WA
// tetap hangat, badan pesan gaya korespondensi sopan. Stop-supply masih disinggung di H+7
// tapi diframing sebagai enabler ("agar order berikutnya dapat langsung kami proses"),
// bukan sanksi. Leverage sebenarnya tetap di tab ⛔ Stop Supply + hold manual Nathan.
// ─────────────────────────────────────────────────────────────────────────────
function _penagihanMessageBatch(c) {
  const cust = c.customer || 'Bapak/Ibu';
  const tier = String(c.tierText || '').charAt(0); // 'A'|'B'|'C'|'D'|''
  const dpd  = c.maxDaysPastDue;

  let msg = 'Halo Bapak/Ibu ' + cust + ', ';
  if (tier === 'A' || tier === 'B') msg += 'terima kasih atas kepercayaan dan kerja samanya selama ini. ';

  if (dpd < 0) {
    msg += 'mohon izin mengingatkan, tagihan berikut akan jatuh tempo dalam ' + (-dpd) + ' hari' +
           (dpd === -1 ? ' (besok)' : '') + '. Apabila pembayaran sudah dijadwalkan, kami ucapkan terima kasih.';
  } else if (dpd <= 2) {
    msg += 'mohon izin mengingatkan, tagihan berikut ' + (dpd === 0 ? 'jatuh tempo hari ini' : 'telah jatuh tempo') +
           '. Apabila pembayaran sudah dijadwalkan, kami ucapkan terima kasih.';
  } else if (dpd <= 6) {
    msg += 'mohon izin melakukan follow up untuk tagihan berikut yang telah melewati tanggal jatuh tempo. Apabila pembayaran masih dalam proses, kami akan sangat terbantu bila Bapak/Ibu berkenan menginformasikan estimasi waktu pembayarannya.';
  } else if (dpd <= 13) {
    msg += 'mohon izin kembali menindaklanjuti tagihan berikut yang masih tercatat belum terselesaikan. Kami akan sangat menghargai bila Bapak/Ibu dapat menginformasikan estimasi waktu pembayarannya, agar order berikutnya dapat langsung kami proses.';
  } else {
    msg += 'mohon izin menindaklanjuti kembali tagihan berikut yang hingga saat ini masih tercatat belum terselesaikan. Kami akan sangat menghargai bila Bapak/Ibu dapat memberikan konfirmasi jadwal pembayarannya. Apabila ada hal yang ingin didiskusikan terkait pembayaran, kami dengan senang hati siap membantu.';
  }

  msg += '\n';
  c.invoices.forEach(function(iv) {
    msg += '\n• ' + iv.number + ' : ' + rupiah(iv.outstanding) + ' (jatuh tempo ' + fmtDate(iv.dueDate) + ')';
  });
  if (c.invoices.length > 1) msg += '\n\nTotal tagihan: ' + rupiah(c.totalOutstanding);

  // VA DULU baru rekening biasa: transfer ke VA otomatis terekonsiliasi ke customer ini,
  // rekening biasa harus dicocokkan manual. Customer tanpa VA langsung lihat BCA.
  msg += '\n\nPembayaran dapat dilakukan melalui rekening berikut:';
  if (c.noVa) msg += '\nVirtual Account BCA ' + _fullVaBca(c.noVa) + ' (khusus ' + cust + ')';
  msg += '\n' + (c.noVa ? 'atau BCA ' : 'BCA ') + FAKTUR.REK_BCA + ' a.n. ' + FAKTUR.ACC_NAME;
  msg += '\n\nSetelah pembayaran dilakukan, mohon berkenan mengirimkan bukti transfer agar dapat segera kami verifikasi.';
  msg += '\nTerima kasih atas perhatian dan kerja sama Bapak/Ibu.\n-TIM ROSH PLASTIC';
  return msg;
}

// HYPERLINK to wa.me with the message pre-filled. Blank phone → blank cell.
function _waLinkFormula(phone, msg) {
  if (!phone) return '';
  const url = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(msg);
  return '=HYPERLINK("' + url + '","📲 Kirim WA")';
}

// ─────────────────────────────────────────────────────────────────────────────
// SAPA JUALAN — pesan reaktivasi untuk customer yang lama tidak order (To-Do seksi SAPA LAGI).
// Lebih ringan dari pesan penagihan: nada lama penagihan saja pernah membuat toko memblokir
// nomor ROSH (2026-07-28), dan ini bukan tagihan, ini ajakan. Tidak menyebut tempo, limit, atau
// harga. Satu pertanyaan, satu penawaran bantuan, selesai. Variasi ikut bucket _followUpBucket.
// ─────────────────────────────────────────────────────────────────────────────
function _sapaMessage(c) {
  const cust = c.customer || 'Bapak/Ibu';
  const tier = String(c.tierText || '').charAt(0);
  const d = c.daysSince || 0;

  let msg = 'Halo Bapak/Ibu ' + cust + '. ';
  if (tier === 'A' || tier === 'B') msg += 'Terima kasih sudah menjadi pelanggan setia ROSH. ';

  if (d < 21) {
    msg += 'Sudah beberapa minggu sejak order terakhir' + (c.lastTransDate ? ' (' + fmtDate(c.lastTransDate) + ')' : '') +
           '. Kalau ada kebutuhan thinwall atau cup yang perlu kami siapkan, tinggal kabari, stok lengkap dan bisa kirim besok.';
  } else if (d < 60) {
    msg += 'Sudah sekitar sebulan kami tidak menerima order dari ' + cust +
           '. Semoga usahanya lancar. Kalau ada kebutuhan kemasan yang bisa kami bantu, kabari saja, kami siapkan dan kirim besok.';
  } else {
    msg += 'Sudah lama kami tidak menyapa. Semoga Bapak/Ibu dan usahanya sehat dan lancar. ' +
           'Stok thinwall dan cup kami lengkap; kalau sewaktu-waktu ada kebutuhan, kami siap bantu siapkan dan antar.';
  }
  msg += '\n\nTerima kasih, Bapak/Ibu.\n-TIM ROSH PLASTIC';
  return msg;
}
