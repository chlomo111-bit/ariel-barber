/*
 * Ariel booking bot — runs on Shlomo's computer.
 *  - connects to WhatsApp with a QR code (dedicated bot number)
 *  - opens a free public tunnel (cloudflared) and writes its address into config.json on GitHub
 *  - customer site: sends a 4-digit code on WhatsApp, then books the appointment directly
 *  - sends the customer a confirmation + calendar link, notifies Ariel, reminds the customer before the appointment
 *  - admin page "וואטסאפ": status, QR, log, test message, disconnect
 * Data: same files as the site (config.json public, data.enc.json encrypted with the admin password).
 */
process.env.TZ = "Asia/Jerusalem";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { webcrypto: wc, createHash, randomInt } = require("node:crypto");
const baileys = require("baileys");
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
const pino = require("pino");
const qrTerm = require("qrcode-terminal");

/* ---------- settings (.env next to this file) ---------- */
function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!fs.existsSync(f)) { console.error("חסר קובץ .env — העתק את .env.example ל-.env ומלא אותו."); process.exit(1); }
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();
const GH = { owner: process.env.GH_OWNER || "chlomo111-bit", repo: process.env.GH_REPO || "ariel-barber", branch: "main" };
const GH_TOKEN = process.env.GH_TOKEN;
const ADMIN_USER = String(process.env.ADMIN_USER || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = +(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // optional fixed address (named tunnel); empty = free quick tunnel
if (!GH_TOKEN || !ADMIN_USER || !ADMIN_PASSWORD) { console.error("GH_TOKEN, ADMIN_USER ו-ADMIN_PASSWORD חובה בקובץ .env"); process.exit(1); }
const AUTH_DIR = path.join(__dirname, "wa-session");

/* ---------- small helpers ---------- */
const pad = n => (n < 10 ? "0" : "") + n;
const toMin = t => { const p = String(t || "0:0").split(":"); return (+p[0]) * 60 + (+p[1] || 0); };
const fromMin = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parseYmd = s => { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
const WD = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const MO = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const dateLong = s => { const d = parseYmd(s); return "יום " + WD[d.getDay()] + ", " + d.getDate() + " ב" + MO[d.getMonth()]; };
const normPhone = v => String(v || "").replace(/[\s\-().]/g, "");
const phoneOk = v => { const p = normPhone(v); return /^05\d{8}$/.test(p) || /^\+?9725\d{8}$/.test(p); };
const pLocal = v => normPhone(v).replace(/^\+?972/, "0");
const pIntl = v => { const d = String(v || "").replace(/\D/g, ""); return d.startsWith("972") ? d : d.startsWith("0") ? "972" + d.slice(1) : d; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const fill = (tpl, v) => String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ""));

const LOG = [];
function log(type, text) {
  const e = { t: new Date().toISOString(), type, text };
  LOG.unshift(e); if (LOG.length > 200) LOG.pop();
  console.log(new Date().toLocaleString("he-IL"), "[" + type + "]", text);
}

/* ---------- crypto: identical format to the site ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64e = b => Buffer.from(b).toString("base64");
const b64d = s => new Uint8Array(Buffer.from(s, "base64"));
async function deriveKey(pass, salt) {
  const base = await wc.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return wc.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptStr(pass, text) {
  const salt = wc.getRandomValues(new Uint8Array(16)), iv = wc.getRandomValues(new Uint8Array(12));
  const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pass, salt), enc.encode(text));
  return { v: 1, salt: b64e(salt), iv: b64e(iv), ct: b64e(new Uint8Array(ct)) };
}
async function decryptStr(pass, o) {
  const pt = await wc.subtle.decrypt({ name: "AES-GCM", iv: b64d(o.iv) }, await deriveKey(pass, b64d(o.salt)), b64d(o.ct));
  return dec.decode(pt);
}

/* ---------- GitHub storage ---------- */
const shas = {};
async function ghReq(method, p, body) {
  const url = "https://api.github.com/repos/" + GH.owner + "/" + GH.repo + "/contents/" + p + (method === "GET" ? "?ref=" + GH.branch + "&t=" + Date.now() : "");
  const r = await fetch(url, { method, headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ariel-bot" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404 && method === "GET") return null;
  if (!r.ok) { const e = new Error("GitHub " + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function ghGet(p) { const j = await ghReq("GET", p); if (!j) return null; shas[p] = j.sha; return Buffer.from(j.content, "base64").toString("utf8"); }
async function ghPut(p, text, msg) {
  const body = { message: msg, content: Buffer.from(text, "utf8").toString("base64"), branch: GH.branch };
  if (shas[p]) body.sha = shas[p];
  const j = await ghReq("PUT", p, body); shas[p] = j.content.sha;
}
/* read-modify-write with one retry on conflict */
async function updateFile(p, read, write, apply, msg) {
  for (let i = 0; i < 3; i++) {
    const cur = await read();
    const next = apply(cur);
    if (next === null) return cur;
    try { await write(next, msg); return next; }
    catch (e) { if ((e.status === 409 || e.status === 422) && i < 2) continue; throw e; }
  }
}
async function readConfig() { const t = await ghGet("config.json"); return t ? JSON.parse(t) : {}; }
async function writeConfig(o, msg) { await ghPut("config.json", JSON.stringify(o), msg); }
/* data.enc.json v2: {v:2, keys:{user: password-wrapped data key}, iv, ct} — same as the site */
let dataKey = null, dataKeyRaw = null, keysMap = null, fileVersion = 2;
async function readStore() {
  const t = await ghGet("data.enc.json");
  if (!t) throw new Error("אין עדיין נתונים. היכנס פעם אחת לניהול באתר לפני הפעלת הבוט.");
  const o = JSON.parse(t);
  if (o.v === 2) {
    fileVersion = 2; keysMap = o.keys || {};
    const k = keysMap[ADMIN_USER];
    if (!k) throw new Error("המשתמש " + ADMIN_USER + " לא קיים בניהול האתר.");
    const raw = new Uint8Array(await wc.subtle.decrypt({ name: "AES-GCM", iv: b64d(k.iv) }, await deriveKey(ADMIN_PASSWORD, b64d(k.salt)), b64d(k.ct)));
    dataKeyRaw = raw; dataKey = await wc.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const pt = await wc.subtle.decrypt({ name: "AES-GCM", iv: b64d(o.iv) }, dataKey, b64d(o.ct));
    return JSON.parse(dec.decode(pt)).docs || {};
  }
  fileVersion = 1; dataKeyRaw = null;
  return JSON.parse(await decryptStr(ADMIN_PASSWORD, o)).docs || {};
}
async function writeStore(docs, msg) {
  if (fileVersion === 1) return ghPut("data.enc.json", JSON.stringify(await encryptStr(ADMIN_PASSWORD, JSON.stringify({ docs }))), msg);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, enc.encode(JSON.stringify({ docs })));
  await ghPut("data.enc.json", JSON.stringify({ v: 2, keys: keysMap, iv: b64e(iv), ct: b64e(new Uint8Array(ct)) }), msg);
}
/* admin pages prove they hold the data key */
const adminKey = () => createHash("sha256").update("ariel-bot:" + (dataKeyRaw ? b64e(dataKeyRaw) : ADMIN_PASSWORD)).digest("hex");
const busyFrom = docs => { const today = ymd(new Date()); return Object.values(docs).filter(a => a.date && a.time && a.date >= today).map(a => ({ d: a.date, s: a.time, m: +a.dur || 0 })); };
async function changeStore(apply, msg) {
  let changed = false;
  const docs = await updateFile("data.enc.json", readStore, writeStore, d => { const r = apply(d); if (r !== null) changed = true; return r; }, msg);
  if (!changed) return docs;
  await updateFile("config.json", readConfig, writeConfig, c => { c.busy = busyFrom(docs); return c; }, "busy times");
  return docs;
}

/* ---------- bot texts (overridable from the admin page: config.bot) ---------- */
const DEFAULT_BOT = {
  otp: "הקוד שלך לקביעת תור אצל {biz}: *{code}*\nהקוד בתוקף ל-10 דקות.",
  confirm: "היי {name}, התור שלך נקבע ✅\n{service}\n{date} בשעה {time}\n📍 {area}\n\nהוספה ליומן: {cal}\n\nצריך לבטל או לשנות? כתבו ל{biz}: {adminPhone}",
  reminder: "היי {name}, תזכורת: התור שלך אצל {biz} היום בשעה {time} ✂️\n📍 {area}\nנתראה!",
  adminNew: "📅 תור חדש נקבע\n{name} · {phone}\n{service}\n{date} בשעה {time}",
  cancel: "היי {name}, התור שלך ב{date} בשעה {time} בוטל. לקביעת תור חדש: {site}",
  autoReply: "שלום! זה מספר אוטומטי לאישורי תורים של {biz} 💈\nלקביעת תור: {site}\nלשאלות כתבו ל{biz}: {adminPhone}",
  reminderMin: 60,
  notifyAdmin: true,
  sendConfirm: true,
  sendReminder: true,
  maxFuturePerPhone: 2
};
const SITE_URL = "https://" + GH.owner + ".github.io/" + GH.repo + "/";
let CFG = {};
const botSet = () => Object.assign({}, DEFAULT_BOT, CFG.bot || {});
const vars = (a, extra) => {
  const st = botSet();
  return Object.assign({
    biz: (CFG.biz && CFG.biz.name) || "אריאל", area: (CFG.biz && CFG.biz.area) || "", site: SITE_URL,
    adminPhone: CFG.wa || "", name: a.name || "", phone: pLocal(a.phone || ""), service: a.note || "",
    date: a.date ? dateLong(a.date) : "", time: a.time || "", cal: a.date ? calLink(a) : "", reminderMin: st.reminderMin
  }, extra || {});
};
function calLink(a) {
  const st = toMin(a.time), en = st + (+a.dur || 30), stamp = m => a.date.replace(/-/g, "") + "T" + fromMin(m).replace(":", "") + "00";
  const biz = (CFG.biz && CFG.biz.name) || "אריאל";
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent("תור אצל " + biz + (a.note ? " · " + a.note : "")) +
    "&dates=" + stamp(st) + "/" + stamp(en) + "&ctz=Asia%2FJerusalem&location=" + encodeURIComponent((CFG.biz && CFG.biz.area) || "");
}

/* ---------- availability (same rules as the site) ---------- */
function onVacation(s) { return (CFG.vacations || []).some(v => s >= v.from && s <= (v.to || v.from)); }
function windowEnd() {
  if (CFG.openMode !== "biweekly" || !CFG.openAnchor) { const e = new Date(); e.setDate(e.getDate() + (+CFG.daysAhead || 14) - 1); return ymd(e); }
  const a = parseYmd(CFG.openAnchor), tm = toMin(CFG.openTime || "08:00"); a.setHours(Math.floor(tm / 60), tm % 60, 0, 0);
  const P = 14 * 864e5, k = Math.floor((Date.now() - a.getTime()) / P), last = new Date(a.getTime() + k * P);
  last.setHours(0, 0, 0, 0); last.setDate(last.getDate() + 13); return ymd(last);
}
function slotFree(docs, day, time, dur) {
  const today = ymd(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return "bad";
  if (day < today || day > windowEnd()) return "closed";
  const h = (CFG.hours || [])[parseYmd(day).getDay()];
  if (!h || h.closed || onVacation(day)) return "closed";
  const t = toMin(time), end = t + dur;
  if (t < toMin(h.open) || end > toMin(h.close)) return "closed";
  if (day === today && t < nowMin() + (+CFG.lead || 0)) return "closed";
  const clash = Object.values(docs).some(a => a.date === day && a.time && t < toMin(a.time) + (+a.dur || 0) && end > toMin(a.time));
  return clash ? "taken" : "ok";
}

/* ---------- WhatsApp ---------- */
let sock = null, waState = "starting", lastQr = null, me = null;
const repliedAt = new Map();
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
  sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), browser: ["Ariel Booking Bot", "Chrome", "1.0"], markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", u => {
    if (u.qr) { lastQr = u.qr; waState = "qr"; console.log("\nסרוק את הקוד עם הוואטסאפ של מספר הבוט (מכשירים מקושרים):"); qrTerm.generate(u.qr, { small: true }); }
    if (u.connection === "open") { waState = "open"; lastQr = null; me = sock.user && sock.user.id ? sock.user.id.split(":")[0].split("@")[0] : null; log("wa", "מחובר לוואטסאפ" + (me ? " (" + me + ")" : "")); }
    if (u.connection === "close") {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : 0;
      if (code === DisconnectReason.loggedOut) {
        waState = "loggedout"; log("wa", "הבוט נותק מהוואטסאפ. צריך לסרוק QR מחדש.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true }); setTimeout(startWA, 2000);
      } else { waState = "reconnecting"; setTimeout(startWA, 5000); }
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid || "";
        if (!jid.endsWith("@s.whatsapp.net")) continue; // no groups / status
        const last = repliedAt.get(jid) || 0;
        if (Date.now() - last < 24 * 3600e3) continue; // answer each person at most once a day
        repliedAt.set(jid, Date.now());
        await sock.sendMessage(jid, { text: fill(botSet().autoReply, vars({})) });
      } catch (e) { log("error", "תשובה אוטומטית נכשלה: " + e.message); }
    }
  });
}
async function sendWA(phone, text) {
  if (waState !== "open") throw Object.assign(new Error("whatsapp offline"), { code: "offline" });
  const intl = pIntl(phone);
  const [r] = await sock.onWhatsApp(intl);
  if (!r || !r.exists) throw Object.assign(new Error("not on whatsapp"), { code: "nowa" });
  await sock.sendMessage(r.jid, { text });
}

/* ---------- verification codes + anti-spam (memory only) ---------- */
const OTP = new Map(); // phone -> {code, exp, tries}
const hits = new Map(); // key -> [timestamps]
function tooMany(key, max, ms) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < ms);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}

/* ---------- HTTP API ---------- */
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Admin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, no) => { let d = ""; req.on("data", c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } }); });
}
const ipOf = req => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/health") return send(res, 200, { ok: true, wa: waState });

    if (p === "/otp" && req.method === "POST") {
      const b = await body(req), phone = pLocal(b.phone);
      if (!phoneOk(phone)) return send(res, 400, { error: "phone" });
      if (tooMany("otp-ip:" + ipOf(req), 8, 3600e3) || tooMany("otp-ph:" + phone, 3, 600e3)) return send(res, 429, { error: "rate" });
      const code = String(randomInt(1000, 10000));
      OTP.set(phone, { code, exp: Date.now() + 10 * 60e3, tries: 0 });
      try { await sendWA(phone, fill(botSet().otp, vars({}, { code }))); }
      catch (e) { return send(res, e.code === "nowa" ? 400 : 503, { error: e.code === "nowa" ? "nowa" : "offline" }); }
      log("otp", "קוד נשלח ל-" + phone);
      return send(res, 200, { ok: true });
    }

    if (p === "/book" && req.method === "POST") {
      const b = await body(req), phone = pLocal(b.phone), o = OTP.get(phone);
      if (!o || o.exp < Date.now()) return send(res, 400, { error: "expired" });
      if (String(b.code || "").trim() !== o.code) { o.tries++; if (o.tries >= 5) OTP.delete(phone); return send(res, 400, { error: "code" }); }
      const name = String(b.name || "").trim().slice(0, 40);
      if (!name) return send(res, 400, { error: "name" });
      CFG = await readConfig();
      const svc = (CFG.services || []).find(s => s.id === b.svc);
      if (!svc) return send(res, 400, { error: "service" });
      const dur = +svc.dur || 30, st = botSet();
      let result = "ok", rec = null;
      await changeStore(docs => {
        const today = ymd(new Date());
        const mine = Object.values(docs).filter(a => a.kind === "appt" && a.date >= today && pLocal(a.phone) === phone).length;
        if (mine >= (+st.maxFuturePerPhone || 2)) { result = "limit"; return null; }
        const f = slotFree(docs, b.day, b.time, dur);
        if (f !== "ok") { result = f; return null; }
        rec = { kind: "appt", date: b.day, time: b.time, dur, name, phone, note: svc.name, price: +svc.price || 0, source: "web", created: Date.now(), reminded: false };
        docs["w" + Date.now().toString(36) + randomInt(100, 999)] = rec;
        return docs;
      }, "booking " + b.day + " " + b.time);
      if (result !== "ok") return send(res, 409, { error: result });
      OTP.delete(phone);
      log("booking", name + " · " + phone + " · " + b.day + " " + b.time + " · " + svc.name);
      if (st.sendConfirm) sendWA(phone, fill(st.confirm, vars(rec))).catch(e => log("error", "אישור ללקוח נכשל: " + e.message));
      if (st.notifyAdmin && CFG.wa) sendWA(CFG.wa, fill(st.adminNew, vars(rec))).catch(e => log("error", "הודעה לאריאל נכשלה: " + e.message));
      return send(res, 200, { ok: true });
    }

    /* ----- admin (key = sha256 of the admin password) ----- */
    if (p.startsWith("/admin/")) {
      if (req.headers["x-admin"] !== adminKey()) return send(res, 401, { error: "auth" });
      if (p === "/admin/status") return send(res, 200, { wa: waState, qr: lastQr, me, url: tunnelUrl, log: LOG.slice(0, 60) });
      if (p === "/admin/test" && req.method === "POST") {
        const b = await body(req);
        try { await sendWA(b.phone || CFG.wa, "בדיקה ✅ הבוט של " + vars({}).biz + " עובד."); log("test", "הודעת בדיקה נשלחה"); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 503, { error: e.code || e.message }); }
      }
      if (p === "/admin/cancel" && req.method === "POST") {
        const b = await body(req);
        try { await sendWA(b.phone, fill(botSet().cancel, vars(b))); log("cancel", "הודעת ביטול נשלחה ל-" + pLocal(b.phone)); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 503, { error: e.code || e.message }); }
      }
      if (p === "/admin/logout" && req.method === "POST") {
        try { await sock.logout(); } catch (_) {}
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) { log("error", "שגיאה: " + e.message); send(res, 500, { error: "server" }); }
});

