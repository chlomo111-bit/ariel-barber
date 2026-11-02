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
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
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
const BOT_PHONE = String(process.env.BOT_PHONE || "").replace(/\D/g, "").replace(/^0/, "972"); // number of the bot, for a pairing code instead of a QR
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
const live = a => a && a.status !== "cancelled";
const busyFrom = docs => { const today = ymd(new Date()); return Object.values(docs).filter(a => live(a) && a.date && a.time && a.date >= today).map(a => ({ d: a.date, s: a.time, m: +a.dur || 0 })); };
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
  confirm: "היי {name}, התור שלך נקבע ✅\n{service}\n{date} בשעה {time}\n📍 {area}\n\nהוספה ליומן: {cal}\n\nלביטול התור השיבו *ביטול* להודעה הזו.",
  cancelOk: "התור שלך ב{date} בשעה {time} בוטל ✅\nלקביעת תור חדש: {site}",
  adminCancel: "❌ תור בוטל{by}\n{name} · {phone}\n{service}\n{date} בשעה {time}",
  reminder: "היי {name}, תזכורת: התור שלך אצל {biz} היום בשעה {time} ✂️\n📍 {area}\nנתראה!",
  adminNew: "📅 תור חדש נקבע\n{name} · {phone}\n{service}\n{date} בשעה {time}",
  cancel: "היי {name}, התור שלך ב{date} בשעה {time} בוטל. לקביעת תור חדש: {site}",
  autoReply: "שלום! זה מספר אוטומטי לאישורי תורים של {biz} 💈\nלקביעת תור: {site}\nלשאלות כתבו ל{biz}: {adminPhone}",
  reminderMin: 60,
  notifyAdmin: true,
  sendConfirm: true,
  sendReminder: true,
  maxFuturePerPhone: 2,
  winback: true,
  winbackDays: 14,
  winbackMaxPerDay: 10,
  winbackDaysOfWeek: [3, 4],
  winbackTexts: [
    "היי {first} 👋 סוף השבוע מתקרב, זה הזמן לסדר את השיער ✂️\nקובעים תור כאן: {site}",
    "{first}, עברו כבר כמה שבועות מהתספורת האחרונה 😉 מתי מסדרים?\n{site}",
    "היי {first}! השבוע עוד יש מקומות פנויים אצל {biz} 💈\nתפוס תור: {site}",
    "אהלן {first} ✂️ מגיע לך להיראות חד לסופ״ש.\nלקביעת תור: {site}",
    "{first}, הפייד מתחיל לגדול? 😄 בוא נסדר אותו.\nתור בקליק: {site}",
    "היי {first}, מזמן לא ראינו אותך במספרה 🙂 מחכים לך!\n{site}",
    "סופ״ש בפתח 🎉 {first}, רוצה להגיע מסודר? יש תורים פנויים:\n{site}",
    "{first}, תזכורת קטנה מ{biz}: הגיע הזמן לתספורת ✂️\n{site}",
    "היי {first} 💈 לפני שהתורים לסוף השבוע נגמרים, קבע לך מקום:\n{site}",
    "אהלן {first}! שבועיים בלי תספורת זה הרבה 😅 קובעים עכשיו:\n{site}"
  ],
  winbackFooter: "\n\nלהסרה מההודעות השיבו *הסר*"
};
const adminPhones = () => { const l = (Array.isArray(CFG.adminPhones) && CFG.adminPhones.length ? CFG.adminPhones : [CFG.wa]).map(pLocal).filter(phoneOk); return [...new Set(l)]; };
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
  const clash = Object.values(docs).some(a => live(a) && a.date === day && a.time && t < toMin(a.time) + (+a.dur || 0) && end > toMin(a.time));
  return clash ? "taken" : "ok";
}

