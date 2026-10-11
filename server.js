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
const pwa = require("./pwa.js");
let QUIZ = null;
try { QUIZ = require("./quiz.js"); } catch (e) { console.warn("  (quiz.js introuvable : examen désactivé)"); }

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

// Clés API : une seule (ANTHROPIC_API_KEY) ou plusieurs (ANTHROPIC_API_KEYS, séparées par des virgules).
// Plusieurs clés = bascule automatique si l'une est saturée/en erreur (voir callClaude).
const API_KEYS = (function () {
  const many = (process.env.ANTHROPIC_API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const one = (process.env.ANTHROPIC_API_KEY || "").trim();
  const all = [];
  many.concat(one ? [one] : []).forEach((k) => { if (k && all.indexOf(k) === -1) all.push(k); });
  return all;
})();
const API_KEY = API_KEYS[0]; // compat / test de présence
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
// Modèle allégé pour les étapes de DISCUSSION (par défaut = le même modèle ; mettre p.ex. un Haiku pour réduire le coût).
// Modèle « léger » : rapide et économique, pour les réponses courtes (questions, cours de codage).
// Réglable via ANTHROPIC_MODEL_LIGHT. Si indisponible sur le compte, callClaude bascule sur MODEL.
const MODEL_LIGHT = process.env.ANTHROPIC_MODEL_LIGHT || "claude-haiku-4-5";
// Modèle PUISSANT pour l'espace « Premium learner » (applications avancées). Opus par défaut.
const MODEL_PREMIUM = process.env.ANTHROPIC_MODEL_PREMIUM || "claude-opus-5-5";
// Plafonds de longueur (max_tokens) pour la génération de code. Une application
// riche (catalogue + panier + comptes + paiement + tableau de bord) dépasse
// facilement 8192 jetons : si on reste à 8192, le fichier est COUPÉ en plein
// milieu et l'apprenant tombe sur une page blanche. On relève donc le plafond
// pour les constructions, surtout l'atelier avancé (modèle le plus puissant).
const PREMIUM_BUILD_TOKENS = parseInt(process.env.PREMIUM_BUILD_TOKENS, 10) || 16000;
const BUILD_TOKENS = parseInt(process.env.BUILD_TOKENS, 10) || 12000;
const PORT = process.env.PORT || 3000;
// Jeton d'hébergement (Palier 2) : la plateforme publie les sites des apprenants à leur place.
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;
// Paiement en ligne (Wave) — mode « API centralisée » optionnel. La clé secrète reste
// UNIQUEMENT ici (variable d'environnement), jamais dans le chat ni dans le code des sites.
// Sans cette clé, seul le mode « lien de paiement par apprenant » est disponible.
const WAVE_API_KEY = process.env.WAVE_API_KEY || "";
const WAVE_API_BASE = process.env.WAVE_API_BASE || "https://api.wave.com";
const WAVE_WEBHOOK_SECRET = process.env.WAVE_WEBHOOK_SECRET || "";
// Base de données (Palier 3) : mémoire durable. Si absente, on retombe sur les fichiers locaux.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const USE_DB = !!(SUPABASE_URL && SUPABASE_KEY);
// Comptes formateur/administrateur (Palier « gestion des apprenants ») : liste d'emails.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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
- Style sobre et professionnel : n'ajoute pas d'émojis dans le site, sauf demande explicite de la personne.
- 100 % HTML + CSS. Tu n'écris TOI-MÊME AUCUN JavaScript. (Pour une boutique ou des rendez-vous, la plateforme ajoute automatiquement un petit script d'interactivité : tu fournis seulement le HTML avec les attributs « data-bat-… » indiqués.) AUCUNE image ni police externe, AUCUN fichier externe.
- Responsive, impeccable sur mobile. Dans le <style> : html{scroll-behavior:smooth;}.

=== STANDARD VISUEL (allure d'entreprise, par défaut) ===
Sauf demande contraire de la personne, chaque site respecte ce standard sobre et professionnel, comme le site d'une entreprise établie :
- Palette limitée : un fond clair et neutre (blanc ou gris très clair), un texte foncé lisible, UNE seule couleur d'accent sobre (bleu, bleu-vert, ardoise ou bordeaux selon l'activité), utilisée avec parcimonie (liens, boutons, filets). Pas de dégradés voyants, pas de couleurs criardes, jamais plus de deux couleurs d'accent.
- Typographie : une pile de polices système lisible, par exemple font-family: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif. Titres nettement plus grands que le texte, hiérarchie claire (h1 > h2 > h3), interlignage confortable (line-height ~1.6 pour le texte courant).
- Mise en page : largeur de contenu limitée et centrée (max-width ~1080px), sections aérées (padding vertical ample), rythme d'espacement régulier entre les blocs.
- En-tête sobre : nom ou logo textuel à gauche, menu à ancres à droite. Pied de page discret avec le contact et les mentions.
- Composants nets : boutons aux coins légèrement arrondis (~8px), cartes à bordure fine ou ombre très légère, filets discrets. Contraste suffisant pour la lisibilité (texte foncé sur fond clair).
- Aucune fioriture décorative, aucun émoji.
La personne garde la main : si elle demande d'autres couleurs, une ambiance plus chaleureuse ou colorée, une police plus grande, etc., applique exactement sa demande.

FICHIERS JOINTS (optionnel, sur demande) :
- Un visiteur peut JOINDRE un fichier (photo, PDF, document) à un formulaire de rendez-vous, de contact ou de commande. Pour l'activer, ajoute simplement, DANS un formulaire, un champ fichier déclaratif : <input type="file" data-bat-file name="fichier" data-label="Votre fichier"> (ajoute « multiple » pour permettre plusieurs fichiers). La plateforme gère tout l'envoi ; tu n'écris AUCUN JavaScript.
- Types acceptés : images, PDF, documents Word / Excel / PowerPoint, texte. Taille maximale : 3 Mo par fichier. Le propriétaire retrouve les fichiers reçus dans son tableau de bord « Données ».
- Pour un formulaire de commande simple avec pièce jointe (ex. un imprimeur qui reçoit un fichier à imprimer), utilise un <form data-bat-form data-bat-collection="commande"> contenant les champs voulus et le champ fichier ci-dessus.

PAIEMENT EN LIGNE (Wave, optionnel) :
- Le paiement s'active depuis le bouton « Paiement » de l'aperçu (la personne y colle son lien Wave) ; tu n'as RIEN à coder pour la boutique : le bouton « Commander » gère automatiquement le paiement quand il est activé.
- Si la personne veut un bouton « Payer » à un endroit précis (montant fixe, don, acompte), place un lien déclaratif : <a data-bat-pay data-amount="5000">Payer</a>. « data-amount » est facultatif (montant en francs, sans décimale pour le FCFA). La plateforme s'occupe du reste ; tu n'écris aucun JavaScript.

RUBRIQUES LIBRES :
- Le menu reflète EXACTEMENT les rubriques voulues (Accueil, Services, Réalisations, À propos, Contact, Tarifs, Blog, FAQ, Équipe, Galerie, Horaires… ce que la personne veut).
- Tu peux à tout moment AJOUTER, RENOMMER, RÉORDONNER ou SUPPRIMER une rubrique sur demande, puis tu renvoies la page entière.
- PLACEHOLDER : une rubrique dont le contenu n'est pas fourni reçoit un espace réservé clair et élégant (ex. « Vos réalisations apparaîtront ici — dites-moi de les ajouter »). Jamais de section vide ni cassée.

ESPACES MÉDIAS — DEMANDE AVANT DE SUPPOSER :
- Quand un espace n'est pas clair (zone d'image, galerie, document…), tu DEMANDES d'abord à la personne à quoi il sert : « des photos », « du texte », ou « des documents (PDF / Word / PowerPoint) » — puis tu poses le bon espace réservé.
- Pour une image : un cadre réservé propre avec une légende. Pour un document : une zone qui annonce le document à venir. Tu n'inventes jamais d'image externe.`;

// Consigne ajoutée quand le projet est en mode « plusieurs pages ».
// Le site reste UN SEUL fichier index.html, mais le contenu est réparti en pages
// que la plateforme affiche une à la fois (navigation gérée automatiquement).
const MULTIPAGE_NOTE = `

=== STRUCTURE EN PLUSIEURS PAGES (mode activé — PRIORITAIRE, remplace la règle « une seule page ») ===
IMPÉRATIF : ce site est en PLUSIEURS PAGES. Oublie toute consigne précédente disant « une seule page » ou « menu à ancres internes » : elle ne s'applique pas ici. Même s'il n'y a qu'une seule rubrique pour l'instant, tu structures le site en pages dès maintenant (au minimum une page « accueil »).
Le site est organisé en PLUSIEURS PAGES, mais TOUJOURS dans un SEUL fichier index.html. Tu ne crées JAMAIS d'autre fichier et tu ne fais JAMAIS de lien vers un fichier .html externe.
- Chaque page est un bloc : <section data-bat-page="xxx" data-bat-title="Titre de la page"> … contenu complet de la page … </section>. « xxx » est un identifiant court, en minuscules, sans accents ni espaces (ex. accueil, apropos, services, boutique, contact).
- Marque la page d'accueil avec l'attribut data-bat-home (ex. <section data-bat-page="accueil" data-bat-home data-bat-title="Accueil">). C'est elle qui s'affiche en premier.
- L'EN-TÊTE de navigation (<header> avec le menu) se place AVANT les blocs de pages, et le PIED DE PAGE (<footer>) APRÈS : ils sont communs à toutes les pages et restent visibles partout. Ne les mets jamais à l'intérieur d'un bloc data-bat-page.
- Le menu contient un lien par page, sous la forme <a href="#xxx">Titre</a> où « xxx » correspond EXACTEMENT au data-bat-page de la page visée. Jamais de lien vide ni de lien vers un fichier.
- La plateforme gère TOUTE la navigation : elle affiche une seule page à la fois, masque les autres, remonte en haut à chaque changement et met le lien actif en évidence. Tu n'écris AUCUN JavaScript et tu ne caches aucune page toi-même (pas de style display:none).
- Chaque page doit être COMPLÈTE et cohérente à elle seule. Si un volet interactif est présent (boutique, rendez-vous, espace membre), donne-lui sa PROPRE page (ex. data-bat-page="boutique").
- Garde une identité visuelle unique et cohérente sur toutes les pages.`;

// --- KIT D'INTERACTIVITÉ (Panier / Réservation) ---------------------------
// Petit script vanilla, FIXE et testé, injecté par la plateforme (jamais écrit par
// le modèle) dans les sites « boutique » / « rendez-vous ». Le modèle ne fournit que
// le HTML déclaratif (attributs data-bat-…). Le panier calcule le total ; « Commander »
// / « Demander » préparent un message pré-rempli (WhatsApp si un numéro est présent,
// sinon email mailto:). 100 % côté visiteur, aucune dépendance, aucun backend.
const INTERACTIVE_KIT = `<script>
(function(){
  try{
    var NL=String.fromCharCode(10);
    var q=function(s,r){return (r||document).querySelector(s);};
    var qa=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
    function esc(s){var d=document.createElement("div");d.textContent=(s==null?"":s);return d.innerHTML;}
    var curEl=q("[data-bat-currency]");
    var CUR=(curEl&&curEl.getAttribute("data-bat-currency"))||"euros";
    function money(n){return (Math.round(n*100)/100).toFixed(2).replace(".",",")+" "+CUR;}
    function contact(){
      var email=null,wa=null,e1=q("[data-bat-order-email]");
      if(e1) email=e1.getAttribute("data-bat-order-email");
      if(!email){var m=q('a[href^="mailto:"]'); if(m) email=m.getAttribute("href").slice(7).split("?")[0];}
      var w1=q("[data-bat-whatsapp]");
      if(w1) wa=w1.getAttribute("data-bat-whatsapp");
      if(!wa){var w=q('a[href*="wa.me/"]'); if(w){var mm=w.getAttribute("href").match(/wa\\.me\\/([0-9]+)/); if(mm) wa=mm[1];}}
      return {email:email||null, wa:(wa?String(wa).replace(/[^0-9]/g,""):null)};
    }
    function send(subject, body){
      var c=contact();
      if(c.wa){window.open("https://wa.me/"+c.wa+"?text="+encodeURIComponent(subject+NL+NL+body),"_blank");return true;}
      if(c.email){window.location.href="mailto:"+c.email+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);return true;}
      return false;
    }
    var APP=(window.__BAT&&window.__BAT.app)||"";
    var PAY=(window.__BAT&&window.__BAT.pay)||{mode:"none"};
    function apiBase(){ return (window.__BAT&&window.__BAT.base)||""; }
    // Bouton « Payer avec Wave » (mode lien) : ouvre le lien du propriétaire, montant affiché.
    function waveLinkButton(amount){
      var a=document.createElement("a");
      a.href=PAY.link; a.target="_blank"; a.rel="noopener";
      a.textContent="Payer avec Wave"+(amount?(" ("+money(amount)+")"):"");
      a.style.cssText="display:inline-block;margin-top:10px;padding:11px 16px;border-radius:8px;background:#1DC3F0;color:#062a33;font-weight:700;text-decoration:none";
      return a;
    }
    // Déclenche le paiement selon le mode configuré. done(node, err) reçoit un bouton (lien) ou une erreur.
    function startPayment(amount, reference, done){
      if(PAY.mode==="link" && PAY.link){ done(waveLinkButton(amount), null); return true; }
      if(PAY.mode==="api" && APP && apiBase()){
        fetch(api("/pay"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app:APP,amount:amount,currency:PAY.currency||"XOF",reference:reference})})
          .then(function(r){ return r.json().catch(function(){return {};}); })
          .then(function(j){ if(j&&j.url){ window.location.href=j.url; } else { done(null,(j&&j.error)||"Paiement indisponible pour le moment."); } })
          .catch(function(){ done(null,"Service de paiement injoignable."); });
        return true;
      }
      return false;
    }
    function api(pth){ return apiBase()+pth; }
    function tok(){ try{ return localStorage.getItem("battok_"+APP); }catch(e){ return null; } }
    function setTok(t){ try{ if(t) localStorage.setItem("battok_"+APP,t); else localStorage.removeItem("battok_"+APP); }catch(e){} }
    // Enregistrement sur la plateforme (le propriétaire retrouve tout dans son espace).
    function postApp(collection, data){
      try{ if(!APP||!apiBase()) return;
        fetch(api("/submit"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app:APP,collection:collection,data:data,token:tok()||undefined})}).catch(function(){});
      }catch(e){}
    }
    // ---- Espace membre (comptes visiteurs) ----
    var member=null, authMode="login";
    var INP='width:100%;padding:9px 11px;border:1px solid #ccc;border-radius:8px;margin:4px 0;font-size:14px;box-sizing:border-box;color:#111;background:#fff';
    var BTN1='margin-top:6px;width:100%;padding:10px;border:none;border-radius:8px;background:#147C8C;color:#fff;font-size:15px;cursor:pointer';
    var BTN2='padding:7px 12px;border:1px solid #ccc;border-radius:8px;background:#f4f4f4;color:#111;cursor:pointer';
    function inp(field,ph,type){ return '<input data-bat-field="'+field+'" type="'+type+'" placeholder="'+ph+'" style="'+INP+'">'; }
    function renderAuth(){
      var boxes=qa("[data-bat-auth]"); if(!boxes.length) return; var html;
      if(member){
        html='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span>Connecté : <b>'+esc(member.name)+'</b></span><button type="button" data-bat-do="logout" style="'+BTN2+'">Se déconnecter</button></div>';
      } else {
        var isReg=authMode==="register";
        html='<div style="max-width:340px"><div style="font-weight:700;margin-bottom:6px">'+(isReg?"Créer un compte":"Se connecter")+'</div>'
          +(isReg?inp("name","Votre nom","text"):"")+inp("email","Adresse e-mail","email")+inp("pass","Mot de passe","password")
          +'<div data-bat-autherr style="color:#c0392b;font-size:13px;min-height:16px;margin:4px 0"></div>'
          +'<button type="button" data-bat-do="'+(isReg?"register":"login")+'" style="'+BTN1+'">'+(isReg?"Créer mon compte":"Se connecter")+'</button>'
          +'<div style="font-size:13px;margin-top:8px">'+(isReg?"Déjà un compte ? ":"Pas encore de compte ? ")+'<a href="#" data-bat-do="switch" style="color:#147C8C;font-weight:600">'+(isReg?"Se connecter":"Créer un compte")+'</a></div></div>';
      }
      boxes.forEach(function(b){ b.innerHTML=html; });
    }
    function toggleMembers(){
      qa("[data-bat-members]").forEach(function(sec){
        var lock=sec.nextElementSibling && sec.nextElementSibling.hasAttribute && sec.nextElementSibling.hasAttribute("data-bat-lock") ? sec.nextElementSibling : null;
        if(member){ if(sec.getAttribute("data-bat-disp")!=null){ sec.style.display=sec.getAttribute("data-bat-disp")||""; } else { sec.style.display=""; } if(lock) lock.parentNode.removeChild(lock); }
        else { if(sec.getAttribute("data-bat-disp")==null){ sec.setAttribute("data-bat-disp", sec.style.display||""); } sec.style.display="none";
          if(!lock){ var n=document.createElement("div"); n.setAttribute("data-bat-lock",""); n.style.cssText="text-align:center;color:#6B7A90;padding:22px;border:1px dashed #ccc;border-radius:10px;margin:10px 0"; n.textContent="Contenu réservé aux membres — connectez-vous pour y accéder."; sec.parentNode.insertBefore(n, sec.nextSibling); } }
      });
    }
    function fval(box,name){ var el=box.querySelector('[data-bat-field="'+name+'"]'); return el?el.value.trim():""; }
    function doAuth(kind, box){
      var email=fval(box,"email"), pass=fval(box,"pass"), name=fval(box,"name");
      var errEl=box.querySelector("[data-bat-autherr]"); if(errEl) errEl.textContent="";
      var body={ app:APP, email:email, password:pass }; if(kind==="register") body.name=name;
      fetch(api(kind==="register"?"/auth/register":"/auth/login"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
        .then(function(x){ if(!x.ok){ if(errEl) errEl.textContent=x.d.error||"Impossible pour le moment."; return; } setTok(x.d.token); member=x.d.user; renderAuth(); toggleMembers(); })
        .catch(function(){ if(errEl) errEl.textContent="Connexion impossible."; });
    }
    function doLogout(){ var t=tok(); setTok(null); member=null; renderAuth(); toggleMembers(); try{ fetch(api("/auth/logout"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:t})}).catch(function(){}); }catch(e){} }
    document.addEventListener("click",function(e){
      var t=e.target&&e.target.closest?e.target.closest("[data-bat-do]"):null; if(!t) return;
      var act=t.getAttribute("data-bat-do");
      if(act==="switch"){ e.preventDefault(); authMode=(authMode==="register"?"login":"register"); renderAuth(); }
      else if(act==="logout"){ e.preventDefault(); doLogout(); }
      else if(act==="login"||act==="register"){ e.preventDefault(); var box=t.closest("[data-bat-auth]"); if(box) doAuth(act, box); }
    });
    function initMembers(){
      if(!qa("[data-bat-auth]").length && !qa("[data-bat-members]").length) return;
      var t=tok();
      if(!t){ renderAuth(); toggleMembers(); return; }
      fetch(api("/auth/me"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app:APP,token:t})})
        .then(function(r){ return r.json(); }).then(function(d){ member=d.user||null; if(!member) setTok(null); renderAuth(); toggleMembers(); })
        .catch(function(){ renderAuth(); toggleMembers(); });
    }
    // ---- Panier (boutique) ----
    var cart={};
    function ensureBox(){
      if(q("[data-bat-cart]")) return;
      if(!q("[data-bat-add]")) return;
      var d=document.createElement("div");
      d.setAttribute("data-bat-cart","");
      d.style.cssText="position:fixed;right:16px;bottom:16px;max-width:320px;width:calc(100% - 32px);background:#fff;color:#111;border:1px solid #ddd;border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:9999;font-size:14px";
      document.body.appendChild(d);
    }
    function render(){
      var boxes=qa("[data-bat-cart]"); if(!boxes.length) return;
      var names=Object.keys(cart), total=0, html="";
      html+='<div style="font-weight:700;margin-bottom:6px">Votre panier</div>';
      if(!names.length){ html+='<div style="opacity:.7">Il est encore vide.</div>'; }
      else{
        names.forEach(function(n){var it=cart[n];total+=it.price*it.qty;
          var k=encodeURIComponent(n);
          html+='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,.08)">'
            +'<span>'+esc(n)+'</span><span style="display:flex;align-items:center;gap:6px">'
            +'<button type="button" data-bat-dec="'+k+'" style="width:24px;height:24px;border-radius:6px;border:1px solid #ccc;background:#f4f4f4;cursor:pointer">-</button>'
            +'<b>'+it.qty+'</b>'
            +'<button type="button" data-bat-inc="'+k+'" style="width:24px;height:24px;border-radius:6px;border:1px solid #ccc;background:#f4f4f4;cursor:pointer">+</button>'
            +'<span style="min-width:78px;text-align:right">'+money(it.price*it.qty)+'</span></span></div>';
        });
        html+='<div style="display:flex;justify-content:space-between;font-weight:800;margin-top:8px"><span>Total</span><span>'+money(total)+'</span></div>';
        html+='<button type="button" data-bat-order style="margin-top:10px;width:100%;padding:11px;border:none;border-radius:8px;background:#147C8C;color:#fff;font-size:15px;cursor:pointer">Commander</button>';
      }
      boxes.forEach(function(b){b.innerHTML=html;});
    }
    function add(name,price){ if(!cart[name]) cart[name]={price:price,qty:0}; cart[name].qty++; render(); }
    document.addEventListener("click",function(e){
      var t=e.target&&e.target.closest?e.target.closest("[data-bat-add],[data-bat-inc],[data-bat-dec],[data-bat-order]"):null;
      if(!t) return;
      if(t.hasAttribute("data-bat-add")){e.preventDefault();
        var n=t.getAttribute("data-name")||t.getAttribute("data-bat-name")||"Article";
        var p=parseFloat(String(t.getAttribute("data-price")||t.getAttribute("data-bat-price")||"0").replace(",","."))||0;
        add(n,p);
      } else if(t.hasAttribute("data-bat-inc")){var a=decodeURIComponent(t.getAttribute("data-bat-inc")); if(cart[a]){cart[a].qty++;render();}}
      else if(t.hasAttribute("data-bat-dec")){var b=decodeURIComponent(t.getAttribute("data-bat-dec")); if(cart[b]){cart[b].qty--; if(cart[b].qty<=0) delete cart[b]; render();}}
      else if(t.hasAttribute("data-bat-order")){e.preventDefault();
        var ns=Object.keys(cart); if(!ns.length) return; var tot=0; var items=[];
        var lines=ns.map(function(n){var it=cart[n];tot+=it.price*it.qty; items.push({produit:n, quantite:it.qty, prix:it.price}); return "- "+n+" x"+it.qty+" : "+money(it.price*it.qty);});
        var total=Math.round(tot*100)/100;
        var payRef=(PAY.mode==="api")?("bat."+APP+"."+Math.random().toString(16).slice(2,10)):null;
        var order={ articles:items, total:total, devise:CUR }; if(payRef) order._ref=payRef;
        postApp("commande", order);
        var box=q("[data-bat-cart]");
        function note(txt){ if(box){ var pre=document.createElement("pre"); pre.style.cssText="white-space:pre-wrap;background:#f4f4f4;color:#111;padding:10px;border-radius:8px;margin-top:8px"; pre.textContent=txt; box.appendChild(pre); } }
        function payErr(msg){ if(box){ var p2=document.createElement("div"); p2.style.cssText="margin-top:8px;color:#c0392b;font-size:14px"; p2.textContent=msg; box.appendChild(p2); } }
        var body="Bonjour, je souhaite commander :"+NL+lines.join(NL)+NL+NL+"Total : "+money(tot);
        // Paiement en ligne si configuré, sinon commande par email/WhatsApp comme avant.
        var handled=startPayment(total, payRef, function(node, err){ if(node && box){ box.appendChild(node); } if(err) payErr(err); });
        if(!handled){ if(!send("Nouvelle commande", body)){ note("Merci ! Votre commande a bien été envoyée."+NL+NL+body); } }
        else if(PAY.mode==="link"){ if(!send("Nouvelle commande", body)){ note("Merci ! Votre commande est enregistrée. Réglez avec le bouton Wave ci-dessous."); } }
      }
    });
    // Bouton de paiement déclaratif : <a data-bat-pay data-amount="5000">Payer</a>
    qa("[data-bat-pay]").forEach(function(el){
      if(PAY.mode==="none"){ el.style.display="none"; return; }
      if(PAY.mode==="link" && PAY.link){ if(el.tagName==="A"){ el.setAttribute("href",PAY.link); el.setAttribute("target","_blank"); el.setAttribute("rel","noopener"); } else { el.addEventListener("click",function(ev){ ev.preventDefault(); window.open(PAY.link,"_blank"); }); } return; }
      el.addEventListener("click",function(ev){ ev.preventDefault();
        var amt=parseFloat(String(el.getAttribute("data-amount")||"0").replace(",","."))||0;
        var ref="bat."+APP+"."+Math.random().toString(16).slice(2,10);
        if(amt>0) postApp("commande", { total:amt, devise:(PAY.currency||CUR), _ref:ref, source:"bouton" });
        startPayment(amt, ref, function(node, err){ if(err){ var d=document.createElement("div"); d.style.cssText="margin-top:6px;color:#c0392b;font-size:14px"; d.textContent=err; el.parentNode.insertBefore(d, el.nextSibling); } });
      });
    });
    // ---- Fichiers joints (upload par le visiteur) ----
    var FILE_MAX = 3 * 1024 * 1024;
    function readB64(file){ return new Promise(function(res,rej){ var r=new FileReader(); r.onload=function(){ res(String(r.result).split(",")[1]||""); }; r.onerror=function(){ rej(new Error("Lecture du fichier impossible.")); }; r.readAsDataURL(file); }); }
    function uploadFile(file){
      if(file.size>FILE_MAX) return Promise.reject(new Error("Le fichier « "+file.name+" » dépasse 3 Mo."));
      return readB64(file).then(function(b64){
        return fetch(api("/upload"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app:APP,name:file.name,type:file.type||"application/octet-stream",size:file.size,data:b64,token:tok()||undefined})})
          .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(r.ok&&j&&j.id) return {id:j.id,name:j.name,type:j.type,size:j.size}; throw new Error((j&&j.error)||"Envoi du fichier impossible."); }); });
      });
    }
    function collectFiles(f){ var out=[]; qa('input[type="file"]',f).forEach(function(el){ if(!el.files) return; for(var i=0;i<el.files.length;i++) out.push(el.files[i]); }); return out; }
    function uploadAll(files){ var refs=[]; return files.reduce(function(pr,file){ return pr.then(function(){ return uploadFile(file).then(function(ref){ refs.push(ref); }); }); }, Promise.resolve()).then(function(){ return refs; }); }
    // ---- Formulaires enregistrés (rendez-vous / message / commande) ----
    function wireForm(f, collection, subject, intro){
      f.addEventListener("submit",function(e){e.preventDefault();
        var hp=f.querySelector('[name="bat_hp"]'); if(hp && hp.value){ return; } // piège anti-robot
        var obj={}, data=[];
        qa("input,select,textarea",f).forEach(function(el){ if(el.type==="file"||!el.name||el.name==="bat_hp"||!el.value) return; var lab=el.getAttribute("data-label")||el.name; obj[lab]=String(el.value); data.push(lab+" : "+el.value); });
        var files=collectFiles(f);
        if(!data.length && !files.length) return;
        var btn=f.querySelector('[type="submit"]'); var lbl=btn?btn.textContent:"";
        var errBox=f.querySelector("[data-bat-formerr]");
        function showErr(msg){ if(!errBox){ errBox=document.createElement("p"); errBox.setAttribute("data-bat-formerr",""); errBox.style.cssText="margin-top:10px;color:#c0392b;font-size:14px"; f.appendChild(errBox); } errBox.textContent=msg; if(btn){ btn.disabled=false; btn.textContent=lbl; } }
        function finish(fichiers){
          if(fichiers && fichiers.length){ obj.fichiers=fichiers.map(function(x){return {id:x.id,name:x.name,type:x.type,size:x.size};}); data.push((fichiers.length>1?"Fichiers joints : ":"Fichier joint : ")+fichiers.map(function(x){return x.name;}).join(", ")); }
          postApp(collection, obj);
          var body="Bonjour, "+intro+NL+data.join(NL);
          if(!send(subject, body)){ var pmsg=document.createElement("p"); pmsg.style.marginTop="10px"; pmsg.textContent="Merci ! Votre demande a bien été prise en compte."; f.appendChild(pmsg); }
          if(errBox) errBox.textContent="";
          try{ f.reset(); }catch(e2){}
          if(btn){ btn.disabled=false; btn.textContent=lbl; }
        }
        if(files.length){
          if(!(APP && apiBase())){ showErr("L'envoi de fichiers sera actif une fois le site publié."); return; }
          if(btn){ btn.disabled=true; btn.textContent="Envoi…"; }
          uploadAll(files).then(finish).catch(function(err){ showErr((err&&err.message)||"Envoi impossible."); });
        } else { finish([]); }
      });
    }
    qa("form[data-bat-booking]").forEach(function(f){ wireForm(f, "rendez-vous", "Demande de rendez-vous", "je souhaite demander un rendez-vous :"); });
    qa("form[data-bat-contact]").forEach(function(f){ wireForm(f, "message", "Nouveau message", "voici mon message :"); });
    qa("form[data-bat-form]").forEach(function(f){ var c=(f.getAttribute("data-bat-collection")||"message").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,40)||"message"; wireForm(f, c, f.getAttribute("data-bat-subject")||"Nouvelle demande", f.getAttribute("data-bat-intro")||"voici ma demande :"); });
    ensureBox(); render(); initMembers();
  }catch(e){}
})();
</script>`;

// --- NAVIGATION « PLUSIEURS PAGES » (un seul fichier) ----------------------
// Script FIXE injecté par la plateforme quand le site contient des blocs
// <section data-bat-page="xxx">. Il affiche UNE page à la fois, masque les
// autres, remonte en haut à chaque changement et met en évidence le lien actif.
// Le modèle ne fournit que la structure déclarative (aucun JavaScript).
const PAGE_NAV = `<style>[data-bat-page]{display:none}[data-bat-home]{display:block}a[aria-current="page"]{font-weight:700}</style>
<script>
(function(){
  try{
    var pages = Array.prototype.slice.call(document.querySelectorAll("[data-bat-page]"));
    if(!pages.length) return;
    function idOf(p){ return (p.getAttribute("data-bat-page")||p.id||"").trim(); }
    var ids = pages.map(idOf);
    var homeEl = document.querySelector("[data-bat-home]");
    var home = homeEl ? idOf(homeEl) : ids[0];
    function pageOfEl(el){ while(el && el!==document.body){ if(el.getAttribute && el.getAttribute("data-bat-page")!=null) return idOf(el); el=el.parentNode; } return null; }
    function show(target, scrollToId){
      if(ids.indexOf(target)<0) target = home;
      pages.forEach(function(p){ p.style.display = (idOf(p)===target) ? "block" : "none"; });
      Array.prototype.slice.call(document.querySelectorAll("a[href^='#'],[data-bat-nav]")).forEach(function(a){
        var h = a.getAttribute("data-bat-nav") || (a.getAttribute("href")||"").replace(/^#/,"");
        if(h){ if(h===target) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); }
      });
      if(scrollToId){ var e=document.getElementById(scrollToId); if(e&&e.scrollIntoView){ e.scrollIntoView(); return; } }
      window.scrollTo(0,0);
    }
    function resolve(hash){
      hash=(hash||"").replace(/^#/,"");
      if(!hash) return { page: home };
      if(ids.indexOf(hash)>=0) return { page: hash };
      var el=document.getElementById(hash); if(el){ var pg=pageOfEl(el); if(pg) return { page: pg, scrollTo: hash }; }
      return { page: home };
    }
    function go(hash, push){
      var r=resolve(hash); show(r.page, r.scrollTo);
      if(push){ try{ history.replaceState(null,"","#"+(r.scrollTo||r.page)); }catch(e){} }
    }
    document.addEventListener("click", function(ev){
      var a=ev.target;
      while(a && a!==document.body && !(a.getAttribute && (a.getAttribute("data-bat-nav")!=null || (a.getAttribute("href")||"").charAt(0)==="#"))) a=a.parentNode;
      if(!a || a===document.body) return;
      var nav=a.getAttribute("data-bat-nav");
      var href=a.getAttribute("href")||"";
      var hash = (nav!=null && nav!=="") ? nav : (href.charAt(0)==="#" ? href.slice(1) : null);
      if(hash==null || hash==="") return;
      ev.preventDefault(); go(hash, true);
    }, false);
    window.addEventListener("hashchange", function(){ go(location.hash, false); });
    go(location.hash, true);
  }catch(e){}
})();
</script>`;

const KIT_RE = /\s*<!-- BAT-KIT:START -->[\s\S]*?<!-- BAT-KIT:END -->/g;
function stripKit(html) { return html ? html.replace(KIT_RE, "").replace(/\n{3,}/g, "\n\n").trim() : html; }
function injectKit(html, mods, conv, baseUrl) {
  if (!html) return html;
  html = stripKit(html);
  mods = mods || [];
  const wantsKit = mods.includes("boutique") || mods.includes("rdv") || mods.includes("membre") || /data-bat-(auth|members|booking|contact|add|form|file|pay)/i.test(html);
  const wantsPages = /data-bat-page\b/i.test(html);
  if (!wantsKit && !wantsPages) return html;
  let inner = "";
  if (wantsKit) {
    const pc = (conv && conv.payment) || {};
    const payCfg = {
      mode: (pc.mode === "link" || pc.mode === "api") ? pc.mode : "none",
      link: pc.mode === "link" ? (pc.link || "") : "",
      currency: pc.currency || "XOF",
      apiReady: pc.mode === "api" && !!WAVE_API_KEY
    };
    const cfg = '<script>window.__BAT={app:' + JSON.stringify((conv && conv.id) || "") + ',base:' + JSON.stringify((baseUrl || "") + "/api/app") + ',pay:' + JSON.stringify(payCfg) + '};</script>';
    inner += cfg + "\n" + INTERACTIVE_KIT + "\n";
  }
  if (wantsPages) inner += PAGE_NAV + "\n";
  const block = "\n<!-- BAT-KIT:START -->\n" + inner + "<!-- BAT-KIT:END -->\n";
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, block + "</body>");
  return html + block;
}

// --- BOÎTE À OUTILS « Batisseur » (Atelier Projet) ---------------------------
// Petit assistant injecté dans les applications de l'atelier. Il donne à l'app
// un accès simple au « cerveau » central de Bâtisseur : données partagées,
// comptes membres, fichiers, paiement. Le jeton membre est gardé dans le
// navigateur (localStorage) pour que la personne reste connectée sur son appareil.
const APP_KIT = `<script>
(function(){
  var B=(window.__BAT||{}), BASE=B.base||"", APP=B.app||"", TKEY="bat_token_"+APP;
  function token(){ try{ return localStorage.getItem(TKEY)||""; }catch(e){ return ""; } }
  function setToken(t){ try{ if(t){localStorage.setItem(TKEY,t);} else {localStorage.removeItem(TKEY);} }catch(e){} }
  function post(path, body){
    body=body||{}; body.app=APP;
    return fetch(BASE+path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(!r.ok){ var e=new Error(j.error||("Erreur "+r.status)); e.status=r.status; throw e; } return j; }); });
  }
  var Batisseur={
    // --- Données partagées ---
    // save(collection, data) : enregistre un objet. Une collection dont le nom commence
    //   par "public_" est visible par tout le monde ; sinon elle est privée au membre connecté.
    save:function(collection, data){ return post("/submit",{collection:collection, data:data, token:token()}); },
    // list(collection, {limit}) : renvoie un tableau d'éléments {id, data, createdAt}.
    list:function(collection, opts){ opts=opts||{}; return post("/list",{collection:collection, token:token(), limit:opts.limit}).then(function(j){ return j.items||[]; }); },
    // --- Comptes membres de l'app ---
    signup:function(email, name, password){ return post("/auth/register",{email:email, name:name, password:password}).then(function(j){ setToken(j.token); return j.user; }); },
    login:function(email, password){ return post("/auth/login",{email:email, password:password}).then(function(j){ setToken(j.token); return j.user; }); },
    me:function(){ if(!token()) return Promise.resolve(null); return post("/auth/me",{token:token()}).then(function(j){ return j.user||null; }).catch(function(){ return null; }); },
    logout:function(){ var t=token(); setToken(""); return post("/auth/logout",{token:t}).then(function(){return true;}).catch(function(){return true;}); },
    isLoggedIn:function(){ return !!token(); },
    // --- Fichiers ---
    upload:function(file){ return new Promise(function(resolve,reject){ var fr=new FileReader(); fr.onload=function(){ var d=String(fr.result||""); var b64=d.indexOf(",")>=0?d.split(",")[1]:d; post("/upload",{name:file.name, type:file.type, size:file.size, data:b64}).then(resolve, reject); }; fr.onerror=function(){ reject(new Error("Lecture du fichier impossible.")); }; fr.readAsDataURL(file); }); },
    // --- Paiement Wave (redirige vers la page de paiement) ---
    pay:function(amount, opts){ opts=opts||{}; return post("/pay",{amount:amount, currency:opts.currency, reference:opts.reference}).then(function(j){ if(opts.redirect!==false && j.url){ window.location.href=j.url; } return j; }); }
  };
  window.Batisseur=Batisseur;
})();
</script>`;

// Injecte la boîte à outils « Batisseur » dans une application de l'atelier.
function injectAppKit(html, conv, baseUrl) {
  if (!html) return html;
  html = stripKit(html);
  const pc = (conv && conv.payment) || {};
  const payCfg = { mode: (pc.mode === "api") ? "api" : "none", currency: pc.currency || "XOF", apiReady: pc.mode === "api" && !!WAVE_API_KEY };
  const cfg = '<script>window.__BAT={app:' + JSON.stringify((conv && conv.id) || "") + ',base:' + JSON.stringify((baseUrl || "") + "/api/app") + ',pay:' + JSON.stringify(payCfg) + '};</script>';
  const block = "\n<!-- BAT-KIT:START -->\n" + cfg + "\n" + APP_KIT + "\n<!-- BAT-KIT:END -->\n";
  // IMPORTANT : on définit window.Batisseur AU PLUS TÔT (dans <head>, sinon juste
  // après <body>) pour qu'il existe AVANT les scripts de l'app. Sans ça, une app
  // qui appelle Batisseur.list(...) dès le chargement échoue (« Impossible de
  // charger… ») parce que l'outil n'est pas encore défini.
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, function(m){ return m + block; });
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, function(m){ return m + block; });
  return block + html;
}

// --- VOLETS DU PROJET (Paliers 5 & 6) : un projet combine un ou plusieurs volets ---
// Version « vitrine intelligente » : catalogue / prestations joliment présentés,
// commande ou rendez-vous via contact ou formulaire simple. 100% HTML/CSS, sans
// JavaScript. Un projet peut RÉUNIR plusieurs volets dans une seule page cohérente.
const MODULES = {
  presentation: {
    label: "Présentation", short: "Présentation", emoji: "",
    tagline: "Présenter une activité, un métier, une association.",
    context: "un volet PRÉSENTATION (site vitrine) : présenter l'activité, inspirer confiance et inciter au contact",
    build: ""
  },
  boutique: {
    label: "Boutique en ligne", short: "Boutique", emoji: "",
    tagline: "Montrer des produits avec leurs prix et donner envie de commander.",
    context: "un volet BOUTIQUE EN LIGNE (vitrine) : présenter des produits à vendre",
    build: `

