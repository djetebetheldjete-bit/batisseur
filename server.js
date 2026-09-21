/**
 * Bâtisseur — le parcours complet (moteur v1.5)
 *
 * Principes de fiabilité (v1.5) :
 * - UNE SEULE structure : le site est une page unique (index.html). Plus de mode.
 * - Édition à partir du RÉEL : à chaque retouche, on injecte le code EXACT du site
 *   actuel dans le prompt, et Claude renvoie la page entière à jour. Rien ne se perd.
 * - EXTRACTION BLINDÉE : le code du site est toujours retiré du message affiché —
 *   jamais de HTML qui fuite dans la discussion, quel que soit le format renvoyé.
 * - HISTORIQUE LÉGER : on ne stocke que le TEXTE des messages (sans code). Le fichier
 *   du site est la seule source de vérité.
 *
 * Étapes : Diagnostic + Modules 01 à 08. Aucune dépendance : Node.js 18+.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    txt.split(/\r?\n/).forEach((line) => {
      if (line.trim().startsWith("#")) return;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    });
  } catch (e) {}
}
loadEnv(path.join(__dirname, ".env"));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const PORT = process.env.PORT || 3000;
// Jeton d'hébergement (Palier 2) : la plateforme publie les sites des apprenants à leur place.
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;
// Base de données (Palier 3) : mémoire durable. Si absente, on retombe sur les fichiers locaux.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const USE_DB = !!(SUPABASE_URL && SUPABASE_KEY);

// --- Les étapes (build:true = étape qui produit / modifie le site) ---
const STEPS = [
  { key: "diagnostic", label: "Comprendre le projet",      promptFile: "diagnostic.txt", kickoff: "Bonjour ! Je découvre Bâtisseur et je veux créer un projet." },
  { key: "clarifier",  label: "Définir les fondations",    promptFile: "clarifier.txt",  kickoff: "On passe à la clarification de mon site." },
  { key: "rassembler", label: "Réunir les éléments",       promptFile: "rassembler.txt", kickoff: "On passe à rassembler les contenus de mon site." },
  { key: "bienparler", label: "Prendre en main l'assistant", promptFile: "module-03.txt", kickoff: "On passe à : bien te demander les choses, avant de construire." },
  { key: "accueil",    label: "Créer la base",             promptFile: "module-04.txt",  kickoff: "On passe à la construction de la page d'accueil de mon site.", build: true },
  { key: "pagescles",  label: "Ajouter les rubriques",     promptFile: "module-05.txt",  kickoff: "On passe à l'ajout des rubriques (À propos, Réalisations…).", build: true },
  { key: "contact",    label: "Mettre en place le contact", promptFile: "module-06.txt", kickoff: "On passe à la mise en place du contact.", build: true },
  { key: "beaumobile", label: "Soigner l'apparence",       promptFile: "module-07.txt",  kickoff: "On passe à rendre le site beau et impeccable sur mobile.", build: true },
  { key: "miseenligne",label: "Publier",                   promptFile: "module-08.txt",  kickoff: "On passe à la mise en ligne de mon site.", build: true }
];
const LAST_STEP = STEPS.length - 1;

const PROMPTS = STEPS.map((s) => {
  try { return fs.readFileSync(path.join(__dirname, "prompts", s.promptFile), "utf8"); }
  catch (e) { console.warn(`  (prompt ${s.promptFile} introuvable)`); return "Tu es un assistant chaleureux, clair et sans jargon."; }
});

// --- Consigne de construction (UNE SEULE PAGE), ajoutée aux étapes de build ---
const SINGLE_INSTRUCTION = `

=== RÈGLES DE FORMAT (à respecter SANS EXCEPTION) ===
Le site est UNE SEULE PAGE : index.html. Chaque rubrique est une SECTION avec un id (ex. <section id="services">). Le menu utilise des ancres internes (ex. <a href="#services">Services</a>) et chaque entrée a bien sa section. Jamais de lien vide (href="#") ni de lien qui ne mène nulle part.

FORMAT DE SORTIE — LE PLUS IMPORTANT :
1) D'abord un COURT message pour la personne (1 à 3 phrases, en français simple, SANS jargon, SANS parler de code, SANS balise).
2) Ensuite le site, dans UN SEUL bloc de code, exactement ainsi :
\`\`\`html:index.html
<!doctype html>
<html lang="fr">
... la page ENTIÈRE ...
</html>
\`\`\`
- Tu renvoies TOUJOURS la page ENTIÈRE (jamais un extrait, jamais « ... » à la place du contenu).
- Tu ne mets JAMAIS de code ni de balise HTML en dehors de ce bloc. Ton message à la personne n'en contient jamais.
- UN SEUL bloc de code par réponse.

CONTRAINTES TECHNIQUES :
- 100 % HTML + CSS. AUCUN JavaScript. AUCUNE image ni police externe, AUCUN fichier externe.
- Responsive, impeccable sur mobile. Dans le <style> : html{scroll-behavior:smooth;}.

RUBRIQUES LIBRES :
- Le menu reflète EXACTEMENT les rubriques voulues (Accueil, Services, Réalisations, À propos, Contact, Tarifs, Blog, FAQ, Équipe, Galerie, Horaires… ce que la personne veut).
- Tu peux à tout moment AJOUTER, RENOMMER, RÉORDONNER ou SUPPRIMER une rubrique sur demande, puis tu renvoies la page entière.
- PLACEHOLDER : une rubrique dont le contenu n'est pas fourni reçoit un espace réservé clair et élégant (ex. « Vos réalisations apparaîtront ici — dites-moi de les ajouter »). Jamais de section vide ni cassée.

ESPACES MÉDIAS — DEMANDE AVANT DE SUPPOSER :
- Quand un espace n'est pas clair (zone d'image, galerie, document…), tu DEMANDES d'abord à la personne à quoi il sert : « des photos », « du texte », ou « des documents (PDF / Word / PowerPoint) » — puis tu poses le bon espace réservé.
- Pour une image : un cadre réservé propre avec une légende. Pour un document : une zone qui annonce le document à venir. Tu n'inventes jamais d'image externe.`;

const DATA_DIR = path.join(__dirname, "data");
const SITES_DIR = path.join(DATA_DIR, "sites");
try { fs.mkdirSync(SITES_DIR, { recursive: true }); } catch (e) {}

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml" };

function sendJson(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 8e6) req.destroy(); }); req.on("end", () => resolve(b)); req.on("error", reject); }); }

function validId(id) { return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id); }
function convPath(id) { return validId(id) ? path.join(DATA_DIR, id + ".json") : null; }
function siteDir(id) { return validId(id) ? path.join(SITES_DIR, id) : null; }
function siteFile(id) { const d = siteDir(id); return d ? path.join(d, "index.html") : null; }
function safeFile(name) { return /^[A-Za-z0-9_-]+\.html$/.test(name) ? name : null; }

// --- Accès Supabase (API REST, aucune dépendance) ---
async function sb(pathPart, opts = {}) {
  const res = await fetch(SUPABASE_URL + "/rest/v1" + pathPart, Object.assign({}, opts, {
    headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" }, opts.headers || {})
  }));
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const e = new Error("Base de données : erreur " + res.status + (data && data.message ? " — " + data.message : "")); e.status = res.status; throw e; }
  return data;
}

// --- Stockage : base de données si configurée, sinon fichiers locaux ---
async function loadConv(id) {
  if (!validId(id)) return null;
  if (USE_DB) { try { const r = await sb(`/conversations?id=eq.${encodeURIComponent(id)}&select=data`); return (r && r[0]) ? r[0].data : null; } catch (e) { console.error("loadConv:", e.message); return null; } }
  const p = convPath(id); try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
async function saveConv(conv) {
  if (USE_DB) { try { await sb(`/conversations?on_conflict=id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: conv.id, data: conv, updated_at: new Date().toISOString() }]) }); } catch (e) { console.error("saveConv:", e.message); } return; }
  const p = convPath(conv.id); if (!p) return; try { fs.writeFileSync(p, JSON.stringify(conv, null, 2)); } catch (e) { console.error("Sauvegarde :", e); }
}

// --- Le site : lecture / écriture (une seule page = index.html) ---
async function readSite(id) {
  if (!validId(id)) return null;
  if (USE_DB) { try { const r = await sb(`/sites?id=eq.${encodeURIComponent(id)}&select=html`); return (r && r[0]) ? r[0].html : null; } catch (e) { console.error("readSite:", e.message); return null; } }
  const f = siteFile(id); if (!f) return null; try { return fs.readFileSync(f, "utf8"); } catch (e) { return null; }
}
async function hasSite(id) {
  if (USE_DB) { return !!(await readSite(id)); }
  const f = siteFile(id); try { return !!f && fs.existsSync(f); } catch (e) { return false; }
}
async function writeSite(id, html) {
  if (!validId(id) || !html) return false;
  if (USE_DB) { try { await sb(`/sites?on_conflict=id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id, html, updated_at: new Date().toISOString() }]) }); return true; } catch (e) { console.error("writeSite:", e.message); return false; } }
  const dir = siteDir(id); if (!dir) return false;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try { fs.readdirSync(dir).forEach((f) => { if (f.endsWith(".html") && f !== "index.html") fs.unlinkSync(path.join(dir, f)); }); } catch (e) {}
  try { fs.writeFileSync(path.join(dir, "index.html"), html); return true; } catch (e) { return false; }
}

// --- EXTRACTION BLINDÉE ---------------------------------------------------
// Objectif : récupérer le HTML du site QUEL QUE SOIT le format renvoyé par Claude,
// et surtout garantir qu'AUCUN code ne reste dans le message affiché à la personne.
function looksLikeHtml(s) {
  if (!s) return false;
  return /<!doctype html/i.test(s) || /<html[\s>]/i.test(s) ||
         (/<(section|header|main|body|nav|div|h1|footer)[\s>]/i.test(s) && (s.match(/<[a-z!\/]/gi) || []).length > 4);
}

function extractSite(text) {
  let message = String(text || "");
  let html = null;

  // 1) Tous les blocs de code entre ``` … ``` (avec ou sans langage / nom de fichier).
  const blocks = [];
  const fence = /```[^\n`]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(message))) blocks.push(m[1]);
  if (blocks.length) {
    // On retire TOUS les blocs fermés du message : rien de codé ne doit rester.
    message = message.replace(/```[^\n`]*\r?\n?[\s\S]*?```/g, "").trim();
    const htmlBlocks = blocks.filter(looksLikeHtml).sort((a, b) => b.length - a.length);
    if (htmlBlocks.length) html = htmlBlocks[0].trim();
  }

  // 2) Pas de bloc HTML fermé ? On cherche une page HTML « nue » dans le texte.
  if (!html) {
    const bare = message.match(/<!doctype html[\s\S]*?<\/html>/i) || message.match(/<html[\s\S]*?<\/html>/i);
    if (bare) { html = bare[0].trim(); message = message.replace(bare[0], "").trim(); }
  }

  // 3) Filet de sécurité : on efface tout résidu de HTML complet dans le message.
  message = message
    .replace(/<!doctype html[\s\S]*?<\/html>/gi, "")
    .replace(/<html[\s\S]*?<\/html>/gi, "")
    .trim();

  // 4) Réponse tronquée : une fence ouverte non refermée, ou un HTML nu qui commence
  //    sans se terminer. On coupe le message à cet endroit (et on récupère le HTML).
  const cut = message.search(/```|<!doctype html|<html[\s>]/i);
  if (cut !== -1) {
    let tail = message.slice(cut).replace(/^```[^\n`]*\r?\n?/, "");
    if (!html && looksLikeHtml(tail)) html = tail.trim();
    message = message.slice(0, cut).trim();
  }

  // 5) Nettoyage final du message (backticks orphelins, lignes vides multiples).
  message = message.replace(/`{1,3}/g, "").replace(/\n{3,}/g, "\n\n").trim();

  return { html, message };
}
// -------------------------------------------------------------------------

async function callClaude(system, messages) {
  const clean = messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8192, system, messages: clean })
  });
  const data = await response.json();
  if (!response.ok) { console.error("Erreur API Claude :", data); const e = new Error((data && data.error && data.error.message) || "Erreur de l'API Claude."); e.status = response.status; throw e; }
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Génère la réponse de l'étape courante (et met à jour le site si c'est une étape de construction).
async function produceCurrent(conv) {
  const step = conv.step || 0;
  const isBuild = !!STEPS[step].build;

  let system = PROMPTS[step];
  if (isBuild) {
    system += SINGLE_INSTRUCTION;
    // On injecte le CODE RÉEL du site actuel : Claude part de l'existant, pas de sa mémoire.
    const current = await readSite(conv.id);
    if (current) {
      system += `

=== ÉTAT ACTUEL DU SITE (index.html) ===
Voici le code EXACT du site tel qu'il est maintenant. Tu PARS de ce code, tu appliques la demande de la personne, et tu renvoies le fichier ENTIER à jour. Tu ne repars jamais de zéro (sauf demande explicite), et tu ne perds aucun contenu déjà présent.
\`\`\`html
${current}
\`\`\``;
    }
  }

  const reply = await callClaude(system, conv.messages);

  // Extraction blindée : le HTML ne fuite jamais dans le message.
  const ex = extractSite(reply);
  let siteUpdated = false;
  let message = ex.message;

  if (isBuild && ex.html && await writeSite(conv.id, ex.html)) { siteUpdated = true; conv.hasSite = true; }
  if (!message || !message.trim()) message = siteUpdated ? "✓ J'ai mis à jour votre site — regardez l'aperçu." : (ex.html ? "✓ C'est fait." : reply);

  // Historique LÉGER : on ne stocke que le TEXTE (jamais le code). La base/fichier = source de vérité.
  conv.messages.push({ role: "assistant", content: message });
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  return { reply: message, siteUpdated };
}

// POST /api/start
async function handleStart(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const id = crypto.randomUUID();
    const conv = { id, step: 0, createdAt: new Date().toISOString(), messages: [{ role: "user", content: STEPS[0].kickoff, hidden: true }] };
    const out = await produceCurrent(conv);
    sendJson(res, 200, { id, step: 0, ...out });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/chat
async function handleChat(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
    if (typeof p.message !== "string" || !p.message.trim()) return sendJson(res, 400, { error: "Message vide." });
    conv.messages.push({ role: "user", content: p.message });
    const out = await produceCurrent(conv);
    sendJson(res, 200, { step: conv.step, ...out });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/next
async function handleNext(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
    const current = conv.step || 0;
    if (current >= LAST_STEP) return sendJson(res, 200, { step: current, atEnd: true, reply: null, siteUpdated: false });
    conv.step = current + 1;
    conv.messages.push({ role: "user", content: STEPS[conv.step].kickoff, hidden: true });
    const out = await produceCurrent(conv);
    sendJson(res, 200, { step: conv.step, atEnd: conv.step >= LAST_STEP, ...out });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// GET /api/download?id=... : télécharge le site (index.html) en pièce jointe
async function handleDownload(req, res) {
  const u = new URL(req.url, "http://localhost");
  const html = await readSite(u.searchParams.get("id"));
  if (!html) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Site introuvable — construisez-le d'abord."); }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-disposition": 'attachment; filename="index.html"'
  });
  res.end(html);
}

// GET /api/conversation?id=...
async function handleGetConversation(req, res) {
  const u = new URL(req.url, "http://localhost");
  const conv = await loadConv(u.searchParams.get("id"));
  if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
  sendJson(res, 200, { id: conv.id, step: conv.step || 0, hasSite: await hasSite(conv.id), publishedUrl: conv.publishedUrl || null, messages: conv.messages.filter((m) => !m.hidden) });
}

// GET /preview/<id>/<fichier> : sert le site généré (une seule page)
async function servePreview(req, res) {
  const parts = decodeURIComponent(req.url.split("?")[0]).split("/").filter(Boolean); // ["preview", id, file?]
  const id = parts[1];
  if (!validId(id)) { res.writeHead(404); return res.end("Introuvable"); }
  let html = null;
  try { html = await readSite(id); } catch (e) { html = null; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (html) return res.end(html);
  // Filet : le site n'existe pas encore.
  res.end("<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui,sans-serif;color:#6B7A90;display:grid;place-items:center;height:88vh;text-align:center;padding:20px\">Le site n'est pas encore construit.<br>Arrivez à l'étape « Créer la base ».</body>");
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Accès interdit"); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Page introuvable"); }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

// --- PUBLICATION EN LIGNE (Palier 2) : via Netlify, sans compte côté apprenant ---
const NETLIFY_API = "https://api.netlify.com/api/v1";
async function netlify(path, opts = {}) {
  const res = await fetch(NETLIFY_API + path, Object.assign({}, opts, {
    headers: Object.assign({ "Authorization": "Bearer " + NETLIFY_TOKEN }, opts.headers || {})
  }));
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) { const e = new Error((data && data.message) || ("Hébergeur : erreur " + res.status)); e.status = res.status; throw e; }
  return data;
}

// Publie (ou met à jour) le site d'une conversation, renvoie l'adresse publique.
async function publishSite(conv) {
  if (!NETLIFY_TOKEN) { const e = new Error("La publication n'est pas encore configurée sur cette plateforme."); e.status = 501; throw e; }
  const html = await readSite(conv.id);
  if (!html) { const e = new Error("Aucun site à publier : construisez d'abord votre site."); e.status = 400; throw e; }
  const buf = Buffer.from(html, "utf8");
  const sha1 = crypto.createHash("sha1").update(buf).digest("hex");

  // 1) Créer le site chez l'hébergeur (une seule fois par conversation).
  if (!conv.netlifySiteId) {
    const site = await netlify("/sites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    conv.netlifySiteId = site.id;
    conv.publishedUrl = site.ssl_url || site.url;
    await saveConv(conv);
  }

  // 2) Créer un déploiement en annonçant le fichier par son empreinte (sha1).
  const deploy = await netlify(`/sites/${conv.netlifySiteId}/deploys`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { "/index.html": sha1 } })
  });

  // 3) Téléverser le fichier si l'hébergeur ne l'a pas déjà.
  if ((deploy.required || []).includes(sha1)) {
    await netlify(`/deploys/${deploy.id}/files/index.html`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf
    });
  }

  // 4) Attendre que le déploiement soit prêt (quelques secondes).
  let state = deploy.state, url = conv.publishedUrl;
  for (let i = 0; i < 8 && state !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try { const d = await netlify(`/deploys/${deploy.id}`); state = d.state; if (d.ssl_url) url = d.ssl_url; } catch (e) { break; }
  }
  if (url) conv.publishedUrl = conv.publishedUrl || url;
  await saveConv(conv);
  return { url: conv.publishedUrl, state };
}

// POST /api/publish
async function handlePublish(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
    const out = await publishSite(conv);
    sendJson(res, 200, out);
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Publication impossible." }); }
}

// GET /api/config : ce que le client a besoin de savoir (ex. si la publication est dispo).
function handleConfig(req, res) { sendJson(res, 200, { canPublish: !!NETLIFY_TOKEN }); }

// --- CERTIFICAT (simple) : une belle page imprimable en PDF ---
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

// GET /api/certificate?id=...&name=...
async function handleCertificate(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id);
  if (!conv) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end("Conversation introuvable."); }
  let name = (u.searchParams.get("name") || "").trim().slice(0, 80);
  if (!name) name = "Apprenant(e)";
  const now = new Date();
  const dateStr = `${now.getDate()} ${MOIS[now.getMonth()]} ${now.getFullYear()}`;
  const num = "BÂT-" + String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  const online = conv.publishedUrl ? `<div class="online">Projet en ligne : <span>${escapeHtml(conv.publishedUrl)}</span></div>` : "";

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Certificat — Bâtisseur</title>
<style>
  @page{ size:A4 landscape; margin:0; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:"Segoe UI",Arial,sans-serif; background:#eef1f6; display:flex; justify-content:center; padding:24px; }
  .print{ position:fixed; top:16px; right:16px; background:#147C8C; color:#fff; border:none; border-radius:8px; padding:10px 16px; font-size:14px; cursor:pointer; box-shadow:0 4px 14px rgba(20,124,140,.35); }
  .print:hover{ filter:brightness(1.06); }
  .sheet{ width:1040px; max-width:100%; aspect-ratio:1.414/1; background:#fff; position:relative; box-shadow:0 12px 44px rgba(14,27,46,.16); }
  .frame{ position:absolute; inset:22px; border:2px solid #147C8C; }
  .frame:before{ content:""; position:absolute; inset:8px; border:1px solid #D98A2B; }
  .inner{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:6% 9%; }
  .brand{ display:flex; align-items:center; gap:10px; }
  .logo{ width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#147C8C,#D98A2B); color:#06121c; font-weight:800; font-size:20px; display:flex; align-items:center; justify-content:center; }
  .brand b{ font-family:Georgia,serif; font-size:20px; color:#0E1B2E; }
  .kicker{ letter-spacing:.34em; text-transform:uppercase; color:#147C8C; font-size:12px; font-weight:700; margin:22px 0 4px; }
  h1{ font-family:Georgia,serif; font-size:42px; color:#0E1B2E; margin:0; }
  .sub{ color:#4a5a70; font-size:15px; margin-top:14px; }
  .name{ font-family:Georgia,serif; font-size:38px; color:#0C5866; margin:14px auto 4px; border-bottom:2px solid #D8DFE9; padding:0 30px 10px; }
  .desc{ color:#1c2b3f; font-size:16px; max-width:66ch; margin:16px auto 0; line-height:1.55; }
  .online{ margin-top:12px; font-size:13px; color:#4a5a70; }
  .online span{ color:#0C5866; }
  .meta{ display:flex; gap:64px; margin-top:34px; color:#6B7A90; font-size:12.5px; }
  .meta b{ display:block; color:#0E1B2E; font-size:15px; font-family:Georgia,serif; margin-top:3px; }
  @media print{ body{ background:#fff; padding:0; } .sheet{ box-shadow:none; width:100%; height:100vh; } .print{ display:none; } }
</style></head>
<body>
  <button class="print" onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button>
  <div class="sheet"><div class="frame"></div><div class="inner">
    <div class="brand"><span class="logo">B</span><b>Bâtisseur</b></div>
    <div class="kicker">Certificat de réussite</div>
    <h1>Parcours de création de site web</h1>
    <div class="sub">Ce certificat atteste que</div>
    <div class="name">${escapeHtml(name)}</div>
    <div class="desc">a suivi et complété le parcours Bâtisseur, et a créé son propre site web en dialoguant avec l'assistant — de l'idée jusqu'à la mise en ligne.</div>
    ${online}
    <div class="meta">
      <div>Délivré le<b>${dateStr}</b></div>
      <div>Certificat n°<b>${num}</b></div>
    </div>
  </div></div>
</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/start") return handleStart(req, res);
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/next") return handleNext(req, res);
  if (req.method === "POST" && req.url === "/api/publish") return handlePublish(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/config")) return handleConfig(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/certificate")) return handleCertificate(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/download")) return handleDownload(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/conversation")) return handleGetConversation(req, res);
  if (req.method === "GET" && req.url.startsWith("/preview/")) return servePreview(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Méthode non autorisée");
});

server.listen(PORT, () => {
  console.log(`\n  Bâtisseur — parcours complet (v1.5) en marche.`);
  console.log(`  Ouvrez  http://localhost:${PORT}`);
  console.log(`  Étapes : ${STEPS.map((s) => s.label).join("  →  ")}`);
  console.log(`  Modèle : ${MODEL}`);
  console.log(`  Mémoire : ${USE_DB ? "base de données (Supabase)" : "fichiers locaux"}`);
  console.log(`  Publication : ${NETLIFY_TOKEN ? "activée" : "désactivée"}\n`);
});

// --- Auto-test hors ligne : node server.js --selftest ---
if (process.argv.includes("--selftest")) {
  const cases = [
    ["nommé", "Voici votre site !\n```html:index.html\n<!doctype html><html><body><section id=\"accueil\">Bonjour</section></body></html>\n```\nDites-moi la suite."],
    ["simple", "J'ai ajouté la rubrique.\n```html\n<!doctype html><html><body><nav>menu</nav></body></html>\n```"],
    ["sans langage", "C'est fait.\n```\n<!doctype html><html><body><header>x</header><main>y</main></body></html>\n```"],
    ["nu sans fence", "Voici le résultat : <!doctype html><html><body><section id=\"a\">A</section></body></html> Voilà."],
    ["tronqué (pas de fin)", "Je mets à jour.\n```html:index.html\n<!doctype html><html><body><section id=\"services\">"],
    ["deux blocs", "Note.\n```txt\nliste\n```\n```html\n<!doctype html><html><body><main>ok</main></body></html>\n```"],
    ["pas de code (discussion)", "Quelles rubriques voulez-vous : Accueil, Services, Contact ?"]
  ];
  let ok = 0;
  cases.forEach(([name, input]) => {
    const r = extractSite(input);
    const leak = /<\/?(html|body|section|nav|header|main|div|doctype)/i.test(r.message) || /```/.test(r.message);
    const wantHtml = name !== "pas de code (discussion)";
    const good = !leak && (wantHtml ? !!r.html : !r.html);
    ok += good ? 1 : 0;
    console.log(`${good ? "✓" : "✗"} ${name}`);
    if (!good) console.log(`    message=<<${r.message}>> html=${r.html ? "[" + r.html.length + " car.]" : "null"}`);
  });
  console.log(`\n${ok}/${cases.length} cas OK`);
  process.exit(ok === cases.length ? 0 : 1);
}