/* ---------- WhatsApp ---------- */
let sock = null, waState = "starting", lastQr = null, me = null, pairCode = null, pairAsked = false;
const repliedAt = new Map();
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version; try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
  sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), browser: Browsers.macOS("Chrome"), markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", u => {
    if (u.qr) {
      lastQr = u.qr; waState = "qr";
      if (BOT_PHONE && !pairAsked) {
        pairAsked = true;
        sock.requestPairingCode(BOT_PHONE).then(c => {
          pairCode = String(c).replace(/(.{4})(.{4})/, "$1-$2");
          console.log("\n======================================\n  קוד חיבור לוואטסאפ:  " + pairCode + "\n======================================");
          console.log("בטלפון של מספר הבוט: וואטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר > קישור עם מספר טלפון במקום, והקלד את הקוד.");
          log("wa", "קוד חיבור: " + pairCode);
        }).catch(e => { log("error", "קוד חיבור נכשל: " + e.message + " (אפשר לסרוק QR)"); });
      }
      if (!BOT_PHONE) { console.log("\nסרוק את הקוד עם הוואטסאפ של מספר הבוט (מכשירים מקושרים):"); qrTerm.generate(u.qr, { small: true }); }
    }
    if (u.connection === "open") { waState = "open"; lastQr = null; pairCode = null; me = sock.user && sock.user.id ? sock.user.id.split(":")[0].split("@")[0] : null; log("wa", "מחובר לוואטסאפ" + (me ? " (" + me + ")" : "")); }
    if (u.connection === "close") {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : 0;
      if (code === DisconnectReason.loggedOut) {
        waState = "loggedout"; log("wa", "הבוט נותק מהוואטסאפ. צריך לסרוק QR מחדש.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true }); pairAsked = false; pairCode = null; setTimeout(startWA, 2000);
      } else {
        waState = "reconnecting"; pairAsked = false;
        if (sock && sock.authState && !sock.authState.creds.registered) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(startWA, 3000);
      }
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        let jid = m.key.remoteJid || "";
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue; // no groups / status
        const pnJid = jid.endsWith("@s.whatsapp.net") ? jid : (m.key.senderPn || m.key.remoteJidAlt || m.key.participantPn || "");
        const text = (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text) || "").trim();
        if (/^(ביטול|לבטל|בטל|בטלו|אני רוצה לבטל|cancel)(?=$|[\s.!?,])/i.test(text)) { await clientCancel(jid, pnJid); continue; }
        if (/^(הסר|הסירו|להסיר|הסרה|stop|תפסיקו|תפסיק)(?=$|[\s.!?,])/i.test(text)) { await clientOptOut(jid, pnJid); continue; }
        if (!pnJid && !jid.endsWith("@lid")) continue;
        const last = repliedAt.get(jid) || 0;
        if (Date.now() - last < 24 * 3600e3) continue; // answer each person at most once a day
        repliedAt.set(jid, Date.now());
        await sock.sendMessage(jid, { text: fill(botSet().autoReply, vars({})) });
      } catch (e) { log("error", "תשובה אוטומטית נכשלה: " + e.message); }
    }
  });
}
/* client replies "הסר": no more come-back messages */
async function clientOptOut(jid, pnJid) {
  const phone = pnJid ? "0" + pnJid.split("@")[0].replace(/^972/, "") : "";
  if (!phoneOk(phone)) return;
  try {
    await changeStore(d => { d["c" + phone] = Object.assign({ kind: "client", phone }, d["c" + phone] || {}, { optOut: true, optOutAt: Date.now() }); return d; }, "client opted out");
    await sock.sendMessage(jid, { text: "הוסרת מרשימת ההודעות ✅ תמיד אפשר לקבוע תור כאן: " + SITE_URL }).catch(() => {});
    log("winback", phone + " ביקש להסיר מההודעות");
  } catch (e) { log("error", "הסרה נכשלה: " + e.message); }
}