=== VOLET BOUTIQUE EN LIGNE (panier interactif) ===
- Rubrique « Boutique » / « Nos produits » : une GRILLE de produits. Chaque produit = une carte avec un cadre image réservé (placeholder propre), un NOM, une courte description, un PRIX, et un bouton d'ajout au panier EXACTEMENT sous cette forme :
  <button data-bat-add data-name="Nom du produit" data-price="49.90">Ajouter au panier</button>
  (data-price est un NOMBRE seul, sans symbole ; point ou virgule décimale.)
- Place UNE seule fois, dans la rubrique boutique, le conteneur du panier : <div data-bat-cart></div>. La plateforme y affiche automatiquement le panier, le TOTAL calculé, et un bouton « Commander » qui prépare la commande pré-remplie.
- Indique la devise si ce n'est pas l'euro, avec un attribut sur n'importe quel élément : data-bat-currency="FCFA" (par défaut : euros).
- Donne un moyen de recevoir les commandes : un lien email <a href="mailto:contact@exemple.com">…</a> ET/OU un numéro WhatsApp <a href="https://wa.me/2250700000000">…</a>. Le bouton « Commander » utilisera WhatsApp si un numéro est présent, sinon l'email. N'invente pas de paiement en ligne.
- Chaque commande validée est aussi ENREGISTRÉE automatiquement pour le propriétaire (rien à ajouter de ta part).
- Tu n'écris AUCUN JavaScript : seulement ce HTML déclaratif.`
  },
  rdv: {
    label: "Prise de rendez-vous", short: "Rendez-vous", emoji: "",
    tagline: "Présenter vos prestations et permettre de demander un créneau.",
    context: "un volet PRISE DE RENDEZ-VOUS (vitrine) : présenter des prestations et faciliter la demande de rendez-vous",
    build: `

=== VOLET PRISE DE RENDEZ-VOUS (demande interactive) ===
- Rubrique « Prestations » / « Services » : chaque prestation = un nom, une courte description, sa DURÉE et son PRIX quand c'est pertinent.
- Rubrique « Horaires » (jours et heures d'ouverture).
- Rubrique « Demander un rendez-vous » : un formulaire EXACTEMENT sous cette forme (la plateforme intercepte l'envoi et prépare la demande pré-remplie) :
  <form data-bat-booking>
    <select name="Prestation"> … une option par prestation … </select>
    <input name="Date" type="date">
    <input name="Heure" type="time">
    <input name="Nom" type="text" placeholder="Votre nom">
    <input name="Contact" type="text" placeholder="Téléphone ou email">
    <textarea name="Message" placeholder="Message (facultatif)"></textarea>
    <input name="bat_hp" style="display:none" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">Demander le rendez-vous</button>
  </form>
  (Le champ « bat_hp » est un piège anti-robot invisible : inclus-le tel quel, ne l'affiche jamais.)
- Donne un moyen de recevoir les demandes : lien email <a href="mailto:contact@exemple.com">…</a> ET/OU WhatsApp <a href="https://wa.me/2250700000000">…</a> (WhatsApp prioritaire s'il est présent).
- Chaque demande est aussi ENREGISTRÉE automatiquement pour le propriétaire (rien à ajouter de ta part).
- N'invente pas d'agenda en temps réel. Tu n'écris AUCUN JavaScript : seulement ce HTML déclaratif.`
  },
  membre: {
    label: "Espace membre", short: "Espace membre", emoji: "",
    tagline: "Permettre aux visiteurs de créer un compte et d'accéder à un espace privé.",
    context: "un volet ESPACE MEMBRE : les visiteurs créent un compte, se connectent, et accèdent à des sections réservées",
    build: `

=== VOLET ESPACE MEMBRE (comptes des visiteurs) ===
- Ajoute UNE seule fois, à un endroit visible (ex. rubrique « Espace membre »), le bloc de connexion : <div data-bat-auth></div>. La plateforme y affiche automatiquement « Créer un compte / Se connecter », puis, une fois connecté, le nom du membre et un bouton « Se déconnecter ». Tu n'ajoutes aucun formulaire de connexion toi-même.
- Marque les SECTIONS réservées aux membres avec l'attribut data-bat-members (ex. <section id="prive" data-bat-members> … </section>). La plateforme les masque automatiquement tant que le visiteur n'est pas connecté, et affiche à la place un message l'invitant à se connecter.
- Tu n'écris AUCUN JavaScript : seulement ce HTML déclaratif.`
  }
};
const MODULE_ORDER = ["presentation", "boutique", "rdv", "membre"];

// Normalise une sélection de volets (tableau moderne, ou ancien champ projectType).
function normalizeModules(mods, legacyType) {
  let set = [];
  if (Array.isArray(mods)) set = mods;
  else if (typeof legacyType === "string") set = (legacyType === "boutique" || legacyType === "rdv") ? [legacyType] : ["presentation"];
  const clean = MODULE_ORDER.filter((k) => set.includes(k));
  return clean.length ? clean : ["presentation"];
}
function convModules(conv) {
  if (conv && Array.isArray(conv.modules) && conv.modules.length) return normalizeModules(conv.modules);
  return normalizeModules(null, conv && conv.projectType);
}
function modulesContext(mods) {
  if (mods.length === 1) return "Le projet est " + MODULES[mods[0]].context + ".";
  return "Le projet COMBINE plusieurs volets dans UNE SEULE page cohérente : " + mods.map((k) => MODULES[k].context).join(" ; ") + ". Le menu doit couvrir toutes ces sections.";
}
function modulesBuild(mods) {
  let out = mods.map((k) => MODULES[k].build).filter(Boolean).join("\n");
  if (mods.length > 1) {
    out += `

=== PROJET COMBINÉ (plusieurs volets) ===
- Le site est UNE SEULE page qui réunit TOUS les volets choisis, chacun dans sa SECTION avec sa propre entrée dans le menu.
- L'accueil présente l'ensemble et oriente vers chaque volet (ex. « Découvrir la boutique », « Prendre rendez-vous »).
- Garde une identité visuelle unique et cohérente sur toute la page ; ne fais pas plusieurs sites séparés.`;
  }
  return out;
}
function modulesLabel(mods) {
  if (mods.length === 1 && mods[0] === "presentation") return "Site vitrine";
  return mods.map((k) => MODULES[k].short).join(" + ");
}

// --- Ce que l'assistant peut PROPOSER (fonctions « application ») ---
// Injecté dans les étapes de discussion pour que l'assistant suggère de lui-même,
// en langage simple, les possibilités « appli » quand le projet s'y prête.
const PLATFORM_CAPABILITIES = `

=== CE QUE TU PEUX PROPOSER À LA PERSONNE (fonctions « application ») ===
Bâtisseur ne fait pas que des sites vitrines : c'est aussi un créateur d'applications simples. Quand le projet de la personne s'y prête (vendre, prendre des commandes, proposer un service, gérer une communauté, un abonnement, un club…), PROPOSE-LUI spontanément, en langage clair et sans jargon, les possibilités adaptées :
- Une BOUTIQUE avec panier (le total se calcule tout seul) : les commandes sont ENREGISTRÉES et la personne les retrouve dans son tableau de bord, avec un SUIVI (nouveau, en cours, prêt, terminé).
- Une PRISE DE RENDEZ-VOUS : les demandes sont enregistrées et suivies de la même façon.
- Un ESPACE MEMBRE : les visiteurs créent un compte, se connectent, et accèdent à des sections réservées.
- Les commandes, rendez-vous et messages arrivent automatiquement dans un tableau de bord « Données ».
- Une APPLICATION INSTALLABLE : au moment de la publication, la personne peut cocher « Installable sur téléphone » pour que son site s'installe comme une vraie appli (icône sur l'écran d'accueil, ouverture en plein écran, fonctionne même hors connexion). La plateforme s'occupe de tout automatiquement — rien à écrire.
- L'ENVOI DE FICHIERS : un visiteur peut joindre une photo, un PDF ou un document à une commande, un rendez-vous ou un message (par exemple un imprimeur qui reçoit le fichier à imprimer, un artisan qui reçoit une photo du projet). Le propriétaire retrouve les fichiers dans son tableau de bord « Données ». Il suffit d'ajouter un champ fichier au formulaire — la plateforme gère tout.
- LE PAIEMENT EN LIGNE (Wave) : la personne peut activer le paiement depuis le bouton « Paiement » (en haut de l'aperçu) en collant SON lien de paiement Wave — un bouton « Payer avec Wave » apparaît alors sur sa boutique, et le bouton « Commander » propose le règlement. Les commandes payées sont signalées « Payé » dans le tableau de bord. La configuration se fait par ce bouton (jamais dans la discussion, jamais de clé à coller ici). Tu peux aussi, sur demande, ajouter un bouton de paiement dans une page : <a data-bat-pay data-amount="5000">Payer</a> (data-amount facultatif).
- PLUSIEURS PAGES : le site peut tenir sur une seule page (menu qui fait défiler) OU être organisé en PLUSIEURS PAGES (Accueil, À propos, Services, Contact…), où le visiteur passe d'une page à l'autre. Le tout reste un seul fichier. La personne bascule quand elle veut avec le bouton « Passer en plusieurs pages » (en haut de l'aperçu) ; le contenu est réorganisé sans rien perdre.
Explique ces possibilités comme des idées concrètes (« on pourrait ajouter… »), sans forcer. Si une fonction demande un volet qui n'est pas activé (Boutique, Rendez-vous, Espace membre), invite gentiment la personne à cliquer le bouton « + Ajouter un volet » (en haut de la discussion) : le volet s'ajoute au projet et s'intègre au site existant SANS rien perdre du travail déjà fait. (Elle peut en combiner plusieurs ; inutile de recommencer le projet.)`;

// Consigne ajoutée au TOUT PREMIER échange (étape « diagnostic ») : l'assistant
// présente spontanément, à CHAQUE personne qui arrive, les possibilités offertes.
const INTRO_PROPOSAL = `

=== PREMIER ÉCHANGE — PRÉSENTE LES POSSIBILITÉS À TOUT LE MONDE ===
Dès ta PREMIÈRE réponse, après un accueil bref et chaleureux, présente SPONTANÉMENT à la personne, en langage simple et sans jargon, ce qu'elle peut créer ici (un petit menu d'idées concrètes, pas une liste technique) :
- un SITE VITRINE pour présenter son activité, son métier ou son association ;
- une BOUTIQUE en ligne avec panier et commandes ;
- une PRISE DE RENDEZ-VOUS ;
- un ESPACE MEMBRE (comptes de visiteurs, sections réservées) ;
- et la possibilité d'avoir PLUSIEURS PAGES (Accueil, À propos, Contact…) ou de tout mettre sur une seule page.
Termine en lui demandant, simplement, ce qu'elle a en tête. Ne décide jamais à sa place : propose, puis écoute. Garde cela court et accueillant.`;

// Consigne commune : proposer des CHOIX cliquables quand une décision guidée aide l'apprenant.
const CHOIX_HELP = `

PROPOSER DES CHOIX CLIQUABLES
Quand tu poses à la personne un choix important (par ex. une couleur, un style, une mise en page, une option de fonctionnement, une orientation), propose-lui 2 à 4 OPTIONS cliquables plutôt qu'une question ouverte. Écris EXACTEMENT un bloc comme ceci (il s'affichera sous forme de boutons) :
\`\`\`choix
Ta question courte ?
- Première option
- Deuxième option
- Troisième option
\`\`\`
Une seule question par bloc ; des options courtes et parlantes. La personne clique, et sa réponse t'est renvoyée comme si elle l'avait écrite. N'en abuse pas : uniquement quand un choix guidé aide vraiment ; sinon, continue normalement.`;

// ============================================================
// PARCOURS « APPRENDRE LA PROGRAMMATION » (2e filière de formation)
// ------------------------------------------------------------
// Deux options de formation au démarrage : « site / application web » (ci-dessus)
// et « apprendre à programmer » (ci-dessous). Ici : un tuteur IA guide l'apprenant
// leçon par leçon (les bases, puis la pratique), avec des exercices concrets ; une
// console intégrée (côté navigateur) permet d'ÉCRIRE et d'EXÉCUTER le code.
// Rien n'est exécuté sur le serveur : Python tourne via Pyodide et JavaScript
// nativement, dans le navigateur de l'apprenant.
const LANGUAGES = {
  python: { label: "Python", run: "python", blurb: "Le langage le plus simple pour débuter : lisible, puissant, très demandé." },
  javascript: { label: "JavaScript", run: "js", blurb: "Le langage du web : il s'exécute directement dans le navigateur. Vos programmes tournent ici même." },
  java: { label: "Java", run: "none", blurb: "Un grand classique très demandé en entreprise. Ici, on lit et on écrit du code que le tuteur corrige (pas d'exécution en direct)." },
  algo: { label: "Algorithmique", run: "python", blurb: "Apprendre à raisonner (les bases de tout programme) avant le langage. On teste les idées en Python." }
};
function languageLabel(k) { return (LANGUAGES[k] && LANGUAGES[k].label) || "Python"; }
function normalizeLanguage(k) { return LANGUAGES[k] ? k : "python"; }

// Programmes (leçons ordonnées). Chaque leçon : titre, objectif, notions à couvrir, exercice pratique.
const CURRICULA = {
  python: [
    { key: "decouverte", title: "Découvrir Python", objectif: "Comprendre ce qu'est un programme et afficher du texte.", notions: "Ce qu'est un programme ; la fonction print() ; les chaînes de caractères entre guillemets ; les commentaires avec #.", exercice: "Écrire un programme qui affiche « Bonjour, je m'appelle ... » (avec le prénom de l'apprenant)." },
    { key: "variables", title: "Variables et types", objectif: "Stocker et réutiliser une information.", notions: "Créer une variable (nom = valeur) ; le typage dynamique et les règles de nommage ; les types de base (texte str, entier int, décimal float, booléen bool) ; type() ; afficher une variable ; f-strings ; affectation multiple et += .", exercice: "Créer deux variables prénom et âge, puis afficher une phrase qui les utilise (ex. « Awa a 20 ans »)." },
    { key: "chaines", title: "Les chaînes de caractères", objectif: "Manipuler du texte.", notions: "une chaîne entre guillemets ; longueur len() ; accès par indice (et indices négatifs) ; tranches (slicing) ; concaténation + et répétition * ; chaînes immuables ; quelques méthodes (upper, lower, strip, replace).", exercice: "Demander un mot, puis afficher sa longueur, son premier et son dernier caractère, et le mot à l'envers." },
    { key: "operateurs", title: "Opérateurs et calculs", objectif: "Calculer et comparer des valeurs.", notions: "opérateurs arithmétiques (+, -, *, /, //, %, **) et priorités ; divmod ; comparaisons (==, !=, <, >) ; opérateurs logiques (and, or, not).", exercice: "Afficher le quotient et le reste de 2026 par 7, puis tester si 2026 est pair." },
    { key: "entrees", title: "Lire ce que tape l'utilisateur", objectif: "Rendre un programme interactif.", notions: "input() ; le résultat de input() est toujours du texte ; convertir en nombre avec int() ou float().", exercice: "Demander son prénom puis son année de naissance, et afficher l'âge approximatif (2026 moins l'année)." },
    { key: "conditions", title: "Les conditions (si… alors)", objectif: "Faire réagir le programme selon les cas.", notions: "if / elif / else ; les comparaisons ; l'indentation qui délimite les blocs ; conditions imbriquées.", exercice: "Demander un nombre et afficher s'il est négatif, nul ou positif." },
    { key: "boucles", title: "Les boucles (répéter)", objectif: "Répéter des actions sans se répéter soi-même.", notions: "la boucle for avec range([début], fin, [pas]) ; la boucle while ; break ; quand choisir l'une ou l'autre.", exercice: "Afficher la table de multiplication d'un nombre demandé (de 1 à 10)." },
    { key: "listes", title: "Les listes", objectif: "Manipuler une collection de valeurs.", notions: "créer une liste ; accéder par indice (et indices négatifs) ; append() ; parcourir avec for ; len().", exercice: "Demander 5 notes, les ranger dans une liste, puis afficher la moyenne." },
    { key: "dictionnaires", title: "Les dictionnaires", objectif: "Associer des valeurs à des clés.", notions: "créer un dictionnaire {cle: valeur} ; accéder par clé ; ajouter une clé ; parcourir un dictionnaire.", exercice: "Décrire un produit (nom, prix, quantité) dans un dictionnaire et afficher chaque information." },
    { key: "fonctions", title: "Les fonctions", objectif: "Ranger et réutiliser son code.", notions: "def nom(parametres): ; return ; appeler une fonction ; l'intérêt (éviter les répétitions).", exercice: "Écrire une fonction est_pair(n) qui renvoie True si n est pair, et l'utiliser sur quelques nombres." },
    { key: "fichiers", title: "Fichiers et erreurs", objectif: "Lire/écrire un fichier et gérer une erreur.", notions: "open() et le bloc with ; write() et parcours ligne à ligne ; les exceptions avec try / except.", exercice: "Écrire trois prénoms dans un fichier, puis le relire pour les afficher." },
    { key: "projet", title: "Petit projet : le juste prix", objectif: "Assembler tout ce qui a été appris.", notions: "combiner variables, boucle while, conditions, et une fonction ; le module random (random.randint).", exercice: "Programmer le jeu du « juste prix » : l'ordinateur choisit un nombre entre 1 et 100, l'utilisateur devine, le programme répond « plus grand / plus petit » jusqu'à trouver." }
  ],
  javascript: [
    { key: "decouverte", title: "Découvrir JavaScript", objectif: "Comprendre ce qu'est un programme et afficher du texte.", notions: "ce qu'est un programme ; console.log() pour afficher ; le texte entre guillemets ; les commentaires avec //.", exercice: "Afficher « Bonjour, je m'appelle ... » avec le prénom de l'apprenant, via console.log." },
    { key: "variables", title: "Variables et types", objectif: "Stocker et réutiliser une information.", notions: "déclarer avec let et const ; les types (texte string, nombre number, booléen boolean) ; les gabarits `texte ${variable}` (accent grave).", exercice: "Créer prenom et age, puis afficher une phrase qui les combine (ex. « Awa a 20 ans »)." },
    { key: "operateurs", title: "Opérateurs et calculs", objectif: "Calculer et comparer.", notions: "opérateurs + - * / % ** ; comparaisons ===, !==, <, > ; opérateurs logiques &&, ||, !.", exercice: "Afficher le reste de 2026 divisé par 7, puis tester si 2026 est pair." },
    { key: "entrees", title: "Lire une saisie", objectif: "Rendre un programme interactif.", notions: "prompt() ouvre une fenêtre de saisie ; le résultat est du texte ; convertir en nombre avec Number().", exercice: "Demander l'année de naissance et afficher l'âge approximatif (2026 moins l'année)." },
    { key: "conditions", title: "Les conditions (if… else)", objectif: "Faire réagir le programme selon les cas.", notions: "if / else if / else ; les accolades { } qui délimitent les blocs ; les comparaisons.", exercice: "Demander un nombre et afficher s'il est négatif, nul ou positif." },
    { key: "boucles", title: "Les boucles (répéter)", objectif: "Répéter des actions.", notions: "la boucle for (let i = 0; i < n; i++) ; la boucle while ; break.", exercice: "Afficher la table de multiplication d'un nombre (de 1 à 10)." },
    { key: "tableaux", title: "Les tableaux", objectif: "Manipuler une collection de valeurs.", notions: "créer un tableau [ ] ; accéder par indice (à partir de 0) ; push() ; length ; parcourir avec for…of.", exercice: "Ranger 5 notes dans un tableau et afficher leur moyenne." },
    { key: "objets", title: "Les objets", objectif: "Regrouper des informations liées.", notions: "un objet { cle: valeur } ; accéder avec objet.cle ; ajouter une propriété.", exercice: "Décrire un produit (nom, prix, quantité) dans un objet et afficher chaque information." },
    { key: "fonctions", title: "Les fonctions", objectif: "Ranger et réutiliser son code.", notions: "function nom(parametres) { … return … } ; les fonctions fléchées const f = (x) => … ; l'intérêt (éviter les répétitions).", exercice: "Écrire estPair(n) qui renvoie true si n est pair, et l'utiliser sur quelques nombres." },
    { key: "projet", title: "Petit projet : le juste prix", objectif: "Assembler ce qui a été appris.", notions: "combiner variables, boucle while, conditions, une fonction ; Math.floor(Math.random()*100)+1 pour un nombre au hasard.", exercice: "Programmer le « juste prix » : l'ordinateur choisit un nombre entre 1 et 100, on devine, le programme répond « plus grand / plus petit »." }
  ],
  java: [
    { key: "decouverte", title: "Découvrir Java", objectif: "Comprendre la structure d'un programme Java et afficher du texte.", notions: "la classe et la méthode main ; System.out.println() pour afficher ; les commentaires // ; le point-virgule à la fin des instructions.", exercice: "Écrire un programme qui affiche « Bonjour, je m'appelle ... ». Écris-le dans la console et montre-le-moi : je le corrige." },
    { key: "variables", title: "Variables et types", objectif: "Déclarer une variable en indiquant son type.", notions: "en Java, on déclare le type : int (entier), double (décimal), String (texte), boolean ; ex. int age = 20; ; l'affectation avec =.", exercice: "Déclarer String prenom et int age, puis afficher une phrase qui les combine (avec + )." },
    { key: "operateurs", title: "Opérateurs et calculs", objectif: "Calculer et comparer.", notions: "opérateurs + - * / % ; attention à la division entière (int / int) ; comparaisons ==, !=, <, > ; logiques &&, ||, !.", exercice: "Calculer et afficher le reste de 2026 divisé par 7, puis tester si 2026 est pair." },
    { key: "entrees", title: "Lire une saisie", objectif: "Rendre un programme interactif.", notions: "la classe Scanner ; Scanner sc = new Scanner(System.in); ; sc.nextInt() pour un entier, sc.nextLine() pour du texte.", exercice: "Demander l'année de naissance et afficher l'âge approximatif (2026 moins l'année)." },
    { key: "conditions", title: "Les conditions (if… else)", objectif: "Choisir selon une condition.", notions: "if / else if / else ; les accolades { } ; les comparaisons ; conditions combinées.", exercice: "Demander un nombre et afficher s'il est négatif, nul ou positif." },
    { key: "boucles", title: "Les boucles (répéter)", objectif: "Répéter des actions.", notions: "la boucle for (int i = 0; i < n; i++) ; la boucle while ; break.", exercice: "Afficher la table de multiplication d'un nombre (de 1 à 10)." },
    { key: "tableaux", title: "Les tableaux", objectif: "Traiter une série de valeurs.", notions: "déclarer un tableau int[] t = {…} ; accéder par indice (à partir de 0) ; t.length ; parcourir avec for.", exercice: "Trouver la plus grande valeur d'un tableau de nombres, sans fonction toute faite." },
    { key: "methodes", title: "Les méthodes (fonctions)", objectif: "Ranger et réutiliser son code.", notions: "une méthode : type de retour, nom, paramètres typés ; ex. static boolean estPair(int n) { return n % 2 == 0; } ; l'appel.", exercice: "Écrire estPair(int n) qui renvoie true si n est pair, et l'utiliser sur quelques nombres." }
  ],
  algo: [
    { key: "algo-quoi", title: "Qu'est-ce qu'un algorithme ?", objectif: "Comprendre la notion de suite d'étapes.", notions: "définition d'un algorithme (une recette) ; entrée → traitement → sortie ; l'importance de l'ordre des étapes.", exercice: "Écrire, en français puis en Python, les étapes pour calculer la somme de deux nombres saisis." },
    { key: "algo-variables", title: "Variables et affectation", objectif: "Mémoriser une valeur et la faire évoluer.", notions: "la notion d'affectation (← ou =) ; échanger deux variables ; incrémenter (compteur = compteur + 1).", exercice: "Échanger le contenu de deux variables a et b, puis les afficher pour vérifier." },
    { key: "algo-conditions", title: "Tests et décisions", objectif: "Choisir selon une condition.", notions: "SI … ALORS … SINON ; conditions combinées (ET, OU) ; traduction en if/elif/else.", exercice: "Déterminer si une année saisie est bissextile (divisible par 4, sauf les siècles non divisibles par 400)." },
    { key: "algo-boucles", title: "Répétitions", objectif: "Répéter tant qu'une condition tient.", notions: "boucle TANT QUE ; boucle POUR ; la condition d'arrêt (éviter les boucles infinies).", exercice: "Calculer la factorielle d'un nombre n (n! = 1×2×…×n)." },
    { key: "algo-tableaux", title: "Tableaux et parcours", objectif: "Traiter une série de valeurs.", notions: "un tableau (liste) ; parcourir ; accumuler (somme, maximum) ; compter.", exercice: "Trouver la plus grande valeur d'une liste de nombres, sans utiliser max()." },
    { key: "algo-tri", title: "Un premier tri", objectif: "Découvrir un algorithme classique.", notions: "l'idée du tri ; comparer et échanger ; le tri par sélection expliqué simplement.", exercice: "Trier une petite liste de nombres du plus petit au plus grand (tri par sélection), étape par étape." }
  ]
};
// Contenu ÉCRIT des cours (rédigé à l'avance) : affiché directement à l'apprenant,
// sans appel à l'IA. Le tuteur IA vient ensuite par-dessus (questions, correction).
let COURSES = {};
try { COURSES = require("./courses.js"); } catch (e) { console.warn("  (courses.js introuvable : cours écrits désactivés)"); }
Object.keys(CURRICULA).forEach((lang) => { CURRICULA[lang].forEach((l) => { l.cours = (COURSES[lang] && COURSES[lang][l.key]) || ""; }); });

function lessonsOf(conv) { return CURRICULA[normalizeLanguage(conv && conv.language)] || CURRICULA.python; }
function currentLesson(conv) { const l = lessonsOf(conv); const i = Math.min(Math.max(0, conv && conv.lesson || 0), l.length - 1); return l[i]; }
function lessonTitles(conv) { return lessonsOf(conv).map((l) => l.title); }
// Texte affiché quand l'apprenant arrive sur une leçon : le cours écrit (ou, à défaut, l'objectif + l'exercice).
function lessonCard(conv) {
  const lessons = lessonsOf(conv);
  const idx = Math.min(Math.max(0, conv.lesson || 0), lessons.length - 1);
  const l = lessons[idx];
  const header = "Leçon " + (idx + 1) + " / " + lessons.length + " — " + l.title + "\n\n";
  const body = l.cours ? l.cours : (l.objectif + "\n\nExercice : " + l.exercice + "\n\nÉcrivez votre solution dans la console, puis montrez-moi le résultat.");
  // Sur la toute première leçon, on invite l'apprenant à préciser sa filière (pour adapter les exemples).
  const intro = (idx === 0)
    ? "Bienvenue dans votre formation. Pour adapter les exemples à vous, dites-moi en un mot votre domaine ou votre filière (informatique, gestion, sciences, lycée, autodidacte…). Vous pouvez me poser une question à tout moment, et écrire puis exécuter votre code dans la console à droite.\n\n"
    : "";
  return intro + header + body;
}

// Prompt du tuteur : pédagogue, en français simple, avec exercices et encouragements.
function codeSystem(conv) {
  const lang = normalizeLanguage(conv.language);
  const lessons = lessonsOf(conv);
  const idx = Math.min(Math.max(0, conv.lesson || 0), lessons.length - 1);
  const les = lessons[idx];
  const langLabel = languageLabel(lang);
  const runLabel = (LANGUAGES[lang].run === "python") ? "Python" : "JavaScript";
  return `RÔLE
Tu es un tuteur de programmation bienveillant et patient de Bâtisseur. Tu enseignes ${langLabel} à un ou une GRANDE DÉBUTANTE, en français simple, sans jargon inutile (et si tu emploies un mot technique, tu l'expliques aussitôt). Tu es encourageant, jamais condescendant. Ton objectif : donner une VRAIE base solide.

LEÇON EN COURS
- Leçon ${idx + 1} sur ${lessons.length} : « ${les.title} »
- Objectif : ${les.objectif}
- Notions : ${les.notions}
- Exercice : ${les.exercice}

LE COURS ÉCRIT EST DÉJÀ AFFICHÉ À L'APPRENANT (ne le répète pas en entier). Le voici pour t'y appuyer et rester COHÉRENT avec lui (mêmes notations, même progression) :
--- DÉBUT DU COURS ---
${les.cours || "(cours écrit indisponible : explique la notion simplement toi-même)"}
--- FIN DU COURS ---

TON RÔLE, PAR-DESSUS LE COURS ÉCRIT
- Réponds aux questions de l'apprenant sur ce cours, donne d'AUTRES exemples, reformule autrement si besoin.
- Quand la personne montre son code ou son résultat, corrige avec bienveillance : félicite ce qui est juste, repère l'erreur SANS donner tout de suite toute la solution, donne un indice, laisse réessayer. Si elle bloque vraiment, montre la correction commentée.
- Invite à ÉCRIRE puis EXÉCUTER le code dans la console à droite (bouton « Exécuter ») avant de te montrer le résultat.
- Quand l'exercice est réussi ou la notion comprise, félicite et invite à passer à la leçon suivante avec le bouton « Leçon suivante → ». N'enchaîne pas seul : attends ce bouton.

ADAPTER À LA FILIÈRE DE L'APPRENANT
- Si tu ne connais pas encore la filière ou le domaine d'études de la personne (par ex. informatique, gestion, sciences, lycée, autodidacte…), DEMANDE-LE dès ton premier message, gentiment, en une phrase — pour adapter tes exemples et tes comparaisons.
- Ensuite, choisis des exemples proches de son domaine pour faciliter la compréhension, tout en gardant le cours écrit comme fil conducteur.
- LES EXERCICES NE SONT PAS FIGÉS. Propose-lui 2 ou 3 petits exercices d'entraînement sur la notion de la leçon, dont le CONTEXTE est tiré de SA filière ou de son métier visé. Par exemple, pour la même notion : agriculture → surfaces de parcelles, rendements, pluviométrie, nombre de plants ; gestion/commerce → prix, factures, remises, stocks ; santé → doses, nombre de patients, température ; lycée/sciences → notes, vitesses, aires. La notion travaillée reste exactement la même, seul l'habillage change. Donne-les du plus simple au plus difficile, de préférence après l'exercice principal du cours, et corrige au fur et à mesure.

RÈGLES
- Montre le code dans des blocs délimités par trois accents graves avec le langage (un bloc \`\`\`${LANGUAGES[lang].run}\`). Le code s'exécute en ${runLabel} dans la console.
- Exemples courts et exécutables. Évite les longues théories. Vérifie régulièrement que la personne suit.
- Ton professionnel et chaleureux. Pas d'émojis.` + CHOIX_HELP;
}

// Prompt du MENTOR de projet : l'apprenant veut CODER LUI-MÊME son application.
// On ne construit pas à sa place : on donne un plan de réalisation, puis on
// l'accompagne morceau par morceau pendant qu'il écrit son code.
function codeProjectSystem(conv) {
  const lang = normalizeLanguage(conv.language);
  const langLabel = languageLabel(lang);
  const run = LANGUAGES[lang] ? LANGUAGES[lang].run : "javascript";
  const name = conv.projectName ? ("« " + conv.projectName + " »") : "son projet";
  return `RÔLE
Tu es un MENTOR de projet de Bâtisseur. La personne veut CODER ELLE-MÊME ${name} (en ${langLabel}). Tu ne construis PAS l'application à sa place : tu la GUIDES pour qu'elle y arrive par elle-même, en français simple et encourageant, sans jargon inutile (et si tu emploies un mot technique, tu l'expliques).

À TON TOUT PREMIER MESSAGE, donne-lui un PLAN DE RÉALISATION clair et motivant, structuré ainsi :
1) En une phrase : ce que l'application doit faire, et pour qui.
2) Les TECHNOLOGIES utiles. Pour une application web : HTML (la structure), CSS (le style, les couleurs), JavaScript (les interactions) ; et une base de données seulement si le projet doit garder des informations.
3) Les ÉTAPES dans l'ordre, du plus simple au plus complet — chacune en une ligne.
4) Les FICHIERS à créer et à quoi sert chacun.
5) La PREMIÈRE petite étape à coder MAINTENANT, avec un court exemple de code exécutable.

ENSUITE (messages suivants) : réponds à ses questions, relis son code, repère ses erreurs avec bienveillance (un indice d'abord, la correction commentée si elle bloque), et propose la prochaine petite étape. Toujours PAR PETITS PAS.

RÈGLES
- Montre le code dans des blocs délimités par trois accents graves avec le langage (un bloc \`\`\`${run}\`). Le code s'exécute dans la console à droite (bouton « Exécuter »). Invite-la à écrire puis exécuter son code avant de te montrer le résultat.
- Exemples COURTS et exécutables. Ne donne JAMAIS l'application entière d'un seul coup : apprends-lui à la construire morceau par morceau.
- Ton professionnel et chaleureux. Pas d'émojis.` + CHOIX_HELP;
}

// Génère la réponse du tuteur (parcours programmation). Aucune extraction HTML : le code
// reste visible dans la discussion, et rien n'est écrit comme « site ».
async function produceCode(conv) {
  const system = conv.codeProject ? codeProjectSystem(conv) : codeSystem(conv);
  // Cours de codage : modèle rapide, réponses courtes → le tuteur répond vite et reste fluide.
  const reply = await callClaude(system, conv.messages, MODEL_LIGHT, 2048);
  const message = (reply && reply.trim()) || "Reprenons : où en êtes-vous ?";
  conv.messages.push({ role: "assistant", content: message });
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  return { reply: message, siteUpdated: false };
}

