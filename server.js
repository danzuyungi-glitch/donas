/**
 * Saweria Webhook Service (Railway)
 * Saweria yang kirim POST ke /webhook tiap ada donasi -> nggak perlu Puppeteer,
 * jadi nggak kena Cloudflare. Bot WA tetap polling GET /donations.
 */
const express = require("express");
const crypto = require("crypto");
const { createMiddleware } = require("saweria-webhook-express");

const PORT = process.env.PORT || 3000;
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;
const API_KEY = process.env.API_KEY;

if (!STREAM_KEY) {
  console.error("ENV SAWERIA_STREAM_KEY belum diisi. Set di Railway > Variables.");
  process.exit(1);
}

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
  res.json({ ok: true, uptime: process.uptime(), totalDonations: donations.length });
});

app.get("/status", (req, res) => {
  res.json({
    mode: "webhook",
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

app.listen(PORT, () => console.log(`[API] Jalan di port ${PORT}`));