/* ---------- come-back messages: clients who have not come for N days and have nothing booked ---------- */
let wbDay = "", wbCount = 0, wbLast = 0, wbBusy = false;
/* test: 2 different come-back texts to each admin, requested by config.winbackTest */
async function winbackTest() {
  const st = botSet(), texts = (st.winbackTexts && st.winbackTexts.length ? st.winbackTexts : DEFAULT_BOT.winbackTexts);
  const order = texts.map((t, i) => i).sort(() => Math.random() - 0.5);
  let k = 0;
  for (const ph of adminPhones()) {
    for (let n = 0; n < 2; n++) {
      const msg = "🧪 בדיקה (" + (n + 1) + "/2)\n\n" + fill(texts[order[k++ % texts.length]], vars({}, { first: "" })).replace(/^\s*,\s*/, "").replace(/ {2,}/g, " ").replace(/ +(?=[,!])/g, "") + (st.winbackFooter || "");
      await sendWA(ph, msg).catch(e => log("error", "בדיקה ל-" + ph + " נכשלה: " + e.message));
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  log("winback", "נשלחו הודעות בדיקה למנהלים");
}
async function winbackTick() {
  if (wbBusy || waState !== "open") return;
  if (CFG.winbackTest) {
    wbBusy = true;
    try {
      await updateFile("config.json", readConfig, writeConfig, c => { if (!c.winbackTest) return null; delete c.winbackTest; return c; }, "winback test done");
      CFG = await readConfig(); await winbackTest();
    } catch (e) { log("error", "בדיקה: " + e.message); } finally { wbBusy = false; }
    return;
  }
  const now = new Date(), st = botSet();
  if (!st.winback) return;
  if (!(st.winbackDaysOfWeek || [3, 4]).includes(now.getDay()) || now.getHours() < 11 || now.getHours() >= 18) return;
  const today = ymd(now);
  if (wbDay !== today) { wbDay = today; wbCount = 0; }
  if (wbCount >= (+st.winbackMaxPerDay || 10)) return;
  if (Date.now() - wbLast < (3 + Math.random() * 4) * 60e3) return; // space messages out
  wbBusy = true;
  try {
    CFG = await readConfig();
    const docs = await readStore(), days = (+st.winbackDays || 14) * 864e5, nowMs = Date.now(), people = {};
    for (const a of Object.values(docs)) {
      if (!a || a.kind !== "appt" || !a.phone) continue;
      const ph = pLocal(a.phone); if (!phoneOk(ph)) continue;
      const p = people[ph] || (people[ph] = { phone: ph, name: "", lastVisit: 0, future: false, lastActivity: 0 });
      if (a.name) p.name = a.name;
      const t = parseYmd(a.date).getTime() + toMin(a.time) * 60e3;
      p.lastActivity = Math.max(p.lastActivity, a.created || 0, a.cancelledAt || 0);
      if (live(a)) { if (t > nowMs) p.future = true; else p.lastVisit = Math.max(p.lastVisit, t); }
    }
    const pick = Object.values(people).filter(p => {
      const meta = docs["c" + p.phone] || {};
      if (meta.optOut || p.future) return false;
      const ref = p.lastVisit || p.lastActivity;
      if (!ref || nowMs - ref < days || nowMs - p.lastActivity < days) return false; // came or contacted us recently
      if (meta.lastContact && nowMs - meta.lastContact < days) return false;
      if (meta.winbackAt && (meta.winbackAt > ref || nowMs - meta.winbackAt < 30 * 864e5)) return false; // one message per absence, max once a month
      return true;
    }).sort((x, y) => (x.lastVisit || x.lastActivity) - (y.lastVisit || y.lastActivity))[0];
    if (!pick) return;
    const texts = (st.winbackTexts && st.winbackTexts.length ? st.winbackTexts : DEFAULT_BOT.winbackTexts);
    const name = ((docs["c" + pick.phone] || {}).name || pick.name || "").trim();
    const msg = fill(texts[randomInt(0, texts.length)], vars({ name }, { first: name.split(" ")[0] || "" })).replace(/^\s*,\s*/, "").replace(/ {2,}/g, " ").replace(/ +(?=[,!])/g, "") + (st.winbackFooter || "");
    try { await sendWA(pick.phone, msg); }
    catch (e) { if (e.code !== "nowa") throw e; }
    wbCount++; wbLast = Date.now();
    await changeStore(d => { d["c" + pick.phone] = Object.assign({ kind: "client", phone: pick.phone, name }, d["c" + pick.phone] || {}, { winbackAt: Date.now() }); return d; }, "come-back message");
    log("winback", "הודעת חזרה נשלחה ל-" + (name || pick.phone));
  } catch (e) { log("error", "הודעות חזרה: " + e.message); }
  finally { wbBusy = false; }
}

/* client replies "ביטול": cancel his next appointment, tell him and the admins */
async function clientCancel(jid, pnJid) {
  const phone = pnJid ? "0" + pnJid.split("@")[0].replace(/^972/, "") : "";
  const reply = t => sock.sendMessage(jid, { text: t }).catch(() => {});
  if (!phoneOk(phone)) { await reply("לא הצלחתי לזהות את המספר. לביטול כתבו ל" + vars({}).biz + ": " + (CFG.wa || "")); return; }
  try {
    CFG = await readConfig();
    const st = botSet(), now = Date.now();
    let found = null, late = false;
    await changeStore(d => {
      const next = Object.entries(d).filter(([, a]) => live(a) && a.kind === "appt" && pLocal(a.phone) === phone && a.date && a.time)
        .map(([id, a]) => [id, a, parseYmd(a.date).getTime() + toMin(a.time) * 60e3]).filter(x => x[2] > now).sort((x, y) => x[2] - y[2])[0];
      if (!next) return null;
      found = next[1];
      if (next[2] - now < (+st.cancelMinBefore || 60) * 60e3) { late = true; return null; }
      d[next[0]] = Object.assign({}, next[1], { status: "cancelled", cancelledAt: now, cancelledBy: "client", cancelNotified: true });
      return d;
    }, "client cancelled");
    if (!found) { await reply("לא מצאתי תור קרוב על המספר הזה. לקביעת תור: " + SITE_URL); return; }
    if (late) { await reply("אי אפשר לבטל דרך הבוט פחות מ-" + (+st.cancelMinBefore || 60) + " דקות לפני התור. כתבו ל" + vars({}).biz + ": " + (CFG.wa || "")); return; }
    await reply(fill(st.cancelOk, vars(found)));
    for (const ph of adminPhones()) await sendWA(ph, fill(st.adminCancel, vars(found, { by: " על ידי הלקוח" }))).catch(() => {});
    log("cancel", "הלקוח " + (found.name || phone) + " ביטל את התור " + found.date + " " + found.time);
  } catch (e) { log("error", "ביטול על ידי לקוח נכשל: " + e.message); await reply("משהו השתבש. כתבו ל" + vars({}).biz + ": " + (CFG.wa || "")); }
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

    /* customer review: verified phone (code) + must be a client; public part goes to config.reviews (no phone) */
    if (p === "/review" && req.method === "POST") {
      const b = await body(req), phone = pLocal(b.phone), o = OTP.get(phone);
      if (!o || o.exp < Date.now()) return send(res, 400, { error: "expired" });
      if (String(b.code || "").trim() !== o.code) { o.tries++; if (o.tries >= 5) OTP.delete(phone); return send(res, 400, { error: "code" }); }
      const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 30), text = String(b.text || "").trim().slice(0, 300), stars = Math.max(1, Math.min(5, Math.round(+b.stars || 0)));
      if (!name || !stars) return send(res, 400, { error: "bad" });
      const docs = await readStore();
      const isClient = Object.values(docs).some(a => a && a.kind === "appt" && live(a) && a.phone && pLocal(a.phone) === phone);
      if (!isClient) return send(res, 403, { error: "notclient" });
      OTP.delete(phone);
      const meta = docs["c" + phone] || {}, id = meta.reviewId || ("r" + Date.now().toString(36) + randomInt(100, 999));
      const rv = { id, name, stars, text, date: ymd(new Date()) };
      await updateFile("config.json", readConfig, writeConfig, c => { c.reviews = (c.reviews || []).filter(r => r.id !== id); c.reviews.unshift(rv); c.reviews = c.reviews.slice(0, 200); return c; }, "review " + stars + "★");
      await changeStore(d => { d["c" + phone] = Object.assign({ kind: "client", phone, name }, d["c" + phone] || {}, { reviewId: id }); return d; }, "review link");
      CFG = await readConfig();
      for (const ph of adminPhones()) sendWA(ph, "⭐ ביקורת חדשה באתר\n" + "★".repeat(stars) + "☆".repeat(5 - stars) + "\n" + name + " · " + phone + (text ? "\n\n" + text : "")).catch(() => {});
      log("review", "ביקורת " + stars + "★ מ-" + name);
      return send(res, 200, { ok: true, review: rv });
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
      let result = "ok", rec = null, newId = null;
      const ctok = createHash("sha256").update(String(Math.random()) + Date.now() + phone).digest("hex").slice(0, 24);
      await changeStore(docs => {
        const today = ymd(new Date());
        const mine = Object.values(docs).filter(a => live(a) && a.kind === "appt" && a.date >= today && pLocal(a.phone) === phone).length;
        if (mine >= (+st.maxFuturePerPhone || 2)) { result = "limit"; return null; }
        const f = slotFree(docs, b.day, b.time, dur);
        if (f !== "ok") { result = f; return null; }
        rec = { kind: "appt", date: b.day, time: b.time, dur, name, phone, note: svc.name, price: +svc.price || 0, source: "web", confirmSent: true, created: Date.now(), reminded: false, ctok };
        newId = "w" + Date.now().toString(36) + randomInt(100, 999);
        docs[newId] = rec;
        return docs;
      }, "booking " + b.day + " " + b.time);
      if (result !== "ok") return send(res, 409, { error: result });
      OTP.delete(phone);
      log("booking", name + " · " + phone + " · " + b.day + " " + b.time + " · " + svc.name);
      setTimeout(() => gcalTick(true), 1500);
      if (st.sendConfirm) sendWA(phone, fill(st.confirm, vars(rec))).catch(e => log("error", "אישור ללקוח נכשל: " + e.message));
      if (st.notifyAdmin) for (const ph of adminPhones()) sendWA(ph, fill(st.adminNew, vars(rec))).catch(e => log("error", "הודעה למנהל " + ph + " נכשלה: " + e.message));
      return send(res, 200, { ok: true, id: newId, ctok });
    }

    /* customer cancels from "התורים שלי" with the private token he got when booking */
    if (p === "/cancel" && req.method === "POST") {
      const b = await body(req);
      if (tooMany("cancel-ip:" + ipOf(req), 10, 3600e3)) return send(res, 429, { error: "rate" });
      if (!b.id || !b.ctok) return send(res, 400, { error: "bad" });
      CFG = await readConfig();
      const st = botSet(), now = Date.now();
      let found = null, result = "ok";
      await changeStore(d => {
        const a = d[b.id];
        if (!a || a.ctok !== String(b.ctok)) { result = "notfound"; return null; }
        if (!live(a)) { result = "already"; return null; }
        const t = parseYmd(a.date).getTime() + toMin(a.time) * 60e3;
        if (t <= now) { result = "past"; return null; }
        if (t - now < (+st.cancelMinBefore || 60) * 60e3) { result = "late"; return null; }
        found = a;
        d[b.id] = Object.assign({}, a, { status: "cancelled", cancelledAt: now, cancelledBy: "client", cancelNotified: true });
        return d;
      }, "client cancelled (site)");
      if (result !== "ok") return send(res, result === "notfound" ? 404 : 409, { error: result, minutes: +st.cancelMinBefore || 60 });
      log("cancel", "הלקוח " + (found.name || found.phone) + " ביטל באתר את התור " + found.date + " " + found.time);
      sendWA(found.phone, fill(st.cancelOk, vars(found))).catch(() => {});
      for (const ph of adminPhones()) sendWA(ph, fill(st.adminCancel, vars(found, { by: " על ידי הלקוח" }))).catch(() => {});
      return send(res, 200, { ok: true });
    }

    /* ----- admin (key = sha256 of the admin password) ----- */
    if (p.startsWith("/admin/")) {
      if (req.headers["x-admin"] !== adminKey()) return send(res, 401, { error: "auth" });
      if (p === "/admin/status") return send(res, 200, { wa: waState, qr: pairCode ? null : lastQr, pair: pairCode, me, gcal: gcalState, url: tunnelUrl, log: LOG.slice(0, 60) });
      if (p === "/admin/test" && req.method === "POST") {
        const b = await body(req);
        try { CFG = await readConfig(); const list = b.phone ? [b.phone] : adminPhones(); for (const ph of list) await sendWA(ph, "בדיקה ✅ הבוט של " + vars({}).biz + " עובד."); log("test", "הודעת בדיקה נשלחה ל-" + list.join(", ")); return send(res, 200, { ok: true, sent: list }); }
        catch (e) { return send(res, 503, { error: e.code || e.message }); }
      }
      if (p === "/admin/cancel" && req.method === "POST") {
        const b = await body(req);
        try { setTimeout(inboxTick, 500); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 503, { error: e.code || e.message }); }
      }
      if (p === "/admin/send" && req.method === "POST") {
        const b = await body(req), text = String(b.text || "").trim().slice(0, 3000);
        if (!phoneOk(b.phone) || !text) return send(res, 400, { error: "bad" });
        try { await sendWA(b.phone, text); log("send", "הודעה נשלחה ל-" + pLocal(b.phone)); return send(res, 200, { ok: true }); }
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
    const due = Object.entries(docs).filter(([, a]) => live(a) && a.kind === "appt" && a.phone && !a.reminded && a.date && a.time).filter(([, a]) => {
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

/* appointments cancelled in the admin panel: tell the client and all admins (once) */
async function cancelNotices(docs) {
  const today = ymd(new Date()), recent = Date.now() - 24 * 3600e3;
  const todo = Object.entries(docs).filter(([, a]) => a && a.kind === "appt" && a.status === "cancelled" && !a.cancelNotified && (a.cancelledAt || 0) > recent && a.date >= today);
  if (!todo.length) return;
  CFG = await readConfig();
  const st = botSet(), done = [];
  for (const [id, a] of todo) {
    const byClient = a.cancelledBy === "client";
    if (!byClient && a.phone) await sendWA(a.phone, fill(st.cancel, vars(a))).catch(e => log("error", "הודעת ביטול ללקוח נכשלה: " + e.message));
    for (const ph of adminPhones()) await sendWA(ph, fill(st.adminCancel, vars(a, { by: byClient ? " על ידי הלקוח" : " על ידי " + ((CFG.biz && CFG.biz.name) || "אריאל") }))).catch(() => {});
    done.push(id); log("cancel", "ביטול נשלח: " + (a.name || a.phone) + " " + a.date + " " + a.time);
  }
  await changeStore(d => { done.forEach(id => { if (d[id]) d[id].cancelNotified = true; }); return d; }, "cancellation notices sent");
}

/* ---------- inbox (Apps Script): bookings made while the bot was off; then confirmations ---------- */
let inboxBusy = false;
async function inboxTick() {
  if (inboxBusy) return; inboxBusy = true;
  try {
    let docs = await readStore();
    const ib = Object.values(docs).find(d => d && d.kind === "inbox" && d.url);
    if (ib) {
      const r = await fetch(ib.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "list", secret: ib.secret }), redirect: "follow" });
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.items && j.items.length) {
        CFG = await readConfig();
        docs = await changeStore(d => {
          for (const x of j.items) {
            if (d[x.id]) continue;
            const clash = Object.values(d).some(a => live(a) && a.date === x.day && a.time && toMin(x.time) < toMin(a.time) + (+a.dur || 0) && toMin(x.time) + x.dur > toMin(a.time));
            d[x.id] = { kind: "appt", date: x.day, time: x.time, dur: x.dur, name: x.name, phone: x.phone, note: x.svcName + (clash ? " ⚠️ חפיפה עם תור אחר" : ""), price: x.price, source: "web", confirmSent: false, created: x.created, reminded: false, ctok: x.ctok || "" };
          }
          return d;
        }, "bookings from inbox");
        await fetch(ib.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "ack", secret: ib.secret, ids: j.items.map(x => x.id) }), redirect: "follow" });
        log("booking", j.items.length + " תורים נכנסו מתיבת ההזמנות");
      }
    }
    if (waState !== "open") return;
    await cancelNotices(docs);
    const todo = Object.entries(docs).filter(([, a]) => live(a) && a.kind === "appt" && a.confirmSent === false && a.date >= ymd(new Date()));
    if (!todo.length) return;
    CFG = await readConfig();
    const st = botSet(), done = [];
    for (const [id, a] of todo) {
      try {
        if (st.sendConfirm) await sendWA(a.phone, fill(st.confirm, vars(a)));
        if (st.notifyAdmin) for (const ph of adminPhones()) await sendWA(ph, fill(st.adminNew, vars(a))).catch(() => {});
        done.push(id); log("booking", "אישור נשלח ל-" + (a.name || a.phone) + " (" + a.date + " " + a.time + ")");
      } catch (e) { if (e.code === "nowa") done.push(id); log("error", "אישור נכשל ל-" + pLocal(a.phone) + ": " + e.message); }
    }
    if (done.length) await changeStore(d => { done.forEach(id => { if (d[id]) d[id].confirmSent = true; }); return d; }, "confirmations sent");
  } catch (e) { log("error", "תיבת ההזמנות: " + e.message); }
  finally { inboxBusy = false; }
}