// ============================================================
// ESPACE « PREMIUM LEARNER » — applications avancées (vrai JavaScript, modèle Opus)
// Réservé aux apprenants promus par le formateur. Ici l'IA ÉCRIT du vrai code
// (HTML + CSS + JavaScript) dans un seul fichier index.html, sans le kit débutant.
// ============================================================
const PREMIUM_INSTRUCTION = `
=== ATELIER PREMIUM (applications avancées) ===
Tu es l'assistant de l'espace « Premium learner » de Bâtisseur, réservé aux apprenants les plus avancés qui conçoivent une vraie application. Ici, contrairement au parcours débutant, tu ÉCRIS DU VRAI CODE, JavaScript compris.

DÉMARCHE
- À ton PREMIER message : pose 2 ou 3 questions courtes pour cerner l'idée (à quoi sert l'application, ses 3-4 fonctions clés, pour qui). Ne construis pas encore.
- Dès que l'idée est claire, construis une PREMIÈRE version fonctionnelle, puis itère avec la personne à chaque demande.

FORMAT DE SORTIE
1) Un court message à la personne (français simple, sans code, sans balise).
2) Puis l'application ENTIÈRE dans UN SEUL bloc, exactement ainsi :
\`\`\`html:index.html
<!doctype html>
<html lang="fr">
... l'application complète (HTML + CSS + JS en ligne) ...
</html>
\`\`\`
- Toujours la page ENTIÈRE (jamais un extrait, jamais « ... »). UN SEUL bloc de code. Aucun code hors du bloc. Tu pars TOUJOURS de l'état actuel fourni plus bas et tu renvoies le fichier entier à jour.

CE QUE TU PEUX FAIRE (large)
- Écrire du HTML, du CSS ET du JavaScript réels dans le même index.html (tout en ligne).
- Créer plusieurs écrans via une navigation en JavaScript (onglets, routeur simple) : l'app peut sembler multi-pages.
- Gérer un état applicatif, des formulaires, des calculs, des filtres, des recherches, des graphiques, des rôles.
- Utiliser au besoin UNE bibliothèque depuis un CDN fiable (cdnjs) — seulement si c'est vraiment utile.

DONNÉES PARTAGÉES, COMPTES, PAIEMENT — la boîte à outils « Batisseur »
La plateforme fournit DÉJÀ, dans la page, un objet global « Batisseur ». Tu n'as RIEN à injecter, configurer, ni redéfinir : il est présent, utilise-le directement (n'écris jamais toi-même un objet Batisseur ni window.__BAT). Il relie l'app au cerveau central : les données sont PARTAGÉES entre tous les utilisateurs et conservées sur le serveur. N'utilise PAS localStorage pour les données métier ; passe par Batisseur. Toutes ses fonctions renvoient une promesse (utilise async/await ou .then, avec try/catch).

- Batisseur.save(collection, data) : enregistre un objet.
- Batisseur.list(collection, { limit }) : renvoie un tableau d'éléments { id, data, createdAt }.
  RÈGLE IMPORTANTE de nommage des collections :
    • nom commençant par "public_"  → visible par TOUT LE MONDE (annuaire, annonces, catalogue, avis…) ;
    • tout autre nom                 → PRIVÉ : il faut être connecté, et chacun ne lit QUE ses propres enregistrements (ex. "commandes", "messages"). Choisis le nom en conséquence.
- Batisseur.signup(email, nom, motdepasse) / Batisseur.login(email, motdepasse) : compte MEMBRE de l'app ; la session est retenue toute seule.
- Batisseur.me() : le membre connecté ou null. Batisseur.logout(). Batisseur.isLoggedIn().
- Batisseur.upload(fichier) : envoie un objet File issu d'un <input type="file">.
- Batisseur.pay(montant, { reference }) : lance un paiement Wave (redirige vers la page de paiement). À n'utiliser que si le projet a activé le paiement.

Exemple (dans le JS de l'app) :
  try {
    await Batisseur.signup(email, nom, mdp);
    await Batisseur.save('public_annonces', { titre: t, prix: p });
    const annonces = await Batisseur.list('public_annonces');
    // afficher annonces…
  } catch (e) { /* montrer un message clair à l'utilisateur */ }

À DIRE HONNÊTEMENT À LA PERSONNE
- Les données sont partagées et gardées sur le serveur de Bâtisseur : c'est déjà une vraie petite plateforme. Pour en faire un service totalement INDÉPENDANT (son propre domaine, son propre serveur), c'est l'étape « export » — une prochaine marche, pas un blocage.

EXIGENCE DE QUALITÉ
- Code clair, commenté, qui FONCTIONNE. Vérifie mentalement chaque fonction. Interface soignée et professionnelle, sans émojis (sauf demande). Explique en une phrase ce que tu viens de construire ou de corriger.`;

// Génère / met à jour l'application avancée (espace Premium). Modèle Opus, sans kit.
async function producePremium(conv) {
  let system = PREMIUM_INSTRUCTION + CHOIX_HELP;
  // On retire la boîte à outils injectée avant de montrer le code à l'IA (elle est gérée par la plateforme).
  const current = stripKit(await readSite(conv.id));
  if (current) {
    system += "\n\n=== ÉTAT ACTUEL DE L'APPLICATION (index.html) ===\nVoici le code EXACT actuel. Pars de ce code, applique la demande, renvoie le fichier ENTIER à jour, sans rien perdre.\n```html\n" + current + "\n```";
  }
  const reply = await callClaude(system, conv.messages, MODEL_PREMIUM, PREMIUM_BUILD_TOKENS);
  const ex = extractSite(reply);
  let message = ex.message; let siteUpdated = false;
  // Sécurité anti-page-blanche : on n'enregistre le site QUE s'il est complet
  // (il se termine bien par </html>). Un fichier coupé net (plafond atteint) est
  // refusé : on garde la version précédente et on explique comment continuer.
  if (ex.html && htmlLooksComplete(ex.html)) {
    if (await writeSite(conv.id, ex.html)) { siteUpdated = true; conv.hasSite = true; }
  } else if (ex.html) {
    // Reprise automatique : la réponse a été coupée (trop longue). On redemande
    // UNE fois une version compacte et complète, sans déranger l'apprenant.
    try {
      const retrySys = system + "\n\nIMPORTANT : ta réponse précédente a été COUPÉE car trop longue. Renvoie MAINTENANT l'application ENTIÈRE dans UN SEUL bloc qui se termine bien par </html>, en restant plus COMPACT (CSS concis, pas de répétitions) pour tenir en une seule réponse.";
      const retry = await callClaude(retrySys, conv.messages, MODEL_PREMIUM, PREMIUM_BUILD_TOKENS);
      const ex2 = extractSite(retry);
      if (ex2.html && htmlLooksComplete(ex2.html) && await writeSite(conv.id, ex2.html)) {
        siteUpdated = true; conv.hasSite = true;
        if (ex2.message && ex2.message.trim()) message = ex2.message;
      } else {
        message = "Ton application est devenue trop grande pour être écrite d'un seul coup. Dis-moi « continue » pour que je termine, ou construisons-la par petites étapes.";
      }
    } catch (e) {
      message = "Ton application est devenue trop grande pour être écrite d'un seul coup. Dis-moi « continue » pour que je termine, ou construisons-la par petites étapes.";
    }
  }
  if (!message || !message.trim()) message = siteUpdated ? "✓ Application mise à jour — regardez l'aperçu." : reply;
  conv.messages.push({ role: "assistant", content: message });
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  return { reply: message, siteUpdated };
}

const DATA_DIR = path.join(__dirname, "data");
const SITES_DIR = path.join(DATA_DIR, "sites");
try { fs.mkdirSync(SITES_DIR, { recursive: true }); } catch (e) {}

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };

function sendJson(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
function reqBase(req) { return (String(req.headers["x-forwarded-proto"] || "http").split(",")[0]) + "://" + (req.headers.host || "localhost"); }
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

// ============================================================
// PALIER 4 — COMPTES & ESPACE MEMBRE
// ------------------------------------------------------------
// Un apprenant peut créer un compte : ses projets lui sont rattachés,
// visibles dans « Mon espace », et son certificat porte son nom.
// Les comptes sont OPTIONNELS : sans compte, on construit comme avant.
// Aucune dépendance : mots de passe hachés avec crypto.scrypt, sessions
// par jeton aléatoire stocké côté serveur (base de données ou fichier).
// ============================================================
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 jours
const SESSION_COOKIE = "bat_session";
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

// -- Stockage FICHIER des comptes (mode sans base de données) --
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); }
  catch (e) { return { users: {}, emails: {}, sessions: {} }; }
}
function saveAccounts(a) { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error("saveAccounts:", e); } }

function normEmail(s) { return String(s || "").trim().toLowerCase(); }
function validEmail(s) { return typeof s === "string" && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

// -- Mot de passe : haché avec scrypt (jamais stocké en clair) --
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}
function verifyPassword(pw, stored) {
  try {
    const [saltHex, hashHex] = String(stored || "").split(":");
    if (!saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 64);
    const a = Buffer.from(hashHex, "hex");
    return a.length === hash.length && crypto.timingSafeEqual(a, hash);
  } catch (e) { return false; }
}

// -- Utilisateurs --
async function findUserByEmail(email) {
  const e = normEmail(email);
  if (USE_DB) { try { const r = await sb(`/users?email=eq.${encodeURIComponent(e)}&select=*`); return (r && r[0]) || null; } catch (err) { console.error("findUserByEmail:", err.message); return null; } }
  const a = loadAccounts(); const id = a.emails[e]; return id ? (a.users[id] || null) : null;
}
async function getUserById(id) {
  if (!id) return null;
  if (USE_DB) { try { const r = await sb(`/users?id=eq.${encodeURIComponent(id)}&select=*`); return (r && r[0]) || null; } catch (err) { return null; } }
  const a = loadAccounts(); return a.users[id] || null;
}
async function createUser({ email, name, password, status, cohort, cohortId, paid }) {
  const e = normEmail(email);
  const user = {
    id: crypto.randomUUID(), email: e,
    name: String(name || "").trim().slice(0, 80) || e.split("@")[0],
    pass: hashPassword(password),
    status: status || "pending",
    paid: paid === true,
    cohort: (cohort != null ? String(cohort).trim().slice(0, 120) : "") || null,
    cohort_id: cohortId || null,
    created_at: new Date().toISOString()
  };
  if (USE_DB) { await sb(`/users`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([user]) }); }
  else { const a = loadAccounts(); a.users[user.id] = user; a.emails[e] = user.id; saveAccounts(a); }
  return user;
}
async function updateUser(id, fields) {
  if (!id) return null;
  if (USE_DB) { await sb(`/users?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) }); return await getUserById(id); }
  const a = loadAccounts(); if (!a.users[id]) return null; Object.assign(a.users[id], fields); saveAccounts(a); return a.users[id];
}
// Suppression complète d'un compte apprenant : le compte, ses sessions de connexion et ses projets.
async function deleteUser(id) {
  if (!id) return false;
  if (USE_DB) {
    try {
      await sb(`/conversations?data->>userId=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await sb(`/sessions?user_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await sb(`/users?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    } catch (e) { console.error("deleteUser:", e.message); return false; }
    return true;
  }
  const a = loadAccounts();
  const usr = a.users[id]; if (!usr) return false;
  delete a.users[id];
  if (usr.email && a.emails[normEmail(usr.email)] === id) delete a.emails[normEmail(usr.email)];
  Object.keys(a.sessions || {}).forEach((tok) => { if (a.sessions[tok] && a.sessions[tok].userId === id) delete a.sessions[tok]; });
  saveAccounts(a);
  try {
    fs.readdirSync(DATA_DIR).forEach((f) => {
      if (!f.endsWith(".json") || f === "accounts.json") return;
      try { const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); if (c && c.userId === id) fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) {}
    });
  } catch (e) {}
  return true;
}

// --- Rôles & statut d'accès ---
function isAdmin(u) { return !!u && ADMIN_EMAILS.includes(normEmail(u.email)); }
function userStatus(u) { if (!u) return "none"; if (isAdmin(u)) return "active"; return u.status || "active"; }
function canView(u) { const s = userStatus(u); return isAdmin(u) || s === "active" || s === "finished"; }
function canBuild(u) { return isAdmin(u) || userStatus(u) === "active"; }
// « Premium learner » : accès réservé (accordé par le formateur) à l'atelier d'applications avancées.
function isPremium(u) { return !!u && (isAdmin(u) || u.premium === true); }
function canPremium(u) { return canBuild(u) && isPremium(u); }
function owns(user, conv) { if (!conv || !conv.userId) return true; return !!(user && user.id === conv.userId); }
function buildBlockMessage(user) {
  if (!user) return { code: 401, error: "Connectez-vous pour accéder à votre formation." };
  const s = userStatus(user);
  if (s === "pending") return { code: 403, error: "Votre inscription est en attente de validation par le formateur." };
  if (s === "finished") return { code: 403, error: "Votre formation est terminée : vous pouvez consulter vos projets, mais plus les modifier. Contactez votre formateur pour être réautorisé(e)." };
  return { code: 403, error: "Accès non autorisé." };
}
// La session doit être LANCÉE par le formateur avant que l'apprenant puisse créer/construire un projet.
// Un compte « actif » = place confirmée (accès au site) ; la création de projet n'ouvre qu'au lancement.
async function sessionLaunchedFor(u) {
  if (isAdmin(u)) return true;
  if (!u || !u.cohort_id) return true; // apprenant sans session attribuée : on ne bloque pas la construction
  try { const c = await getCohort(u.cohort_id); return !!(c && c.launched); } catch (e) { return true; }
}
// La formation s'ouvre à partir du PAIEMENT (marqué « Payé » par le formateur) :
//  - Programmation : accessible dès que la place est payée.
//  - Création de projet (site / application) : payée ET session lancée par le formateur.
function paidOk(u) { return isAdmin(u) || !!(u && u.paid === true); }
// Porte d'accès. kind = "code" (programmation) ou "project" (création de site/app + premium).
// Renvoie null si OK, sinon { code, error, accessStatus, locked }.
async function accessGate(user, kind) {
  if (!user) return { code: 401, error: "Connectez-vous pour accéder à votre formation." };
  if (userStatus(user) === "finished" && !isAdmin(user)) return { code: 403, accessStatus: "finished", error: "Votre formation est terminée : vous pouvez consulter vos projets, mais plus les modifier. Contactez votre formateur." };
  if (!paidOk(user)) return { code: 403, accessStatus: "unpaid", locked: "unpaid", error: "Votre place n'est pas encore validée. Réservez et réglez votre place ; dès que le formateur confirme votre paiement, l'accès s'ouvre." };
  if (kind !== "code") {
    if (!(await sessionLaunchedFor(user))) return { code: 403, accessStatus: userStatus(user), locked: "notlaunched", error: "La création de votre projet s'ouvrira dès que le formateur aura lancé la session. En attendant, la programmation est déjà disponible." };
  }
  return null;
}
// Compat : ancienne porte (projet) conservée pour les endpoints non filière-spécifiques.
async function buildGate(user) { return accessGate(user, "project"); }

// -- Sessions (jeton aléatoire côté serveur) --
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const created_at = new Date().toISOString();
  if (USE_DB) { await sb(`/sessions`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ token, user_id: userId, created_at }]) }); }
  else { const a = loadAccounts(); a.sessions[token] = { userId, at: Date.now() }; saveAccounts(a); }
  return token;
}
async function deleteSession(token) {
  if (!token) return;
  if (USE_DB) { try { await sb(`/sessions?token=eq.${encodeURIComponent(token)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  const a = loadAccounts(); if (a.sessions[token]) { delete a.sessions[token]; saveAccounts(a); }
}
async function getSessionUser(token) {
  if (!token) return null;
  if (USE_DB) {
    try {
      const r = await sb(`/sessions?token=eq.${encodeURIComponent(token)}&select=user_id,created_at`);
      const s = r && r[0]; if (!s) return null;
      if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL_MS) { await deleteSession(token); return null; }
      return await getUserById(s.user_id);
    } catch (e) { return null; }
  }
  const a = loadAccounts(); const s = a.sessions[token]; if (!s) return null;
  if (Date.now() - (s.at || 0) > SESSION_TTL_MS) { delete a.sessions[token]; saveAccounts(a); return null; }
  return a.users[s.userId] || null;
}

// -- Cookies / utilisateur courant --
function parseCookies(req) {
  const h = req.headers.cookie || ""; const out = {};
  h.split(";").forEach((p) => { const i = p.indexOf("="); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
// En production (Render), le cookie de session est marqué « Secure » : il ne
// circule qu'en HTTPS. En local (http://localhost) on ne l'ajoute pas, sinon la
// connexion de test ne fonctionnerait pas. Render définit la variable RENDER.
const COOKIE_SECURE = (process.env.RENDER || process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1") ? "; Secure" : "";
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE}; Max-Age=0`);
}
async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? await getSessionUser(token) : null;
}
function publicUser(u) { return u ? { id: u.id, email: u.email, name: u.name, status: userStatus(u), cohort: u.cohort || null, cohortId: u.cohort_id || null, isAdmin: isAdmin(u), premium: isPremium(u) } : null; }

// Un projet rattaché à un compte n'est accessible qu'à son propriétaire (voir owns()).
// Les projets anonymes (sans userId) restent accessibles par id, comme avant.

// -- Liste des projets d'un compte (résumés légers pour « Mon espace ») --
function convTitle(conv) {
  if (conv.projectName) return String(conv.projectName).slice(0, 60);
  if (conv.title) return String(conv.title).slice(0, 60);
  if (conv && conv.track === "code") return "Programmation — " + languageLabel(conv.language);
  if (conv && conv.track === "premium") return "Application avancée (Premium)";
  const firstReal = (conv.messages || []).find((m) => m.role === "user" && !m.hidden);
  if (firstReal && firstReal.content) return String(firstReal.content).replace(/\s+/g, " ").trim().slice(0, 60) || "Projet sans titre";
  return "Projet sans titre";
}
function convSummary(conv) {
  const base = { id: conv.id, title: convTitle(conv), projectName: conv.projectName || null, modules: convModules(conv), step: conv.step || 0, hasSite: !!conv.hasSite, publishedUrl: conv.publishedUrl || null, pwa: !!conv.pwa, updatedAt: conv.updatedAt || conv.createdAt || null };
  if (conv.track === "code") { base.track = "code"; base.language = normalizeLanguage(conv.language); base.lesson = conv.lesson || 0; base.lessonCount = lessonsOf(conv).length; }
  if (conv.track === "premium") base.track = "premium";
  return base;
}
async function listConvsForUser(userId) {
  if (!userId) return [];
  if (USE_DB) {
    try {
      const r = await sb(`/conversations?data->>userId=eq.${encodeURIComponent(userId)}&select=data&order=updated_at.desc`);
      return (r || []).map((row) => convSummary(row.data)).filter((s) => s.id);
    } catch (e) { console.error("listConvsForUser:", e.message); return []; }
  }
  const out = [];
  try {
    fs.readdirSync(DATA_DIR).forEach((f) => {
      if (!f.endsWith(".json") || f === "accounts.json") return;
      try { const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); if (c && c.userId === userId) out.push(convSummary(c)); } catch (e) {}
    });
  } catch (e) {}
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
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

// Un fichier HTML complet se termine par </html>. Si cette balise manque, c'est
// que la réponse du modèle a été coupée (plafond de longueur atteint) : on refuse
// alors d'enregistrer ce site pour ne pas remplacer une bonne version par une
// page blanche.
function htmlLooksComplete(html) {
  return typeof html === "string" && /<\/html\s*>/i.test(html);
}
// -------------------------------------------------------------------------

// Round-robin de départ entre les clés (réparti dans le temps).
let KEY_CURSOR = 0;
const RETRYABLE = [408, 409, 429, 500, 502, 503, 504, 529];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Point d'entrée : choisit le modèle, et si le modèle demandé est inconnu/refusé (ex. modèle
// rapide indisponible sur le compte), réessaie UNE fois avec le modèle principal. La plateforme
// ne bloque donc jamais à cause d'un nom de modèle.
async function callClaude(system, messages, model, maxTokens) {
  const useModel = model || MODEL;
  const mt = maxTokens || 8192;
  try {
    return await callClaudeOnce(system, messages, useModel, mt);
  } catch (e) {
    if (e && (e.status === 400 || e.status === 404) && useModel !== MODEL) {
      console.error("Modèle « " + useModel + " » indisponible → bascule sur « " + MODEL + " ».");
      return await callClaudeOnce(system, messages, MODEL, mt);
    }
    throw e;
  }
}

async function callClaudeOnce(system, messages, model, maxTokens) {
  const clean = messages.map((m) => ({ role: m.role, content: m.content }));
  const body = JSON.stringify({ model: model || MODEL, max_tokens: maxTokens || 8192, system, messages: clean });
  const n = API_KEYS.length || 1;
  const start = KEY_CURSOR; KEY_CURSOR = (KEY_CURSOR + 1) % n; // avance pour la prochaine requête
  let lastErr = null;

  for (let i = 0; i < n; i++) {
    const key = API_KEYS[(start + i) % n];
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

      const status = response.status;
      const msg = (data && data.error && data.error.message) || ("Erreur de l'API Claude (" + status + ").");
      lastErr = Object.assign(new Error(msg), { status });
      // 400/404 = problème de requête/modèle, pas de clé : inutile de basculer.
      if (status === 400 || status === 404) throw lastErr;
      // Sinon (429 saturation, 401/403 clé, 5xx…) : on tente la clé suivante.
      console.error(`Clé API ${(start + i) % n + 1}/${n} → erreur ${status}, bascule…`);
      if ((status === 429 || status === 529) && i < n - 1) await sleep(600);
    } catch (e) {
      if (e && (e.status === 400 || e.status === 404)) throw e;
      lastErr = e; // erreur réseau : on tente la clé suivante
    }
  }
  throw lastErr || new Error("Aucune clé API disponible.");
}

// Génère la réponse de l'étape courante (et met à jour le site si c'est une étape de construction).
async function produceCurrent(conv, baseUrl) {
  if (conv.track === "code") return produceCode(conv);   // 2e filière : apprendre à programmer
  if (conv.track === "premium") return producePremium(conv); // espace Premium : applications avancées
  const step = conv.step || 0;
  const isBuild = !!STEPS[step].build;
  const mods = convModules(conv);

  // Les volets choisis éclairent TOUTES les étapes (le diagnostic comme la construction).
  let system = PROMPTS[step] + `

=== CONTEXTE DU PROJET ===
${modulesContext(mods)}`;
  // Étapes de discussion : l'assistant propose de lui-même les fonctions « appli ».
  if (!isBuild) system += PLATFORM_CAPABILITIES + CHOIX_HELP;
  // Tout premier échange : présenter les possibilités à chaque personne qui arrive.
  if (!isBuild && step === 0) system += INTRO_PROPOSAL;
  // Ton professionnel imposé sur toutes les étapes.
  system += "\n\n=== TON ===\nAdopte un ton professionnel, clair et sobre. N'emploie pas d'émojis dans tes messages.";
  if (isBuild) {
    system += SINGLE_INSTRUCTION;
    if (conv.multipage) system += MULTIPAGE_NOTE;
    const focus = modulesBuild(mods); if (focus) system += focus;
    // On injecte le CODE RÉEL du site actuel : Claude part de l'existant, pas de sa mémoire.
    // (On retire le kit d'interactivité de sa vue : il est géré par la plateforme.)
    const current = stripKit(await readSite(conv.id));
    if (current) {
      system += `

=== ÉTAT ACTUEL DU SITE (index.html) ===
Voici le code EXACT du site tel qu'il est maintenant. Tu PARS de ce code, tu appliques la demande de la personne, et tu renvoies le fichier ENTIER à jour. Tu ne repars jamais de zéro (sauf demande explicite), et tu ne perds aucun contenu déjà présent.
\`\`\`html
${current}
\`\`\``;
    }
  }

  // Construction d'un projet = modèle principal, réponse longue (le site entier) : on prend le temps.
  // Discussion / questions simples = modèle rapide, réponse courte : plus vif.
  const reply = await callClaude(system, conv.messages, isBuild ? MODEL : MODEL_LIGHT, isBuild ? BUILD_TOKENS : 2048);

  // Extraction blindée : le HTML ne fuite jamais dans le message.
  const ex = extractSite(reply);
  let siteUpdated = false;
  let message = ex.message;

  // Anti-page-blanche : on n'enregistre un site que s'il est complet (</html>).
  // Un fichier coupé (plafond atteint) est refusé — on garde la version actuelle.
  let builtHtml = null;
  if (isBuild && ex.html && htmlLooksComplete(ex.html)) {
    const withKit = injectKit(ex.html, mods, conv, baseUrl);
    if (await writeSite(conv.id, withKit)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex.html; }
  } else if (isBuild && ex.html) {
    // Reprise automatique : la réponse a été coupée. On redemande une version compacte et complète.
    try {
      const retrySys = system + "\n\nIMPORTANT : ta réponse précédente a été COUPÉE car trop longue. Renvoie MAINTENANT le site ENTIER dans UN SEUL bloc qui se termine bien par </html>, en restant plus COMPACT (CSS concis, pas de répétitions).";
      const retry = await callClaude(retrySys, conv.messages, MODEL, BUILD_TOKENS);
      const ex2 = extractSite(retry);
      if (ex2.html && htmlLooksComplete(ex2.html)) {
        const withKit2 = injectKit(ex2.html, mods, conv, baseUrl);
        if (await writeSite(conv.id, withKit2)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex2.html; }
        if (ex2.message && ex2.message.trim()) message = ex2.message;
      } else {
        message = "Votre site est devenu un peu trop grand pour être écrit d'un seul coup. Dites « continue » pour que je termine, ou avançons par petites étapes.";
      }
    } catch (e) {
      message = "Votre site est devenu un peu trop grand pour être écrit d'un seul coup. Dites « continue » pour que je termine, ou avançons par petites étapes.";
    }
  }
  if (!message || !message.trim()) message = siteUpdated ? "✓ J'ai mis à jour votre site — regardez l'aperçu." : (ex.html ? "✓ C'est fait." : reply);

  // Historique LÉGER : on ne stocke que le TEXTE (jamais le code). La base/fichier = source de vérité.
  conv.messages.push({ role: "assistant", content: message });
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  const out = { reply: message, siteUpdated };
  if (builtHtml != null) out.hasPages = /data-bat-page\b/i.test(builtHtml);
  return out;
}

