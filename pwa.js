"use strict";
// ============================================================
// Bâtisseur — brique « Application installable » (PWA)
// 100 % Node natif (zlib, crypto via l'appelant). AUCUNE dépendance npm.
//
// Rôle : au moment de la PUBLICATION, la plateforme rend le site
// installable comme une appli sur le téléphone. L'apprenant n'écrit rien :
// - on génère deux icônes PNG (192 / 512) à partir de l'initiale et d'une
//   couleur sobre,
// - on génère un manifeste (manifest.webmanifest) et un service worker (sw.js),
// - on injecte dans index.html le lien du manifeste, la couleur de thème,
//   l'icône Apple et le petit script d'enregistrement du service worker.
// Tous ces fichiers sont ajoutés au déploiement Netlify aux côtés d'index.html.
// ============================================================

const zlib = require("zlib");

// --- Police 5x7 compacte (A–Z, 0–9) pour dessiner l'initiale --------------
const GLYPHS = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01110","10001","10000","10000","10000","10001","01110"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01110","10001","10000","10111","10001","10001","01110"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"],
  J: ["00011","00001","00001","00001","10001","10001","01110"],
  K: ["10001","10010","10100","11000","10100","10010","10001"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","11011","10001"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"],
  Z: ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11111","00010","00100","00010","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["01110","10000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00001","01110"]
};

// Palette d'accents sobres (fonds d'icône ; texte toujours blanc).
const PALETTE = ["#1F3A5F", "#14532D", "#3B2F63", "#7A2E2E", "#0F5257", "#334155", "#1E3A8A", "#4A2E10"];

function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --- Encodeur PNG minimal (RGBA 8 bits, type couleur 6) -------------------
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Données brutes : un octet de filtre (0) par ligne + les pixels RGBA.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const ro = y * (1 + width * 4);
    raw[ro] = 0;
    rgba.copy(raw, ro + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// Dessine une icône carrée : fond = couleur d'accent, initiale blanche centrée.
function iconPng(size, bgHex, letter) {
  const bg = hexToRgb(bgHex) || [31, 58, 95];
  const fg = [255, 255, 255];
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255;
  }
  const ch = String(letter || "A").toUpperCase();
  const g = GLYPHS[ch] || GLYPHS.A;
  const scale = Math.max(1, Math.floor((size * 0.5) / 7));
  const gw = 5 * scale, gh = 7 * scale;
  const ox = Math.floor((size - gw) / 2), oy = Math.floor((size - gh) / 2);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (g[row][col] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + col * scale + dx, py = oy + row * scale + dy;
          const o = (py * size + px) * 4;
          rgba[o] = fg[0]; rgba[o + 1] = fg[1]; rgba[o + 2] = fg[2]; rgba[o + 3] = 255;
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

// --- Choix de l'identité visuelle à partir du site ------------------------
function firstLetter(name) {
  const m = String(name || "").match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "A";
}
function shortName(name) {
  const s = String(name || "Application").trim();
  const first = s.split(/\s+/)[0] || "App";
  return first.length > 12 ? first.slice(0, 12) : first;
}
// Couleur de thème : on réutilise la couleur du site si elle est déclarée
// (<meta name="theme-color">), sinon on choisit une teinte sobre stable.
function themeColor(name, html) {
  const m = /<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(html || "");
  if (m && hexToRgb(m[1])) return m[1].trim();
  let h = 0; const s = String(name || "app");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function manifestJson(opts) {
  return JSON.stringify({
    name: opts.name || "Application",
    short_name: shortName(opts.name),
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: opts.theme,
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  }, null, 2);
}

function serviceWorker(version) {
  const v = String(version || "1").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "1";
  return `// Service worker Bâtisseur — mise en cache de l'app (généré, ne pas modifier).
var CACHE = "bat-` + v + `";
var ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;                       // on ne touche pas aux envois (commandes, comptes)
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;        // requêtes vers la plateforme : intactes
  e.respondWith(
    caches.match(req).then(function(hit){
      return hit || fetch(req).then(function(resp){
        if(resp && resp.status === 200 && resp.type === "basic"){
          var copy = resp.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); });
        }
        return resp;
      }).catch(function(){ return caches.match("./index.html"); });
    })
  );
});`;
}

// Injecte dans la page les balises PWA + l'enregistrement du service worker.
function injectPwa(html, opts) {
  const theme = opts.theme;
  const head =
    '\n<!-- BAT-PWA:START -->' +
    '\n<link rel="manifest" href="manifest.webmanifest">' +
    '\n<meta name="theme-color" content="' + theme + '">' +
    '\n<link rel="apple-touch-icon" href="icon-192.png">' +
    '\n<meta name="apple-mobile-web-app-capable" content="yes">' +
    '\n<meta name="apple-mobile-web-app-title" content="' + shortName(opts.name).replace(/"/g, "") + '">' +
    (/name=["']viewport["']/i.test(html) ? "" : '\n<meta name="viewport" content="width=device-width, initial-scale=1">') +
    '\n<!-- BAT-PWA:END -->\n';
  const reg =
    '\n<!-- BAT-PWA:SW -->' +
    '\n<script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("sw.js").catch(function(){});});}</script>\n';

  let out = html;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, head + "</head>");
  else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, "<body$1>" + head);
  else out = head + out;

  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, reg + "</body>");
  else out = out + reg;
  return out;
}

// Construit l'ensemble des fichiers à déployer pour rendre le site installable.
// Renvoie { "index.html": Buffer, "manifest.webmanifest": Buffer, "sw.js": Buffer,
//           "icon-192.png": Buffer, "icon-512.png": Buffer }
function buildPwaFiles(html, opts) {
  const name = (opts && opts.name) || "Application";
  const version = (opts && opts.version) || "1";
  const theme = themeColor(name, html);
  const letter = firstLetter(name);
  const injected = injectPwa(html, { name: name, theme: theme });
  return {
    "index.html": Buffer.from(injected, "utf8"),
    "manifest.webmanifest": Buffer.from(manifestJson({ name: name, theme: theme }), "utf8"),
    "sw.js": Buffer.from(serviceWorker(version), "utf8"),
    "icon-192.png": iconPng(192, theme, letter),
    "icon-512.png": iconPng(512, theme, letter)
  };
}

module.exports = { buildPwaFiles, injectPwa, iconPng, manifestJson, serviceWorker, themeColor, firstLetter, shortName, encodePng };
