/**
 * Saweria Watcher Service - untuk deploy di Railway
 * ---------------------------------------------------
 * Tugasnya CUMA dua:
 * 1. Buka halaman widget alert Saweria pakai Puppeteer, pantengin donasi baru masuk.
 * 2. Nyediain API (GET /donations) buat dipoll dari bot WhatsApp kamu di Pterodactyl.
 *
 * Nggak ada koneksi WhatsApp sama sekali di sini — murni cuma "mata-mata" donasi.
 */

const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const crypto = require("crypto");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;

if (!STREAM_KEY) {
  console.error("ENV SAWERIA_STREAM_KEY belum diisi. Set di Railway > Variables.");
  process.exit(1);
}

// Simpan donasi di memory (cukup buat kebutuhan ini, nggak perlu database)
// Format: { id, nama, nominal, pesan, rawText, ts }
const donations = [];
const MAX_STORED = 200; // biar nggak numpuk terus, simpan 200 terakhir aja

function parseAlertText(rawText) {
  if (!rawText) return null;
  const text = rawText.replace(/\s+/g, " ").trim();

  const re = /(.+?)\s+baru saja memberikan\s+Rp\s*([\d.,]+)\s*(.*)$/i;
  const match = text.match(re);
  if (!match) return null;

  const nama = match[1].trim() || "Orang Baik";
  const nominalRaw = match[2].replace(/[.,]/g, "");
  const nominal = Number(nominalRaw) || 0;
  const pesan = (match[3] || "").trim();

  return { nama, nominal, pesan, rawText: text };
}

function addDonation(rawText) {
  const parsed = parseAlertText(rawText);
  if (!parsed) return;

  const now = Date.now();

  // Dedupe: teks sama persis dalam 30 detik terakhir, skip
  const duplicate = donations.find(
    (d) => d.rawText === parsed.rawText && now - d.ts < 30000
  );
  if (duplicate) return;

  const record = {
    id: crypto.randomUUID(),
    nama: parsed.nama,
    nominal: parsed.nominal,
    pesan: parsed.pesan,
    rawText: parsed.rawText,
    ts: now,
  };

  donations.push(record);
  if (donations.length > MAX_STORED) donations.shift();

  lastDonationAt = now;
  console.log(`[DONASI MASUK] ${record.nama} - Rp${record.nominal} - ${record.pesan}`);
}

let browser = null;
let stopped = false;
let isConnected = false;
let lastError = null;
let blockCount = 0;
let lastHeartbeatAt = 0;
let retryTimer = null;
let widgetLoaded = false; // true kalau widget sudah render (bukan stuck "Loading...")
let backendStatus = null; // status terakhir dari backend.saweria.co (angka HTTP atau pesan error)
let backendOk = false; // pernah dapat balasan sukses dari backend.saweria.co di sesi ini
let backendFailures = 0;
let loadingStreak = 0;
let lastDonationAt = null;
let lastSnippet = "";
let connectedSince = null;

const loadingRe = /^\s*loading(\.{1,3})?\s*$/i;
const redact = (u) => String(u).replace(/(stream_?key=)[^&\s]+/gi, "$1***");

const CHROME_DATA_DIR = process.env.CHROME_DATA_DIR || "/tmp/chrome-data";
const challengeRe =
  /you have been blocked|attention required|just a moment|performing security verification|verify you are human|checking your browser/i;

// Satu-satunya pintu buat retry: ada backoff kalau kena blokir (60s, 2m, 4m ... maks 15m),
// biar nggak "ngetuk pintu" Cloudflare terus-terusan yang malah bikin IP makin dicurigai.
function scheduleRetry(blocked) {
  if (stopped || retryTimer) return;
  let delay = 15000;
  if (blocked) {
    delay = Math.min(60000 * 2 ** blockCount, 15 * 60000);
    blockCount++;
  }
  console.log(`[SAWERIA] Coba lagi dalam ${Math.round(delay / 1000)} detik...`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    launchAndWatch();
  }, delay);
}

async function closeBrowser() {
  if (!browser) return;
  const b = browser;
  browser = null;
  b.removeAllListeners("disconnected");
  try {
    await b.close();
  } catch {}
}

// Watchdog: kalau halaman mandek (heartbeat nggak datang >2 menit), restart browser
setInterval(() => {
  if (isConnected && lastHeartbeatAt && Date.now() - lastHeartbeatAt > 120000) {
    console.log("[WATCHDOG] Heartbeat berhenti >2 menit, restart browser...");
    isConnected = false;
    lastError = "Watchdog: halaman mandek";
    closeBrowser().then(() => scheduleRetry(false));
  }
}, 60000);