// POST /api/start
// Journal d'activité d'un projet : on note ce que l'apprenant FAIT (démarrage, étape, publication),
// avec la date, pour que le formateur voie son activité jour par jour. Attaché à la conversation.
function logConv(conv, type, detail) {
  try {
    if (!conv) return;
    if (!Array.isArray(conv.log)) conv.log = [];
    const at = new Date().toISOString();
    conv.log.push({ at, d: at.slice(0, 10), t: type, x: (detail != null ? String(detail).slice(0, 120) : "") });
    if (conv.log.length > 300) conv.log = conv.log.slice(-300);
  } catch (e) {}
}
async function handleStart(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const user = await currentUser(req);
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
    { const g = await accessGate(user, (p.track === "code" || p.track === "codeproj") ? "code" : "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    const id = crypto.randomUUID();
    // Filière « apprendre à programmer » (2e option de formation).
    if (p.track === "code") {
      const language = normalizeLanguage(p.language);
      const kickoff = `Bonjour ! Je veux apprendre ${languageLabel(language)} depuis le début.`;
      const conv = { id, track: "code", language, lesson: 0, userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
      // Le cours écrit s'affiche directement (aucun appel à l'IA pour le délivrer).
      const card = lessonCard(conv);
      conv.messages.push({ role: "assistant", content: card });
      conv.updatedAt = new Date().toISOString();
      await saveConv(conv);
      return sendJson(res, 200, { id, track: "code", language, lesson: 0, lessons: lessonTitles(conv), reply: card, siteUpdated: false });
    }
    // Au-delà d'ici, on sollicite l'IA : on applique le plafond par apprenant.
    if (!(await aiQuotaGuard(user))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    // Espace « Premium learner » : atelier d'applications avancées (réservé, modèle Opus).
    if (p.track === "premium") {
      if (!canPremium(user)) return sendJson(res, 403, { error: "L'atelier Premium est réservé aux apprenants sélectionnés par le formateur." });
      const projName = String(p.name || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
      const kickoff = "Bonjour ! Je veux créer une application avancée" + (projName ? (" nommée « " + projName + " »") : "") + ". Voici mon idée : " + String(p.idea || "").slice(0, 500);
      const conv = { id, track: "premium", projectName: projName || null, userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
      const out = await produceCurrent(conv, reqBase(req));
      return sendJson(res, 200, { id, track: "premium", projectName: conv.projectName, ...out });
    }
    // Espace « Coder soi-même » : l'apprenant code LUI-MÊME son projet (guide + éditeur).
    if (p.track === "codeproj") {
      const language = normalizeLanguage(p.language);
      const projName = String(p.name || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
      const idea = String(p.idea || "").slice(0, 500);
      const kickoff = "Je veux coder MOI-MÊME mon projet" + (projName ? (" « " + projName + " »") : "") + " en " + languageLabel(language) + ". Voici mon idée : " + idea + "\nDonne-moi d'abord un plan clair pour le réaliser moi-même, puis guide-moi pendant que j'écris le code.";
      const conv = { id, track: "code", codeProject: true, language, projectName: projName || null, lesson: 0, userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
      const out = await produceCode(conv);
      return sendJson(res, 200, { id, track: "code", codeProject: true, language, projectName: conv.projectName, lessons: [], ...out });
    }
    // Pause « 1 h de travail » : bloque la création de site tant que la pause est active.
    { const w = workCapGuard(user); if (w) return sendJson(res, w.code, w); }
    // Limite : un apprenant qui a DÉJÀ publié un site web ne peut plus en créer un nouveau
    // (il peut continuer à modifier le sien). Ne concerne que les sites/applis web, pas le formateur.
    if (!isAdmin(user)) {
      try {
        const mine = await listConvsForUser(user.id);
        if (mine.some((s) => !s.track && s.publishedUrl)) {
          return sendJson(res, 403, { error: "Vous avez déjà publié votre site. Vous pouvez continuer à le modifier, mais vous ne pouvez pas créer un nouveau site.", projectDone: true });
        }
      } catch (e) {}
    }
    const mods = normalizeModules(p.modules, p.projectType);
    const multipage = !!p.multipage;
    const kickoff = `Bonjour ! Je découvre Bâtisseur et je veux créer : ${modulesLabel(mods)}.`;
    const conv = { id, step: 0, modules: mods, multipage, userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
    logConv(conv, "start", "A démarré un projet de site : " + modulesLabel(mods) + (multipage ? " (plusieurs pages)" : ""));
    const out = await produceCurrent(conv, reqBase(req));
    sendJson(res, 200, { id, step: 0, modules: mods, multipage, ...out });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/chat
async function handleChat(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    { const g = await accessGate(user, conv.track === "code" ? "code" : "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    if (conv.track === "premium" && !canPremium(user)) return sendJson(res, 403, { error: "L'atelier Premium est réservé aux apprenants sélectionnés." });
    if (typeof p.message !== "string" || !p.message.trim()) return sendJson(res, 400, { error: "Message vide." });
    // Pause « 1 h de travail » : uniquement pour la création de site (base web).
    if (conv.track !== "code" && conv.track !== "premium" && !conv.codeProject) { const w = workCapGuard(user); if (w) return sendJson(res, w.code, w); }
    if (!(await aiQuotaGuard(user))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    conv.messages.push({ role: "user", content: p.message });
    const out = await produceCurrent(conv, reqBase(req));
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
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    { const g = await accessGate(user, conv.track === "code" ? "code" : "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    if (conv.track === "premium") return sendJson(res, 200, { atEnd: true, reply: null, siteUpdated: false }); // pas d'étapes en Premium
    if (conv.codeProject) return sendJson(res, 200, { atEnd: true, reply: null, siteUpdated: false }); // « coder soi-même » : pas de leçons
    // Filière programmation : « Leçon suivante » avance dans le programme.
    if (conv.track === "code") {
      const lessons = lessonsOf(conv); const cur = Math.min(Math.max(0, conv.lesson || 0), lessons.length - 1);
      if (cur >= lessons.length - 1) return sendJson(res, 200, { lesson: cur, atEnd: true, reply: null, siteUpdated: false });
      conv.lesson = cur + 1;
      logConv(conv, "lesson", "Leçon : " + (lessons[conv.lesson] && lessons[conv.lesson].title ? lessons[conv.lesson].title : ("n°" + (conv.lesson + 1))));
      // Le cours écrit de la nouvelle leçon s'affiche directement (aucun appel à l'IA).
      conv.messages.push({ role: "user", content: `Leçon suivante : « ${lessons[conv.lesson].title} ».`, hidden: true });
      const card = lessonCard(conv);
      conv.messages.push({ role: "assistant", content: card });
      conv.updatedAt = new Date().toISOString();
      await saveConv(conv);
      return sendJson(res, 200, { lesson: conv.lesson, atEnd: conv.lesson >= lessons.length - 1, reply: card, siteUpdated: false });
    }
    const current = conv.step || 0;
    if (current >= LAST_STEP) return sendJson(res, 200, { step: current, atEnd: true, reply: null, siteUpdated: false });
    { const w = workCapGuard(user); if (w) return sendJson(res, w.code, w); }   // pause « 1 h de travail »
    if (!(await aiQuotaGuard(user))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    conv.step = current + 1;
    logConv(conv, "step", "Étape " + (conv.step + 1) + (STEPS[conv.step] && STEPS[conv.step].title ? " — " + STEPS[conv.step].title : ""));
    conv.messages.push({ role: "user", content: STEPS[conv.step].kickoff, hidden: true });
    const out = await produceCurrent(conv, reqBase(req));
    sendJson(res, 200, { step: conv.step, atEnd: conv.step >= LAST_STEP, ...out });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/goto : navigation dans le parcours (revenir en arrière ou revoir une étape).
// Ne reconstruit RIEN et n'appelle PAS l'IA : repositionne simplement l'étape/la leçon.
async function handleGoto(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    if (conv.track === "code" && !conv.codeProject) {
      const lessons = lessonsOf(conv);
      let to = parseInt(p.lesson, 10); if (isNaN(to)) to = (conv.lesson || 0) - 1;
      to = Math.max(0, Math.min(lessons.length - 1, to));
      conv.lesson = to; conv.updatedAt = new Date().toISOString(); await saveConv(conv);
      return sendJson(res, 200, { lesson: conv.lesson, atEnd: conv.lesson >= lessons.length - 1, reply: lessonCard(conv), siteUpdated: false, nav: true });
    }
    let to = parseInt(p.step, 10); if (isNaN(to)) to = (conv.step || 0) - 1;
    to = Math.max(0, Math.min(LAST_STEP, to));
    conv.step = to; conv.updatedAt = new Date().toISOString(); await saveConv(conv);
    const title = (STEPS[to] && STEPS[to].label) || ("Étape " + (to + 1));
    return sendJson(res, 200, { step: conv.step, atEnd: conv.step >= LAST_STEP, reply: "◀ Retour à l'étape " + (to + 1) + " — « " + title + " ». Vous pouvez relire ou ajuster cette étape, puis continuer avec « Étape suivante ».", siteUpdated: false, nav: true });
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/add-module : ajoute un volet (boutique, rendez-vous, espace membre) à un
// projet DÉJÀ commencé, en ENRICHISSANT le site existant sans rien perdre du travail fait.
// Réservé aux projets « web » (sites / applications à volets).
async function handleAddModule(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    { const g = await accessGate(user, "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    if (conv.track === "code" || conv.track === "premium" || conv.codeProject) {
      return sendJson(res, 400, { error: "On ne peut ajouter un volet qu'à un projet de type site ou application." });
    }
    const mod = String(p.module || "").trim();
    if (!MODULES[mod] || mod === "presentation") return sendJson(res, 400, { error: "Volet inconnu." });
    const mods = convModules(conv);
    if (mods.includes(mod)) {
      return sendJson(res, 200, { modules: mods, already: true, siteUpdated: false, reply: "Le volet « " + MODULES[mod].short + " » fait déjà partie de votre projet." });
    }
    // On ajoute le volet et on l'enregistre : il sera pris en compte à chaque construction.
    const newMods = MODULE_ORDER.filter((k) => mods.includes(k) || k === mod);
    conv.modules = newMods;
    logConv(conv, "module", "A ajouté le volet « " + MODULES[mod].short + " »");
    // Site pas encore construit : on confirme simplement l'ajout (rien à enrichir pour l'instant).
    const current = stripKit(await readSite(conv.id));
    if (!current) {
      conv.updatedAt = new Date().toISOString(); await saveConv(conv);
      return sendJson(res, 200, { modules: newMods, siteUpdated: false, reply: "Le volet « " + MODULES[mod].short + " » est ajouté à votre projet. Il sera intégré automatiquement dès que votre site sera construit." });
    }
    { const w = workCapGuard(user); if (w) return sendJson(res, w.code, w); }   // pause « 1 h de travail »
    if (!(await aiQuotaGuard(user))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    // Construction ENRICHIE : on part du site actuel et on y AJOUTE le nouveau volet.
    let system = "Tu es l'assistant de construction de Bâtisseur. Tu pars d'un site existant et tu l'enrichis."
      + "\n\n=== CONTEXTE DU PROJET ===\n" + modulesContext(newMods)
      + SINGLE_INSTRUCTION;
    if (conv.multipage) system += MULTIPAGE_NOTE;
    const focus = modulesBuild(newMods); if (focus) system += focus;
    const emplacement = conv.multipage
      ? "Ajoute une NOUVELLE PAGE dédiée (un bloc data-bat-page) et son entrée dans le menu"
      : "Ajoute une NOUVELLE SECTION dédiée (avec son id) et son entrée dans le menu";
    system += `

=== DEMANDE PRÉCISE ===
La personne vient d'AJOUTER le volet « ${MODULES[mod].label} » à son projet. Intègre ce nouveau volet au site EXISTANT :
- ${emplacement}, en suivant les consignes de ce volet ci-dessus.
- GARDE absolument tout le contenu, le style et les rubriques déjà présents : tu ne supprimes rien et tu ne repars jamais de zéro.
- Conserve une identité visuelle unique et cohérente avec l'existant.
Renvoie la page ENTIÈRE à jour.`;
    system += `

=== ÉTAT ACTUEL DU SITE (index.html) ===
Voici le code EXACT du site tel qu'il est maintenant. Tu PARS de ce code, tu ajoutes le nouveau volet, et tu renvoies le fichier ENTIER à jour.
\`\`\`html
${current}
\`\`\``;
    const baseUrl = reqBase(req);
    conv.messages.push({ role: "user", content: "Ajoute le volet « " + MODULES[mod].label + " » à mon site, en gardant tout ce qui existe déjà.", hidden: true });
    const reply = await callClaude(system, conv.messages, MODEL, BUILD_TOKENS);
    const ex = extractSite(reply);
    let siteUpdated = false; let message = ex.message; let builtHtml = null;
    if (ex.html && htmlLooksComplete(ex.html)) {
      const withKit = injectKit(ex.html, newMods, conv, baseUrl);
      if (await writeSite(conv.id, withKit)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex.html; }
    } else if (ex.html) {
      try {
        const retrySys = system + "\n\nIMPORTANT : ta réponse précédente a été COUPÉE car trop longue. Renvoie MAINTENANT le site ENTIER dans UN SEUL bloc qui se termine bien par </html>, en restant plus COMPACT (CSS concis, pas de répétitions).";
        const retry = await callClaude(retrySys, conv.messages, MODEL, BUILD_TOKENS);
        const ex2 = extractSite(retry);
        if (ex2.html && htmlLooksComplete(ex2.html)) {
          const withKit2 = injectKit(ex2.html, newMods, conv, baseUrl);
          if (await writeSite(conv.id, withKit2)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex2.html; }
          if (ex2.message && ex2.message.trim()) message = ex2.message;
        } else {
          message = "Le volet est ajouté à votre projet, mais le site est devenu un peu trop grand pour tout réécrire d'un coup. Dites « ajoute la section " + MODULES[mod].short + " » dans le chat pour que je termine.";
        }
      } catch (e) {
        message = "Le volet est ajouté à votre projet. Dites « ajoute la section " + MODULES[mod].short + " » dans le chat pour que je l'intègre au site.";
      }
    }
    if (!message || !message.trim()) message = siteUpdated ? ("J'ai ajouté le volet « " + MODULES[mod].short + " » à votre site — regardez l'aperçu.") : "C'est fait.";
    conv.messages.push({ role: "assistant", content: message });
    conv.updatedAt = new Date().toISOString();
    await saveConv(conv);
    const resp = { modules: newMods, siteUpdated, reply: message };
    if (builtHtml != null) resp.hasPages = /data-bat-page\b/i.test(builtHtml);
    return sendJson(res, 200, resp);
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/page-mode : bascule un projet entre « une seule page » et « plusieurs pages »
// (toujours un seul fichier). Si un site existe déjà, il est réorganisé sans rien perdre.
async function handlePageMode(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante. Renseignez ANTHROPIC_API_KEY dans le fichier .env." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    { const g = await accessGate(user, "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    if (conv.track === "code" || conv.track === "premium" || conv.codeProject) {
      return sendJson(res, 400, { error: "Le mode « plusieurs pages » ne concerne que les projets de type site ou application." });
    }
    const want = !!p.multipage;
    const mods = convModules(conv);
    const current = stripKit(await readSite(conv.id));
    // On décide d'après la STRUCTURE RÉELLE du site, pas seulement d'après le drapeau :
    // ainsi la bascule fonctionne même si le site a été construit « à plat » alors que
    // le mode était déjà coché (ex. juste après la base).
    const hasPagesNow = !!current && /data-bat-page\b/i.test(current);
    conv.multipage = want;
    // Pas encore de site : on mémorise simplement le choix.
    if (!current) {
      logConv(conv, "pages", want ? "A choisi plusieurs pages" : "A choisi une seule page");
      conv.updatedAt = new Date().toISOString(); await saveConv(conv);
      return sendJson(res, 200, { multipage: want, hasPages: false, siteUpdated: false, reply: want
        ? "Mode « plusieurs pages » activé. Votre site sera organisé en plusieurs pages dès sa construction."
        : "Mode « une seule page » activé. Votre site sera construit sur une seule page." });
    }
    // Le site est déjà dans l'état demandé : rien à reconstruire.
    if (want === hasPagesNow) {
      conv.updatedAt = new Date().toISOString(); await saveConv(conv);
      return sendJson(res, 200, { multipage: want, hasPages: hasPagesNow, siteUpdated: false, reply: want ? "Votre site est déjà en plusieurs pages." : "Votre site est déjà sur une seule page." });
    }
    logConv(conv, "pages", want ? "Est passé en plusieurs pages" : "Est revenu à une seule page");
    { const w = workCapGuard(user); if (w) return sendJson(res, w.code, w); }   // pause « 1 h de travail »
    if (!(await aiQuotaGuard(user))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    // Réorganisation du site EXISTANT (sans rien perdre).
    let system = "Tu es l'assistant de construction de Bâtisseur. Tu réorganises un site existant sans en perdre le contenu."
      + "\n\n=== CONTEXTE DU PROJET ===\n" + modulesContext(mods)
      + SINGLE_INSTRUCTION;
    if (want) system += MULTIPAGE_NOTE;
    const focus = modulesBuild(mods); if (focus) system += focus;
    system += want ? `

=== DEMANDE PRÉCISE ===
Réorganise le site EXISTANT en PLUSIEURS PAGES (toujours dans un seul fichier index.html), en suivant la structure « plusieurs pages » ci-dessus :
- Répartis les rubriques actuelles sur des pages logiques (ex. Accueil, À propos / Services, Contact, et une page par volet interactif).
- Chaque page devient un bloc data-bat-page avec son entrée de menu ; la page d'accueil reçoit data-bat-home.
- GARDE absolument tout le contenu, les textes, le style et les images réservées : tu ne supprimes rien, tu ne fais que réorganiser.
Renvoie la page ENTIÈRE à jour.` : `

=== DEMANDE PRÉCISE ===
Regroupe tout le contenu du site EXISTANT sur UNE SEULE PAGE :
- Transforme chaque page (bloc data-bat-page) en une SECTION de la même page, avec son id, et un menu à ancres (<a href="#id">).
- Enlève les attributs data-bat-page et data-bat-home : il n'y a plus qu'une seule page.
- GARDE absolument tout le contenu, les textes, le style et les images réservées : tu ne supprimes rien, tu ne fais que regrouper.
Renvoie la page ENTIÈRE à jour.`;
    system += `

=== ÉTAT ACTUEL DU SITE (index.html) ===
Voici le code EXACT du site tel qu'il est maintenant. Tu PARS de ce code, tu appliques la réorganisation, et tu renvoies le fichier ENTIER à jour.
\`\`\`html
${current}
\`\`\``;
    const baseUrl = reqBase(req);
    conv.messages.push({ role: "user", content: want ? "Réorganise mon site en plusieurs pages, en gardant tout le contenu." : "Regroupe mon site sur une seule page, en gardant tout le contenu.", hidden: true });
    const reply = await callClaude(system, conv.messages, MODEL, BUILD_TOKENS);
    const ex = extractSite(reply);
    let siteUpdated = false; let message = ex.message; let builtHtml = null;
    if (ex.html && htmlLooksComplete(ex.html)) {
      const withKit = injectKit(ex.html, mods, conv, baseUrl);
      if (await writeSite(conv.id, withKit)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex.html; }
    } else if (ex.html) {
      try {
        const retrySys = system + "\n\nIMPORTANT : ta réponse précédente a été COUPÉE car trop longue. Renvoie MAINTENANT le site ENTIER dans UN SEUL bloc qui se termine bien par </html>, en restant plus COMPACT (CSS concis, pas de répétitions).";
        const retry = await callClaude(retrySys, conv.messages, MODEL, BUILD_TOKENS);
        const ex2 = extractSite(retry);
        if (ex2.html && htmlLooksComplete(ex2.html)) {
          const withKit2 = injectKit(ex2.html, mods, conv, baseUrl);
          if (await writeSite(conv.id, withKit2)) { siteUpdated = true; conv.hasSite = true; builtHtml = ex2.html; }
          if (ex2.message && ex2.message.trim()) message = ex2.message;
        } else {
          message = "Le mode est changé, mais le site est un peu trop grand pour tout réécrire d'un coup. Dites « réorganise le site » dans le chat pour que je termine.";
        }
      } catch (e) {
        message = "Le mode est changé. Dites « réorganise le site » dans le chat pour que j'applique la nouvelle structure.";
      }
    }
    if (!message || !message.trim()) message = siteUpdated
      ? (want ? "J'ai réorganisé votre site en plusieurs pages — regardez l'aperçu." : "J'ai regroupé votre site sur une seule page — regardez l'aperçu.")
      : "C'est fait.";
    conv.messages.push({ role: "assistant", content: message });
    conv.updatedAt = new Date().toISOString();
    await saveConv(conv);
    const hasPages = builtHtml != null ? /data-bat-page\b/i.test(builtHtml) : hasPagesNow;
    return sendJson(res, 200, { multipage: want, hasPages, siteUpdated, reply: message });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// GET /api/download?id=... : télécharge le site (index.html) en pièce jointe
async function handleDownload(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id);
  if (conv) {
    const cu = await currentUser(req);
    if (!owns(cu, conv)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Ce projet appartient à un autre compte."); }
    if (conv.userId && !canView(cu)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Accès non autorisé pour le moment."); }
  }
  const html = await readSite(id);
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
  const cu = await currentUser(req);
  if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
  if (conv.userId && !canView(cu)) { const m = buildBlockMessage(cu); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(cu) }); }
  const siteHtml = await readSite(conv.id).catch(() => null);
  const payload = { id: conv.id, step: conv.step || 0, modules: convModules(conv), multipage: !!conv.multipage, hasPages: !!siteHtml && /data-bat-page\b/i.test(siteHtml), hasSite: !!siteHtml, publishedUrl: conv.publishedUrl || null, pwa: !!conv.pwa, payment: publicPayment(conv), ownerName: conv.ownerName || null, messages: conv.messages.filter((m) => !m.hidden) };
  if (conv.track === "code") { payload.track = "code"; payload.language = normalizeLanguage(conv.language); payload.lesson = conv.lesson || 0; payload.lessons = conv.codeProject ? [] : lessonTitles(conv); payload.codeProject = !!conv.codeProject; if (conv.codeProject) payload.projectName = conv.projectName || null; }
  if (conv.track === "premium") { payload.track = "premium"; payload.projectName = conv.projectName || null; }
  sendJson(res, 200, payload);
}

// GET /preview/<id>/<fichier> : sert le site généré (une seule page)
async function servePreview(req, res) {
  const parts = decodeURIComponent(req.url.split("?")[0]).split("/").filter(Boolean); // ["preview", id, file?]
  const id = parts[1];
  if (!validId(id)) { res.writeHead(404); return res.end("Introuvable"); }
  // Aperçu privé : un projet rattaché à un compte ne s'affiche qu'à son propriétaire.
  const conv = await loadConv(id);
  if (conv && conv.userId) {
    const cu = await currentUser(req);
    if (!owns(cu, conv) || !canView(cu)) { res.writeHead(403, { "content-type": "text/html; charset=utf-8" }); return res.end("<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui,sans-serif;color:#6B7A90;display:grid;place-items:center;height:88vh;text-align:center;padding:20px\">Cet aperçu est privé.<br>Connectez-vous avec le compte propriétaire.</body>"); }
  }
  let html = null;
  try { html = await readSite(id); } catch (e) { html = null; }
  // Rafraîchit le kit avec l'état ACTUEL du projet (paiement, volets) : ainsi une
  // configuration modifiée après la construction (ex. activation du paiement) est
  // reflétée immédiatement, sans reconstruire le site.
  if (html && conv) { try { html = (conv.track === "premium") ? injectAppKit(html, conv, reqBase(req)) : injectKit(html, convModules(conv), conv, reqBase(req)); } catch (e) {} }
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

// --- PAIEMENT EN LIGNE (Wave) -------------------------------------------------
// Deux modes, au choix du propriétaire du projet (jamais de secret dans le chat) :
//  - "link" : le propriétaire colle SON lien de paiement Wave ; le site affiche un
//    bouton « Payer avec Wave » qui ouvre ce lien. Aucune clé, aucune intégration.
//  - "api"  : la plateforme crée une session Wave Checkout (clé WAVE_API_KEY côté
//    serveur) et redirige le client vers l'app Wave. Confirmation possible par webhook.
function publicPayment(conv) {
  const pc = (conv && conv.payment) || {};
  const mode = (pc.mode === "link" || pc.mode === "api") ? pc.mode : "none";
  return { mode, link: mode === "link" ? (pc.link || "") : "", currency: pc.currency || "XOF", apiAvailable: !!WAVE_API_KEY };
}
function validPayLink(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https:\/\//i.test(u)) return null;         // HTTPS obligatoire
  if (u.length > 400) return null;
  // On accepte tout lien HTTPS ; on recommande un lien Wave, sans l'imposer.
  return u;
}

// GET /api/payment?id=<projet> — le propriétaire lit la configuration de paiement
async function handleGetPayment(req, res) {
  const u = new URL(req.url, "http://localhost");
  const conv = await loadConv(u.searchParams.get("id"));
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  sendJson(res, 200, { payment: publicPayment(conv), waveApi: !!WAVE_API_KEY });
}

// POST /api/payment/config { id, mode, link, currency } — le propriétaire configure
async function handleSetPayment(req, res) {
  const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const conv = await loadConv(p.id);
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
  if (!canBuild(cu)) { const m = buildBlockMessage(cu); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(cu) }); }
  const mode = (p.mode === "link" || p.mode === "api") ? p.mode : "none";
  const payment = { mode: mode, currency: (String(p.currency || "XOF").replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase() || "XOF") };
  if (mode === "link") {
    const link = validPayLink(p.link);
    if (link === null) return sendJson(res, 400, { error: "Le lien doit commencer par https://" });
    if (!link) return sendJson(res, 400, { error: "Indiquez votre lien de paiement Wave." });
    payment.link = link;
  }
  if (mode === "api" && !WAVE_API_KEY) return sendJson(res, 400, { error: "Le paiement par API n'est pas activé sur cette plateforme." });
  conv.payment = payment;
  await saveConv(conv);
  sendJson(res, 200, { payment: publicPayment(conv) });
}

// POST /api/app/pay { app, amount, currency, reference } — public : crée une session Wave (mode API)
async function handlePay(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app;
    if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?";
    if (!rateOk("pay:" + app + ":" + ip, 15, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop de tentatives. Réessayez dans quelques minutes." });
    const conv = await loadConv(app);
    if (!conv) return sendJsonCors(res, 404, { error: "Application introuvable." });
    const pc = conv.payment || {};
    if (pc.mode !== "api") return sendJsonCors(res, 400, { error: "Le paiement par API n'est pas activé pour ce site." });
    if (!WAVE_API_KEY) return sendJsonCors(res, 501, { error: "Paiement non configuré sur la plateforme." });
    const currency = (pc.currency || "XOF").toUpperCase();
    let amount = Number(p.amount);
    if (!isFinite(amount) || amount <= 0) return sendJsonCors(res, 400, { error: "Montant invalide." });
    // XOF : pas de décimales.
    amount = currency === "XOF" ? String(Math.round(amount)) : String(Math.round(amount * 100) / 100);
    // La référence encode l'identifiant complet du projet, pour le rattachement par webhook.
    // Le kit peut fournir la sienne (déjà enregistrée avec la commande) ; sinon on en crée une.
    let ref = String(p.reference || "");
    if (!(ref.indexOf("bat." + app + ".") === 0 && ref.length <= 120 && /^[a-zA-Z0-9._-]+$/.test(ref))) {
      ref = "bat." + app + "." + crypto.randomBytes(4).toString("hex");
    }
    const base = conv.publishedUrl || (reqBase(req));
    const okUrl = base + (base.indexOf("?") >= 0 ? "&" : "?") + "paiement=ok";
    const koUrl = base + (base.indexOf("?") >= 0 ? "&" : "?") + "paiement=echec";
    let session;
    try {
      const r = await fetch(WAVE_API_BASE + "/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + WAVE_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ amount: amount, currency: currency, success_url: okUrl, error_url: koUrl, client_reference: ref })
      });
      const t = await r.text(); try { session = t ? JSON.parse(t) : {}; } catch (e) { session = {}; }
      if (!r.ok) return sendJsonCors(res, 502, { error: "Le service de paiement a refusé la demande." });
    } catch (e) { return sendJsonCors(res, 502, { error: "Service de paiement injoignable." }); }
    const url = session && (session.wave_launch_url || session.launch_url);
    if (!url) return sendJsonCors(res, 502, { error: "Réponse de paiement invalide." });
    sendJsonCors(res, 200, { url: url, reference: ref, sessionId: session.id || null });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/wave/webhook — Wave notifie le paiement ; on marque la commande payée.
async function handleWaveWebhook(req, res) {
  const raw = await readBody(req);
  if (!WAVE_WEBHOOK_SECRET) { res.writeHead(501); return res.end("webhook désactivé"); }
  // Vérification de signature HMAC (en-tête « Wave-Signature »).
  const sig = String(req.headers["wave-signature"] || req.headers["x-wave-signature"] || "");
  let okSig = false;
  try {
    const expected = crypto.createHmac("sha256", WAVE_WEBHOOK_SECRET).update(raw).digest("hex");
    const a = Buffer.from(expected); const b = Buffer.from(sig.replace(/^sha256=/, ""));
    okSig = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { okSig = false; }
  if (!okSig) { res.writeHead(401); return res.end("signature invalide"); }
  let evt = {}; try { evt = JSON.parse(raw || "{}"); } catch (e) {}
  const type = evt && evt.type;
  const data = (evt && evt.data) || {};
  const ref = data.client_reference || "";
  const status = String((data.payment_status || data.status || type || "")).toLowerCase();
  if (/complete|success|succeed|paid/.test(status) && /^bat\./.test(ref)) {
    // ref = « bat.<idProjet>.<hasard> » → on retrouve le projet et la commande, puis on marque payé.
    try {
      const projId = ref.split(".")[1];
      if (projId) {
        const subs = await listSubmissions(projId);
        const target = subs.find((s) => s.data && s.data._ref === ref);
        if (target) { const nd = Object.assign({}, target.data, { _paye: true }); await sbUpdateSubmissionData(target.id, projId, nd); }
      }
    } catch (e) {}
  }
  res.writeHead(200); res.end("ok");
}
async function sbUpdateSubmissionData(id, projectId, data) {
  if (USE_DB) { try { await sb(`/submissions?id=eq.${encodeURIComponent(id)}&project_id=eq.${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ data }) }); } catch (e) {} return; }
  const a = loadSubs(); a.forEach((s) => { if (s.id === id && s.projectId === projectId) s.data = data; }); saveSubs(a);
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
async function publishSite(conv, baseUrl) {
  if (!NETLIFY_TOKEN) { const e = new Error("La publication n'est pas encore configurée sur cette plateforme."); e.status = 501; throw e; }
  let html = await readSite(conv.id);
  if (!html) { const e = new Error("Aucun site à publier : construisez d'abord votre site."); e.status = 400; throw e; }
  // Rafraîchit le kit avec l'état ACTUEL (paiement, volets) au moment de la publication,
  // avec l'origine de la PLATEFORME (là où vivent /api/app) — pas l'adresse du site publié.
  if (baseUrl && conv) { try { html = (conv.track === "premium") ? injectAppKit(html, conv, baseUrl) : injectKit(html, convModules(conv), conv, baseUrl); } catch (e) {} }

  // Jeu de fichiers à déployer. Site simple = index.html seul. Application
  // installable (PWA) = index.html enrichi + manifeste + service worker + icônes.
  let fileset;
  if (conv.pwa) {
    fileset = pwa.buildPwaFiles(html, { name: convTitle(conv), version: crypto.createHash("sha1").update(html).digest("hex").slice(0, 12) });
  } else {
    fileset = { "index.html": Buffer.from(html, "utf8") };
  }
  const files = {};   // "/chemin" -> sha1 (annoncé à l'hébergeur)
  const bySha = {};   // sha1 -> { name, buf } (pour le téléversement)
  for (const name of Object.keys(fileset)) {
    const fbuf = fileset[name];
    const fsha = crypto.createHash("sha1").update(fbuf).digest("hex");
    files["/" + name] = fsha;
    bySha[fsha] = { name: name, buf: fbuf };
  }

  // 1) Créer le site chez l'hébergeur (une seule fois par conversation).
  if (!conv.netlifySiteId) {
    const site = await netlify("/sites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    conv.netlifySiteId = site.id;
    conv.publishedUrl = site.ssl_url || site.url;
    await saveConv(conv);
  }

  // 2) Créer un déploiement en annonçant les fichiers par leur empreinte (sha1).
  const deploy = await netlify(`/sites/${conv.netlifySiteId}/deploys`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: files })
  });

  // 3) Téléverser chaque fichier que l'hébergeur ne possède pas déjà.
  for (const need of (deploy.required || [])) {
    const f = bySha[need];
    if (!f) continue;
    await netlify(`/deploys/${deploy.id}/files/${f.name}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: f.buf
    });
  }

  // 4) Attendre que le déploiement soit prêt (quelques secondes).
  let state = deploy.state, url = conv.publishedUrl;
  for (let i = 0; i < 8 && state !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try { const d = await netlify(`/deploys/${deploy.id}`); state = d.state; if (d.ssl_url) url = d.ssl_url; } catch (e) { break; }
  }
  const wasPublished = !!conv.publishedUrl;
  if (url) conv.publishedUrl = conv.publishedUrl || url;
  if (conv.publishedUrl && !wasPublished) logConv(conv, "publish", "A publié son site en ligne");
  await saveConv(conv);
  return { url: conv.publishedUrl, state };
}

// POST /api/publish
async function handlePublish(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
    const conv = await loadConv(p.id);
    if (!conv) return sendJson(res, 404, { error: "Conversation introuvable." });
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    { const g = await accessGate(user, conv.track === "code" ? "code" : "project"); if (g) return sendJson(res, g.code, { error: g.error, accessStatus: g.accessStatus, locked: g.locked }); }
    if (typeof p.pwa === "boolean") { conv.pwa = p.pwa; await saveConv(conv); }
    const out = await publishSite(conv, reqBase(req));
    out.pwa = !!conv.pwa;
    sendJson(res, 200, out);
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Publication impossible." }); }
}

// GET /api/config : ce que le client a besoin de savoir (ex. si la publication est dispo).
function handleConfig(req, res) { sendJson(res, 200, { canPublish: !!NETLIFY_TOKEN, accounts: true, waveApi: !!WAVE_API_KEY }); }

// --- COMPTES (Palier 4) : inscription, connexion, session ---
// POST /api/auth/register  { email, name, password }
async function handleRegister(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const email = normEmail(p.email);
    if (!validEmail(email)) return sendJson(res, 400, { error: "Adresse e-mail invalide." });
    if (typeof p.password !== "string" || p.password.length < 6) return sendJson(res, 400, { error: "Le mot de passe doit contenir au moins 6 caractères." });
    if (await findUserByEmail(email)) return sendJson(res, 409, { error: "Un compte existe déjà avec cette adresse. Connectez-vous." });
    // Auto-inscription : le compte est « en attente » de validation par le formateur.
    // Sauf l'admin lui-même, qui est actif d'emblée pour pouvoir gérer la plateforme.
    const status = ADMIN_EMAILS.includes(email) ? "active" : "pending";
    // Choix d'une session (réservation d'une place) : contrôle d'ouverture + capacité.
    let cohort = null, cohortId = null;
    if (p.cohortId) {
      const c = await getCohort(p.cohortId);
      if (!c || c.closed) return sendJson(res, 400, { error: "Cette session n'est plus disponible. Choisissez-en une autre." });
      const counts = await cohortCounts();
      if ((counts[c.id] || 0) >= (c.capacity || 0)) return sendJson(res, 409, { error: "Cette session est complète. Choisissez-en une autre." });
      cohort = c.label; cohortId = c.id;
    }
    const user = await createUser({ email, name: p.name, password: p.password, status, cohort, cohortId });
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    sendJson(res, 200, { user: publicUser(user) });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/auth/login  { email, password }
async function handleLogin(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const user = await findUserByEmail(p.email);
    if (!user || !verifyPassword(p.password, user.pass)) return sendJson(res, 401, { error: "E-mail ou mot de passe incorrect." });
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    sendJson(res, 200, { user: publicUser(user) });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/auth/logout
async function handleLogout(req, res) {
  try { await deleteSession(parseCookies(req)[SESSION_COOKIE]); } catch (e) {}
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

// GET /api/auth/me
async function handleMe(req, res) {
  const u = await currentUser(req);
  const pub = publicUser(u);
  if (pub && !pub.isAdmin) {
    pub.paid = !!(u && u.paid === true);
    pub.sessionLaunched = await sessionLaunchedFor(u);
    try { const mine = await listConvsForUser(u.id); pub.webDone = mine.some((s) => !s.track && s.publishedUrl); } catch (e) {}
    if (u && u.cohort_id) { try { const c = await getCohort(u.cohort_id); pub.sessionStart = c ? (c.startDate || null) : null; pub.sessionLabel = c ? (c.label || null) : null; if (pub.paid) { const cfg = formationConfig(await getSettings()); pub.community = cohortCommunityLink(c, cfg); } } catch (e) {} }
  }
  sendJson(res, 200, { user: pub });
}

// ---- Réinitialisation du mot de passe (lien envoyé par e-mail) ----
const RESET_TTL_MS = 60 * 60 * 1000; // 1 heure
async function createReset(userId) {
  const token = crypto.randomBytes(24).toString("hex"); const created_at = new Date().toISOString();
  if (USE_DB) { try { await sb(`/password_resets`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ token, user_id: userId, created_at }]) }); } catch (e) { console.error("createReset:", e.message); } }
  else { const a = loadAccounts(); a.resets = a.resets || {}; a.resets[token] = { userId, at: Date.now() }; saveAccounts(a); }
  return token;
}
async function consumeReset(token) {
  if (!token) return null;
  if (USE_DB) {
    try {
      const r = await sb(`/password_resets?token=eq.${encodeURIComponent(token)}&select=user_id,created_at`);
      const x = r && r[0]; if (!x) return null;
      const ok = Date.now() - new Date(x.created_at).getTime() < RESET_TTL_MS;
      await sb(`/password_resets?token=eq.${encodeURIComponent(token)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
      return ok ? x.user_id : null;
    } catch (e) { return null; }
  }
  const a = loadAccounts(); a.resets = a.resets || {}; const x = a.resets[token]; if (!x) return null; delete a.resets[token]; saveAccounts(a);
  return (Date.now() - (x.at || 0) < RESET_TTL_MS) ? x.userId : null;
}
// POST /api/auth/forgot { email } : envoie un lien de réinitialisation (réponse générique, ne révèle rien).
async function handleForgot(req, res) {
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const email = normEmail(p.email);
  const generic = { ok: true, message: "Si un compte existe avec cet e-mail, un lien de réinitialisation vient d'être envoyé. Vérifiez votre boîte (et les spams)." };
  if (!validEmail(email)) return sendJson(res, 200, generic);
  if (!rateOk("forgot:" + email, 5, 60 * 60 * 1000)) return sendJson(res, 200, generic);
  const user = await findUserByEmail(email);
  if (user) {
    try {
      const token = await createReset(user.id);
      const link = `${reqBase(req)}/reset?token=${token}`;
      const subject = "Réinitialisation de votre mot de passe — Bâtisseur";
      const text = "Bonjour,\n\nVous avez demandé à réinitialiser votre mot de passe Bâtisseur.\nCliquez sur ce lien (valable 1 heure) pour choisir un nouveau mot de passe :\n\n" + link + "\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.\n\nL'équipe Bâtisseur";
      const sent = await sendReminderEmail(email, subject, text);
      if (!sent) console.warn("forgot: e-mail non configuré (BREVO_API_KEY / MAIL_FROM) — lien:", link);
    } catch (e) { console.error("forgot:", e.message); }
  }
  sendJson(res, 200, generic);
}
// POST /api/auth/reset { token, password } : applique le nouveau mot de passe.
async function handleReset(req, res) {
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  if (typeof p.password !== "string" || p.password.length < 6) return sendJson(res, 400, { error: "Le mot de passe doit contenir au moins 6 caractères." });
  const userId = await consumeReset(String(p.token || ""));
  if (!userId) return sendJson(res, 400, { error: "Lien invalide ou expiré. Refaites une demande de réinitialisation." });
  try { await updateUser(userId, { pass: hashPassword(p.password) }); } catch (e) { return sendJson(res, 500, { error: "Impossible de mettre à jour le mot de passe." }); }
  sendJson(res, 200, { ok: true });
}

// GET /api/projects : les projets du compte connecté (pour « Mon espace »)
async function handleProjects(req, res) {
  const u = await currentUser(req);
  if (!u) return sendJson(res, 401, { error: "Non connecté." });
  sendJson(res, 200, { projects: await listConvsForUser(u.id) });
}

// --- ESPACE FORMATEUR (admin) : gestion des apprenants & des sessions ---
async function adminListUsers() {
  if (USE_DB) { try { return (await sb(`/users?select=id,email,name,status,cohort,cohort_id,premium,paid,created_at&order=created_at.desc`)) || []; } catch (e) { console.error("adminListUsers:", e.message); return []; } }
  const a = loadAccounts(); return Object.values(a.users).sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
}
async function allConvs() {
  if (USE_DB) { try { return ((await sb(`/conversations?select=data`)) || []).map((x) => x.data).filter(Boolean); } catch (e) { return []; } }
  const out = [];
  try { fs.readdirSync(DATA_DIR).forEach((f) => { if (!f.endsWith(".json") || f === "accounts.json") return; try { out.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"))); } catch (e) {} }); } catch (e) {}
  return out;
}

// GET /api/admin/learners
// GET /api/admin/ai-stats — activité IA du jour (réservé formateur)
async function handleAiStats(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  const users = Object.values(AI_STATS.byUser).sort((a, b) => b.count - a.count).slice(0, 12);
  sendJson(res, 200, { day: AI_STATS.day || todayKey(), total: AI_STATS.total, users });
}

// GET /api/admin/export — télécharge une sauvegarde JSON des données clés (réservé formateur)
async function handleAdminExport(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Réservé à l'administrateur."); }
  const bundle = { exportedAt: new Date().toISOString(), note: "Sauvegarde Bâtisseur — données clés (les mots de passe ne sont pas inclus)." };
  try {
    const usersRaw = await adminListUsers();
    bundle.users = (usersRaw || []).map((x) => { const y = Object.assign({}, x); delete y.pass; return y; });
  } catch (e) { bundle.users = []; }
  try { bundle.reservations = USE_DB ? ((await sb(`/reservations?select=*`).catch(() => [])) || []) : []; } catch (e) { bundle.reservations = []; }
  try { bundle.cohorts = USE_DB ? ((await sb(`/cohorts?select=*`).catch(() => [])) || []).map((x) => x.data || x) : []; } catch (e) { bundle.cohorts = []; }
  try { bundle.settings = await getSettings(); } catch (e) { bundle.settings = {}; }
  try {
    const convs = await allConvs();
    bundle.projects = (convs || []).map((c) => ({ id: c.id, userId: c.userId || null, ownerName: c.ownerName || null, track: c.track || "web", projectName: c.projectName || null, codeProject: !!c.codeProject, publishedUrl: c.publishedUrl || null, createdAt: c.createdAt || null, updatedAt: c.updatedAt || null }));
  } catch (e) { bundle.projects = []; }
  bundle.counts = { users: (bundle.users || []).length, reservations: (bundle.reservations || []).length, cohorts: (bundle.cohorts || []).length, projects: (bundle.projects || []).length };
  const json = JSON.stringify(bundle, null, 2);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="batisseur-sauvegarde-' + todayKey() + '.json"' });
  res.end(json);
}

// POST /api/admin/premium-note { userId, projet, attitude } — note manuelle du formateur (classement Premium)
async function handlePremiumNote(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const uid = String(p.userId || ""); if (!uid) return sendJson(res, 400, { error: "Apprenant manquant." });
  const cohortId = String(p.cohortId || ""); if (!cohortId) return sendJson(res, 400, { error: "Session manquante." });
  const st = await getSettings();
  // Notes RANGÉES PAR SESSION : premiumNotes[cohortId][uid]. Une nouvelle session repart donc à zéro.
  const notes = Object.assign({}, st.premiumNotes || {});
  const cn = Object.assign({}, (notes[cohortId] && typeof notes[cohortId] === "object") ? notes[cohortId] : {});
  const cur = Object.assign({}, cn[uid] || {});
  if (p.projet === null) delete cur.projet; else if (p.projet != null) { let v = parseFloat(p.projet); if (isNaN(v)) v = 0; cur.projet = Math.max(0, Math.min(30, v)); }
  if (p.attitude === null) delete cur.attitude; else if (p.attitude != null) { let v = parseFloat(p.attitude); if (isNaN(v)) v = 0; cur.attitude = Math.max(0, Math.min(10, v)); }
  cn[uid] = cur; notes[cohortId] = cn;
  await setSettings({ premiumNotes: notes });
  sendJson(res, 200, { ok: true, userId: uid, projet: (typeof cur.projet === "number") ? cur.projet : null, attitude: (typeof cur.attitude === "number") ? cur.attitude : null });
}

// ---- Classement Premium PAR SESSION ----
// Chaque session (cohorte) a son propre classement : assiduité, projets, progression,
// présences et notes du formateur sont calculés sur la FENÊTRE de la session
// (du lancement à la fin). Une nouvelle session repart donc à zéro.
const SESSION_WINDOW_DAYS = parseInt(process.env.SESSION_WINDOW_DAYS, 10) || 16; // couvre ~2 semaines / 3 samedis
async function currentSessionCohort() {
  const list = await listCohorts();
  const launched = list.filter((c) => c && c.launched && c.launchedAt);
  if (launched.length) { launched.sort((a, b) => String(b.launchedAt).localeCompare(String(a.launchedAt))); return launched[0]; }
  const sorted = list.filter(Boolean).sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
  return sorted[0] || null;
}
function sessionWindow(cohort) {
  // Le classement ne démarre qu'au LANCEMENT de la session (bouton « Lancer »).
  // Tant que launchedAt est absent, il n'y a pas de fenêtre : rien ne compte.
  if (!cohort || !cohort.launchedAt) return null;
  const start = String(cohort.launchedAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const s = new Date(start + "T00:00:00Z");
  const end = new Date(s.getTime() + SESSION_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end, startTs: String(cohort.launchedAt) };
}
function daysBetween(start, end) {
  const out = []; let d = new Date(start + "T00:00:00Z"); const e = new Date(end + "T00:00:00Z");
  while (d <= e) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}
async function attCountsForDates(dates) {
  const out = {}; const set = Array.from(new Set(dates || []));
  for (const d of set) { try { const rows = await attRowsForDate(d); rows.forEach((r) => { if (r.present) out[r.user_id] = (out[r.user_id] || 0) + 1; }); } catch (e) {} }
  return out;
}
async function handlePremiumBoard(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  const qs = new URLSearchParams((req.url.split("?")[1] || ""));
  const list = await listCohorts();
  let cohort = qs.get("cohortId") ? await getCohort(qs.get("cohortId")) : await currentSessionCohort();
  const sessions = list.filter(Boolean).map((c) => ({ id: c.id, label: c.label, startDate: c.startDate, launched: !!c.launched }))
    .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
  if (!cohort) return sendJson(res, 200, { cohortId: null, cohortLabel: null, sessions, learners: [], launched: false });
  const win = sessionWindow(cohort);
  const launched = !!win;
  const users = (await adminListUsers()).filter((x) => !ADMIN_EMAILS.includes(normEmail(x.email)) && x.cohort_id === cohort.id);
  const st = await getSettings();
  const notesAll = (st.premiumNotes && typeof st.premiumNotes === "object") ? st.premiumNotes : {};
  const cohortNotes = (notesAll[cohort.id] && typeof notesAll[cohort.id] === "object") ? notesAll[cohort.id] : {};
  // Session PAS ENCORE LANCÉE : aucun score ne compte, tout est à zéro (le classement démarre au lancement).
  if (!launched) {
    const learners0 = users.map((x) => { const n = cohortNotes[x.id] || {}; return { id: x.id, name: x.name, email: x.email, premium: x.premium === true, paid: x.paid === true, projects: 0, published: 0, activitySeconds: 0, progressFrac: 0, sessionsPresent: 0, sessionsTotal: 0, noteProjet: (typeof n.projet === "number") ? n.projet : null, noteAttitude: (typeof n.attitude === "number") ? n.attitude : null }; });
    return sendJson(res, 200, { cohortId: cohort.id, cohortLabel: cohort.label, window: null, launched: false, sessions, learners: learners0 });
  }
  const windowDays = daysBetween(win.start, win.end);
  // Projets/progression : on ne compte que l'activité À PARTIR du lancement (updatedAt ≥ lancement).
  const convs = (await allConvs()).filter((c) => c && c.userId && String(c.updatedAt || c.createdAt || "") >= win.startTs);
  const byUser = {}, listByUser = {};
  convs.forEach((c) => { const b = byUser[c.userId] || (byUser[c.userId] = { projects: 0, published: 0 }); b.projects++; if (c.publishedUrl) b.published++; (listByUser[c.userId] || (listByUser[c.userId] = [])).push(c); });
  let actMap = {}; try { actMap = await activityForUsers(users.map((x) => x.id), windowDays); } catch (e) {}
  const allDates = Array.isArray(st.attendanceDates) ? st.attendanceDates : [];
  const sessionDates = allDates.filter((d) => d >= win.start && d <= win.end);
  let attCounts = {}; try { attCounts = await attCountsForDates(sessionDates); } catch (e) {}
  const learners = users.map((x) => {
    const act = actMap[x.id] || {}; let secs = 0; Object.keys(act).forEach((d) => { secs += act[d] || 0; });
    let frac = 0; try { frac = progressSummary(listByUser[x.id] || []).frac || 0; } catch (e) {}
    const n = cohortNotes[x.id] || {};
    return { id: x.id, name: x.name, email: x.email, premium: x.premium === true, paid: x.paid === true,
      projects: byUser[x.id] ? byUser[x.id].projects : 0, published: byUser[x.id] ? byUser[x.id].published : 0,
      activitySeconds: secs, progressFrac: frac, sessionsPresent: attCounts[x.id] || 0, sessionsTotal: sessionDates.length,
      noteProjet: (typeof n.projet === "number") ? n.projet : null, noteAttitude: (typeof n.attitude === "number") ? n.attitude : null };
  });
  sendJson(res, 200, { cohortId: cohort.id, cohortLabel: cohort.label, window: win, launched: true, sessions, learners });
}

async function handleAdminLearners(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  const users = await adminListUsers();
  const convs = await allConvs();
  const byUser = {}; const listByUser = {};
  convs.forEach((c) => { if (!c || !c.userId) return; const b = byUser[c.userId] || (byUser[c.userId] = { projects: 0, published: 0 }); b.projects++; if (c.publishedUrl) b.published++; (listByUser[c.userId] || (listByUser[c.userId] = [])).push(c); });
  const learnerUsers = users.filter((x) => !ADMIN_EMAILS.includes(normEmail(x.email)));
  // Pour le classement Premium : assiduité (28 derniers jours) + progression + notes du formateur.
  let actMap = {}; try { actMap = await activityForUsers(learnerUsers.map((x) => x.id), lastNDays(28)); } catch (e) {}
  let pnotes = {}, sessionsTotal = 0, attCounts = {};
  try { const st = await getSettings(); pnotes = (st && st.premiumNotes) || {}; sessionsTotal = Array.isArray(st && st.attendanceDates) ? st.attendanceDates.length : 0; } catch (e) {}
  try { attCounts = await attCountsByUser(); } catch (e) {}
  const learners = learnerUsers.map((x) => {
    const act = actMap[x.id] || {}; let secs = 0; Object.keys(act).forEach((d) => { secs += act[d] || 0; });
    let frac = 0; try { frac = progressSummary(listByUser[x.id] || []).frac || 0; } catch (e) {}
    const n = pnotes[x.id] || {};
    return { id: x.id, email: x.email, name: x.name, cohort: x.cohort || null, cohortId: x.cohort_id || null, status: (x.status || "active"), premium: x.premium === true, paid: x.paid === true, createdAt: x.created_at || null,
      projects: byUser[x.id] ? byUser[x.id].projects : 0, published: byUser[x.id] ? byUser[x.id].published : 0,
      activitySeconds: secs, progressFrac: frac,
      sessionsPresent: attCounts[x.id] || 0, sessionsTotal: sessionsTotal,
      noteProjet: (typeof n.projet === "number") ? n.projet : null, noteAttitude: (typeof n.attitude === "number") ? n.attitude : null };
  });
  const stats = {
    total: learners.length,
    active: learners.filter((l) => l.status === "active").length,
    pending: learners.filter((l) => l.status === "pending").length,
    finished: learners.filter((l) => l.status === "finished").length,
    paid: learners.filter((l) => l.paid).length
  };
  const cohorts = {};
  learners.forEach((l) => { const k = l.cohort || "—"; cohorts[k] = (cohorts[k] || 0) + 1; });
  sendJson(res, 200, { learners, stats, cohorts });
}

// POST /api/admin/learner/create  { name, email, cohort, password }
async function handleAdminCreate(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const email = normEmail(p.email);
  if (!validEmail(email)) return sendJson(res, 400, { error: "Adresse e-mail invalide." });
  if (typeof p.password !== "string" || p.password.length < 6) return sendJson(res, 400, { error: "Mot de passe : 6 caractères minimum." });
  if (await findUserByEmail(email)) return sendJson(res, 409, { error: "Un compte existe déjà avec cette adresse." });
  let cohort = p.cohort || null, cohortId = null;
  if (p.cohortId) { const c = await getCohort(p.cohortId); if (c) { cohortId = c.id; cohort = c.label; } }
  // Inscription manuelle : compte « en attente » et non payé par défaut ; le formateur coche « Payé » ensuite.
  const user = await createUser({ email, name: p.name, password: p.password, status: "pending", cohort, cohortId });
  sendJson(res, 200, { user: publicUser(user) });
}

// POST /api/admin/learner/update  { userId, status?, cohort? }
async function handleAdminUpdate(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  if (!p.userId) return sendJson(res, 400, { error: "Apprenant manquant." });
  const target = await getUserById(p.userId);
  if (!target) return sendJson(res, 404, { error: "Apprenant introuvable." });
  if (ADMIN_EMAILS.includes(normEmail(target.email))) return sendJson(res, 400, { error: "Le compte administrateur ne se gère pas ici." });
  const fields = {};
  if (typeof p.status === "string" && ["pending", "active", "finished"].includes(p.status)) fields.status = p.status;
  if (p.cohortId !== undefined) {
    if (p.cohortId) { const c = await getCohort(p.cohortId); if (c) { fields.cohort_id = c.id; fields.cohort = c.label; } }
    else { fields.cohort_id = null; fields.cohort = null; }
  } else if (p.cohort !== undefined) { fields.cohort = String(p.cohort || "").trim().slice(0, 120) || null; }
  if (typeof p.premium === "boolean") fields.premium = p.premium;   // promotion « Premium learner »
  if (typeof p.paid === "boolean") fields.paid = p.paid;            // marqueur « a payé » (coché par le formateur)
  if (!Object.keys(fields).length) return sendJson(res, 400, { error: "Rien à modifier." });
  const updated = await updateUser(p.userId, fields);
  sendJson(res, 200, { user: publicUser(updated) });
}

// POST /api/admin/learner/delete  { userId } : supprime définitivement un compte apprenant
async function handleAdminDelete(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  if (!p.userId) return sendJson(res, 400, { error: "Apprenant manquant." });
  const target = await getUserById(p.userId);
  if (!target) return sendJson(res, 404, { error: "Apprenant introuvable." });
  if (ADMIN_EMAILS.includes(normEmail(target.email))) return sendJson(res, 400, { error: "Le compte administrateur ne peut pas être supprimé." });
  const okDel = await deleteUser(p.userId);
  if (!okDel) return sendJson(res, 500, { error: "Suppression impossible." });
  sendJson(res, 200, { ok: true });
}

// --- SESSIONS DE FORMATION (cohorts) : dates + capacité + places ---
const COHORTS_FILE = path.join(DATA_DIR, "cohorts.json");
function loadCohortsStore() { try { return JSON.parse(fs.readFileSync(COHORTS_FILE, "utf8")); } catch (e) { return {}; } }
function saveCohortsStore(o) { try { fs.writeFileSync(COHORTS_FILE, JSON.stringify(o, null, 2)); } catch (e) { console.error("saveCohorts:", e); } }
async function getCohort(id) {
  if (!id) return null;
  if (USE_DB) { try { const r = await sb(`/cohorts?id=eq.${encodeURIComponent(id)}&select=data`); return (r && r[0]) ? r[0].data : null; } catch (e) { return null; } }
  return loadCohortsStore()[id] || null;
}
async function listCohorts() {
  let arr = [];
  if (USE_DB) { try { arr = ((await sb(`/cohorts?select=data`)) || []).map((x) => x.data).filter(Boolean); } catch (e) { arr = []; } }
  else arr = Object.values(loadCohortsStore());
  arr.sort((a, b) => String(a.startDate || "").localeCompare(String(b.startDate || "")));
  return arr;
}
async function saveCohort(rec) {
  if (USE_DB) { try { await sb(`/cohorts?on_conflict=id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: rec.id, data: rec, created_at: new Date().toISOString() }]) }); } catch (e) { console.error("saveCohort:", e.message); } return; }
  const o = loadCohortsStore(); o[rec.id] = rec; saveCohortsStore(o);
}
async function updateCohortRec(id, fields) { const c = await getCohort(id); if (!c) return null; Object.assign(c, fields); await saveCohort(c); return c; }
async function cohortCounts() {
  const users = await adminListUsers();
  const m = {};
  users.forEach((u) => { const cid = u.cohort_id, st = u.status || "active"; if (cid && (st === "pending" || st === "active")) m[cid] = (m[cid] || 0) + 1; });
  return m;
}

// GET /api/cohorts : sessions OUVERTES avec places restantes (public, pour l'inscription)
async function handleCohorts(req, res) {
  const list = await listCohorts(); const counts = await cohortCounts();
  const open = list.filter((c) => !c.closed).map((c) => {
    const enrolled = counts[c.id] || 0; const remaining = Math.max(0, (c.capacity || 0) - enrolled);
    return { id: c.id, label: c.label, startDate: c.startDate, capacity: c.capacity, remaining: remaining, full: remaining <= 0 };
  });
  sendJson(res, 200, { cohorts: open });
}

// GET /api/admin/cohorts : toutes les sessions + inscrits (admin)
async function handleAdminCohorts(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  const list = await listCohorts(); const counts = await cohortCounts(); const pend = await cohortPendingCounts();
  sendJson(res, 200, { cohorts: list.map((c) => ({ id: c.id, label: c.label, startDate: c.startDate, capacity: c.capacity, closed: !!c.closed, enrolled: counts[c.id] || 0, launched: !!c.launched, pending: pend[c.id] || 0, whatsappLink: c.whatsappLink || "" })) });
}
// Nombre d'apprenants « en attente » (pending) par session — pour le bouton « Lancer ».
async function cohortPendingCounts() {
  const users = await adminListUsers(); const m = {};
  users.forEach((u) => { const cid = u.cohort_id; if (cid && (u.status || "active") === "pending") m[cid] = (m[cid] || 0) + 1; });
  return m;
}
// Nombre d'apprenants « actifs » (place confirmée) par session — ceux qui pourront construire au lancement.
async function cohortActiveCounts() {
  const users = await adminListUsers(); const m = {};
  users.forEach((u) => { const cid = u.cohort_id; if (cid && (u.status || "active") === "active") m[cid] = (m[cid] || 0) + 1; });
  return m;
}

// POST /api/admin/cohort/generate  { startDate, intervalDays, count, capacity }
async function handleAdminCohortGenerate(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const start = String(p.startDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return sendJson(res, 400, { error: "Date de début invalide (AAAA-MM-JJ)." });
  const interval = Math.max(1, parseInt(p.intervalDays, 10) || 14);
  const count = Math.min(52, Math.max(1, parseInt(p.count, 10) || 1));
  const capacity = Math.max(1, parseInt(p.capacity, 10) || 15);
  const existing = await listCohorts(); const seen = {}; existing.forEach((c) => { seen[c.startDate] = true; });
  const base = new Date(start + "T00:00:00Z"); let created = 0;
  for (let i = 0; i < count; i++) {
    const iso = new Date(base.getTime() + i * interval * 86400000).toISOString().slice(0, 10);
    if (seen[iso]) continue;
    await saveCohort({ id: crypto.randomUUID(), label: "Session du " + frDate(iso), startDate: iso, capacity: capacity, closed: false, createdAt: new Date().toISOString() });
    seen[iso] = true; created++;
  }
  sendJson(res, 200, { created });
}

// POST /api/admin/cohort/update  { id, closed?, capacity?, label? }
async function handleAdminCohortUpdate(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  if (!p.id) return sendJson(res, 400, { error: "Session manquante." });
  const fields = {};
  if (typeof p.closed === "boolean") fields.closed = p.closed;
  if (p.capacity !== undefined) { const c = parseInt(p.capacity, 10); if (c >= 1) fields.capacity = c; }
  if (p.price !== undefined) { const pr = parseInt(p.price, 10); fields.price = (pr > 0) ? pr : null; }
  if (typeof p.label === "string" && p.label.trim()) fields.label = p.label.trim().slice(0, 120);
  if (typeof p.whatsappLink === "string") { const l = p.whatsappLink.trim(); if (l && !/^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com)\//i.test(l)) return sendJson(res, 400, { error: "Lien WhatsApp invalide (il commence par https://chat.whatsapp.com/…)." }); fields.whatsappLink = l; }
  if (!Object.keys(fields).length) return sendJson(res, 400, { error: "Rien à modifier." });
  const c = await updateCohortRec(p.id, fields);
  if (!c) return sendJson(res, 404, { error: "Session introuvable." });
  sendJson(res, 200, { ok: true });
}

// POST /api/admin/cohort/launch  { id, launched? } : ouvre (ou referme) la CRÉATION DE PROJET pour la session.
// Le lancement ne change pas les comptes : ceux qui ont payé (actifs) accèdent déjà au site ;
// le lancement leur ouvre la construction de leur projet. { launched:false } reverrouille.
async function handleAdminCohortLaunch(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const c = await getCohort(p.id); if (!c) return sendJson(res, 404, { error: "Session introuvable." });
  const launched = (p.launched === false) ? false : true;
  await updateCohortRec(c.id, { launched, launchedAt: launched ? new Date().toISOString() : null });
  const active = await cohortActiveCounts();
  sendJson(res, 200, { ok: true, launched, activeCount: active[c.id] || 0 });
}

// --- CERTIFICAT (simple) : une belle page imprimable en PDF ---
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
function frDate(iso) { try { const d = new Date(iso + "T00:00:00Z"); return JOURS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MOIS[d.getUTCMonth()] + " " + d.getUTCFullYear(); } catch (e) { return iso; } }

// ============================================================
//  JOURNAL DES VISITES (formateur) : qui est passé sur le site.
//  On enregistre seulement les vraies pages (pas les fichiers ni les appels API),
//  avec la date, l'adresse IP, le navigateur, la provenance et — si la personne
//  est connectée — son adresse e-mail. Les visiteurs anonymes ne sont pas identifiables
//  par leur nom (c'est normal : ils ne se sont pas connectés).
// ============================================================
const VISITS_FILE = path.join(DATA_DIR, "visits.json");
const VISIT_PAGES = { "/": "Accueil (formation)", "/accueil": "Page de présentation", "/reserver": "Réservation", "/mon-programme": "Mon programme" };
function loadVisitsLocal() { try { return JSON.parse(fs.readFileSync(VISITS_FILE, "utf8")); } catch (e) { return []; } }
function saveVisitsLocal(a) { try { fs.writeFileSync(VISITS_FILE, JSON.stringify(a.slice(-1000))); } catch (e) {} }
function clientIp(req) { const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); return xf || (req.socket && req.socket.remoteAddress) || ""; }
function shortUA(ua) {
  ua = String(ua || "");
  let b = "Autre"; if (/Edg\//.test(ua)) b = "Edge"; else if (/OPR\/|Opera/.test(ua)) b = "Opera"; else if (/SamsungBrowser/.test(ua)) b = "Samsung"; else if (/Chrome\//.test(ua)) b = "Chrome"; else if (/Firefox\//.test(ua)) b = "Firefox"; else if (/Safari\//.test(ua)) b = "Safari";
  let os = ""; if (/Android/.test(ua)) os = "Android"; else if (/iPhone|iPad|iPod/.test(ua)) os = "iPhone/iPad"; else if (/Windows/.test(ua)) os = "Windows"; else if (/Mac OS/.test(ua)) os = "Mac"; else if (/Linux/.test(ua)) os = "Linux";
  const mobile = /Mobi|Android|iPhone/.test(ua) ? "Mobile" : "Ordinateur";
  return { browser: b, os: os || "?", device: mobile };
}
// Localisation approximative d'après l'IP (ville / pays). Résultat mis en cache par IP,
// pour ne pas interroger le service à chaque visite. Sans clé, sans dépendance (ipwho.is).
const GEO_CACHE = {};
async function geoLookup(ip) {
  if (!ip) return null;
  if (/^(127\.|10\.|192\.168\.|::1|::ffff:127|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null; // réseaux privés / local
  if (Object.prototype.hasOwnProperty.call(GEO_CACHE, ip)) return GEO_CACHE[ip];
  GEO_CACHE[ip] = null; // évite deux requêtes simultanées pour la même IP
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch("https://ipwho.is/" + encodeURIComponent(ip) + "?fields=success,city,country,country_code", { signal: ctrl.signal });
    clearTimeout(to);
    const d = await r.json();
    if (d && d.success) { const g = { city: d.city || "", country: d.country || "", cc: d.country_code || "" }; GEO_CACHE[ip] = g; return g; }
  } catch (e) {}
  GEO_CACHE[ip] = null; return null;
}
async function logVisit(req) {
  try {
    const p = String(req.url || "").split("?")[0];
    if (!VISIT_PAGES[p]) return; // uniquement les vraies pages (ni /api, ni fichiers, ni /preview)
    let who = null; try { const u = await currentUser(req); who = u ? u.email : null; } catch (e) {}
    const ua = shortUA(req.headers["user-agent"]);
    const ip = clientIp(req);
    const rec = { at: new Date().toISOString(), path: p, page: VISIT_PAGES[p], ip: ip, browser: ua.browser, os: ua.os, device: ua.device, ref: String(req.headers["referer"] || "").slice(0, 140), who };
    const g = await geoLookup(ip); if (g) { rec.city = g.city; rec.country = g.country; rec.cc = g.cc; }
    if (USE_DB) { sb(`/visits`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([rec]) }).catch(() => {}); }
    else { const a = loadVisitsLocal(); a.push(rec); saveVisitsLocal(a); }
  } catch (e) {}
}
// Charge les dernières visites + calcule des statistiques simples (partagé liste + PDF).
async function loadVisitsData() {
  let list = [];
  if (USE_DB) { try { list = (await sb(`/visits?select=*&order=at.desc&limit=400`)) || []; } catch (e) { list = []; } }
  else { list = loadVisitsLocal().slice().reverse().slice(0, 400); }
  const now = Date.now(); const dayMs = 86400000;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0); const t0 = startToday.getTime();
  const ips = new Set(), ipsToday = new Set(), ips7 = new Set(); const byPage = {}; let today = 0, last7 = 0, connu = 0;
  const whoSet = new Set();
  list.forEach((v) => {
    const t = new Date(v.at).getTime(); if (v.ip) ips.add(v.ip);
    byPage[v.page || v.path] = (byPage[v.page || v.path] || 0) + 1;
    if (t >= t0) { today++; if (v.ip) ipsToday.add(v.ip); }
    if (t >= now - 7 * dayMs) { last7++; if (v.ip) ips7.add(v.ip); }
    if (v.who) { connu++; whoSet.add(v.who); }
  });
  return { list, stats: { total: list.length, uniques: ips.size, today, uniquesToday: ipsToday.size, last7, uniques7: ips7.size, connus: whoSet.size, byPage } };
}
// GET /api/admin/visits : les dernières visites + statistiques simples (formateur).
async function handleAdminVisits(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const d = await loadVisitsData();
  sendJson(res, 200, { visits: d.list.slice(0, 200), stats: d.stats });
}

// --- Générateur de PDF minimal (sans dépendance) pour le rapport des visiteurs ---
function pdfEsc(s) { return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function pdfSafe(s) { // garde le Latin-1 (accents FR) ; convertit la ponctuation typographique ; remplace le reste (emoji…)
  return String(s == null ? "" : s)
    .replace(/[–—]/g, "-")           // tirets longs → -
    .replace(/[‘’‚′]/g, "'") // apostrophes courbes → '
    .replace(/[“”„]/g, '"')      // guillemets courbes → "
    .replace(/…/g, "...")                    // points de suspension
    .replace(/[    ]/g, " ") // espaces insécables → espace
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?");   // le reste hors Latin-1
}
// lines: [{ t, size, gap }]. Pagine automatiquement sur A4 portrait.
function buildPdf(lines) {
  const W = 595.28, H = 841.89, M = 42;
  const pages = []; let cur = []; let y = H - M;
  for (const ln of lines) {
    const size = ln.size || 10;
    if (y < M + size) { pages.push(cur); cur = []; y = H - M; }
    cur.push({ x: M, y, size, t: pdfEsc(pdfSafe(ln.t)) });
    y -= (size + (ln.gap || 3));
  }
  if (cur.length) pages.push(cur);
  if (!pages.length) pages.push([]);
  const objs = []; // texte de chaque objet indirect (sans l'en-tête "N 0 obj")
  // 1 catalog, 2 pages, 3 font, puis pour chaque page : contenu + page
  const nPages = pages.length;
  const fontObj = 3;
  const kids = [];
  const contentStart = 4;
  for (let i = 0; i < nPages; i++) {
    const contentNo = contentStart + i * 2;
    const pageNo = contentStart + i * 2 + 1;
    kids.push(pageNo + " 0 R");
  }
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + nPages + " >>";
  objs[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  for (let i = 0; i < nPages; i++) {
    const contentNo = contentStart + i * 2;
    const pageNo = contentStart + i * 2 + 1;
    let stream = "BT\n";
    for (const op of pages[i]) {
      stream += "/F1 " + op.size + " Tf\n1 0 0 1 " + op.x.toFixed(2) + " " + op.y.toFixed(2) + " Tm\n(" + op.t + ") Tj\n";
    }
    stream += "ET";
    objs[contentNo] = "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream";
    objs[pageNo] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W.toFixed(2) + " " + H.toFixed(2) + "] /Resources << /Font << /F1 " + fontObj + " 0 R >> >> /Contents " + contentNo + " 0 R >>";
  }
  // Sérialisation + table xref
  let out = "%PDF-1.4\n"; const offsets = []; const total = objs.length - 1;
  for (let n = 1; n <= total; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += n + " 0 obj\n" + objs[n] + "\nendobj\n";
  }
  const xrefPos = Buffer.byteLength(out, "latin1");
  out += "xref\n0 " + (total + 1) + "\n0000000000 65535 f \n";
  for (let n = 1; n <= total; n++) { out += String(offsets[n]).padStart(10, "0") + " 00000 n \n"; }
  out += "trailer\n<< /Size " + (total + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF";
  return Buffer.from(out, "latin1");
}
function visitWhenFr(iso) {
  try { const d = new Date(iso); const D = (n) => (n < 10 ? "0" : "") + n; return D(d.getDate()) + "/" + D(d.getMonth() + 1) + "/" + d.getFullYear() + " " + D(d.getHours()) + ":" + D(d.getMinutes()); } catch (e) { return String(iso || ""); }
}
// GET /api/admin/visits.pdf : rapport PDF des visiteurs, régénéré à chaque ouverture.
async function handleAdminVisitsPdf(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Réservé au formateur."); }
  const { list, stats } = await loadVisitsData();
  const lines = [];
  lines.push({ t: "Bâtisseur — Journal des visiteurs", size: 18, gap: 6 });
  lines.push({ t: "Rapport généré le " + visitWhenFr(new Date().toISOString()), size: 9, gap: 10 });
  lines.push({ t: "Aujourd'hui : " + stats.today + " visite(s), " + stats.uniquesToday + " visiteur(s) distinct(s)", size: 11, gap: 2 });
  lines.push({ t: "7 derniers jours : " + stats.last7 + " visite(s), " + stats.uniques7 + " visiteur(s) distinct(s)", size: 11, gap: 2 });
  lines.push({ t: "Personnes connectées (identifiées) : " + stats.connus, size: 11, gap: 12 });
  lines.push({ t: "Dernières visites (de la plus récente à la plus ancienne) :", size: 12, gap: 8 });
  if (!list.length) lines.push({ t: "Aucune visite enregistrée pour l'instant.", size: 10 });
  list.slice(0, 300).forEach((v) => {
    const who = v.who ? v.who : "Visiteur anonyme";
    const loc = [v.city, v.country].filter(Boolean).join(", ");
    const dev = [v.device, v.browser].filter(Boolean).join(" ") + (v.os ? (" (" + v.os + ")") : "");
    let l = visitWhenFr(v.at) + "  |  " + who + "  |  " + (v.page || v.path || "");
    if (loc) l += "  |  " + loc;
    l += "  |  " + dev;
    if (v.ip) l += "  |  IP " + v.ip;
    lines.push({ t: l, size: 8.5, gap: 3 });
  });
  const pdf = buildPdf(lines);
  res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "inline; filename=\"batisseur-visiteurs.pdf\"", "cache-control": "no-store" });
  res.end(pdf);
}

// ============================================================
//  CHRONOGRAMME DE LA SESSION (visible par l'apprenant, après connexion)
//  Rendu à partir de la date de début de SA session : 3 samedis (9 h–13 h),
//  travail du projet en autonomie la semaine. Même design que le document PDF.
// ============================================================
const MOIS_ABBR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DOW_ABBR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
function chronoAb(dt) { return dt.getUTCDate() + " " + MOIS_ABBR[dt.getUTCMonth()]; }
const CHRONO_CSS = `
  :root{ --ink:#0E1B2E; --teal:#147C8C; --deep:#0C5866; --warm:#D98A2B; --soft:#4a5a70; --line:#d8dfe9; --bg:#f4f7fb; }
  *{ box-sizing:border-box; margin:0; padding:0; }
  html,body{ background:#eef2f7; }
  body{ font-family:"Segoe UI",Arial,sans-serif; color:var(--ink); padding:18px; }
  .sheet{ max-width:1180px; margin:0 auto; background:#fff; border:1px solid var(--line); border-radius:14px; box-shadow:0 10px 40px rgba(14,27,46,.08); padding:26px 30px 24px; }
  .intro{ background:linear-gradient(135deg,var(--deep),var(--teal)); color:#fff; border-radius:12px; padding:16px 18px; margin-bottom:20px; }
  .intro h2{ font-size:17px; margin-bottom:8px; }
  .intro ul{ margin:0; padding-left:18px; font-size:13px; line-height:1.7; }
  .intro b{ color:#ffe9cf; }
  .backbar{ max-width:1180px; margin:0 auto 12px; }
  .backbar a{ display:inline-block; text-decoration:none; color:var(--deep); font-weight:700; font-size:13px; background:#fff; border:1px solid var(--line); border-radius:9px; padding:7px 13px; }
  .head{ display:flex; align-items:flex-end; justify-content:space-between; border-bottom:3px solid var(--teal); padding-bottom:12px; flex-wrap:wrap; gap:10px; }
  .brand{ display:flex; align-items:center; gap:12px; }
  .logo{ width:40px; height:40px; border-radius:10px; background:linear-gradient(135deg,var(--teal),var(--warm)); color:#06121c; font-weight:800; font-size:22px; display:flex; align-items:center; justify-content:center; }
  .brand .k{ font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--soft); font-weight:700; }
  .brand b{ font-size:20px; }
  h1{ font-size:22px; color:var(--deep); }
  .sub{ font-size:13px; color:var(--soft); text-align:right; }
  .sub b{ color:var(--ink); }
  table.g{ width:100%; border-collapse:collapse; margin-top:18px; table-layout:fixed; }
  .actcol{ width:230px; }
  table.g th, table.g td{ border:1px solid var(--line); height:30px; font-size:11px; text-align:center; vertical-align:middle; }
  thead .wk{ background:var(--deep); color:#fff; font-weight:700; font-size:12px; }
  thead .sath{ background:var(--teal); color:#fff; font-weight:700; font-size:11.5px; }
  thead .dh{ background:var(--bg); color:var(--soft); font-weight:700; font-size:10.5px; line-height:1.15; }
  thead .dh .dn{ display:block; color:var(--ink); font-size:11.5px; }
  thead .sat{ background:color-mix(in srgb,var(--teal) 16%,#fff); color:var(--deep); }
  .rowh{ text-align:left; padding:0 12px; font-size:11.5px; font-weight:600; background:#fff; }
  .rowh .ic{ display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:8px; vertical-align:middle; }
  td.cell{ padding:0; }
  .bar{ height:20px; margin:5px 3px; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:9.5px; font-weight:700; white-space:nowrap; overflow:hidden; }
  .b-pres{ background:var(--deep); } .b-work{ background:var(--teal); } .b-eng{ background:#3B7A57; }
  .b-sig{ background:var(--warm); color:#231202; } .b-ctl{ background:#5a6b80; } .b-expo{ background:#B23A48; }
  .legend{ display:flex; flex-wrap:wrap; gap:12px 16px; margin-top:13px; font-size:10.5px; color:var(--soft); align-items:center; }
  .legend span{ display:inline-flex; align-items:center; gap:6px; }
  .legend i{ width:12px; height:12px; border-radius:4px; display:inline-block; }
  .note{ margin-top:10px; font-size:11.5px; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-left:4px solid var(--warm); border-radius:8px; padding:9px 12px; line-height:1.55; }
  .note b{ color:var(--deep); }
  h3.sec{ font-size:15px; color:var(--deep); margin:20px 0 9px; }
  .sats{ display:flex; gap:14px; flex-wrap:wrap; }
  .satcard{ flex:1; min-width:250px; border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .satcard .cap{ background:var(--deep); color:#fff; padding:8px 11px; font-weight:700; font-size:11.5px; }
  .satcard .cap .d{ display:block; font-weight:600; opacity:.9; font-size:10.5px; margin-top:2px; }
  table.h{ width:100%; border-collapse:collapse; }
  table.h td{ border-top:1px solid var(--line); padding:5px 9px; font-size:10.5px; vertical-align:top; line-height:1.3; }
  table.h td.t{ width:82px; font-weight:700; color:var(--deep); white-space:nowrap; }
  table.h tr:nth-child(even){ background:var(--bg); }
  .pause td{ color:var(--soft); font-style:italic; }
  .foot{ margin-top:14px; font-size:10.5px; color:#8394a8; border-top:1px solid var(--line); padding-top:7px; }
  @media(max-width:720px){ table.g{ display:none; } }
`;
function chronoDayHead(dt) { return '<th class="dh"><span class="dn">' + DOW_ABBR[dt.getUTCDay()] + '</span>' + dt.getUTCDate() + '</th>'; }
// Rend le chronogramme d'UNE session à partir de sa date de début (1er samedi).
function chronoLearnerPage(startISO, label) {
  const base = new Date(startISO + "T00:00:00Z");
  const day = (k) => new Date(base.getTime() + k * 86400000);
  const s1 = day(0), s2 = day(7), s3 = day(14);
  const w1 = [2, 3, 4, 5, 6].map(day), w2 = [9, 10, 11, 12, 13].map(day);
  const yr = s1.getUTCFullYear(), yr3 = s3.getUTCFullYear();
  const spanYear = (yr === yr3) ? String(yr) : (yr + "–" + yr3);
  const cards = [
    { cap: "Samedi 1 — Lancement &amp; fondations", dt: s1, rows: [
      ["9 h 00 – 9 h 30", "Accueil et cadrage : objectifs, le vibe coding, les piliers."],
      ["9 h 30 – 10 h 30", "Projet : prise en main ; chacun démarre et définit son projet."],
      ["10 h 30 – 11 h 15", "Initiation SIG : QGIS / ArcGIS + installation des logiciels."],
      ["11 h 15 – 11 h 30", "Pause.", "pause"],
      ["11 h 30 – 12 h 15", "Atelier projet accompagné : premières pages."],
      ["12 h 15 – 13 h 00", "Anglais : conseils + lecture (natif ou formateur)."] ] },
    { cap: "Samedi 2 — Suivi &amp; approfondissement", dt: s2, rows: [
      ["9 h 00 – 9 h 45", "Contrôle des projets : avancement de la semaine ; déblocage."],
      ["9 h 45 – 10 h 45", "Atelier projet : enrichir et avancer, accompagné."],
      ["10 h 45 – 11 h 00", "Pause.", "pause"],
      ["11 h 00 – 11 h 45", "SIG (pratique) : exercice de cartographie appliqué."],
      ["11 h 45 – 12 h 30", "Anglais : conseils + lecture (natif ou formateur)."],
      ["12 h 30 – 13 h 00", "Cap sur la semaine 2 : objectifs et présentation."] ] },
    { cap: "Samedi 3 — Finalisation &amp; exposition", dt: s3, rows: [
      ["9 h 00 – 9 h 45", "Contrôle final et derniers réglages des projets."],
      ["9 h 45 – 10 h 45", "Finalisation et mise en ligne des projets."],
      ["10 h 45 – 11 h 00", "Pause.", "pause"],
      ["11 h 00 – 11 h 45", "Anglais : préparer la présentation en anglais."],
      ["11 h 45 – 13 h 00", "Exposition des projets (français + anglais) + attestations.", "eve"] ] },
  ];
  const cardHtml = cards.map((c) => {
    const rows = c.rows.map((r) => {
      const cls = r[2] === "pause" ? ' class="pause"' : (r[2] === "eve" ? ' style="background:color-mix(in srgb,#B23A48 8%,#fff);"' : "");
      const tcol = r[2] === "eve" ? ' style="color:#B23A48;"' : "";
      return "<tr" + cls + '><td class="t"' + tcol + ">" + r[0] + "</td><td>" + r[1] + "</td></tr>";
    }).join("");
    return '<div class="satcard"><div class="cap">' + c.cap + '<span class="d">' + chronoAb(c.dt) + ". · 9 h–13 h</span></div><table class=\"h\">" + rows + "</table></div>";
  }).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mon programme — Bâtisseur</title><style>${CHRONO_CSS}</style></head><body>
  <div class="backbar"><a href="/">← Retour à ma formation</a></div>
  <div class="sheet">
    <div class="intro">
      <h2>Comment travailler pendant votre formation</h2>
      <ul>
        <li><b>Chaque jour en semaine :</b> connectez-vous et faites avancer votre projet <b>30 à 60 min</b> dans Bâtisseur (l'assistant vous guide).</li>
        <li><b>Chaque samedi (9 h – 13 h) :</b> séance en présentiel — contrôle du projet, initiation SIG et anglais.</li>
        <li><b>Samedi 3 :</b> exposition de votre projet (français + anglais) et remise de l'attestation.</li>
        <li><b>Programmation (Python, JavaScript, Java) :</b> à votre rythme, à poursuivre après la formation — Bâtisseur reste ouvert.</li>
      </ul>
    </div>
    <div class="head">
      <div>
        <div class="brand"><span class="logo">B</span><div><div class="k">Centre de formation</div><b>Bâtisseur</b></div></div>
        <h1 style="margin-top:12px;">Chronogramme de ma session · 2 semaines, 3 samedis</h1>
      </div>
      <div class="sub">${escapeHtml(label || "Ma session")} — ${spanYear}<br>Samedis : <b>${chronoAb(s1)}, ${chronoAb(s2)} &amp; ${chronoAb(s3)}</b>, de <b>9 h à 13 h</b><br>Exposition : <b>${frDate(s3.toISOString().slice(0, 10)).replace(/^[a-zéû]+ /, "samedi ")}</b></div>
    </div>
    <table class="g">
      <colgroup><col class="actcol"><col span="13"></colgroup>
      <thead>
        <tr>
          <th class="wk" style="background:#fff;border:none;"></th>
          <th class="sath">Samedi 1</th>
          <th class="wk" colspan="5">Semaine 1 (${chronoAb(s1)} → ${chronoAb(s2)})</th>
          <th class="sath">Samedi 2</th>
          <th class="wk" colspan="5">Semaine 2 (${chronoAb(s2)} → ${chronoAb(s3)})</th>
          <th class="sath">Samedi 3</th>
        </tr>
        <tr>
          <th class="dh" style="text-align:left;padding-left:12px;">Pilier</th>
          <th class="dh sat"><span class="dn">Sam</span>${s1.getUTCDate()}</th>
          ${w1.map(chronoDayHead).join("")}
          <th class="dh sat"><span class="dn">Sam</span>${s2.getUTCDate()}</th>
          ${w2.map(chronoDayHead).join("")}
          <th class="dh sat"><span class="dn">Sam</span>${s3.getUTCDate()}</th>
        </tr>
      </thead>
      <tbody>
        <tr><td class="rowh"><span class="ic" style="background:#0C5866"></span>Présentiel du samedi (9 h – 13 h)</td>
          <td class="cell"><div class="bar b-pres">Samedi 1</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-pres">Samedi 2</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-pres">Samedi 3</div></td></tr>
        <tr><td class="rowh"><span class="ic" style="background:#147C8C"></span>Projet — travail en autonomie (30–60 min/j)</td>
          <td></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td>
          <td></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td><td class="cell"><div class="bar b-work"></div></td>
          <td></td></tr>
        <tr><td class="rowh"><span class="ic" style="background:#5a6b80"></span>Contrôle de l'évolution du projet</td>
          <td></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-ctl">Contrôle</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-ctl">Contrôle</div></td></tr>
        <tr><td class="rowh"><span class="ic" style="background:#D98A2B"></span>Initiation SIG (+ logiciels)</td>
          <td class="cell"><div class="bar b-sig">SIG</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-sig">SIG</div></td><td></td><td></td><td></td><td></td><td></td>
          <td></td></tr>
        <tr><td class="rowh"><span class="ic" style="background:#3B7A57"></span>Anglais : conseils &amp; lecture (samedi)</td>
          <td class="cell"><div class="bar b-eng">Anglais</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-eng">Anglais</div></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-eng">Anglais</div></td></tr>
        <tr><td class="rowh"><span class="ic" style="background:#B23A48"></span>Exposition des projets (FR + EN)</td>
          <td></td><td></td><td></td><td></td><td></td><td></td>
          <td></td><td></td><td></td><td></td><td></td><td></td>
          <td class="cell"><div class="bar b-expo">Expo</div></td></tr>
      </tbody>
    </table>
    <div class="legend">
      <span><i style="background:#0C5866"></i> Présentiel (samedi, 9 h–13 h)</span>
      <span><i style="background:#147C8C"></i> Projet en autonomie (semaine)</span>
      <span><i style="background:#5a6b80"></i> Contrôle du projet</span>
      <span><i style="background:#D98A2B"></i> Initiation SIG</span>
      <span><i style="background:#3B7A57"></i> Anglais : conseils &amp; lecture</span>
      <span><i style="background:#B23A48"></i> Exposition (FR + EN)</span>
    </div>
    <div class="note"><b>En semaine :</b> chacun fait avancer <b>son propre projet</b> (une application, un site… Bâtisseur en est un exemple), même sans le formateur ; l'évolution est <b>contrôlée chaque samedi</b>. La <b>programmation</b> se poursuit après, à votre rythme.</div>
    <h3 class="sec">Emploi du temps des trois samedis (9 h – 13 h)</h3>
    <div class="sats">${cardHtml}</div>
    <div class="foot">Bâtisseur — Chronogramme de votre session « Réaliser son projet numérique grâce au vibe coding ». Dates et horaires indicatifs, ajustables par le formateur.</div>
  </div>
</body></html>`;
}
// GET /mon-programme : le chronogramme de LA session de l'apprenant connecté.
async function handleLearnerChrono(req, res) {
  const u = await currentUser(req);
  const wrap = (inner) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mon programme — Bâtisseur</title><style>${CHRONO_CSS}</style></head><body><div class="backbar"><a href="/">← Retour à ma formation</a></div><div class="sheet"><div class="intro"><h2>Mon programme</h2></div><p style="font-size:14px;color:var(--soft);line-height:1.6;">${inner}</p></div></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (!u) return res.end(wrap("Connectez-vous d'abord à votre espace, puis rouvrez « Mon programme »."));
  const cid = u.cohort_id || null;
  const cohort = cid ? await getCohort(cid) : null;
  if (!cohort || !cohort.startDate) return res.end(wrap("Votre session n'est pas encore attribuée. Votre formateur vous rattachera à une session — le programme apparaîtra ici ensuite."));
  return res.end(chronoLearnerPage(String(cohort.startDate).slice(0, 10), cohort.label));
}

// ============================================================
// RÉSERVATIONS DE SESSION AVEC PAIEMENT (« garder sa place »)
// ------------------------------------------------------------
// Une personne réserve une place dans une session et paie sur Wave pour la garder ;
// le formateur valide (l'intègre réellement). Paiement en espèces possible (le
// formateur l'enregistre). Rappels (e-mail + WhatsApp, au nom de Bâtisseur) 12h avant
// l'échéance (la veille de la session) ; sans règlement, la personne passe en file
// d'attente. Aucune dépendance : stockage base (tables settings/reservations) ou fichier.
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
// Lien Wave par défaut = compte du formateur (Imprim USP) ; le montant s'ajoute via ?amount=.
const DEFAULT_WAVE_FORMATION_LINK = process.env.WAVE_FORMATION_LINK || "https://pay.wave.com/m/M_ci_JmZaF8F6GuC-/c/ci/";
function loadSettingsLocal() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (e) { return {}; } }
function saveSettingsLocal(o) { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
async function getSettings() {
  if (USE_DB) { try { const r = await sb(`/settings?id=eq.formation&select=data`); return (r && r[0] && r[0].data) || {}; } catch (e) { return {}; } }
  return loadSettingsLocal();
}
async function setSettings(fields) {
  const next = Object.assign({}, await getSettings(), fields);
  if (USE_DB) { try { await sb(`/settings?on_conflict=id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ id: "formation", data: next }]) }); } catch (e) {} }
  else saveSettingsLocal(next);
  return next;
}
function formationConfig(s) {
  return {
    payLink: (s && s.payLink) || DEFAULT_WAVE_FORMATION_LINK,
    price: (s && s.price != null) ? s.price : (parseInt(process.env.FORMATION_PRICE, 10) || 5000),
    currency: (s && s.currency) || "FCFA",
    open: s ? (s.open !== false) : true,
    dailyGoalMin: (s && s.dailyGoalMin != null) ? s.dailyGoalMin : (parseInt(process.env.DAILY_GOAL_MIN, 10) || 60),
    proofRequired: (s && typeof s.proofRequired === "boolean") ? s.proofRequired : true,
    // Plafond de messages IA par apprenant et par 24 h (protège le coût d'API).
    // Volontairement large : un apprenant normal ne l'atteint jamais. Le formateur
    // n'est pas concerné. Réglable depuis l'Espace formateur.
    aiDailyLimit: (s && s.aiDailyLimit != null) ? s.aiDailyLimit : (parseInt(process.env.AI_DAILY_LIMIT, 10) || 150),
    // Lien d'invitation de la communauté WhatsApp : envoyé automatiquement aux admis.
    whatsappLink: (s && typeof s.whatsappLink === "string") ? s.whatsappLink : (process.env.WHATSAPP_COMMUNITY_LINK || "")
  };
}
function communityLink(cfg) { return (cfg && cfg.whatsappLink) ? String(cfg.whatsappLink) : ""; }
// Lien de la communauté WhatsApp propre à la SESSION, avec repli sur le lien global des réglages.
function cohortCommunityLink(cohort, cfg) { return (cohort && cohort.whatsappLink) ? String(cohort.whatsappLink) : communityLink(cfg); }
// Limite IA par apprenant : petit cache (60 s) pour éviter de relire les réglages à chaque message.
let _aiLimCache = { v: null, at: 0 };
async function aiDailyLimit() {
  const now = Date.now();
  if (_aiLimCache.v != null && now - _aiLimCache.at < 60000) return _aiLimCache.v;
  const cfg = formationConfig(await getSettings());
  _aiLimCache = { v: cfg.aiDailyLimit, at: now };
  return cfg.aiDailyLimit;
}
// --- Compteur d'appels à l'IA (suivi des coûts, côté formateur) --------------
// Léger et en mémoire : donne une idée de l'activité du jour. Remis à zéro au
// redémarrage du serveur (c'est un repère pour repérer une hausse, pas une
// comptabilité exacte).
function todayKey() { return new Date().toISOString().slice(0, 10); }
function lastNDays(n) { const out = []; const now = Date.now(); for (let i = 0; i < n; i++) out.push(new Date(now - i * 86400000).toISOString().slice(0, 10)); return out; }
let AI_STATS = { day: todayKey(), total: 0, byUser: {} };
function recordAiCall(user) {
  const d = todayKey();
  if (AI_STATS.day !== d) AI_STATS = { day: d, total: 0, byUser: {} };
  AI_STATS.total++;
  const id = (user && user.id) || "anon";
  const name = (user && user.name) || "—";
  const u = AI_STATS.byUser[id] || { name, count: 0 };
  u.name = name; u.count++; AI_STATS.byUser[id] = u;
}

// Vrai si l'apprenant peut encore solliciter l'IA. Le formateur (admin) n'est jamais limité.
async function aiQuotaGuard(user) {
  recordAiCall(user);   // on compte toutes les sollicitations de l'IA (suivi des coûts)
  if (!user || isAdmin(user)) return true;
  const lim = await aiDailyLimit();
  if (!(lim > 0)) return true; // 0 ou vide = pas de plafond
  return rateOk("ai:" + user.id, lim, 24 * 60 * 60 * 1000);
}
const AI_QUOTA_MSG = "Vous avez beaucoup travaillé aujourd'hui, bravo ! Reprenez dans un moment, ou demandez à votre formateur d'augmenter la limite.";
function waveLinkWithAmount(link, amount) {
  if (!link) return "";
  if (amount == null || !(amount > 0)) return link;
  return link + (link.indexOf("?") >= 0 ? "&" : "?") + "amount=" + Math.round(amount);
}

const RESV_FILE = path.join(DATA_DIR, "reservations.json");
const RESV_STATUSES = ["en_attente", "paiement_declare", "admis", "file_attente", "annule"];
function loadResv() { try { return JSON.parse(fs.readFileSync(RESV_FILE, "utf8")); } catch (e) { return []; } }
function saveResvLocal(a) { try { fs.writeFileSync(RESV_FILE, JSON.stringify(a, null, 2)); } catch (e) {} }
function toResvRow(r) { return { id: r.id, cohort_id: r.cohortId, name: r.name, email: r.email, whatsapp: r.whatsapp, status: r.status, source: r.source, declared_at: r.declaredAt || null, admitted_at: r.admittedAt || null, reminded_at: r.remindedAt || null, created_at: r.createdAt }; }
function fromResvRow(x) { return { id: x.id, cohortId: x.cohort_id, name: x.name, email: x.email, whatsapp: x.whatsapp, status: x.status, source: x.source, declaredAt: x.declared_at, admittedAt: x.admitted_at, remindedAt: x.reminded_at, createdAt: x.created_at }; }
async function addReservation(rec) {
  if (USE_DB) { try { await sb(`/reservations`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([toResvRow(rec)]) }); } catch (e) { console.error("addReservation:", e.message); throw e; } return; }
  const a = loadResv(); a.push(rec); saveResvLocal(a);
}
async function listReservations(cohortId) {
  if (USE_DB) { try { const q = cohortId ? `?cohort_id=eq.${encodeURIComponent(cohortId)}&` : `?`; const r = await sb(`/reservations${q}select=*&order=created_at.asc`); return (r || []).map(fromResvRow); } catch (e) { return []; } }
  let a = loadResv(); if (cohortId) a = a.filter((r) => r.cohortId === cohortId);
  return a.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
}
async function getReservation(id) {
  if (USE_DB) { try { const r = await sb(`/reservations?id=eq.${encodeURIComponent(id)}&select=*`); return (r && r[0]) ? fromResvRow(r[0]) : null; } catch (e) { return null; } }
  return loadResv().find((r) => r.id === id) || null;
}
async function updateReservation(id, fields) {
  if (USE_DB) {
    const map = { status: "status", source: "source", declaredAt: "declared_at", admittedAt: "admitted_at", remindedAt: "reminded_at", name: "name", whatsapp: "whatsapp" };
    const row = {}; Object.keys(fields).forEach((k) => { if (map[k]) row[map[k]] = fields[k]; });
    try { await sb(`/reservations?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) }); } catch (e) {}
    return;
  }
  const a = loadResv(); a.forEach((r) => { if (r.id === id) Object.assign(r, fields); }); saveResvLocal(a);
}
function cohortPrice(cohort, cfg) { return (cohort && cohort.price != null) ? cohort.price : cfg.price; }
async function admittedCounts() {
  const all = await listReservations(null); const m = {};
  all.forEach((r) => { if (r.status === "admis") m[r.cohortId] = (m[r.cohortId] || 0) + 1; });
  return m;
}

// --- Messages au nom de Bâtisseur (polis et professionnels) ---
function reminderMessages(resv, cohort, cfg) {
  const dateStr = frDate(cohort.startDate);
  const price = cohortPrice(cohort, cfg);
  const amount = (price != null) ? (Math.round(price) + " " + cfg.currency) : "le montant de la formation";
  const payLink = waveLinkWithAmount(cfg.payLink, price);
  const subject = "Bâtisseur — votre place pour la session du " + dateStr;
  const email = "Bonjour " + resv.name + ",\n\n"
    + "Vous avez réservé une place pour la session de formation du " + dateStr + ". Pour garantir cette place, le règlement (" + amount + ") doit être effectué au plus tard la veille de la session.\n\n"
    + "Vous pouvez régler dès maintenant avec Wave : " + payLink + "\n\n"
    + "Sans règlement d'ici la fin de la journée, votre nom sera reporté en fin de liste d'attente afin de laisser la place à une autre personne. Si vous avez déjà payé (en ligne ou en espèces auprès du formateur), merci d'ignorer ce message.\n\n"
    + "Nous restons à votre disposition.\nL'équipe Bâtisseur";
  const wa = "Bonjour " + resv.name + ", ici l'équipe Bâtisseur. Pour conserver votre place à la session du " + dateStr + ", merci de régler " + amount + " avant la veille de la session. Paiement Wave : " + payLink + " — sans règlement d'ici la fin de journée, la place sera proposée à une autre personne. Merci de votre compréhension.";
  return { subject, email, wa };
}
// E-mail d'admission envoyé automatiquement dès qu'une place est validée (admis) :
// bienvenue + identifiants éventuels + lien de la communauté WhatsApp.
async function sendAdmissionEmail(resv, cohort, cfg, access) {
  try {
    if (!resv || !resv.email || !emailAutoConfigured()) return;
    const dateStr = cohort ? frDate(cohort.startDate) : "";
    const base = process.env.PUBLIC_BASE_URL || "https://batisseur.onrender.com";
    const link = cohortCommunityLink(cohort, cfg);
    const subject = "Bâtisseur — votre place est confirmée 🎉";
    let body = "Bonjour " + resv.name + ",\n\n"
      + "Bonne nouvelle : votre place" + (dateStr ? (" pour la session du " + dateStr) : "") + " est confirmée. Bienvenue dans Bâtisseur !\n\n"
      + "Connectez-vous dès maintenant pour commencer : " + base + "\n";
    if (access && access.created && access.password) {
      body += "\nVos identifiants de connexion :\n- E-mail : " + resv.email + "\n- Mot de passe provisoire : " + access.password + "\n(Vous pourrez le modifier après votre première connexion.)\n";
    }
    if (link) body += "\nRejoignez la communauté WhatsApp de la promo ici :\n" + link + "\n";
    body += "\nÀ très vite, et bonne construction !\nL'équipe Bâtisseur";
    await sendReminderEmail(resv.email, subject, body);
  } catch (e) { console.error("E-mail admission:", e && e.message); }
}
function waLink(number, text) { const n = String(number || "").replace(/[^0-9]/g, ""); return n ? ("https://wa.me/" + n + "?text=" + encodeURIComponent(text)) : ""; }
function mailtoLink(email, subject, body) { return email ? ("mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body)) : ""; }
// Envoi automatique si un service est configuré (webhooks) ; sinon le formateur envoie depuis l'outbox.
// L'envoi e-mail automatique est actif dès qu'une clé Brevo (BREVO_API_KEY + MAIL_FROM)
// ou un webhook (MAIL_WEBHOOK_URL) est configuré dans les variables d'environnement Render.
function emailAutoConfigured() { return !!((process.env.BREVO_API_KEY && process.env.MAIL_FROM) || process.env.MAIL_WEBHOOK_URL); }
async function sendReminderEmail(to, subject, text) {
  if (!to) return false;
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (key && from) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": key, "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ sender: { email: from, name: process.env.MAIL_FROM_NAME || "Bâtisseur" }, to: [{ email: to }], subject, textContent: text })
      });
      if (r.ok) return true;
      console.error("E-mail (Brevo) échec:", r.status, (await r.text().catch(() => "")).slice(0, 200));
    } catch (e) { console.error("E-mail (Brevo):", e.message); }
  }
  if (process.env.MAIL_WEBHOOK_URL) {
    try { const r = await fetch(process.env.MAIL_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, subject, text }) }); return !!(r && r.ok); } catch (e) {}
  }
  return false;
}
async function deliverReminder(resv, msg) {
  try {
    // WhatsApp : envoi automatique uniquement si un webhook est fourni ; sinon lien prêt à envoyer côté formateur.
    if (process.env.WA_WEBHOOK_URL && resv.whatsapp) { fetch(process.env.WA_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: resv.whatsapp, text: msg.wa }) }).catch(() => {}); }
    // E-mail : envoi automatique via Brevo ou webhook si configuré.
    if (resv.email) { await sendReminderEmail(resv.email, msg.subject, msg.email); }
  } catch (e) {}
}

// --- Planificateur : rappels 12h avant l'échéance, passage en file d'attente après ---
async function runReservationMaintenance(now) {
  now = now || new Date();
  const cfg = formationConfig(await getSettings());
  const cohorts = await listCohorts();
  const t = now.getTime();
  for (const c of cohorts) {
    if (!c.startDate) continue;
    const start = new Date(c.startDate + "T00:00:00Z").getTime(); // début du jour de session
    const deadline = start;                       // échéance = tout début du jour de session (fin de la veille)
    const remindFrom = deadline - 12 * 3600 * 1000; // 12h avant
    const resvs = await listReservations(c.id);
    for (const r of resvs) {
      if (r.status !== "en_attente") continue;
      if (t >= deadline) { await updateReservation(r.id, { status: "file_attente" }); }
      else if (t >= remindFrom && !r.remindedAt) {
        const msg = reminderMessages(r, c, cfg);
        await updateReservation(r.id, { remindedAt: now.toISOString() });
        await deliverReminder(r, msg);
      }
    }
  }
}

// GET /api/formation/sessions : sessions ouvertes à la réservation (public)
async function handleFormationSessions(req, res) {
  const cfg = formationConfig(await getSettings());
  if (!cfg.open) return sendJson(res, 200, { open: false, sessions: [] });
  const list = await listCohorts(); const admitted = await admittedCounts();
  const sessions = list.filter((c) => !c.closed).map((c) => {
    const seats = Math.max(0, (c.capacity || 0) - (admitted[c.id] || 0));
    return { id: c.id, label: c.label, startDate: c.startDate, dateFr: frDate(c.startDate), capacity: c.capacity || 0, remaining: seats, full: seats <= 0, price: cohortPrice(c, cfg), currency: cfg.currency };
  });
  sendJson(res, 200, { open: true, currency: cfg.currency, proofRequired: !!cfg.proofRequired, sessions });
}

// POST /api/reservations : réserver une place (public)
async function handleReserve(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const cfg = formationConfig(await getSettings());
    if (!cfg.open) return sendJson(res, 403, { error: "Les réservations sont fermées pour le moment." });
    const cohort = await getCohort(p.cohortId);
    if (!cohort || cohort.closed) return sendJson(res, 404, { error: "Session introuvable ou fermée." });
    const name = String(p.name || "").trim().slice(0, 80);
    const email = normEmail(p.email);
    const whatsapp = String(p.whatsapp || "").replace(/[^0-9+ ]/g, "").trim().slice(0, 25);
    const password = typeof p.password === "string" ? p.password : "";
    if (name.length < 2) return sendJson(res, 400, { error: "Indiquez votre nom." });
    if (!validEmail(email)) return sendJson(res, 400, { error: "Adresse e-mail invalide." });
    if (whatsapp.replace(/[^0-9]/g, "").length < 6) return sendJson(res, 400, { error: "Numéro WhatsApp invalide." });
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || "?";
    if (!rateOk("resv:" + ip, 12, 60 * 60 * 1000)) return sendJson(res, 429, { error: "Trop de demandes. Réessayez plus tard." });
    // Le compte de l'apprenant est créé DEPUIS la réservation (mot de passe choisi ici).
    const already = await findUserByEmail(email);
    let accountCreated = false;
    if (!already) {
      if (password.length < 6) return sendJson(res, 400, { error: "Choisissez un mot de passe (au moins 6 caractères) pour créer votre compte." });
      try { await createUser({ email, name, password, status: "pending", cohort: cohort.label, cohortId: cohort.id }); accountCreated = true; }
      catch (e) { console.error("réservation → compte :", e.message); }
    } else {
      // Compte déjà existant : on le rattache à cette session si besoin (sans toucher au mot de passe).
      if (already.cohort_id !== cohort.id) { try { await updateUser(already.id, { cohort: cohort.label, cohort_id: cohort.id }); } catch (e) {} }
    }
    const existing = (await listReservations(cohort.id)).find((r) => r.email === email && r.status !== "annule");
    let id;
    if (existing) { id = existing.id; if (existing.status === "file_attente") await updateReservation(id, { status: "en_attente" }); }
    else { id = crypto.randomUUID(); await addReservation({ id, cohortId: cohort.id, name, email, whatsapp, status: "en_attente", source: "en_ligne", createdAt: new Date().toISOString() }); }
    const price = cohortPrice(cohort, cfg);
    sendJson(res, 200, { id, accountCreated, alreadyHadAccount: !!already, session: { label: cohort.label, dateFr: frDate(cohort.startDate) }, price, currency: cfg.currency, payLink: waveLinkWithAmount(cfg.payLink, price) });
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/reservations/declare : la personne déclare avoir payé (public) ; le formateur vérifiera
async function handleReserveDeclare(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const r = await getReservation(p.id);
    if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
    if (normEmail(p.email) !== r.email) return sendJson(res, 403, { error: "Cet e-mail ne correspond pas à la réservation." });
    const cfg0 = formationConfig(await getSettings());
    // Le lien de la communauté n'est donné qu'APRÈS validation du formateur (statut "admis").
    if (r.status === "admis") { const community = cohortCommunityLink(await getCohort(r.cohortId), cfg0); return sendJson(res, 200, { ok: true, status: "admis", community }); }
    if (cfg0.proofRequired) {                                    // preuve obligatoire : refuser la déclaration sans capture
      const existing = await getUpload(r.id, "reservation_proof");
      if (!existing) return sendJson(res, 400, { error: "La preuve de paiement (capture) est obligatoire. Joignez-la pour valider." });
    }
    await updateReservation(r.id, { status: "paiement_declare", declaredAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true, status: "paiement_declare" });
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/reservations/proof : la personne joint la capture de son paiement (public)
async function handleReserveProof(req, res) {
  try {
    if (!rateOk("proof:" + (req.socket && req.socket.remoteAddress || "x"), 20, 60000)) return sendJson(res, 429, { error: "Trop de tentatives, réessayez dans un instant." });
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const r = await getReservation(p.id);
    if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
    if (normEmail(p.email) !== r.email) return sendJson(res, 403, { error: "Cet e-mail ne correspond pas à la réservation." });
    const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String(p.image || ""));
    if (!m) return sendJson(res, 400, { error: "Image invalide." });
    const type = m[1].toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif|heic|heif)$/.test(type)) return sendJson(res, 400, { error: "Joignez une image (PNG, JPG, WEBP…)." });
    const data = m[2];
    const size = Math.floor(data.length * 3 / 4);
    if (size > UPLOAD_MAX_BYTES) return sendJson(res, 413, { error: "Image trop lourde (max 3 Mo)." });
    await deleteUpload(r.id, "reservation_proof");                 // remplace une éventuelle preuve précédente
    await addUpload({ id: r.id, projectId: "reservation_proof", name: safeName(p.name || "preuve"), type, size, data, createdAt: new Date().toISOString() });
    if (r.status !== "admis") await updateReservation(r.id, { status: "paiement_declare", declaredAt: new Date().toISOString() });
    const resp = { ok: true, status: r.status === "admis" ? "admis" : "paiement_declare" };
    // Lien de la communauté réservé aux places déjà validées par le formateur.
    if (r.status === "admis") resp.community = cohortCommunityLink(await getCohort(r.cohortId), formationConfig(await getSettings()));
    sendJson(res, 200, resp);
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// GET /api/reservation/proof?id=  (formateur) : afficher l'image de la preuve
async function handleReserveProofView(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Réservé au formateur."); }
  const uo = new URL(req.url, "http://localhost"); const id = uo.searchParams.get("id");
  const up = await getUpload(id, "reservation_proof");
  if (!up) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Aucune preuve pour cette réservation."); }
  const buf = Buffer.from(up.data, "base64");
  res.writeHead(200, { "content-type": up.type || "image/png", "Content-Length": buf.length, "Cache-Control": "private, max-age=60" });
  res.end(buf);
}

// Ensemble des ids de réservation disposant d'une preuve (affichage formateur)
async function proofIdSet() {
  if (USE_DB) { try { const r = await sb(`/uploads?project_id=eq.reservation_proof&select=id`); return new Set((r || []).map((x) => x.id)); } catch (e) { return new Set(); } }
  return new Set(loadUploads().filter((u) => u.projectId === "reservation_proof").map((u) => u.id));
}

// GET /api/formation/reservations?cohortId=  (formateur) : listes + outbox des rappels
async function handleFormationReservations(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const uo = new URL(req.url, "http://localhost"); const cid = uo.searchParams.get("cohortId");
  const cfg = formationConfig(await getSettings());
  const cohort = cid ? await getCohort(cid) : null;
  const rawList = await listReservations(cid || null);
  const proofs = await proofIdSet();
  const list = rawList.map((r) => Object.assign({}, r, { hasProof: proofs.has(r.id) }));
  const outbox = [];
  if (cohort) {
    list.forEach((r) => {
      if (r.remindedAt && (r.status === "en_attente" || r.status === "file_attente")) {
        const m = reminderMessages(r, cohort, cfg);
        outbox.push({ id: r.id, name: r.name, email: r.email, whatsapp: r.whatsapp, wa: waLink(r.whatsapp, m.wa), mailto: mailtoLink(r.email, m.subject, m.email) });
      }
    });
  }
  sendJson(res, 200, { reservations: list, price: cohort ? cohortPrice(cohort, cfg) : cfg.price, currency: cfg.currency, capacity: cohort ? (cohort.capacity || 0) : 0, outbox, emailAuto: emailAutoConfigured() });
}

// GET /api/formation/roster?cohortId=  (formateur) : liste imprimable (PDF) des admis d'une session
async function handleFormationRoster(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) { res.writeHead(403, { "content-type": "text/html; charset=utf-8" }); return res.end("Réservé au formateur."); }
  const uo = new URL(req.url, "http://localhost"); const cid = uo.searchParams.get("cohortId");
  const cohort = cid ? await getCohort(cid) : null;
  if (!cohort) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end("Session introuvable."); }
  const cfg = formationConfig(await getSettings());
  const list = (await listReservations(cid)).filter((r) => r.status === "admis");
  list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"));
  const dateStr = frDate(cohort.startDate);
  const title = cohort.label || ("Session du " + dateStr);
  const price = cohortPrice(cohort, cfg);
  const amountStr = (price != null) ? (Math.round(price) + " " + cfg.currency) : "—";
  const paidStr = (iso) => { if (!iso) return "—"; const d = new Date(iso); if (isNaN(d.getTime())) return "—"; return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + d.getUTCFullYear(); };
  const now = new Date();
  const genStr = now.getUTCDate() + " " + MOIS[now.getUTCMonth()] + " " + now.getUTCFullYear();
  const rowsHtml = list.length
    ? list.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${escapeHtml(r.name || "")}</td><td class="em">${escapeHtml(r.email || "")}</td><td>${escapeHtml(r.whatsapp || "")}</td><td>${escapeHtml(amountStr)}</td><td>${paidStr(r.declaredAt)}</td><td class="sig"></td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">Aucun apprenant admis pour le moment.</td></tr>`;
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liste des admis — ${escapeHtml(title)}</title>
<style>
  @page{ size:A4 portrait; margin:14mm; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:"Segoe UI",Arial,sans-serif; color:#0E1B2E; background:#eef1f6; padding:24px; }
  .print{ position:fixed; top:16px; right:16px; background:#147C8C; color:#fff; border:none; border-radius:8px; padding:10px 16px; font-size:14px; cursor:pointer; box-shadow:0 4px 14px rgba(20,124,140,.35); }
  .sheet{ max-width:820px; margin:0 auto; background:#fff; padding:34px 38px; box-shadow:0 12px 44px rgba(14,27,46,.14); }
  .head{ display:flex; align-items:center; gap:12px; border-bottom:3px solid #147C8C; padding-bottom:14px; }
  .logo{ width:40px; height:40px; border-radius:10px; background:linear-gradient(135deg,#147C8C,#D98A2B); color:#06121c; font-weight:800; font-size:22px; display:flex; align-items:center; justify-content:center; }
  .head b{ font-size:20px; } .head .k{ color:#4a5a70; font-size:12px; letter-spacing:.14em; text-transform:uppercase; font-weight:700; }
  h1{ font-size:22px; margin:20px 0 2px; }
  .meta{ color:#4a5a70; font-size:14px; margin-bottom:2px; }
  .meta b{ color:#0C5866; }
  .count{ margin:14px 0 8px; font-weight:700; color:#0E1B2E; }
  table{ width:100%; border-collapse:collapse; font-size:11.5px; table-layout:fixed; }
  th,td{ border:1px solid #cdd6e2; padding:7px 7px; text-align:left; vertical-align:middle; word-wrap:break-word; overflow-wrap:anywhere; }
  th{ background:#f1f5fa; color:#0C5866; font-size:10.5px; text-transform:uppercase; letter-spacing:.02em; }
  td.n{ width:26px; text-align:center; color:#6B7A90; }
  td.em{ font-size:10.5px; }
  td.sig, th.sig{ width:96px; }
  td.empty{ text-align:center; color:#6B7A90; padding:20px; }
  tr:nth-child(even) td{ background:#fafcfe; }
  .foot{ margin-top:22px; display:flex; justify-content:space-between; color:#6B7A90; font-size:12px; }
  .sign{ margin-top:40px; text-align:right; color:#4a5a70; font-size:13px; }
  .sign .line{ display:inline-block; border-top:1px solid #9aa7b8; width:220px; margin-top:34px; padding-top:6px; }
  @media print{ body{ background:#fff; padding:0; } .sheet{ box-shadow:none; max-width:none; padding:0; } .print{ display:none; } }
</style></head>
<body>
  <button class="print" onclick="window.print()">Imprimer / Enregistrer en PDF</button>
  <div class="sheet">
    <div class="head"><span class="logo">B</span><div><div class="k">Centre de formation</div><b>Bâtisseur</b></div></div>
    <h1>Liste des admis</h1>
    <div class="meta">Intitulé : <b>${escapeHtml(title)}</b></div>
    <div class="meta">Date de la session : <b>${escapeHtml(dateStr)}</b></div>
    <div class="count">${list.length} apprenant${list.length > 1 ? "s" : ""} admis${cohort.capacity ? " / " + cohort.capacity + " places" : ""}</div>
    <table>
      <thead><tr><th class="n">N°</th><th>Nom et prénom</th><th>E-mail</th><th>WhatsApp</th><th>Montant</th><th>Payé le</th><th class="sig">Émargement</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="sign"><span class="line">Le formateur</span></div>
    <div class="foot"><span>Bâtisseur — liste des admis</span><span>Éditée le ${genStr}</span></div>
  </div>
</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// POST /api/formation/reservation/status { id, status }  (formateur)
async function handleFormationReservationStatus(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const r = await getReservation(p.id); if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
  const status = String(p.status || ""); if (!RESV_STATUSES.includes(status)) return sendJson(res, 400, { error: "Statut invalide." });
  if (status === "admis") {
    const cohort = await getCohort(r.cohortId);
    const admitted = (await listReservations(r.cohortId)).filter((x) => x.status === "admis" && x.id !== r.id).length;
    if (cohort && admitted >= (cohort.capacity || 0)) return sendJson(res, 409, { error: "Session complète : capacité atteinte." });
  }
  const fields = { status }; if (status === "admis") fields.admittedAt = new Date().toISOString();
  await updateReservation(r.id, fields);
  let access = null;
  if (status === "admis") {
    try { access = await grantAccessForReservation(Object.assign({}, r, fields)); } catch (e) {}
    try { const cfg = formationConfig(await getSettings()); const cohort = await getCohort(r.cohortId); await sendAdmissionEmail(Object.assign({}, r, fields), cohort, cfg, access); } catch (e) {}
  }
  sendJson(res, 200, { ok: true, access });
}

async function deleteReservation(id) {
  if (USE_DB) { try { await sb(`/reservations?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  saveResvLocal(loadResv().filter((r) => r.id !== id));
}
// POST /api/formation/reservation/delete { id }  (formateur) : supprimer/annuler une réservation
async function handleFormationReservationDelete(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const r = await getReservation(p.id); if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
  await deleteReservation(p.id);
  sendJson(res, 200, { ok: true });
}

// POST /api/formation/reservation/cash { cohortId, name, email, whatsapp }  (formateur) : paiement espèces -> admis
async function handleFormationCash(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const cohort = await getCohort(p.cohortId); if (!cohort) return sendJson(res, 404, { error: "Session introuvable." });
  const name = String(p.name || "").trim().slice(0, 80);
  const email = p.email ? normEmail(p.email) : null;
  const whatsapp = String(p.whatsapp || "").replace(/[^0-9+ ]/g, "").slice(0, 25) || null;
  if (name.length < 2) return sendJson(res, 400, { error: "Nom requis." });
  const admitted = (await listReservations(cohort.id)).filter((x) => x.status === "admis").length;
  if (admitted >= (cohort.capacity || 0)) return sendJson(res, 409, { error: "Session complète." });
  const id = crypto.randomUUID();
  const rec = { id, cohortId: cohort.id, name, email, whatsapp, status: "admis", source: "especes", admittedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  await addReservation(rec);
  let access = null; try { access = await grantAccessForReservation(rec); } catch (e) {}
  try { const cfg = formationConfig(await getSettings()); await sendAdmissionEmail(rec, cohort, cfg, access); } catch (e) {}
  sendJson(res, 200, { ok: true, id, access });
}

// GET/POST /api/formation/settings  (formateur) : lien Wave, prix, ouverture
async function handleFormationSettings(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  if (req.method === "GET") return sendJson(res, 200, { settings: formationConfig(await getSettings()) });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const fields = {};
  if (typeof p.payLink === "string") { const l = p.payLink.trim(); if (l && !/^https:\/\//i.test(l)) return sendJson(res, 400, { error: "Le lien doit commencer par https://" }); fields.payLink = l; }
  if (p.price !== undefined) { const n = parseInt(p.price, 10); fields.price = (n > 0) ? n : null; }
  if (typeof p.currency === "string" && p.currency.trim()) fields.currency = p.currency.trim().slice(0, 8);
  if (typeof p.open === "boolean") fields.open = p.open;
  if (p.dailyGoalMin !== undefined) { const n = parseInt(p.dailyGoalMin, 10); if (!(n >= 5 && n <= 600)) return sendJson(res, 400, { error: "Objectif quotidien : entre 5 et 600 minutes." }); fields.dailyGoalMin = n; }
  if (typeof p.proofRequired === "boolean") fields.proofRequired = p.proofRequired;
  if (p.aiDailyLimit !== undefined) { const n = parseInt(p.aiDailyLimit, 10); if (!(n >= 20 && n <= 2000)) return sendJson(res, 400, { error: "Plafond IA par apprenant : entre 20 et 2000 messages par jour." }); fields.aiDailyLimit = n; }
  if (typeof p.whatsappLink === "string") { const l = p.whatsappLink.trim(); if (l && !/^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com)\//i.test(l)) return sendJson(res, 400, { error: "Collez un lien d'invitation WhatsApp valide (il commence par https://chat.whatsapp.com/…)." }); fields.whatsappLink = l; }
  const next = await setSettings(fields);
  _aiLimCache.at = 0; // forcer la prise en compte immédiate du nouveau plafond
  sendJson(res, 200, { settings: formationConfig(next) });
}

// ============================================================
//  ASSIDUITÉ : temps de travail quotidien par apprenant.
//  Le navigateur envoie un « battement » tant que la personne travaille (page
//  ouverte, visible, activité récente) ; le serveur cumule les secondes par jour.
//  Le formateur consulte l'assiduité de la semaine (lundi → vendredi).
//  Abidjan étant à UTC+0, la date UTC correspond au jour local.
// ============================================================
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
function loadActivityLocal() { try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")); } catch (e) { return {}; } }
function saveActivityLocal(o) { try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
const DAY_CAP_SECONDS = 16 * 3600; // plafond de sécurité : 16 h/jour maximum
function dayKey(d) { return new Date(d).toISOString().slice(0, 10); }
function weekdaysThisWeek() {
  const now = new Date();
  const dow = now.getUTCDay();                       // 0=dim … 6=sam
  const toMonday = (dow === 0 ? -6 : 1 - dow);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + toMonday));
  const days = [];
  for (let i = 0; i < 5; i++) days.push(dayKey(new Date(monday.getTime() + i * 86400000)));
  return days;                                        // [lun, mar, mer, jeu, ven]
}
async function addActivity(userId, addSeconds) {
  if (!userId || !(addSeconds > 0)) return 0;
  const day = dayKey(new Date());
  if (USE_DB) {
    try {
      const r = await sb(`/activity?user_id=eq.${encodeURIComponent(userId)}&day=eq.${day}&select=seconds`);
      const cur = (r && r[0] && r[0].seconds) || 0;
      const next = Math.min(DAY_CAP_SECONDS, cur + addSeconds);
      await sb(`/activity?on_conflict=user_id,day`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ user_id: userId, day, seconds: next, updated_at: new Date().toISOString() }]) });
      return next;
    } catch (e) { console.error("addActivity:", e.message); return 0; }
  }
  const a = loadActivityLocal();
  const u = a[userId] || (a[userId] = {});
  u[day] = Math.min(DAY_CAP_SECONDS, (u[day] || 0) + addSeconds);
  saveActivityLocal(a);
  return u[day];
}
// ---- Plafond de travail : 1 h par apprenant, puis pause, réinitialisation auto 10 h après ----
// Ne concerne QUE la création de site web (base). Le formateur n'est jamais limité.
const WORKCAP_FILE = path.join(DATA_DIR, "workcap.json");
function loadWorkcap() { try { return JSON.parse(fs.readFileSync(WORKCAP_FILE, "utf8")); } catch (e) { return {}; } }
function saveWorkcap(o) { try { fs.writeFileSync(WORKCAP_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
const WORK_CAP_SECONDS = parseInt(process.env.WORK_CAP_SECONDS, 10) || 3600;          // 1 h de travail
const WORK_COOLDOWN_MS = (parseInt(process.env.WORK_COOLDOWN_HOURS, 10) || 10) * 3600 * 1000; // pause de 10 h
// Applique la règle de réinitialisation (10 h après le blocage) et renvoie l'état à jour.
function workcapEval(rec) {
  const now = Date.now();
  rec = rec && typeof rec === "object" ? { sec: rec.sec || 0, startTs: rec.startTs || 0, cappedTs: rec.cappedTs || 0 } : { sec: 0, startTs: 0, cappedTs: 0 };
  if (rec.cappedTs && (now - rec.cappedTs >= WORK_COOLDOWN_MS)) rec = { sec: 0, startTs: 0, cappedTs: 0 };
  const blocked = !!rec.cappedTs;
  const resetInMs = blocked ? Math.max(0, WORK_COOLDOWN_MS - (now - rec.cappedTs)) : 0;
  return { rec, blocked, resetInMs };
}
// Lecture de l'état (sans ajouter de temps) ; persiste si une réinitialisation vient d'avoir lieu.
function workcapState(userId) {
  if (!userId) return { blocked: false, resetInMs: 0, sec: 0 };
  const all = loadWorkcap();
  const before = JSON.stringify(all[userId] || null);
  const { rec, blocked, resetInMs } = workcapEval(all[userId]);
  if (JSON.stringify(rec) !== before) { if (!rec.sec && !rec.cappedTs) delete all[userId]; else all[userId] = rec; saveWorkcap(all); }
  return { blocked, resetInMs, sec: rec.sec };
}
// Ajoute du temps de travail et bascule en « pause » dès que la 1 h est atteinte.
function workcapAdd(userId, addSeconds) {
  if (!userId || !(addSeconds > 0)) return workcapState(userId);
  const all = loadWorkcap();
  const { rec } = workcapEval(all[userId]);
  if (!rec.cappedTs) {
    if (!rec.startTs) rec.startTs = Date.now();
    rec.sec = (rec.sec || 0) + addSeconds;
    if (rec.sec >= WORK_CAP_SECONDS) { rec.sec = WORK_CAP_SECONDS; rec.cappedTs = Date.now(); }
  }
  all[userId] = rec; saveWorkcap(all);
  const blocked = !!rec.cappedTs;
  return { blocked, resetInMs: blocked ? Math.max(0, WORK_COOLDOWN_MS - (Date.now() - rec.cappedTs)) : 0, sec: rec.sec };
}
function workCapMessage(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const t = h > 0 ? (h + " h" + (m ? (" " + m + " min") : "")) : (m + " min");
  return "Tu as fait ta 1 h de travail pour aujourd'hui — fais une pause ! La création de ton site se rouvrira automatiquement dans environ " + t + ".";
}
// Garde-fou serveur : bloque la création de site (base web) quand la pause est active.
function workCapGuard(user) {
  if (!user || isAdmin(user)) return null;
  const st = workcapState(user.id);
  if (!st.blocked) return null;
  const min = Math.max(1, Math.ceil(st.resetInMs / 60000));
  return { code: 429, error: workCapMessage(min), workCapped: true, resetInMin: min };
}

// Remise à zéro du décompte du temps (assiduité) — action du formateur.
async function clearActivity() {
  if (USE_DB) { try { await sb(`/activity?user_id=neq.__none__`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) { console.error("clearActivity:", e.message); } return; }
  try { saveActivityLocal({}); } catch (e) {}
}
async function handleActivityReset(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  await clearActivity();
  sendJson(res, 200, { ok: true });
}
async function activityForUsers(userIds, dayKeys) {
  const out = {}; userIds.forEach((id) => (out[id] = {}));
  if (!userIds.length || !dayKeys.length) return out;
  if (USE_DB) {
    try {
      const uin = userIds.map((d) => `"${d}"`).join(",");
      const din = dayKeys.map((d) => `"${d}"`).join(",");
      const r = await sb(`/activity?user_id=in.(${uin})&day=in.(${din})&select=user_id,day,seconds`);
      (r || []).forEach((row) => { const uid = row.user_id, dk = String(row.day).slice(0, 10); if (!out[uid]) out[uid] = {}; out[uid][dk] = row.seconds || 0; });
    } catch (e) {}
    return out;
  }
  const a = loadActivityLocal();
  userIds.forEach((id) => { const u = a[id] || {}; dayKeys.forEach((d) => { out[id][d] = u[d] || 0; }); });
  return out;
}

// POST /api/activity/ping  { s } : battement d'activité (secondes travaillées depuis le dernier envoi)
async function handleActivityPing(req, res) {
  const u = await currentUser(req);
  if (!u) return sendJson(res, 401, { error: "Non connecté." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
  let s = parseInt(p.s, 10); if (isNaN(s)) s = 60;
  s = Math.max(0, Math.min(s, 120));                  // un battement crédite au plus 120 s ; 0 = simple lecture
  const cfg = formationConfig(await getSettings());
  let today = 0; let cap = { blocked: false, resetInMs: 0 };
  if (!isAdmin(u)) {                                   // le formateur n'est pas suivi
    if (s > 0) { today = await addActivity(u.id, s); cap = workcapAdd(u.id, s); }
    else { const day = dayKey(new Date()); const m = await activityForUsers([u.id], [day]); today = (m[u.id] && m[u.id][day]) || 0; cap = workcapState(u.id); }
  }
  sendJson(res, 200, { ok: true, todaySeconds: today, goalMin: cfg.dailyGoalMin, workCapped: cap.blocked, workResetMin: cap.blocked ? Math.max(1, Math.ceil(cap.resetInMs / 60000)) : 0, workCapMin: Math.round(WORK_CAP_SECONDS / 60) });
}

// ============================================================================
// PRÉSENCE DU SAMEDI — « Code + WiFi »
// Le formateur OUVRE la présence (il est l'ancre : ça remplace la règle « 3
// apprenants + formateur »). Les apprenants sur le MÊME réseau WiFi que le
// formateur sont mis présents automatiquement ; les autres saisissent le CODE
// affiché en salle. Correction manuelle possible. Les absences comptent dans
// le score. État de la séance : settings.attendance (seul le formateur écrit) ;
// présences : table `attendance` (une ligne par apprenant → aucun conflit même
// si tout le monde se connecte en même temps).
// ============================================================================
function genAttCode() { return String(Math.floor(1000 + Math.random() * 9000)); }
const ATT_WINDOW_MS = 5 * 60 * 60 * 1000; // la présence se ferme automatiquement 5 h après l'ouverture
function attOpenNow(st) { return !!(st && st.open && st.openedAt && (Date.now() - new Date(st.openedAt).getTime() < ATT_WINDOW_MS)); }
async function attState() { try { const s = await getSettings(); return s.attendance || { open: false }; } catch (e) { return { open: false }; } }
async function attSetState(obj) { try { await setSettings({ attendance: obj }); } catch (e) {} }
async function attAddDate(date) { try { const s = await getSettings(); const dates = Array.isArray(s.attendanceDates) ? s.attendanceDates.slice() : []; if (!dates.includes(date)) { dates.push(date); await setSettings({ attendanceDates: dates }); } } catch (e) {} }
async function attMark(date, userId, present, method) {
  if (USE_DB) { try { await sb(`/attendance?on_conflict=session_date,user_id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ session_date: date, user_id: userId, present: !!present, method: method || "auto", marked_at: new Date().toISOString() }]) }); return true; } catch (e) { return false; } }
  try { const f = path.join(DATA_DIR, "attendance.json"); let a = {}; try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {} (a[date] || (a[date] = {}))[userId] = { present: !!present, method: method || "auto", at: new Date().toISOString() }; fs.writeFileSync(f, JSON.stringify(a, null, 2)); return true; } catch (e) { return false; }
}
async function attRowsForDate(date) {
  if (USE_DB) { try { return (await sb(`/attendance?session_date=eq.${encodeURIComponent(date)}&select=user_id,present,method,marked_at`)) || []; } catch (e) { return []; } }
  try { const a = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "attendance.json"), "utf8")); return Object.keys(a[date] || {}).map((uid) => ({ user_id: uid, present: a[date][uid].present, method: a[date][uid].method, marked_at: a[date][uid].at })); } catch (e) { return []; }
}
async function attCountsByUser() {
  const out = {};
  if (USE_DB) { try { const r = (await sb(`/attendance?present=eq.true&select=user_id`)) || []; r.forEach((x) => { out[x.user_id] = (out[x.user_id] || 0) + 1; }); } catch (e) {} return out; }
  try { const a = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "attendance.json"), "utf8")); Object.keys(a).forEach((d) => Object.keys(a[d]).forEach((uid) => { if (a[d][uid].present) out[uid] = (out[uid] || 0) + 1; })); } catch (e) {}
  return out;
}
function sameNetwork(ipA, ipB) { if (!ipA || !ipB) return false; const a = String(ipA).replace(/^::ffff:/, ""), b = String(ipB).replace(/^::ffff:/, ""); return a === b; }

async function handleAttOpen(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const date = todayKey();
  const st = { open: true, date, code: genAttCode(), roomIp: clientIp(req), openedBy: u.id, openedAt: new Date().toISOString() };
  await attSetState(st); await attAddDate(date);
  sendJson(res, 200, { open: true, date, code: st.code });
}
async function handleAttClose(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const st = await attState(); st.open = false; await attSetState(st);
  sendJson(res, 200, { open: false });
}
async function handleAttStatus(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const st = await attState(); const date = st.date || todayKey();
  const openNow = attOpenNow(st);
  if (st.open && !openNow) { try { st.open = false; await attSetState(st); } catch (e) {} }   // fermeture auto après 5 h
  const rows = await attRowsForDate(date); const map = {}; rows.forEach((r) => { map[r.user_id] = r; });
  const users = (await adminListUsers()).filter((x) => !ADMIN_EMAILS.includes(normEmail(x.email)));
  const present = [], absent = [];
  users.forEach((x) => { const r = map[x.id]; if (r && r.present) present.push({ userId: x.id, name: x.name, method: r.method, at: r.marked_at }); else absent.push({ userId: x.id, name: x.name }); });
  const closesAt = (openNow && st.openedAt) ? new Date(new Date(st.openedAt).getTime() + ATT_WINDOW_MS).toISOString() : null;
  sendJson(res, 200, { open: openNow, date, code: openNow ? st.code : null, closesAt, present, absent, total: users.length });
}
async function handleAttMark(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
  if (!p.userId) return sendJson(res, 400, { error: "Apprenant manquant." });
  const st = await attState(); const date = st.date || todayKey();
  await attAddDate(date); await attMark(date, String(p.userId), !!p.present, "manuel");
  sendJson(res, 200, { ok: true });
}
async function handleAttMe(req, res) {
  const u = await currentUser(req); if (!u) return sendJson(res, 200, { open: false });
  const st = await attState(); if (!attOpenNow(st)) return sendJson(res, 200, { open: false });
  const date = st.date;
  const rows = await attRowsForDate(date); const mine = rows.find((r) => r.user_id === u.id);
  if (mine && mine.present) return sendJson(res, 200, { open: true, date, present: true });
  if (!isAdmin(u) && sameNetwork(clientIp(req), st.roomIp)) { await attMark(date, u.id, true, "wifi"); return sendJson(res, 200, { open: true, date, present: true, method: "wifi" }); }
  sendJson(res, 200, { open: true, date, present: false, needCode: true });
}
async function handleAttCheckin(req, res) {
  const u = await currentUser(req); if (!u) return sendJson(res, 401, { error: "Non connecté." });
  if (!rateOk("att:" + u.id, 10, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Trop de tentatives, patientez." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
  const st = await attState(); if (!attOpenNow(st)) return sendJson(res, 400, { error: "La présence n'est pas ouverte." });
  const code = String(p.code || "").trim();
  if (!code || code !== String(st.code)) return sendJson(res, 400, { error: "Code incorrect." });
  await attMark(st.date, u.id, true, "code");
  sendJson(res, 200, { ok: true, present: true });
}
// Annuler une séance : la retire de la liste des séances (donc du calcul des scores)
// et efface les présences enregistrées pour cette date. Utile si une séance a été
// ouverte par erreur. Par défaut la date du jour ; sinon la date fournie.
async function attRemoveDate(date) { try { const s = await getSettings(); const dates = (Array.isArray(s.attendanceDates) ? s.attendanceDates : []).filter((d) => d !== date); await setSettings({ attendanceDates: dates }); } catch (e) {} }
async function attDeleteRows(date) {
  if (USE_DB) { try { await sb(`/attendance?session_date=eq.${encodeURIComponent(date)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  try { const f = path.join(DATA_DIR, "attendance.json"); let a = {}; try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {} delete a[date]; fs.writeFileSync(f, JSON.stringify(a, null, 2)); } catch (e) {}
}
async function handleAttReset(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
  const st = await attState();
  const date = String(p.date || st.date || todayKey());
  await attRemoveDate(date);
  await attDeleteRows(date);
  if ((st.date || todayKey()) === date) { await attSetState({ open: false }); }
  sendJson(res, 200, { ok: true, date });
}

// Résumé d'avancement d'un apprenant à partir de ses projets (étapes / leçons franchies).
function progressSummary(list) {
  if (!list || !list.length) return { projects: 0, published: 0, text: "Pas encore de projet", frac: 0 };
  const published = list.filter((c) => c.publishedUrl).length;
  function frac(c) {
    if (c.track === "code") { const tot = (lessonsOf(c).length || 1); return Math.min(1, (c.lesson || 0) / tot); }
    if (c.track === "premium") { return c.publishedUrl ? 1 : 0.5; }
    return Math.min(1, (c.step || 0) / (LAST_STEP || 1));
  }
  const best = list.slice().sort((a, b) => frac(b) - frac(a))[0];
  let head;
  if (best.track === "code") { const tot = lessonsOf(best).length; head = "Prog. leçon " + Math.min((best.lesson || 0) + 1, tot) + "/" + tot; }
  else if (best.track === "premium") { head = best.publishedUrl ? "App. avancée publiée" : "App. avancée"; }
  else { const tot = STEPS.length; head = best.publishedUrl ? "Site publié ✓" : ("Site — étape " + Math.min((best.step || 0) + 1, tot) + "/" + tot); }
  return { projects: list.length, published, text: head + (list.length > 1 ? " · " + list.length + " projets" : ""), frac: frac(best) };
}

// GET /api/formation/activity : assiduité de la semaine (lun–ven) + avancement par apprenant (formateur)
async function handleFormationActivity(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const cfg = formationConfig(await getSettings());
  const goalSec = cfg.dailyGoalMin * 60;
  const users = (await adminListUsers()).filter((x) => !ADMIN_EMAILS.includes(normEmail(x.email)));
  const week = weekdaysThisWeek();
  const today = dayKey(new Date());
  const allDays = Array.from(new Set(week.concat([today]).concat(lastNDays(14))));
  const act = await activityForUsers(users.map((x) => x.id), allDays);
  // avancement : projets par apprenant
  const convs = await allConvs();
  const byUser = {};
  convs.forEach((c) => { if (!c || !c.userId) return; (byUser[c.userId] || (byUser[c.userId] = [])).push(c); });
  const learners = users.map((x) => {
    const a = act[x.id] || {};
    const days = {}; let daysMet = 0, weekTotal = 0;
    week.forEach((d) => { const sec = a[d] || 0; days[d] = sec; weekTotal += sec; if (sec >= goalSec) daysMet++; });
    const todaySec = a[today] || 0;
    // Journal « ce qu'il a fait chaque jour » : regroupe les événements des projets par date.
    const evByDay = {};
    (byUser[x.id] || []).forEach((c) => { (Array.isArray(c.log) ? c.log : []).forEach((ev) => { const d = ev.d || String(ev.at || "").slice(0, 10); if (!d) return; (evByDay[d] || (evByDay[d] = [])).push({ t: ev.t, x: ev.x, at: ev.at, project: c.projectName || null }); }); });
    const journal = Object.keys(evByDay).sort().reverse().slice(0, 14).map((d) => ({ d, seconds: a[d] || 0, events: evByDay[d].sort((p, q) => String(p.at).localeCompare(String(q.at))) }));
    return { id: x.id, name: x.name, email: x.email, cohort: x.cohort || null, status: x.status || "active", today: todaySec, metToday: todaySec >= goalSec, days, daysMetThisWeek: daysMet, weekTotal, journal, progress: progressSummary(byUser[x.id] || []) };
  });
  learners.sort((A, B) => (A.metToday - B.metToday) || (B.today - A.today));
  sendJson(res, 200, { goalMin: cfg.dailyGoalMin, week, today, learners });
}

// ============================================================
//  EXAMEN DE PROGRAMMATION (QCM) : à réussir avant l'attestation.
//  Stockage des résultats par apprenant (meilleur score conservé).
// ============================================================
const QUIZ_FILE = path.join(DATA_DIR, "quiz_results.json");
function loadQuizLocal() { try { return JSON.parse(fs.readFileSync(QUIZ_FILE, "utf8")); } catch (e) { return {}; } }
function saveQuizLocal(o) { try { fs.writeFileSync(QUIZ_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
async function getQuizResult(userId, quizId) {
  if (!userId) return null;
  if (USE_DB) {
    try { const r = await sb(`/quiz_results?user_id=eq.${encodeURIComponent(userId)}&quiz=eq.${encodeURIComponent(quizId)}&select=*`); return (r && r[0]) || null; }
    catch (e) { return null; }
  }
  const a = loadQuizLocal(); return (a[userId] && a[userId][quizId]) || null;
}
async function saveQuizResult(userId, quizId, rec) {
  if (!userId) return;
  const row = { user_id: userId, quiz: quizId, score: rec.score, total: rec.total, passed: !!rec.passed, updated_at: new Date().toISOString() };
  if (USE_DB) {
    try { await sb(`/quiz_results?on_conflict=user_id,quiz`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([row]) }); } catch (e) { console.error("saveQuizResult:", e.message); }
    return;
  }
  const a = loadQuizLocal(); (a[userId] || (a[userId] = {}))[quizId] = row; saveQuizLocal(a);
}

// GET /api/quiz/programmation : questions (sans réponses) + résultat déjà obtenu par l'apprenant
async function handleQuizGet(req, res) {
  if (!QUIZ) return sendJson(res, 404, { error: "Examen indisponible." });
  const u = await currentUser(req);
  if (!u) return sendJson(res, 401, { error: "Connectez-vous pour passer l'examen." });
  if (!canBuild(u)) return sendJson(res, 403, { error: "Votre accès à la formation n'est pas actif." });
  const prev = await getQuizResult(u.id, QUIZ.QUIZ_PROGRAMMATION.id);
  sendJson(res, 200, { quiz: QUIZ.quizForClient(QUIZ.QUIZ_PROGRAMMATION), result: prev ? { score: prev.score, total: prev.total, passed: !!prev.passed } : null });
}

// POST /api/quiz/programmation/submit { answers:{qId:index} } : notation + enregistrement (meilleur score)
async function handleQuizSubmit(req, res) {
  if (!QUIZ) return sendJson(res, 404, { error: "Examen indisponible." });
  const u = await currentUser(req);
  if (!u) return sendJson(res, 401, { error: "Connectez-vous pour passer l'examen." });
  if (!canBuild(u)) return sendJson(res, 403, { error: "Votre accès à la formation n'est pas actif." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const graded = QUIZ.gradeQuiz(QUIZ.QUIZ_PROGRAMMATION, p.answers || {});
  const prev = await getQuizResult(u.id, QUIZ.QUIZ_PROGRAMMATION.id);
  // on conserve le meilleur score / le statut « réussi » une fois obtenu
  const bestScore = prev ? Math.max(prev.score || 0, graded.score) : graded.score;
  const everPassed = (prev && prev.passed) || graded.passed;
  await saveQuizResult(u.id, QUIZ.QUIZ_PROGRAMMATION.id, { score: bestScore, total: graded.total, passed: everPassed });
  sendJson(res, 200, { score: graded.score, total: graded.total, passPct: graded.passPct, passed: graded.passed, everPassed, details: graded.details });
}

// POST /api/formation/run-maintenance (formateur) : force la vérification (rappels / file d'attente)
async function handleFormationTick(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {}
  const now = (process.env.RESV_TEST === "1" && p.nowMs) ? new Date(Number(p.nowMs)) : new Date();
  await runReservationMaintenance(now);
  sendJson(res, 200, { ok: true });
}

// GET /api/cron/maintenance?key=... : déclencheur EXTERNE (pinger) pour faire tourner les rappels
// même quand l'hébergeur met l'app en veille. Protégé par la variable d'environnement CRON_KEY.
async function handleCronMaintenance(req, res) {
  const u = new URL(req.url, "http://localhost");
  if (!process.env.CRON_KEY) { res.writeHead(501, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "CRON_KEY non configuré sur la plateforme." })); }
  if ((u.searchParams.get("key") || "") !== process.env.CRON_KEY) { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Clé invalide." })); }
  try { await runReservationMaintenance(); } catch (e) {}
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
}

// --- ADMISSION -> ACCÈS : créer/activer le compte de l'apprenant admis ---
function genTempPassword() { return "BAT-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }
async function grantAccessForReservation(resv) {
  if (!resv || !resv.email) return { created: false, email: null };
  const cohort = resv.cohortId ? await getCohort(resv.cohortId) : null;
  const existing = await findUserByEmail(resv.email);
  if (existing) {
    // Réservation validée = paiement confirmé : on coche « Payé » (accès à la programmation).
    // On ne touche pas au statut « en attente / actif / terminé » choisi par le formateur.
    const fields = { paid: true };
    if (cohort) { fields.cohort_id = cohort.id; fields.cohort = cohort.label; }
    try { await updateUser(existing.id, fields); } catch (e) {}
    return { created: false, email: resv.email };
  }
  const tempPass = genTempPassword();
  // Nouveau compte créé lors de la validation : payé, et « en attente » tant que la session n'est pas lancée.
  try { await createUser({ email: resv.email, name: resv.name, password: tempPass, status: "pending", paid: true, cohort: cohort ? cohort.label : null, cohortId: cohort ? cohort.id : null }); }
  catch (e) { return { created: false, email: resv.email, error: true }; }
  return { created: true, email: resv.email, password: tempPass };
}

// POST /api/formation/reservation/access { id } (formateur) : (re)génère un mot de passe d'accès
async function handleFormationAccess(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const r = await getReservation(p.id); if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
  if (!r.email) return sendJson(res, 400, { error: "Aucune adresse e-mail sur cette réservation." });
  const cohort = r.cohortId ? await getCohort(r.cohortId) : null;
  const tempPass = genTempPassword();
  const existing = await findUserByEmail(r.email);
  try {
    if (existing) { const fields = { status: "active", pass: hashPassword(tempPass) }; if (cohort) { fields.cohort_id = cohort.id; fields.cohort = cohort.label; } await updateUser(existing.id, fields); }
    else { await createUser({ email: r.email, name: r.name, password: tempPass, status: "active", cohort: cohort ? cohort.label : null, cohortId: cohort ? cohort.id : null }); }
  } catch (e) { return sendJson(res, 500, { error: "Impossible de générer l'accès." }); }
  sendJson(res, 200, { access: { created: !existing, email: r.email, password: tempPass } });
}

// --- Registre des certificats (pour la vérification publique) ---
const CERTS_FILE = path.join(DATA_DIR, "certificates.json");
// Clé de recherche robuste : majuscules, sans accents ni séparateurs (BÂT-1A2B → BAT1A2B).
function normalizeNum(s) { return String(s || "").toUpperCase().normalize("NFD").replace(/[^A-Z0-9]/g, ""); }
function loadCerts() { try { return JSON.parse(fs.readFileSync(CERTS_FILE, "utf8")); } catch (e) { return {}; } }
function saveCerts(o) { try { fs.writeFileSync(CERTS_FILE, JSON.stringify(o, null, 2)); } catch (e) { console.error("saveCerts:", e); } }
async function getCertificate(key) {
  if (!key) return null;
  if (USE_DB) { try { const r = await sb(`/certificates?num=eq.${encodeURIComponent(key)}&select=data`); return (r && r[0]) ? r[0].data : null; } catch (e) { console.error("getCertificate:", e.message); return null; } }
  return loadCerts()[key] || null;
}
async function saveCertificate(rec) {
  if (USE_DB) { try { await sb(`/certificates?on_conflict=num`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ num: rec.key, data: rec, created_at: new Date().toISOString() }]) }); } catch (e) { console.error("saveCertificate:", e.message); } return; }
  const o = loadCerts(); o[rec.key] = rec; saveCerts(o);
}

// GET /api/certificate?id=...&name=...
async function handleCertificate(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id);
  if (!conv) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end("Conversation introuvable."); }
  const cu = await currentUser(req);
  if (!owns(cu, conv)) { res.writeHead(403, { "content-type": "text/html; charset=utf-8" }); return res.end("Ce projet appartient à un autre compte."); }
  if (conv.userId && !canView(cu)) { res.writeHead(403, { "content-type": "text/html; charset=utf-8" }); return res.end("Accès non autorisé pour le moment."); }
  const track = (conv.track === "code") ? "code" : (conv.track === "premium" ? "premium" : "web");
  // Piste programmation : l'attestation n'est délivrée qu'après réussite de l'examen.
  let quizMention = "";
  if (track === "code") {
    const qr = QUIZ ? await getQuizResult(conv.userId, QUIZ.QUIZ_PROGRAMMATION.id) : null;
    if (!qr || !qr.passed) { res.writeHead(403, { "content-type": "text/html; charset=utf-8" }); return res.end("Pour obtenir l'attestation de programmation, vous devez d'abord réussir l'examen de programmation."); }
    quizMention = `Examen de programmation réussi : ${qr.score}/${qr.total}`;
  }
  const titleByTrack = { web: "Parcours de création de site web", code: "Parcours de programmation", premium: "Atelier d'applications avancées" };
  const descByTrack = {
    web: "a suivi et complété le parcours Bâtisseur, et a créé son propre site web en dialoguant avec l'assistant — de l'idée jusqu'à la mise en ligne.",
    code: "a suivi et complété le parcours de programmation Bâtisseur (algorithmique et Python), et a réussi l'examen de validation des connaissances.",
    premium: "a conçu et réalisé une application avancée dans l'atelier Premium de Bâtisseur."
  };
  const h1title = titleByTrack[track];
  const certDesc = descByTrack[track];
  // Le nom du compte fait foi ; sinon, le nom saisi ; sinon un libellé neutre.
  // Le nom du compte fait foi (empêche d'émettre un certificat au nom d'un autre).
  let name = (conv.ownerName || u.searchParams.get("name") || "").trim().slice(0, 80);
  if (!name) name = "Apprenant(e)";
  const now = new Date();
  const num = "BÂT-" + String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  const key = normalizeNum(num);

  // Enregistrement au registre (pour la vérification), en gardant la 1re date d'émission.
  const existing = await getCertificate(key);
  const issuedAt = (existing && existing.issuedAt) || now.toISOString();
  const issued = new Date(issuedAt);
  const dateStr = `${issued.getDate()} ${MOIS[issued.getMonth()]} ${issued.getFullYear()}`;
  let cohort = null;
  if (conv.userId) { try { const owner = await getUserById(conv.userId); cohort = (owner && owner.cohort) ? owner.cohort : null; } catch (e) {} }
  await saveCertificate({ key, number: num, name, cohort, projectId: conv.id, userId: conv.userId || null, url: conv.publishedUrl || null, date: dateStr, issuedAt });

  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  const verifyUrl = `${proto}://${req.headers.host}/verifier`;
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
  .inner{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:4.5% 9%; }
  .brand{ display:flex; align-items:center; gap:10px; }
  .logo{ width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#147C8C,#D98A2B); color:#06121c; font-weight:800; font-size:20px; display:flex; align-items:center; justify-content:center; }
  .brand b{ font-family:Georgia,serif; font-size:20px; color:#0E1B2E; }
  .kicker{ letter-spacing:.34em; text-transform:uppercase; color:#147C8C; font-size:12px; font-weight:700; margin:16px 0 4px; }
  h1{ font-family:Georgia,serif; font-size:40px; color:#0E1B2E; margin:0; }
  .sub{ color:#4a5a70; font-size:15px; margin-top:12px; }
  .name{ font-family:Georgia,serif; font-size:37px; color:#0C5866; margin:12px auto 4px; border-bottom:2px solid #D8DFE9; padding:0 30px 9px; }
  .desc{ color:#1c2b3f; font-size:15.5px; max-width:66ch; margin:13px auto 0; line-height:1.5; }
  .online{ margin-top:10px; font-size:13px; color:#4a5a70; }
  .online span{ color:#0C5866; }
  .meta{ display:flex; align-items:center; justify-content:center; gap:56px; margin-top:16px; color:#6B7A90; font-size:12.5px; }
  .meta .col{ text-align:center; }
  .meta b{ display:block; color:#0E1B2E; font-size:15px; font-family:Georgia,serif; margin-top:3px; }
  .medal{ width:112px; height:auto; }
  .sigcol{ text-align:center; margin-top:6px; }
  .signline{ width:170px; border-top:1px solid #8394a8; margin:0 auto 5px; height:20px; }
  .sigcol .lab{ font-size:12px; color:#6B7A90; }
  .sigcol .opt{ font-size:9.5px; color:#a7b2c1; }
  .verify{ margin-top:12px; font-size:11px; color:#8394a8; }
  .verify b{ color:#0C5866; font-weight:700; }
  @media print{ body{ background:#fff; padding:0; } .sheet{ box-shadow:none; width:100%; height:100vh; } .print{ display:none; } }
</style></head>
<body>
  <button class="print" onclick="window.print()">Imprimer / Enregistrer en PDF</button>
  <div class="sheet"><div class="frame"></div><div class="inner">
    <div class="brand"><span class="logo">B</span><b>Bâtisseur</b></div>
    <div class="kicker">Certificat de réussite</div>
    <h1>${escapeHtml(h1title)}</h1>
    <div class="sub">Ce certificat atteste que</div>
    <div class="name">${escapeHtml(name)}</div>
    <div class="desc">${certDesc}</div>
    ${quizMention ? `<div class="online">${escapeHtml(quizMention)}</div>` : online}
    <div class="meta">
      <div class="col">Délivré le<b>${dateStr}</b></div>
      <img class="medal" src="/batisseur-medaille.svg" alt="Médaille Bâtisseur">
      <div class="col">Certificat n°<b>${num}</b></div>
    </div>
    <div class="sigcol"><div class="signline"></div><div class="lab">Le formateur <span class="opt">(signature facultative)</span></div></div>
    <div class="verify">Authenticité vérifiable sur <b>${escapeHtml(verifyUrl)}</b> — indiquez le n° <b>${escapeHtml(num)}</b></div>
  </div></div>
</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// GET /api/verify?num=... : vérification publique d'un certificat
async function handleVerifyApi(req, res) {
  const u = new URL(req.url, "http://localhost");
  const key = normalizeNum(u.searchParams.get("num"));
  const rec = key ? await getCertificate(key) : null;
  if (!rec) return sendJson(res, 200, { valid: false });
  sendJson(res, 200, { valid: true, number: rec.number, name: rec.name, date: rec.date, cohort: rec.cohort || null, url: rec.url || null });
}

// GET /verifier : page publique de vérification d'un certificat
function handleVerifyPage(req, res) {
  const page = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vérifier un certificat — Bâtisseur</title>
<style>
  *{ box-sizing:border-box; }
  body{ margin:0; min-height:100vh; font-family:"Segoe UI",system-ui,Arial,sans-serif; background:#eef1f6; color:#0E1B2E; display:flex; align-items:flex-start; justify-content:center; padding:32px 16px; }
  @media(prefers-color-scheme:dark){ body{ background:#0A121D; color:#E9EFF6; } }
  .card{ width:100%; max-width:520px; background:#fff; border:1px solid #d8dfe9; border-radius:16px; padding:26px; box-shadow:0 12px 44px rgba(14,27,46,.10); }
  @media(prefers-color-scheme:dark){ .card{ background:#101E30; border-color:#223449; } }
  .brand{ display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .logo{ width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#147C8C,#D98A2B); color:#06121c; font-weight:800; font-size:19px; display:grid; place-items:center; }
  .brand b{ font-family:Georgia,serif; font-size:20px; }
  h1{ font-size:1.15rem; margin:6px 0 4px; }
  p.lead{ color:#6B7A90; font-size:.9rem; margin:0 0 18px; }
  form{ display:flex; gap:8px; }
  input{ flex:1; padding:12px 14px; border:1px solid #c6cfdb; border-radius:10px; font-size:1rem; background:#fff; color:#0E1B2E; }
  @media(prefers-color-scheme:dark){ input{ background:#15263B; border-color:#2E4460; color:#E9EFF6; } }
  button{ border:none; background:#147C8C; color:#fff; font-weight:600; border-radius:10px; padding:0 18px; font-size:.95rem; cursor:pointer; }
  button:hover{ filter:brightness(1.06); }
  .result{ margin-top:18px; border-radius:12px; padding:16px 18px; display:none; }
  .result.ok{ display:block; background:rgba(46,139,111,.10); border:1px solid rgba(46,139,111,.45); }
  .result.no{ display:block; background:rgba(192,57,43,.08); border:1px solid rgba(192,57,43,.4); }
  .result h2{ margin:0 0 8px; font-size:1rem; }
  .result .who{ font-family:Georgia,serif; font-size:1.5rem; margin:2px 0 6px; }
  .result .row{ font-size:.9rem; color:#33445C; margin-top:3px; }
  @media(prefers-color-scheme:dark){ .result .row{ color:#AFBED2; } }
  .result a{ color:#0C5866; }
  .foot{ margin-top:18px; font-size:.78rem; color:#8394a8; text-align:center; }
</style></head>
<body>
  <div class="card">
    <div class="brand"><span class="logo">B</span><b>Bâtisseur</b></div>
    <h1>Vérifier un certificat</h1>
    <p class="lead">Saisissez le numéro figurant sur le certificat (ex. BÂT-1A2B3C4D) pour confirmer son authenticité.</p>
    <form id="f">
      <input id="num" placeholder="Numéro du certificat" autocomplete="off" autocapitalize="characters">
      <button type="submit">Vérifier</button>
    </form>
    <div class="result" id="res"></div>
    <div class="foot">Formation Bâtisseur — attestation de réussite (non accréditée par l'État).</div>
  </div>
  <script>
    const res = document.getElementById("res"), num = document.getElementById("num");
    function esc(s){ const d=document.createElement("div"); d.textContent=(s==null?"":s); return d.innerHTML; }
    async function check(){
      const v = num.value.trim();
      if(!v){ return; }
      res.className="result"; res.style.display="none";
      try{
        const r = await fetch("/api/verify?num=" + encodeURIComponent(v));
        const d = await r.json();
        if(d.valid){
          res.className="result ok";
          res.innerHTML = '<h2>Certificat authentique</h2>'
            + '<div class="who">' + esc(d.name) + '</div>'
            + '<div class="row">a complété le parcours de création de site web Bâtisseur.</div>'
            + '<div class="row">Délivré le <b>' + esc(d.date) + '</b> · N° <b>' + esc(d.number) + '</b></div>'
            + (d.cohort ? '<div class="row">Session : ' + esc(d.cohort) + '</div>' : '')
            + (d.url ? '<div class="row">Projet en ligne : <a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.url) + '</a></div>' : '');
        } else {
          res.className="result no";
          res.innerHTML = '<h2>Aucun certificat trouvé</h2><div class="row">Ce numéro ne correspond à aucun certificat délivré. Vérifiez la saisie.</div>';
        }
      }catch(e){ res.className="result no"; res.innerHTML='<div class="row">Vérification impossible pour le moment.</div>'; }
    }
    document.getElementById("f").addEventListener("submit",(e)=>{ e.preventDefault(); check(); });
    const q = new URLSearchParams(location.search).get("num");
    if(q){ num.value=q; check(); }
  </script>
</body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}

// ============================================================
// APPLICATIONS WEB — ENREGISTREMENT DES DONNÉES (Niveau 2, Étape A)
// Les commandes / rendez-vous / messages envoyés depuis un site publié sont
// enregistrés (isolés par projet), et le propriétaire les retrouve dans son espace.
// ============================================================
const SUBS_FILE = path.join(DATA_DIR, "submissions.json");
function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")); } catch (e) { return []; } }
function saveSubs(a) { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error("saveSubs:", e); } }
const SUB_STATUSES = ["nouveau", "en_cours", "pret", "termine"];
async function addSubmission(rec) {
  if (USE_DB) { try { await sb(`/submissions`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ id: rec.id, project_id: rec.projectId, collection: rec.collection, data: rec.data, status: rec.status || "nouveau", created_at: rec.createdAt }]) }); } catch (e) { console.error("addSubmission:", e.message); } return; }
  const a = loadSubs(); a.push(rec); saveSubs(a);
}
async function listSubmissions(projectId) {
  if (USE_DB) { try { const r = await sb(`/submissions?project_id=eq.${encodeURIComponent(projectId)}&select=*&order=created_at.desc`); return (r || []).map((x) => ({ id: x.id, projectId: x.project_id, collection: x.collection, data: x.data, status: x.status || "nouveau", createdAt: x.created_at })); } catch (e) { return []; } }
  return loadSubs().filter((s) => s.projectId === projectId).map((s) => Object.assign({ status: "nouveau" }, s)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function deleteSubmission(id, projectId) {
  if (USE_DB) { try { await sb(`/submissions?id=eq.${encodeURIComponent(id)}&project_id=eq.${encodeURIComponent(projectId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  saveSubs(loadSubs().filter((s) => !(s.id === id && s.projectId === projectId)));
}
async function updateSubmissionStatus(id, projectId, status) {
  if (USE_DB) { try { await sb(`/submissions?id=eq.${encodeURIComponent(id)}&project_id=eq.${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status }) }); } catch (e) {} return; }
  const a = loadSubs(); a.forEach((s) => { if (s.id === id && s.projectId === projectId) s.status = status; }); saveSubs(a);
}

// --- FICHIERS JOINTS (upload par les visiteurs des applications) -----------
// Un visiteur peut joindre un fichier (photo, PDF, document) à une commande,
// un rendez-vous ou un message. Le fichier est stocké côté plateforme (base ou
// fichier local) et SEUL le propriétaire peut le télécharger depuis son tableau
// de bord. Aucune dépendance : le fichier arrive en base64 dans un POST JSON.
const UPLOADS_FILE = path.join(DATA_DIR, "uploads.json");
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;          // 3 Mo par fichier
const UPLOAD_TYPES_OK = /^(image\/(png|jpeg|jpg|webp|gif|heic|heif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-(excel|powerpoint)|text\/plain|text\/csv)$/i;
function loadUploads() { try { return JSON.parse(fs.readFileSync(UPLOADS_FILE, "utf8")); } catch (e) { return []; } }
function saveUploads(a) { try { fs.writeFileSync(UPLOADS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error("saveUploads:", e); } }
function safeName(name) {
  let n = String(name || "fichier").replace(/[\/\\]/g, "_").replace(/[^\w .()\-À-ÿ]/g, "").trim();
  n = n.slice(-80) || "fichier";
  return n;
}
async function addUpload(rec) {
  if (USE_DB) { await sb(`/uploads`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ id: rec.id, project_id: rec.projectId, name: rec.name, type: rec.type, size: rec.size, data: rec.data, created_at: rec.createdAt }]) }); return; }
  const a = loadUploads(); a.push(rec); saveUploads(a);
}
async function getUpload(id, projectId) {
  if (USE_DB) { try { const r = await sb(`/uploads?id=eq.${encodeURIComponent(id)}&project_id=eq.${encodeURIComponent(projectId)}&select=*`); const x = (r || [])[0]; return x ? { id: x.id, projectId: x.project_id, name: x.name, type: x.type, size: x.size, data: x.data } : null; } catch (e) { return null; } }
  return loadUploads().find((u) => u.id === id && u.projectId === projectId) || null;
}
async function deleteUpload(id, projectId) {
  if (USE_DB) { try { await sb(`/uploads?id=eq.${encodeURIComponent(id)}&project_id=eq.${encodeURIComponent(projectId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  saveUploads(loadUploads().filter((u) => !(u.id === id && u.projectId === projectId)));
}

// Limiteur de débit en mémoire (anti-abus) + en-têtes CORS pour l'écriture publique.
const RL = {};
function rateOk(key, limit, windowMs) { const now = Date.now(); const arr = (RL[key] || []).filter((t) => now - t < windowMs); arr.push(now); RL[key] = arr; return arr.length <= limit; }
function corsHeaders() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" }; }
function sendJsonCors(res, code, obj) { res.writeHead(code, Object.assign({ "content-type": "application/json; charset=utf-8" }, corsHeaders())); res.end(JSON.stringify(obj)); }

// POST /api/app/submit  { app, collection, data }  — appelé par les sites publiés (public)
async function handleSubmit(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app;
    if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    const collection = (String(p.collection || "message").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)) || "message";
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?";
    if (!rateOk(app + ":" + ip, 15, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop de demandes. Réessayez dans quelques minutes." });
    if (!rateOk("app:" + app, 400, 24 * 60 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Limite journalière atteinte." });
    const conv = await loadConv(app);
    if (!conv) return sendJsonCors(res, 404, { error: "Application introuvable." });
    let data = p.data;
    if (data === null || typeof data !== "object") data = { valeur: String(data == null ? "" : data).slice(0, 2000) };
    if (Array.isArray(data)) data = { liste: data };
    const raw = JSON.stringify(data);
    if (raw.length > 8000) return sendJsonCors(res, 413, { error: "Données trop volumineuses." });
    const clean = {};
    Object.keys(data).slice(0, 20).forEach((k) => {
      const kk = String(k).slice(0, 60); let v = data[k];
      if (typeof v === "string") v = v.slice(0, 2000);
      else if (typeof v === "object" && v !== null) { try { v = JSON.parse(JSON.stringify(v)); } catch (e) { v = null; } }
      clean[kk] = v;
    });
    // Si l'envoi vient d'un membre connecté, on le rattache (visible par le propriétaire).
    if (p.token) { try { const m = await appSessionUser(p.token, app); if (m) clean._membre = m.email; } catch (e) {} }
    await addSubmission({ id: crypto.randomUUID(), projectId: app, collection, data: clean, status: "nouveau", createdAt: new Date().toISOString() });
    sendJsonCors(res, 200, { ok: true });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/app/list  { app, collection, token?, limit? }  — public : LECTURE de données partagées.
// Règle de sécurité :
//   • collection dont le nom commence par "public_"  → lisible par tout le monde (annuaire, annonces…)
//     (les champs privés préfixés par "_", comme l'e-mail du membre, sont retirés de la réponse) ;
//   • toute autre collection                          → privée : il faut un jeton membre valide, et on
//     ne renvoie QUE les enregistrements de ce membre (ex. « mes commandes »).
async function handleAppList(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app;
    if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    const collection = String(p.collection || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    if (!collection) return sendJsonCors(res, 400, { error: "Collection manquante." });
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?";
    if (!rateOk("list:" + app + ":" + ip, 120, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop de requêtes. Réessayez dans quelques minutes." });
    const conv = await loadConv(app);
    if (!conv) return sendJsonCors(res, 404, { error: "Application introuvable." });
    const isPublic = /^public_/.test(collection);
    let email = null;
    if (!isPublic) {
      const m = p.token ? await appSessionUser(p.token, app) : null;
      if (!m) return sendJsonCors(res, 403, { error: "Connexion requise pour accéder à ces données." });
      email = m.email;
    }
    const limit = Math.min(Math.max(parseInt(p.limit, 10) || 50, 1), 200);
    let rows = (await listSubmissions(app)).filter((s) => s.collection === collection);
    if (!isPublic) rows = rows.filter((s) => s.data && s.data._membre === email);
    const items = rows.slice(0, limit).map((s) => {
      let d = s.data || {};
      if (isPublic) { d = Object.assign({}, d); Object.keys(d).forEach((k) => { if (k.charAt(0) === "_") delete d[k]; }); }
      return { id: s.id, data: d, createdAt: s.createdAt };
    });
    sendJsonCors(res, 200, { items });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/app/upload  { app, name, type, size, data(base64) }  — public (sites publiés)
async function handleUpload(req, res) {
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app;
    if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?";
    if (!rateOk("up:" + app + ":" + ip, 20, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop d'envois de fichiers. Réessayez dans quelques minutes." });
    if (!rateOk("upday:" + app, 300, 24 * 60 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Limite journalière atteinte." });
    const conv = await loadConv(app);
    if (!conv) return sendJsonCors(res, 404, { error: "Application introuvable." });
    const type = String(p.type || "").slice(0, 100);
    if (!UPLOAD_TYPES_OK.test(type)) return sendJsonCors(res, 415, { error: "Type de fichier non pris en charge." });
    const b64 = String(p.data || "").replace(/^data:[^,]*,/, "");
    if (!b64 || b64.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 1024) return sendJsonCors(res, 413, { error: "Fichier trop volumineux (maximum 3 Mo)." });
    let buf; try { buf = Buffer.from(b64, "base64"); } catch (e) { return sendJsonCors(res, 400, { error: "Fichier illisible." }); }
    if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return sendJsonCors(res, 413, { error: "Fichier trop volumineux (maximum 3 Mo)." });
    const name = safeName(p.name);
    const id = crypto.randomUUID();
    try { await addUpload({ id, projectId: app, name, type, size: buf.length, data: b64, createdAt: new Date().toISOString() }); }
    catch (e) { return sendJsonCors(res, 500, { error: "Enregistrement du fichier impossible." }); }
    sendJsonCors(res, 200, { id, name, type, size: buf.length });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}

// GET /api/upload?id=&projectId=  — téléchargement RÉSERVÉ au propriétaire du projet
async function handleUploadDownload(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id"); const projectId = u.searchParams.get("projectId");
  const conv = await loadConv(projectId);
  if (!conv) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Projet introuvable."); }
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Accès non autorisé."); }
  const up = await getUpload(id, projectId);
  if (!up) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Fichier introuvable."); }
  let buf; try { buf = Buffer.from(String(up.data || "").replace(/^data:[^,]*,/, ""), "base64"); } catch (e) { buf = Buffer.alloc(0); }
  const disp = (u.searchParams.get("view") === "1") ? "inline" : "attachment";
  res.writeHead(200, {
    "content-type": (up.type && /^[\w.+/-]+$/.test(up.type)) ? up.type : "application/octet-stream",
    "content-disposition": disp + '; filename="' + safeName(up.name).replace(/"/g, "") + '"',
    "content-length": buf.length,
    "cache-control": "private, no-store"
  });
  res.end(buf);
}

// GET /api/submissions?id=<projet>  — le propriétaire consulte les données reçues
async function handleSubmissions(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id);
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  sendJson(res, 200, { submissions: await listSubmissions(id) });
}

// POST /api/submissions/delete  { id, projectId }
async function handleSubmissionDelete(req, res) {
  const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
  const conv = await loadConv(p.projectId);
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  // Supprime aussi les fichiers joints à cet envoi.
  try {
    const subs = await listSubmissions(p.projectId);
    const target = subs.find((s) => s.id === p.id);
    const fs2 = target && target.data && Array.isArray(target.data.fichiers) ? target.data.fichiers : [];
    for (const f of fs2) { if (f && f.id) await deleteUpload(f.id, p.projectId); }
  } catch (e) {}
  await deleteSubmission(p.id, p.projectId);
  sendJson(res, 200, { ok: true });
}

// POST /api/submissions/status  { id, projectId, status }
async function handleSubmissionStatus(req, res) {
  const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
  if (!SUB_STATUSES.includes(p.status)) return sendJson(res, 400, { error: "Statut invalide." });
  const conv = await loadConv(p.projectId);
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  await updateSubmissionStatus(p.id, p.projectId, p.status);
  sendJson(res, 200, { ok: true });
}

// --- COMPTES DES VISITEURS d'une application (Étape B) ---
// Séparés des comptes Bâtisseur. Un compte appartient à UNE application (isolé).
// Authentification par jeton (stocké côté site dans le navigateur), pas de cookie
// tiers (le site publié est sur un autre domaine).
const APP_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 60;
const APPUSERS_FILE = path.join(DATA_DIR, "app_users.json");
function loadAppUsers() { try { return JSON.parse(fs.readFileSync(APPUSERS_FILE, "utf8")); } catch (e) { return { users: {}, sessions: {} }; } }
function saveAppUsers(a) { try { fs.writeFileSync(APPUSERS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error("saveAppUsers:", e); } }
async function findAppUser(appId, email) {
  const e = normEmail(email);
  if (USE_DB) { try { const r = await sb(`/app_users?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(e)}&select=*`); return (r && r[0]) || null; } catch (err) { return null; } }
  return Object.values(loadAppUsers().users).find((u) => u.app_id === appId && u.email === e) || null;
}
async function getAppUserById(id) {
  if (!id) return null;
  if (USE_DB) { try { const r = await sb(`/app_users?id=eq.${encodeURIComponent(id)}&select=*`); return (r && r[0]) || null; } catch (e) { return null; } }
  return loadAppUsers().users[id] || null;
}
async function createAppUser(appId, email, name, password) {
  const e = normEmail(email);
  const user = { id: crypto.randomUUID(), app_id: appId, email: e, name: String(name || "").trim().slice(0, 80) || e.split("@")[0], pass: hashPassword(password), created_at: new Date().toISOString() };
  if (USE_DB) { await sb(`/app_users`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([user]) }); }
  else { const a = loadAppUsers(); a.users[user.id] = user; saveAppUsers(a); }
  return user;
}
async function createAppSession(appId, userId) {
  const token = crypto.randomBytes(32).toString("hex"); const created_at = new Date().toISOString();
  if (USE_DB) { await sb(`/app_sessions`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ token, app_id: appId, user_id: userId, created_at }]) }); }
  else { const a = loadAppUsers(); a.sessions[token] = { userId, appId, at: Date.now() }; saveAppUsers(a); }
  return token;
}
async function deleteAppSession(token) {
  if (!token) return;
  if (USE_DB) { try { await sb(`/app_sessions?token=eq.${encodeURIComponent(token)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {} return; }
  const a = loadAppUsers(); if (a.sessions[token]) { delete a.sessions[token]; saveAppUsers(a); }
}
async function appSessionUser(token, appId) {
  if (!token) return null;
  if (USE_DB) {
    try {
      const r = await sb(`/app_sessions?token=eq.${encodeURIComponent(token)}&select=user_id,app_id,created_at`);
      const s = r && r[0]; if (!s) return null;
      if (appId && s.app_id !== appId) return null;
      if (Date.now() - new Date(s.created_at).getTime() > APP_SESSION_TTL_MS) { await deleteAppSession(token); return null; }
      return await getAppUserById(s.user_id);
    } catch (e) { return null; }
  }
  const a = loadAppUsers(); const s = a.sessions[token]; if (!s) return null;
  if (appId && s.appId !== appId) return null;
  if (Date.now() - (s.at || 0) > APP_SESSION_TTL_MS) { delete a.sessions[token]; saveAppUsers(a); return null; }
  return a.users[s.userId] || null;
}
function publicAppUser(u) { return u ? { id: u.id, name: u.name, email: u.email } : null; }
async function listAppUsers(appId) {
  if (USE_DB) { try { return (await sb(`/app_users?app_id=eq.${encodeURIComponent(appId)}&select=id,name,email,created_at&order=created_at.desc`)) || []; } catch (e) { return []; } }
  return Object.values(loadAppUsers().users).filter((u) => u.app_id === appId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
function reqIp(req) { return (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "?"; }

// POST /api/app/auth/register  { app, email, name, password }
async function handleAppRegister(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app; if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    if (!rateOk("auth:" + app + ":" + reqIp(req), 25, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop de tentatives. Réessayez plus tard." });
    const email = normEmail(p.email); if (!validEmail(email)) return sendJsonCors(res, 400, { error: "Adresse e-mail invalide." });
    if (typeof p.password !== "string" || p.password.length < 6) return sendJsonCors(res, 400, { error: "Mot de passe : 6 caractères minimum." });
    const conv = await loadConv(app); if (!conv) return sendJsonCors(res, 404, { error: "Application introuvable." });
    if (await findAppUser(app, email)) return sendJsonCors(res, 409, { error: "Un compte existe déjà avec cette adresse." });
    const user = await createAppUser(app, email, p.name, p.password);
    const token = await createAppSession(app, user.id);
    sendJsonCors(res, 200, { token, user: publicAppUser(user) });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}
// POST /api/app/auth/login  { app, email, password }
async function handleAppLogin(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJsonCors(res, 400, { error: "Requête invalide." }); }
    const app = p.app; if (!validId(app)) return sendJsonCors(res, 400, { error: "Application inconnue." });
    if (!rateOk("auth:" + app + ":" + reqIp(req), 25, 10 * 60 * 1000)) return sendJsonCors(res, 429, { error: "Trop de tentatives. Réessayez plus tard." });
    const user = await findAppUser(app, p.email);
    if (!user || !verifyPassword(p.password, user.pass)) return sendJsonCors(res, 401, { error: "E-mail ou mot de passe incorrect." });
    const token = await createAppSession(app, user.id);
    sendJsonCors(res, 200, { token, user: publicAppUser(user) });
  } catch (e) { sendJsonCors(res, 500, { error: "Erreur serveur." }); }
}
// POST /api/app/auth/me  { app, token }
async function handleAppMe(req, res) {
  try { let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {} const u = await appSessionUser(p.token, p.app); sendJsonCors(res, 200, { user: publicAppUser(u) }); }
  catch (e) { sendJsonCors(res, 200, { user: null }); }
}
// POST /api/app/auth/logout  { token }
async function handleAppLogout(req, res) {
  try { let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) {} await deleteAppSession(p.token); } catch (e) {}
  sendJsonCors(res, 200, { ok: true });
}
// GET /api/app-users?id=<projet>  (propriétaire : liste des membres)
async function handleAppUsersList(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  const members = (await listAppUsers(id)).map((m) => ({ name: m.name, email: m.email, createdAt: m.created_at }));
  sendJson(res, 200, { members });
}

// POST /api/project/name  { id, name } — le propriétaire nomme (ou renomme) son projet.
async function handleProjectName(req, res) {
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const conv = await loadConv(p.id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  const name = String(p.name || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  conv.projectName = name || null;
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  sendJson(res, 200, { ok: true, projectName: conv.projectName });
}

// POST /api/project/upgrade { id } — le propriétaire (autorisé Premium) fait passer un projet
// de « site débutant » à l'atelier avancé, en conservant le site existant comme point de départ.
async function handleProjectUpgrade(req, res) {
  let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
  const conv = await loadConv(p.id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  if (!canPremium(cu)) return sendJson(res, 403, { error: "L'atelier avancé n'est pas activé pour votre compte. Demandez à votre formateur." });
  if (conv.track === "code") return sendJson(res, 400, { error: "Un parcours de programmation ne se convertit pas en projet." });
  if (conv.track === "premium") return sendJson(res, 200, { ok: true, already: true });
  conv.track = "premium";
  conv.updatedAt = new Date().toISOString();
  await saveConv(conv);
  sendJson(res, 200, { ok: true });
}

// GET /api/project/dashboard?id=<projet> — tableau de bord du propriétaire :
// le nom du projet, ses membres, et ses données regroupées par collection.
async function handleProjectDashboard(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) return sendJson(res, 403, { error: "Non autorisé." });
  const members = (await listAppUsers(id)).map((m) => ({ name: m.name, email: m.email, createdAt: m.created_at || m.createdAt || null }));
  const subs = await listSubmissions(id);
  const collections = {};
  subs.forEach((s) => { const c = s.collection || "message"; (collections[c] = collections[c] || []).push({ id: s.id, data: s.data, status: s.status, createdAt: s.createdAt }); });
  sendJson(res, 200, { projectName: conv.projectName || null, title: convTitle(conv), memberCount: members.length, members, collections });
}

// GET /api/project/export?id=<projet> — télécharge l'application (index.html) prête à être
// déployée seule : la boîte à outils Batisseur y pointe vers « /api/app » (le serveur autonome
// fourni dans le kit d'export), au lieu du serveur de Bâtisseur.
async function handleProjectExport(req, res) {
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  const conv = await loadConv(id); if (!conv) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Projet introuvable."); }
  const cu = await currentUser(req);
  if (!owns(cu, conv) || (conv.userId && !canView(cu))) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("Non autorisé."); }
  let html = stripKit(await readSite(id)) || "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><title>Mon projet</title></head><body><h1>Mon projet</h1></body></html>";
  try { html = injectAppKit(html, conv, ""); } catch (e) {}   // base relative "/api/app"
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-disposition": 'attachment; filename="index.html"' });
  res.end(html);
}

// ============================================================================
// « COMPRENDRE MON APPLICATION » — les coulisses du code
// L'apprenant qui a construit un projet peut voir son code et comprendre ce
// qu'il y a derrière. ÉCONOMIE DES CRÉDITS : l'explication personnalisée est
// générée UNE SEULE FOIS puis enregistrée (conv.explain) ; on la ressert
// gratuitement tant que le code ne change pas. Les questions libres sont
// plafonnées et sauvegardées (conv.explainFaq) : une réponse sert à tous.
// ============================================================================
const EXPLAIN_MAX_Q = parseInt(process.env.EXPLAIN_MAX_Q, 10) || 6;
function codeHash(s) { try { return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16); } catch (e) { return String((s || "").length); } }
const EXPLAIN_SYSTEM = `Tu es un formateur bienveillant qui explique, EN FRANÇAIS SIMPLE, les coulisses d'une application web à une personne débutante qui vient de la créer (sans coder elle-même). On te donne le code (HTML/CSS/JavaScript). Explique ce qu'il y a derrière, de façon claire, encourageante et structurée, en t'appuyant sur SON code réel. Couvre notamment :
- La STRUCTURE / mise en page (ce qui place les éléments : HTML, puis flexbox/grid en CSS).
- Les COULEURS et le style (les variables de couleur, où elles sont définies, le rôle du CSS).
- Les TEXTES et le contenu.
- Les INTERACTIONS (boutons, formulaires) et, s'il y en a, le JavaScript et la « boîte à outils Batisseur » qui enregistre/affiche les données partagées, gère les comptes, le paiement.
- Les ANIMATIONS éventuelles.
Cite de courts extraits de SON code entre balises \`\`\` quand c'est utile, mais garde des explications courtes et accessibles (pas de jargon inutile). Termine par une phrase d'encouragement. N'invente rien qui ne soit pas dans le code.`;

// GET /api/project/code?id=... — renvoie le code de l'application (lecture seule)
async function handleProjectCode(req, res) {
  const u = new URL(req.url, "http://localhost");
  const conv = await loadConv(u.searchParams.get("id"));
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
  if (conv.userId && !canView(cu)) return sendJson(res, 403, { error: "Accès non autorisé pour le moment." });
  const code = stripKit(await readSite(conv.id)) || "";
  sendJson(res, 200, { hasCode: !!code, code });
}

// GET /api/project/explain?id=... — état de l'explication (sans rien générer)
async function handleProjectExplain(req, res) {
  const u = new URL(req.url, "http://localhost");
  const conv = await loadConv(u.searchParams.get("id"));
  if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
  const cu = await currentUser(req);
  if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
  if (conv.userId && !canView(cu)) return sendJson(res, 403, { error: "Accès non autorisé pour le moment." });
  const code = stripKit(await readSite(conv.id)) || "";
  const ex = conv.explain || null;
  const faq = conv.explainFaq || [];
  sendJson(res, 200, {
    hasCode: !!code,
    explanation: ex ? ex.text : null,
    generatedAt: ex ? ex.at : null,
    stale: ex ? (ex.codeHash !== codeHash(code)) : false,
    faq,
    questionsLeft: Math.max(0, EXPLAIN_MAX_Q - faq.length)
  });
}

// POST /api/project/explain/generate {id} — génère UNE fois et enregistre (sinon ressert le cache)
async function handleProjectExplainGenerate(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
    const conv = await loadConv(p.id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
    const cu = await currentUser(req);
    if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    if (conv.userId && !canView(cu)) return sendJson(res, 403, { error: "Accès non autorisé pour le moment." });
    const code = stripKit(await readSite(conv.id)) || "";
    if (!code) return sendJson(res, 400, { error: "Construisez d'abord votre projet : il n'y a pas encore de code à expliquer." });
    const h = codeHash(code);
    if (conv.explain && conv.explain.codeHash === h) return sendJson(res, 200, { explanation: conv.explain.text, generatedAt: conv.explain.at, cached: true });
    if (!(await aiQuotaGuard(cu))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    const msg = [{ role: "user", content: "Voici le code de mon application. Explique-moi, simplement, ce qu'il y a derrière :\n```html\n" + code.slice(0, 48000) + "\n```" }];
    const text = await callClaude(EXPLAIN_SYSTEM, msg, MODEL_LIGHT, 2048);
    conv.explain = { text: String(text || "").trim(), codeHash: h, at: new Date().toISOString() };
    conv.updatedAt = new Date().toISOString();
    await saveConv(conv);
    sendJson(res, 200, { explanation: conv.explain.text, generatedAt: conv.explain.at, cached: false });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

// POST /api/project/explain/ask {id, question} — question libre, plafonnée et sauvegardée
async function handleProjectExplainAsk(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "Clé API manquante." });
  try {
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
    const conv = await loadConv(p.id); if (!conv) return sendJson(res, 404, { error: "Projet introuvable." });
    const cu = await currentUser(req);
    if (!owns(cu, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    if (conv.userId && !canView(cu)) return sendJson(res, 403, { error: "Accès non autorisé pour le moment." });
    const faq = conv.explainFaq || [];
    if (faq.length >= EXPLAIN_MAX_Q) return sendJson(res, 200, { faq, questionsLeft: 0, limited: true });
    const q = String(p.question || "").trim().slice(0, 300);
    if (!q) return sendJson(res, 400, { error: "Question vide." });
    if (!(await aiQuotaGuard(cu))) return sendJson(res, 429, { error: AI_QUOTA_MSG, aiQuota: true });
    const code = stripKit(await readSite(conv.id)) || "";
    const sys = EXPLAIN_SYSTEM + "\n\nIci, réponds UNIQUEMENT et BRIÈVEMENT à la question posée, en t'appuyant sur le code ci-dessous.";
    const text = await callClaude(sys, [{ role: "user", content: "Code de l'application :\n```html\n" + code.slice(0, 48000) + "\n```\n\nMa question : " + q }], MODEL_LIGHT, 1024);
    faq.push({ q, a: String(text || "").trim(), at: new Date().toISOString() });
    conv.explainFaq = faq; conv.updatedAt = new Date().toISOString();
    await saveConv(conv);
    sendJson(res, 200, { faq, questionsLeft: Math.max(0, EXPLAIN_MAX_Q - faq.length) });
  } catch (e) { sendJson(res, e.status || 500, { error: e.message || "Erreur serveur." }); }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/app/")) { res.writeHead(204, corsHeaders()); return res.end(); }
  if (req.method === "GET") { logVisit(req); }   // journal des visites (pages seulement, non bloquant)
  if (req.method === "POST" && req.url === "/api/start") return handleStart(req, res);
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/next") return handleNext(req, res);
  if (req.method === "POST" && req.url === "/api/goto") return handleGoto(req, res);
  if (req.method === "POST" && req.url === "/api/add-module") return handleAddModule(req, res);
  if (req.method === "POST" && req.url === "/api/page-mode") return handlePageMode(req, res);
  if (req.method === "POST" && req.url === "/api/publish") return handlePublish(req, res);
  if (req.method === "POST" && req.url === "/api/auth/register") return handleRegister(req, res);
  if (req.method === "POST" && req.url === "/api/auth/login") return handleLogin(req, res);
  if (req.method === "POST" && req.url === "/api/auth/logout") return handleLogout(req, res);
  if (req.method === "POST" && req.url === "/api/auth/forgot") return handleForgot(req, res);
  if (req.method === "POST" && req.url === "/api/auth/reset") return handleReset(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/auth/me")) return handleMe(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/projects")) return handleProjects(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/learners")) return handleAdminLearners(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/ai-stats")) return handleAiStats(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/export")) return handleAdminExport(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/premium-board")) return handlePremiumBoard(req, res);
  if (req.method === "POST" && req.url === "/api/admin/premium-note") return handlePremiumNote(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/create") return handleAdminCreate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/update") return handleAdminUpdate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/delete") return handleAdminDelete(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/cohorts")) return handleAdminCohorts(req, res);
  if (req.method === "POST" && req.url === "/api/admin/cohort/generate") return handleAdminCohortGenerate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/cohort/update") return handleAdminCohortUpdate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/cohort/launch") return handleAdminCohortLaunch(req, res);
  if (req.method === "GET" && (req.url === "/api/admin/visits.pdf" || req.url.startsWith("/api/admin/visits.pdf?"))) return handleAdminVisitsPdf(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/visits")) return handleAdminVisits(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/cohorts")) return handleCohorts(req, res);
  if (req.method === "POST" && req.url === "/api/app/submit") return handleSubmit(req, res);
  if (req.method === "POST" && req.url === "/api/app/list") return handleAppList(req, res);
  if (req.method === "POST" && req.url === "/api/app/upload") return handleUpload(req, res);
  if (req.method === "POST" && req.url === "/api/app/pay") return handlePay(req, res);
  if (req.method === "POST" && req.url === "/api/wave/webhook") return handleWaveWebhook(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/payment")) return handleGetPayment(req, res);
  if (req.method === "POST" && req.url === "/api/payment/config") return handleSetPayment(req, res);
  if (req.method === "POST" && req.url === "/api/app/auth/register") return handleAppRegister(req, res);
  if (req.method === "POST" && req.url === "/api/app/auth/login") return handleAppLogin(req, res);
  if (req.method === "POST" && req.url === "/api/app/auth/me") return handleAppMe(req, res);
  if (req.method === "POST" && req.url === "/api/app/auth/logout") return handleAppLogout(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/app-users")) return handleAppUsersList(req, res);
  if (req.method === "POST" && req.url === "/api/project/name") return handleProjectName(req, res);
  if (req.method === "POST" && req.url === "/api/project/upgrade") return handleProjectUpgrade(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/project/dashboard")) return handleProjectDashboard(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/project/export")) return handleProjectExport(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/project/code")) return handleProjectCode(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/project/explain")) return handleProjectExplain(req, res);
  if (req.method === "POST" && req.url === "/api/project/explain/generate") return handleProjectExplainGenerate(req, res);
  if (req.method === "POST" && req.url === "/api/project/explain/ask") return handleProjectExplainAsk(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/upload")) return handleUploadDownload(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/submissions")) return handleSubmissions(req, res);
  if (req.method === "POST" && req.url === "/api/submissions/delete") return handleSubmissionDelete(req, res);
  if (req.method === "POST" && req.url === "/api/submissions/status") return handleSubmissionStatus(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/config")) return handleConfig(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/certificate")) return handleCertificate(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/verify")) return handleVerifyApi(req, res);
  if (req.method === "GET" && req.url.startsWith("/verifier")) return handleVerifyPage(req, res);
  // Réservations de session avec paiement
  if (req.method === "GET" && req.url.startsWith("/api/formation/sessions")) return handleFormationSessions(req, res);
  if (req.method === "POST" && req.url === "/api/reservations") return handleReserve(req, res);
  if (req.method === "POST" && req.url === "/api/reservations/declare") return handleReserveDeclare(req, res);
  if (req.method === "POST" && req.url === "/api/reservations/proof") return handleReserveProof(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/reservation/proof")) return handleReserveProofView(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/formation/roster")) return handleFormationRoster(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/formation/reservations")) return handleFormationReservations(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/status") return handleFormationReservationStatus(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/delete") return handleFormationReservationDelete(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/cash") return handleFormationCash(req, res);
  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/api/formation/settings")) return handleFormationSettings(req, res);
  if (req.method === "POST" && req.url === "/api/activity/ping") return handleActivityPing(req, res);
  if (req.method === "POST" && req.url === "/api/admin/activity/reset") return handleActivityReset(req, res);
  if (req.method === "POST" && req.url === "/api/attendance/open") return handleAttOpen(req, res);
  if (req.method === "POST" && req.url === "/api/attendance/close") return handleAttClose(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/attendance/status")) return handleAttStatus(req, res);
  if (req.method === "POST" && req.url === "/api/attendance/mark") return handleAttMark(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/attendance/me")) return handleAttMe(req, res);
  if (req.method === "POST" && req.url === "/api/attendance/checkin") return handleAttCheckin(req, res);
  if (req.method === "POST" && req.url === "/api/attendance/reset") return handleAttReset(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/formation/activity")) return handleFormationActivity(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/quiz/programmation")) return handleQuizGet(req, res);
  if (req.method === "POST" && req.url === "/api/quiz/programmation/submit") return handleQuizSubmit(req, res);
  if (req.method === "POST" && req.url === "/api/formation/run-maintenance") return handleFormationTick(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/access") return handleFormationAccess(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/cron/maintenance")) return handleCronMaintenance(req, res);
  if (req.method === "GET" && (req.url === "/reserver" || req.url.startsWith("/reserver?"))) return serveStatic(Object.assign(req, { url: "/reserver.html" }), res);
  if (req.method === "GET" && (req.url === "/accueil" || req.url.startsWith("/accueil?"))) return serveStatic(Object.assign(req, { url: "/accueil.html" }), res);
  if (req.method === "GET" && (req.url === "/reset" || req.url.startsWith("/reset?"))) return serveStatic(Object.assign(req, { url: "/reset.html" }), res);
  if (req.method === "GET" && (req.url === "/mon-programme" || req.url.startsWith("/mon-programme?"))) return handleLearnerChrono(req, res);
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
  console.log(`  Modèles : construction ${MODEL} · questions & cours ${MODEL_LIGHT} · premium ${MODEL_PREMIUM}`);
  console.log(`  Clés API : ${API_KEYS.length} (bascule automatique)`);
  console.log(`  Mémoire : ${USE_DB ? "base de données (Supabase)" : "fichiers locaux"}`);
  console.log(`  Publication : ${NETLIFY_TOKEN ? "activée" : "désactivée"}`);
  console.log(`  Comptes : activés (espace membre)`);
  console.log(`  Formateur(s) : ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(", ") : "aucun — définir ADMIN_EMAILS"}\n`);
});

// Planificateur des réservations : rappels 12h avant l'échéance, passage en file d'attente ensuite.
if (!process.argv.includes("--selftest")) {
  const RESV_TICK_MS = Math.max(60000, parseInt(process.env.RESV_TICK_MS, 10) || 15 * 60 * 1000);
  setTimeout(function tick() {
    runReservationMaintenance().catch(() => {}).finally(() => setTimeout(tick, RESV_TICK_MS));
  }, 20000);
}

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
