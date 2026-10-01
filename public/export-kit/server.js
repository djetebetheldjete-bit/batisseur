"use strict";
// ============================================================
// Mini-serveur AUTONOME généré par Bâtisseur.
// Il sert votre application (public/index.html) ET lui fournit le « cerveau » :
// données partagées, comptes membres, fichiers — via les mêmes commandes Batisseur.*
// que dans l'atelier. Pur Node.js, zéro dépendance à installer.
//
// Démarrage local :   node server.js   puis ouvrez http://localhost:3000
// En ligne (Render) : voir le guide README.md
// Données : par défaut un simple fichier local (data.json). Pour une vraie base
// partagée et permanente, renseignez SUPABASE_URL et SUPABASE_KEY (voir README).
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const USE_DB = !!(SUPABASE_URL && SUPABASE_KEY);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data.json");
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 jours

// ---------- stockage ----------
function loadLocal() { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return { submissions: [], users: {}, sessions: {} }; } }
function saveLocal(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch (e) {} }
async function sb(q, opts = {}) {
  const r = await fetch(SUPABASE_URL + "/rest/v1" + q, { ...opts, headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "content-type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text(); if (!r.ok) throw new Error("DB " + r.status + " " + t); return t ? JSON.parse(t) : null;
}

// ---------- utilitaires ----------
function hashPw(pw) { const salt = crypto.randomBytes(16).toString("hex"); const h = crypto.scryptSync(String(pw), salt, 32).toString("hex"); return salt + ":" + h; }
function verifyPw(pw, stored) { try { const [salt, h] = String(stored).split(":"); const k = crypto.scryptSync(String(pw), salt, 32).toString("hex"); return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(h)); } catch (e) { return false; } }
function readBody(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { res({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" }); res.end(JSON.stringify(obj)); }
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function cleanColl(c) { return (String(c || "message").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)) || "message"; }

// ---------- données (submit / list) ----------
async function addSubmission(rec) {
  if (USE_DB) { await sb("/submissions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ id: rec.id, collection: rec.collection, data: rec.data, created_at: rec.createdAt }]) }); }
  else { const d = loadLocal(); d.submissions.push(rec); saveLocal(d); }
}
async function listSubmissions(collection) {
  if (USE_DB) { return (await sb("/submissions?collection=eq." + encodeURIComponent(collection) + "&select=id,data,created_at&order=created_at.desc&limit=500")) || []; }
  return loadLocal().submissions.filter((s) => s.collection === collection).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---------- comptes membres ----------
async function findUser(email) {
  const e = normEmail(email);
  if (USE_DB) { const r = await sb("/app_users?email=eq." + encodeURIComponent(e) + "&select=*"); return (r && r[0]) || null; }
  return Object.values(loadLocal().users).find((u) => u.email === e) || null;
}
async function createUser(email, name, pw) {
  const user = { id: crypto.randomUUID(), email: normEmail(email), name: String(name || "").slice(0, 80) || normEmail(email).split("@")[0], pass: hashPw(pw), created_at: new Date().toISOString() };
  if (USE_DB) { await sb("/app_users", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([user]) }); }
  else { const d = loadLocal(); d.users[user.id] = user; saveLocal(d); }
  return user;
}
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  if (USE_DB) { await sb("/app_sessions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ token, user_id: userId, created_at: new Date().toISOString() }]) }); }
  else { const d = loadLocal(); d.sessions[token] = { userId, at: Date.now() }; saveLocal(d); }
  return token;
}
async function userFromToken(token) {
  if (!token) return null;
  if (USE_DB) {
    const r = await sb("/app_sessions?token=eq." + encodeURIComponent(token) + "&select=user_id,created_at"); const s = r && r[0]; if (!s) return null;
    if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL) return null;
    const u = await sb("/app_users?id=eq." + encodeURIComponent(s.user_id) + "&select=*"); return (u && u[0]) || null;
  }
  const d = loadLocal(); const s = d.sessions[token]; if (!s) return null; if (Date.now() - (s.at || 0) > SESSION_TTL) return null; return d.users[s.userId] || null;
}
async function deleteSession(token) {
  if (USE_DB) { try { await sb("/app_sessions?token=eq." + encodeURIComponent(token), { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} }
  else { const d = loadLocal(); delete d.sessions[token]; saveLocal(d); }
}
function publicUser(u) { return u ? { id: u.id, name: u.name, email: u.email } : null; }

// ---------- API /api/app/* ----------
async function handleApp(req, res, action) {
  const p = await readBody(req);
  try {
    if (action === "submit") {
      const collection = cleanColl(p.collection);
      let data = (p.data && typeof p.data === "object") ? p.data : { valeur: String(p.data == null ? "" : p.data).slice(0, 2000) };
      const clean = {}; Object.keys(data).slice(0, 20).forEach((k) => { let v = data[k]; if (typeof v === "string") v = v.slice(0, 2000); clean[String(k).slice(0, 60)] = v; });
      if (p.token) { const m = await userFromToken(p.token); if (m) clean._membre = m.email; }
      await addSubmission({ id: crypto.randomUUID(), collection, data: clean, createdAt: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (action === "list") {
      const collection = cleanColl(p.collection);
      const isPublic = /^public_/.test(collection);
      let email = null;
      if (!isPublic) { const m = p.token ? await userFromToken(p.token) : null; if (!m) return json(res, 403, { error: "Connexion requise." }); email = m.email; }
      const limit = Math.min(Math.max(parseInt(p.limit, 10) || 50, 1), 200);
      let rows = await listSubmissions(collection);
      if (!isPublic) rows = rows.filter((s) => s.data && s.data._membre === email);
      const items = rows.slice(0, limit).map((s) => { let d = s.data || {}; if (isPublic) { d = Object.assign({}, d); Object.keys(d).forEach((k) => { if (k.charAt(0) === "_") delete d[k]; }); } return { id: s.id, data: d, createdAt: s.created_at || s.createdAt }; });
      return json(res, 200, { items });
    }
    if (action === "auth/register") {
      const email = normEmail(p.email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "E-mail invalide." });
      if (typeof p.password !== "string" || p.password.length < 6) return json(res, 400, { error: "Mot de passe : 6 caractères minimum." });
      if (await findUser(email)) return json(res, 409, { error: "Un compte existe déjà." });
      const u = await createUser(email, p.name, p.password); const token = await createSession(u.id);
      return json(res, 200, { token, user: publicUser(u) });
    }
    if (action === "auth/login") {
      const u = await findUser(p.email); if (!u || !verifyPw(p.password, u.pass)) return json(res, 401, { error: "E-mail ou mot de passe incorrect." });
      const token = await createSession(u.id); return json(res, 200, { token, user: publicUser(u) });
    }
    if (action === "auth/me") { const u = await userFromToken(p.token); return json(res, 200, { user: publicUser(u) }); }
    if (action === "auth/logout") { await deleteSession(p.token); return json(res, 200, { ok: true }); }
    if (action === "upload") { return json(res, 200, { ok: true, note: "Upload non activé dans cette version autonome." }); }
    if (action === "pay") { return json(res, 400, { error: "Le paiement nécessite une clé Wave côté serveur." }); }
    return json(res, 404, { error: "Action inconnue." });
  } catch (e) { return json(res, 500, { error: "Erreur serveur." }); }
}

// ---------- fichiers statiques ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url.split("?")[0]) || "/"); if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Interdit"); }
  fs.readFile(file, (err, buf) => {
    if (err) { // repli : sert index.html (application à page unique)
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => { if (e2) { res.writeHead(404); return res.end("Introuvable"); } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(idx); });
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" }); res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/app/")) { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" }); return res.end(); }
  if (req.method === "POST" && req.url.startsWith("/api/app/")) { return handleApp(req, res, req.url.replace("/api/app/", "").split("?")[0]); }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Méthode non supportée");
});
server.listen(PORT, () => { console.log("Votre application tourne sur http://localhost:" + PORT + (USE_DB ? "  (base Supabase)" : "  (données locales : data.json)")); });
