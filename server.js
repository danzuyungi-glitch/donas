/**
 * Saweria Webhook Service (Railway)
 * URL publik : https://donas-production.up.railway.app
 * Webhook    : https://donas-production.up.railway.app/webhook  (isi di dashboard Saweria)
 *
 * Alur: Saweria POST /webhook -> verifikasi signature -> simpan di memori (bot WA polling GET /donations)
 *       DAN langsung ditulis ke Firebase Realtime Database (project donasi-69866) di node `donations/<id>`
 *       -> halaman donasi.html otomatis tertambah (realtime).
 * Yang disimpan ke Firebase HANYA: name, amount, message, ts. Email donatur tidak pernah disimpan.
 *
 * ENV (Railway > Variables):
 *   SAWERIA_STREAM_KEY            wajib
 *   API_KEY                       disarankan (proteksi GET /donations, /status)
 *   FIREBASE_SERVICE_ACCOUNT_DONASI  service account project donasi-69866 (JSON mentah atau base64)
 *   FIREBASE_DATABASE_URL         opsional, default URL RTDB project donasi-69866
 */
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { createMiddleware } = require("saweria-webhook-express");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || "https://donas-production.up.railway.app";
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;
const API_KEY = process.env.API_KEY;
const FB_PROJECT_ID = "donasi-69866";
const FB_DB_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://donasi-69866-default-rtdb.asia-southeast1.firebasedatabase.app";

if (!STREAM_KEY) {
  console.error("ENV SAWERIA_STREAM_KEY belum diisi. Set di Railway > Variables.");
  process.exit(1);
}

// ---------- Firebase Admin (key privat, bypass rules, tanpa App Check) ----------
let fbDb = null;
(function initFirebase() {
  let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_DONASI || "").trim();
  if (!raw) {
    console.warn("[FIREBASE] FIREBASE_SERVICE_ACCOUNT_DONASI belum diisi -> donasi TIDAK ditulis ke Firebase.");
    return;
  }
  try {
    if (raw[0] !== "{") raw = Buffer.from(raw, "base64").toString("utf8");
    const cred = JSON.parse(raw);
    if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, "\n");
    if (cred.project_id !== FB_PROJECT_ID) {
      throw new Error("service account bukan milik project " + FB_PROJECT_ID);
    }
    const app = admin.initializeApp(
      { credential: admin.credential.cert(cred), databaseURL: FB_DB_URL },
      "donasi"
    );
    fbDb = admin.database(app);
    console.log("[FIREBASE] Terhubung ke " + FB_PROJECT_ID);
  } catch (e) {
    console.error("[FIREBASE] Gagal init:", e.message);
  }
})();

async function saveToFirebase(record) {
  if (!fbDb) return;
  // Key = id Saweria -> idempoten (restart / retry Saweria tidak bikin dobel)
  const key = /^[A-Za-z0-9_-]{1,64}$/.test(record.id) ? record.id : fbDb.ref("donations").push().key;
  const data = {
    name: String(record.nama || "Orang Baik").trim().slice(0, 60) || "Orang Baik",
    amount: Math.round(record.nominal),
    message: String(record.pesan || "").trim().slice(0, 500),
    ts: record.ts,
  };
  if (!(data.amount > 0)) return;
  for (let i = 1; i <= 3; i++) {
    try {
      await fbDb.ref("donations/" + key).set(data);
      console.log(`[FIREBASE] Tersimpan donations/${key}`);
      return;
    } catch (e) {
      console.error(`[FIREBASE] Gagal simpan (percobaan ${i}/3):`, e.message);
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
}

// ---------- Penyimpanan di memori (untuk bot WA) ----------
const donations = [];
const MAX_STORED = 200;
let lastDonationAt = null;
const seenIds = new Set();

function addDonation(p) {
  if (seenIds.has(p.id)) return; // Saweria bisa retry, jangan dobel
  seenIds.add(p.id);
  if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value);

  const now = Date.now();
  const record = {
    id: p.id || crypto.randomUUID(),
    nama: p.donatorName || "Orang Baik",
    nominal: Number(p.amountRaw) || 0,
    pesan: p.message || "",
    rawText: `${p.donatorName} baru saja memberikan Rp${p.amountRaw} ${p.message || ""}`.trim(),
    ts: now,
  };
  donations.push(record);
  if (donations.length > MAX_STORED) donations.shift();
  lastDonationAt = now;
  console.log(`[DONASI MASUK] ${record.nama} - Rp${record.nominal} - ${record.pesan}`);

  saveToFirebase(record).catch((e) => console.error("[FIREBASE]", e.message));
}

const app = express();

// Webhook: TANPA API_KEY (Saweria nggak bisa kirim header custom), diamankan signature stream key
const verifySignature = createMiddleware(STREAM_KEY, { camelCase: true });
let lastWebhookAt = null;
let webhookHits = 0;
app.post(
  "/webhook",
  (req, res, next) => {
    webhookHits++;
    console.log(`[WEBHOOK] Request masuk (signature: ${req.get("Saweria-Callback-Signature") ? "ada" : "TIDAK ADA"})`);
    next();
  },
  express.json(),
  verifySignature,
  (req, res) => {
    lastWebhookAt = Date.now();
    try {
      if (req.body.type === "donation") addDonation(req.body);
    } catch (e) {
      console.error("[WEBHOOK ERROR]", e.message);
    }
    res.sendStatus(200);
  }
);

// Proteksi endpoint lain pakai API_KEY
if (!API_KEY) console.warn("[API] PERINGATAN: API_KEY belum diisi, endpoint terbuka untuk publik!");
app.use((req, res, next) => {
  if (!API_KEY || req.path === "/health") return next();
  const given = req.get("x-api-key") || req.query.key;
  if (given !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), totalDonations: donations.length, firebase: !!fbDb });
});

app.get("/status", (req, res) => {
  res.json({
    mode: "webhook",
    firebase: !!fbDb,
    webhookHits,
    webhookTerakhir: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
    totalDonasi: donations.length,
    donasiTerakhir: lastDonationAt ? new Date(lastDonationAt).toISOString() : null,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get("/donations", (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({ donations: donations.filter((d) => d.ts > since), serverTime: Date.now() });
});

app.listen(PORT, () => {
  console.log(`[API] Jalan di port ${PORT}`);
  console.log(`[API] Webhook Saweria -> ${PUBLIC_URL}/webhook`);
});