async function launchAndWatch() {
  if (stopped) return;

  try {
    // Profil Chrome disimpan, jadi cookie cf_clearance kepakai lagi kalau browser restart
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fs.rmSync(`${CHROME_DATA_DIR}/${f}`, { force: true });
      } catch {}
    }

    const launchOpts = {
      headless: "new",
      userDataDir: CHROME_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,720",
      ],
    };
    // Opsional: proxy (set PROXY_URL=http://host:port di Railway Variables)
    if (process.env.PROXY_URL) {
      launchOpts.args.push(`--proxy-server=${process.env.PROXY_URL}`);
    }
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    widgetLoaded = false;
    backendStatus = null;
    backendOk = false;
    backendFailures = 0;
    loadingStreak = 0;
    connectedSince = null;

    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Proxy dengan login (opsional): PROXY_USER & PROXY_PASS
    if (process.env.PROXY_USER) {
      await page.authenticate({
        username: process.env.PROXY_USER,
        password: process.env.PROXY_PASS || "",
      });
    }

    // User-Agent sengaja TIDAK dipalsukan: plugin stealth sudah menyamarkan "HeadlessChrome",
    // dan UA palsu yang beda versi/OS dari browser asli malah jadi sidik jari mencurigakan.
    await page.setViewport({ width: 1280, height: 720 });

    // === CCTV: semua console.log & error DI DALAM browser di-forward ke log Railway ===
    // Halaman Saweria punya script anti-DevTools yang spam console, jadi
    // cuma teruskan log kita sendiri (diawali "[PAGE]") dan error asli.
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("[PAGE]") || text.startsWith("[HEARTBEAT ERROR]")) {
        console.log(`[PAGE CONSOLE:${msg.type()}]`, text);
      }
    });
    page.on("pageerror", (err) => {
      console.log("[PAGE ERROR]", err.message);
    });
    page.on("requestfailed", (req) => {
      const err = req.failure()?.errorText;
      console.log("[PAGE REQUEST FAILED]", redact(req.url()), err);
      if (req.url().includes("backend.saweria.co")) {
        backendFailures++;
        backendStatus = err || "request failed";
      }
    });
    // Pantau balasan dari backend.saweria.co: ini kunci supaya tahu widget beneran bisa ambil data
    page.on("response", (res) => {
      const u = res.url();
      if (!u.includes("backend.saweria.co")) return;
      backendStatus = res.status();
      if (res.status() >= 400) {
        backendFailures++;
        console.log(`[BACKEND] HTTP ${res.status()} <- ${redact(u)}`);
      } else {
        backendOk = true;
      }
    });

    await page.exposeFunction("__onSaweriaAlert", (text) => {
      addDonation(text);
    });

    await page.exposeFunction("__onHeartbeat", (snippet) => {
      lastHeartbeatAt = Date.now();
      const plain = snippet.replace(/^\[CHANGE\]\s*/, "");
      lastSnippet = plain.slice(0, 120);
      widgetLoaded = !loadingRe.test(plain);
      console.log("[HEARTBEAT] Isi halaman saat ini:", JSON.stringify(snippet));
      // Widget nyangkut di "Loading..." terus (3 heartbeat berturut-turut = ~60 detik) -> restart
      if (!snippet.startsWith("[CHANGE]")) {
        loadingStreak = widgetLoaded ? 0 : loadingStreak + 1;
        if (loadingStreak >= 3 && isConnected) {
          console.log("[SAWERIA] Widget macet di Loading..., restart browser...");
          isConnected = false;
          lastError = `Widget macet di Loading... (backend.saweria.co: ${backendStatus ?? "tidak ada respon"})`;
          closeBrowser().then(() => scheduleRetry(true));
          return;
        }
      }
      // Challenge muncul di tengah sesi -> tandai putus & restart dengan backoff
      if (!snippet.startsWith("[CHANGE]") && challengeRe.test(snippet) && isConnected) {
        console.log("[SAWERIA] Challenge Cloudflare muncul di tengah sesi, restart browser...");
        isConnected = false;
        lastError = "Diblokir Cloudflare (muncul saat sesi berjalan)";
        closeBrowser().then(() => scheduleRetry(true));
      }
    });

    const url = `https://saweria.co/widgets/alert?streamKey=${encodeURIComponent(
      STREAM_KEY
    )}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000)); // kasih waktu halaman/challenge selesai render

    // Deteksi & tunggu challenge Cloudflare (maks ~30 detik), jangan pura-pura "connected"
    const getText = () =>
      page
        .evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400))
        .catch(() => "");
    let firstText = await getText();
    for (let i = 0; i < 15 && challengeRe.test(firstText); i++) {
      if (/you have been blocked/i.test(firstText)) break; // blokir keras, nunggu percuma
      await new Promise((r) => setTimeout(r, 2000));
      firstText = await getText();
    }
    // challenge lolos biasanya bikin halaman reload, kasih jeda lalu cek ulang
    await new Promise((r) => setTimeout(r, 3000));
    firstText = await getText();
    if (challengeRe.test(firstText)) {
      throw new Error("Diblokir Cloudflare (challenge nggak lolos): " + firstText.slice(0, 80));
    }

    // Pastikan widget BENERAN termuat (bukan nyangkut "Loading..."), baru dianggap tersambung
    for (let i = 0; i < 15 && loadingRe.test(firstText); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      firstText = await getText();
    }
    if (loadingRe.test(firstText) || (backendFailures > 0 && !backendOk)) {
      throw new Error(
        `Widget macet di Loading... (backend.saweria.co: ${backendStatus ?? "tidak ada respon"}) - kemungkinan IP Railway diblokir, coba pakai proxy`
      );
    }

    await page.evaluate(() => {
      try {
        let lastReported = "";
        let scanTimer = null;

        let lastText = "";
        function scanPage() {
          const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
          // DEBUG: tiap teks halaman berubah, kirim ke log supaya kelihatan format alert aslinya
          if (text && text !== lastText) {
            lastText = text;
            window.__onHeartbeat("[CHANGE] " + text.slice(0, 300));
          }
          const match = text.match(/(.+?baru saja memberikan\s+Rp\s*[\d.,]+.*)/i);
          const candidate = match ? match[1] : null;
          if (candidate && candidate !== lastReported) {
            lastReported = candidate;
            window.__onSaweriaAlert(candidate);
          }
        }

        const observer = new MutationObserver(() => {
          // Debounce dikit biar nggak nembak berkali-kali pas teks lagi dianimasikan
          clearTimeout(scanTimer);
          scanTimer = setTimeout(scanPage, 400);
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        // Scan sekali di awal juga, jaga-jaga kalau alert udah kejadian pas baru connect
        scanPage();

        // Heartbeat: tiap 20 detik kirim cuplikan isi halaman + scan ulang manual,
        // biar kita bisa lihat dari log Railway apakah halamannya "hidup" atau mandek.
        setInterval(() => {
          try {
            const snippet = (document.body.innerText || "").slice(0, 150);
            window.__onHeartbeat(snippet);
            scanPage();
          } catch (e) {
            console.error("[HEARTBEAT ERROR]", e.message);
          }
        }, 20000);

        console.log("[PAGE] Observer & heartbeat berhasil dipasang, siap mantengin.");
      } catch (e) {
        console.error("[PAGE EVALUATE ERROR]", e.message, e.stack);
      }
    });

    console.log("[SAWERIA] Berhasil terhubung ke widget alert, mantengin donasi...");
    isConnected = true;
    widgetLoaded = true;
    connectedSince = Date.now();
    lastError = null;
    blockCount = 0;
    lastHeartbeatAt = Date.now();

    browser.on("disconnected", () => {
      if (stopped) return;
      isConnected = false;
      console.log("[SAWERIA] Browser terputus.");
      scheduleRetry(false);
    });
  } catch (e) {
    console.error("[SAWERIA ERROR]", e.message);
    isConnected = false;
    lastError = e.message;
    await closeBrowser();
    scheduleRetry(/Diblokir Cloudflare|Widget macet/.test(e.message));
  }
}

launchAndWatch();

// ---------------- API ----------------

const app = express();

// Proteksi API: set API_KEY di Railway Variables, lalu bot WA kirim header "x-api-key: <API_KEY>"
// (atau query ?key=<API_KEY>). /health tetap publik buat healthcheck Railway.
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.warn("[API] PERINGATAN: API_KEY belum diisi, /donations & /status terbuka untuk publik!");
}
app.use((req, res, next) => {
  if (!API_KEY || req.path === "/health") return next();
  const given = req.get("x-api-key") || req.query.key;
  if (given !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), totalDonations: donations.length });
});

// Cek apakah listener-nya beneran tersambung ke widget Saweria
// Buka: https://<domain-railway>/status?key=<API_KEY>
app.get("/status", (req, res) => {
  const tersambung = isConnected && widgetLoaded;
  let ringkasan;
  if (tersambung) {
    ringkasan = "TERSAMBUNG: widget alert Saweria aktif dan siap menerima donasi.";
  } else if (lastError) {
    ringkasan = "TIDAK TERSAMBUNG: " + lastError;
  } else {
    ringkasan = "TIDAK TERSAMBUNG: masih mencoba menyambung...";
  }
  res.json({
    tersambung,
    ringkasan,
    connected: isConnected,
    widgetLoaded,
    backendSaweria: backendStatus,
    backendFailures,
    lastError,
    blockCount,
    nextRetry: retryTimer ? "terjadwal" : null,
    proxyDipakai: !!process.env.PROXY_URL,
    isiHalaman: lastSnippet,
    tersambungSejakDetik: connectedSince ? Math.round((Date.now() - connectedSince) / 1000) : null,
    lastHeartbeatAgoSec: lastHeartbeatAt ? Math.round((Date.now() - lastHeartbeatAt) / 1000) : null,
    totalDonasi: donations.length,
    donasiTerakhir: lastDonationAt ? new Date(lastDonationAt).toISOString() : null,
    uptimeSec: Math.round(process.uptime()),
  });
});

// Bot WA polling endpoint ini tiap beberapa detik.
// Query param "since" = timestamp (ms) terakhir kali dia cek, biar cuma dapet yang baru.
// Dilindungi API_KEY (lihat middleware di atas).
app.get("/donations", (req, res) => {
  const since = Number(req.query.since) || 0;
  const newOnes = donations.filter((d) => d.ts > since);
  res.json({
    donations: newOnes,
    serverTime: Date.now(), // dipakai client buat update "since" berikutnya
  });
});

app.listen(PORT, () => {
  console.log(`[API] Jalan di port ${PORT}`);
});