/* ---------- reminders: every minute ---------- */
let reminderBusy = false;
async function reminderTick() {
  if (reminderBusy || waState !== "open") return;
  reminderBusy = true;
  try {
    CFG = await readConfig();
    const st = botSet(); if (!st.sendReminder) return;
    const lead = (+st.reminderMin || 60) * 60e3, now = Date.now();
    const docs = await readStore();
    const due = Object.entries(docs).filter(([, a]) => a.kind === "appt" && a.phone && !a.reminded && a.date && a.time).filter(([, a]) => {
      const t = parseYmd(a.date).getTime() + toMin(a.time) * 60e3;
      return t - now <= lead && t > now; // inside the reminder window, still in the future
    });
    if (!due.length) return;
    const sent = [];
    for (const [id, a] of due) {
      try { await sendWA(a.phone, fill(st.reminder, vars(a))); sent.push(id); log("reminder", "תזכורת נשלחה ל-" + (a.name || a.phone) + " (" + a.time + ")"); }
      catch (e) { log("error", "תזכורת נכשלה ל-" + pLocal(a.phone) + ": " + e.message); if (e.code === "nowa") sent.push(id); }
    }
    if (sent.length) await changeStore(d => { sent.forEach(id => { if (d[id]) d[id].reminded = true; }); return d; }, "reminders sent");
  } catch (e) { log("error", "בדיקת תזכורות נכשלה: " + e.message); }
  finally { reminderBusy = false; }
}