/* ---------- Google Calendar sync (Apps Script web app; url+secret stored encrypted in data.enc.json, doc kind "gcal") ---------- */
let gcalState = "off", gcalHash = "", gcalAt = 0, gcalBusy = false;
async function gcalTick(force) {
  if (gcalBusy) return; gcalBusy = true;
  try {
    const docs = await readStore();
    const g = Object.values(docs).find(d => d && d.kind === "gcal" && d.url);
    if (!g) { gcalState = "off"; return; }
    const today = ymd(new Date()), biz = (CFG.biz && CFG.biz.name) || "אריאל";
    const items = Object.entries(docs).filter(([, a]) => live(a) && a.kind === "appt" && a.date && a.time && a.date >= today).map(([id, a]) => {
      const st = parseYmd(a.date); st.setMinutes(toMin(a.time)); const en = new Date(st.getTime() + (+a.dur || 30) * 60e3);
      return { id, title: "✂️ " + (a.name || "לקוח") + (a.note ? " · " + a.note : ""), start: st.toISOString(), end: en.toISOString(),
        desc: [a.phone ? "טלפון: " + pLocal(a.phone) : "", a.price ? "מחיר: " + a.price + " ₪" : "", a.source === "web" ? "נקבע באתר" : "נוסף בניהול"].filter(Boolean).join("\n"),
        loc: (CFG.biz && CFG.biz.area) || "" };
    }).sort((x, y) => x.id < y.id ? -1 : 1);
    const hash = JSON.stringify(items);
    if (!force && hash === gcalHash && Date.now() - gcalAt < 6 * 3600e3) return;
    const r = await fetch(g.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ secret: g.secret, items }), redirect: "follow" });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { gcalState = "error"; log("error", "סנכרון יומן Google נכשל" + (j.error ? ": " + j.error : "")); return; }
    if (gcalState !== "ok" || j.made || j.removed) log("gcal", "יומן Google מסונכרן" + (j.made ? " · נוספו " + j.made : "") + (j.removed ? " · הוסרו " + j.removed : ""));
    gcalState = "ok"; gcalHash = hash; gcalAt = Date.now();
  } catch (e) { gcalState = "error"; log("error", "סנכרון יומן Google: " + e.message); }
  finally { gcalBusy = false; }
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
  setInterval(() => gcalTick(false), 60e3);
  setInterval(winbackTick, 60e3);
  setInterval(inboxTick, 45e3); setTimeout(inboxTick, 5000); setTimeout(() => gcalTick(true), 8000);
  setInterval(() => { for (const [k, v] of OTP) if (v.exp < Date.now()) OTP.delete(k); }, 10 * 60e3);
})();