/* ---------- public address: free cloudflared tunnel, written into config.json ---------- */
let tunnelUrl = PUBLIC_URL || null;
async function publishUrl(u) {
  await updateFile("config.json", readConfig, writeConfig, c => { c.botUrl = u; c.botAt = Date.now(); return c; }, "bot address");
  log("tunnel", "כתובת הבוט פורסמה: " + u);
}
function startTunnel() {
  const bin = process.env.CLOUDFLARED || "cloudflared";
  const cf = spawn(bin, ["tunnel", "--no-autoupdate", "--url", "http://localhost:" + PORT], { stdio: ["ignore", "pipe", "pipe"] });
  const onData = d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== tunnelUrl) { tunnelUrl = m[0]; publishUrl(tunnelUrl).catch(e => log("error", "פרסום הכתובת נכשל: " + e.message)); }
  };
  cf.stdout.on("data", onData); cf.stderr.on("data", onData);
  cf.on("error", () => { log("error", "cloudflared לא מותקן. התקן עם: brew install cloudflared"); });
  cf.on("exit", c => { log("tunnel", "המנהרה נסגרה (" + c + "), פותח מחדש…"); setTimeout(startTunnel, 5000); });
}

/* ---------- go ---------- */
(async () => {
  try { CFG = await readConfig(); await readStore(); }
  catch (e) {
    console.error(e.status === 401 || e.status === 403 ? "מפתח GitHub לא תקין." : e.name === "OperationError" ? "ADMIN_USER / ADMIN_PASSWORD לא תואמים למשתמש ניהול באתר." : "שגיאה: " + e.message);
    process.exit(1);
  }
  server.listen(PORT, "127.0.0.1", () => log("server", "השרת פועל על פורט " + PORT));
  if (PUBLIC_URL) publishUrl(PUBLIC_URL).catch(e => log("error", e.message)); else startTunnel();
  startWA();
  setInterval(reminderTick, 60e3);
  setInterval(() => { for (const [k, v] of OTP) if (v.exp < Date.now()) OTP.delete(k); }, 10 * 60e3);
})();
