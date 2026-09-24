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
const MODEL_LIGHT = process.env.ANTHROPIC_MODEL_LIGHT || MODEL;
// Modèle PUISSANT pour l'espace « Premium learner » (applications avancées). Opus par défaut.
const MODEL_PREMIUM = process.env.ANTHROPIC_MODEL_PREMIUM || "claude-opus-5-5";
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

const KIT_RE = /\s*<!-- BAT-KIT:START -->[\s\S]*?<!-- BAT-KIT:END -->/g;
function stripKit(html) { return html ? html.replace(KIT_RE, "").replace(/\n{3,}/g, "\n\n").trim() : html; }
function injectKit(html, mods, conv, baseUrl) {
  if (!html) return html;
  html = stripKit(html);
  const wants = mods.includes("boutique") || mods.includes("rdv") || mods.includes("membre") || /data-bat-(auth|members|booking|contact|add|form|file|pay)/i.test(html);
  if (!wants) return html;
  const pc = (conv && conv.payment) || {};
  const payCfg = {
    mode: (pc.mode === "link" || pc.mode === "api") ? pc.mode : "none",
    link: pc.mode === "link" ? (pc.link || "") : "",
    currency: pc.currency || "XOF",
    apiReady: pc.mode === "api" && !!WAVE_API_KEY
  };
  const cfg = '<script>window.__BAT={app:' + JSON.stringify((conv && conv.id) || "") + ',base:' + JSON.stringify((baseUrl || "") + "/api/app") + ',pay:' + JSON.stringify(payCfg) + '};</script>';
  const block = "\n<!-- BAT-KIT:START -->\n" + cfg + "\n" + INTERACTIVE_KIT + "\n<!-- BAT-KIT:END -->\n";
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, block + "</body>");
  return html + block;
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
Explique ces possibilités comme des idées concrètes (« on pourrait ajouter… »), sans forcer. Si une fonction demande un volet qui n'est pas activé (Boutique, Rendez-vous, Espace membre), invite gentiment la personne à cliquer « Recommencer » et à cocher le ou les volets voulus (on peut en combiner plusieurs).`;

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
  algo: { label: "Algorithmique", run: "python", blurb: "Apprendre à raisonner (les bases de tout programme) avant le langage. On teste les idées en Python." }
};
function languageLabel(k) { return (LANGUAGES[k] && LANGUAGES[k].label) || "Python"; }
function normalizeLanguage(k) { return LANGUAGES[k] ? k : "python"; }

// Programmes (leçons ordonnées). Chaque leçon : titre, objectif, notions à couvrir, exercice pratique.
const CURRICULA = {
  python: [
    { key: "decouverte", title: "Découvrir Python", objectif: "Comprendre ce qu'est un programme et afficher du texte.", notions: "Ce qu'est un programme ; la fonction print() ; les chaînes de caractères entre guillemets ; les commentaires avec #.", exercice: "Écrire un programme qui affiche « Bonjour, je m'appelle ... » (avec le prénom de l'apprenant)." },
    { key: "variables", title: "Variables et types", objectif: "Stocker et réutiliser une information.", notions: "Créer une variable (nom = valeur) ; les types de base (texte str, entier int, décimal float, booléen bool) ; afficher une variable ; f-strings.", exercice: "Créer deux variables prénom et âge, puis afficher une phrase qui les utilise (ex. « Awa a 20 ans »)." },
    { key: "operateurs", title: "Opérateurs et calculs", objectif: "Calculer et comparer des valeurs.", notions: "opérateurs arithmétiques (+, -, *, /, //, %, **) et priorités ; comparaisons (==, !=, <, >) ; opérateurs logiques (and, or, not).", exercice: "Afficher le quotient et le reste de 2026 par 7, puis tester si 2026 est pair." },
    { key: "entrees", title: "Lire ce que tape l'utilisateur", objectif: "Rendre un programme interactif.", notions: "input() ; le résultat de input() est toujours du texte ; convertir en nombre avec int() ou float().", exercice: "Demander son prénom puis son année de naissance, et afficher l'âge approximatif (2026 moins l'année)." },
    { key: "conditions", title: "Les conditions (si… alors)", objectif: "Faire réagir le programme selon les cas.", notions: "if / elif / else ; les comparaisons ; l'indentation qui délimite les blocs ; conditions imbriquées.", exercice: "Demander un nombre et afficher s'il est négatif, nul ou positif." },
    { key: "boucles", title: "Les boucles (répéter)", objectif: "Répéter des actions sans se répéter soi-même.", notions: "la boucle for avec range([début], fin, [pas]) ; la boucle while ; break ; quand choisir l'une ou l'autre.", exercice: "Afficher la table de multiplication d'un nombre demandé (de 1 à 10)." },
    { key: "listes", title: "Les listes", objectif: "Manipuler une collection de valeurs.", notions: "créer une liste ; accéder par indice (et indices négatifs) ; append() ; parcourir avec for ; len().", exercice: "Demander 5 notes, les ranger dans une liste, puis afficher la moyenne." },
    { key: "dictionnaires", title: "Les dictionnaires", objectif: "Associer des valeurs à des clés.", notions: "créer un dictionnaire {cle: valeur} ; accéder par clé ; ajouter une clé ; parcourir un dictionnaire.", exercice: "Décrire un produit (nom, prix, quantité) dans un dictionnaire et afficher chaque information." },
    { key: "fonctions", title: "Les fonctions", objectif: "Ranger et réutiliser son code.", notions: "def nom(parametres): ; return ; appeler une fonction ; l'intérêt (éviter les répétitions).", exercice: "Écrire une fonction est_pair(n) qui renvoie True si n est pair, et l'utiliser sur quelques nombres." },
    { key: "fichiers", title: "Fichiers et erreurs", objectif: "Lire/écrire un fichier et gérer une erreur.", notions: "open() et le bloc with ; write() et parcours ligne à ligne ; les exceptions avec try / except.", exercice: "Écrire trois prénoms dans un fichier, puis le relire pour les afficher." },
    { key: "projet", title: "Petit projet : le juste prix", objectif: "Assembler tout ce qui a été appris.", notions: "combiner variables, boucle while, conditions, et une fonction ; le module random (random.randint).", exercice: "Programmer le jeu du « juste prix » : l'ordinateur choisit un nombre entre 1 et 100, l'utilisateur devine, le programme répond « plus grand / plus petit » jusqu'à trouver." }
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

RÈGLES
- Montre le code dans des blocs délimités par trois accents graves avec le langage (un bloc \`\`\`${LANGUAGES[lang].run}\`). Le code s'exécute en ${runLabel} dans la console.
- Exemples courts et exécutables. Évite les longues théories. Vérifie régulièrement que la personne suit.
- Ton professionnel et chaleureux. Pas d'émojis.`;
}

// Génère la réponse du tuteur (parcours programmation). Aucune extraction HTML : le code
// reste visible dans la discussion, et rien n'est écrit comme « site ».
async function produceCode(conv) {
  const system = codeSystem(conv);
  const reply = await callClaude(system, conv.messages, MODEL);
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
- Gérer un état applicatif, des formulaires, des calculs, des filtres, des recherches, des graphiques, des rôles côté client.
- Conserver les données dans le navigateur avec localStorage (persistance locale, par appareil).
- Utiliser au besoin UNE bibliothèque depuis un CDN fiable (cdnjs) — seulement si c'est vraiment utile.

À DIRE HONNÊTEMENT À LA PERSONNE
- L'application s'exécute dans le navigateur : les données en localStorage restent sur l'appareil, non partagées entre utilisateurs. Le temps réel multi-utilisateur et une base de données centrale exigent un serveur dédié — c'est une étape ultérieure, hors de cet atelier.

EXIGENCE DE QUALITÉ
- Code clair, commenté, qui FONCTIONNE. Vérifie mentalement chaque fonction. Interface soignée et professionnelle, sans émojis (sauf demande). Explique en une phrase ce que tu viens de construire ou de corriger.`;

// Génère / met à jour l'application avancée (espace Premium). Modèle Opus, sans kit.
async function producePremium(conv) {
  let system = PREMIUM_INSTRUCTION;
  const current = await readSite(conv.id);
  if (current) {
    system += "\n\n=== ÉTAT ACTUEL DE L'APPLICATION (index.html) ===\nVoici le code EXACT actuel. Pars de ce code, applique la demande, renvoie le fichier ENTIER à jour, sans rien perdre.\n```html\n" + current + "\n```";
  }
  const reply = await callClaude(system, conv.messages, MODEL_PREMIUM);
  const ex = extractSite(reply);
  let message = ex.message; let siteUpdated = false;
  if (ex.html && await writeSite(conv.id, ex.html)) { siteUpdated = true; conv.hasSite = true; }
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
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml" };

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
async function createUser({ email, name, password, status, cohort, cohortId }) {
  const e = normEmail(email);
  const user = {
    id: crypto.randomUUID(), email: e,
    name: String(name || "").trim().slice(0, 80) || e.split("@")[0],
    pass: hashPassword(password),
    status: status || "pending",
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
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
  if (conv.title) return String(conv.title).slice(0, 60);
  if (conv && conv.track === "code") return "Programmation — " + languageLabel(conv.language);
  if (conv && conv.track === "premium") return "Application avancée (Premium)";
  const firstReal = (conv.messages || []).find((m) => m.role === "user" && !m.hidden);
  if (firstReal && firstReal.content) return String(firstReal.content).replace(/\s+/g, " ").trim().slice(0, 60) || "Projet sans titre";
  return "Projet sans titre";
}
function convSummary(conv) {
  const base = { id: conv.id, title: convTitle(conv), modules: convModules(conv), step: conv.step || 0, hasSite: !!conv.hasSite, publishedUrl: conv.publishedUrl || null, pwa: !!conv.pwa, updatedAt: conv.updatedAt || conv.createdAt || null };
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
// -------------------------------------------------------------------------

// Round-robin de départ entre les clés (réparti dans le temps).
let KEY_CURSOR = 0;
const RETRYABLE = [408, 409, 429, 500, 502, 503, 504, 529];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callClaude(system, messages, model) {
  const clean = messages.map((m) => ({ role: m.role, content: m.content }));
  const body = JSON.stringify({ model: model || MODEL, max_tokens: 8192, system, messages: clean });
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
  if (!isBuild) system += PLATFORM_CAPABILITIES;
  // Ton professionnel imposé sur toutes les étapes.
  system += "\n\n=== TON ===\nAdopte un ton professionnel, clair et sobre. N'emploie pas d'émojis dans tes messages.";
  if (isBuild) {
    system += SINGLE_INSTRUCTION;
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

  // Construction = modèle principal ; discussion = modèle allégé (économie).
  const reply = await callClaude(system, conv.messages, isBuild ? MODEL : MODEL_LIGHT);

  // Extraction blindée : le HTML ne fuite jamais dans le message.
  const ex = extractSite(reply);
  let siteUpdated = false;
  let message = ex.message;

  if (isBuild && ex.html) ex.html = injectKit(ex.html, mods, conv, baseUrl);
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
    const user = await currentUser(req);
    if (!canBuild(user)) { const m = buildBlockMessage(user); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(user) }); }
    const body = await readBody(req); let p = {}; try { p = JSON.parse(body || "{}"); } catch (e) {}
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
    // Espace « Premium learner » : atelier d'applications avancées (réservé, modèle Opus).
    if (p.track === "premium") {
      if (!canPremium(user)) return sendJson(res, 403, { error: "L'atelier Premium est réservé aux apprenants sélectionnés par le formateur." });
      const kickoff = "Bonjour ! Je veux créer une application avancée. Voici mon idée : " + String(p.idea || "").slice(0, 500);
      const conv = { id, track: "premium", userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
      const out = await produceCurrent(conv, reqBase(req));
      return sendJson(res, 200, { id, track: "premium", ...out });
    }
    const mods = normalizeModules(p.modules, p.projectType);
    const kickoff = `Bonjour ! Je découvre Bâtisseur et je veux créer : ${modulesLabel(mods)}.`;
    const conv = { id, step: 0, modules: mods, userId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), messages: [{ role: "user", content: kickoff, hidden: true }] };
    const out = await produceCurrent(conv, reqBase(req));
    sendJson(res, 200, { id, step: 0, modules: mods, ...out });
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
    if (!canBuild(user)) { const m = buildBlockMessage(user); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(user) }); }
    if (conv.track === "premium" && !canPremium(user)) return sendJson(res, 403, { error: "L'atelier Premium est réservé aux apprenants sélectionnés." });
    if (typeof p.message !== "string" || !p.message.trim()) return sendJson(res, 400, { error: "Message vide." });
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
    if (!canBuild(user)) { const m = buildBlockMessage(user); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(user) }); }
    if (conv.track === "premium") return sendJson(res, 200, { atEnd: true, reply: null, siteUpdated: false }); // pas d'étapes en Premium
    // Filière programmation : « Leçon suivante » avance dans le programme.
    if (conv.track === "code") {
      const lessons = lessonsOf(conv); const cur = Math.min(Math.max(0, conv.lesson || 0), lessons.length - 1);
      if (cur >= lessons.length - 1) return sendJson(res, 200, { lesson: cur, atEnd: true, reply: null, siteUpdated: false });
      conv.lesson = cur + 1;
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
    conv.step = current + 1;
    conv.messages.push({ role: "user", content: STEPS[conv.step].kickoff, hidden: true });
    const out = await produceCurrent(conv, reqBase(req));
    sendJson(res, 200, { step: conv.step, atEnd: conv.step >= LAST_STEP, ...out });
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
  const payload = { id: conv.id, step: conv.step || 0, modules: convModules(conv), hasSite: await hasSite(conv.id), publishedUrl: conv.publishedUrl || null, pwa: !!conv.pwa, payment: publicPayment(conv), ownerName: conv.ownerName || null, messages: conv.messages.filter((m) => !m.hidden) };
  if (conv.track === "code") { payload.track = "code"; payload.language = normalizeLanguage(conv.language); payload.lesson = conv.lesson || 0; payload.lessons = lessonTitles(conv); }
  if (conv.track === "premium") payload.track = "premium";
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
  if (html && conv && conv.track !== "premium") { try { html = injectKit(html, convModules(conv), conv, reqBase(req)); } catch (e) {} }
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
  if (baseUrl && conv.track !== "premium") { try { html = injectKit(html, convModules(conv), conv, baseUrl); } catch (e) {} }

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
    const user = await currentUser(req);
    if (!owns(user, conv)) return sendJson(res, 403, { error: "Ce projet appartient à un autre compte." });
    if (!canBuild(user)) { const m = buildBlockMessage(user); return sendJson(res, m.code, { error: m.error, accessStatus: userStatus(user) }); }
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
  sendJson(res, 200, { user: publicUser(u) });
}

// GET /api/projects : les projets du compte connecté (pour « Mon espace »)
async function handleProjects(req, res) {
  const u = await currentUser(req);
  if (!u) return sendJson(res, 401, { error: "Non connecté." });
  sendJson(res, 200, { projects: await listConvsForUser(u.id) });
}

// --- ESPACE FORMATEUR (admin) : gestion des apprenants & des sessions ---
async function adminListUsers() {
  if (USE_DB) { try { return (await sb(`/users?select=id,email,name,status,cohort,cohort_id,premium,created_at&order=created_at.desc`)) || []; } catch (e) { console.error("adminListUsers:", e.message); return []; } }
  const a = loadAccounts(); return Object.values(a.users).sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
}
async function allConvs() {
  if (USE_DB) { try { return ((await sb(`/conversations?select=data`)) || []).map((x) => x.data).filter(Boolean); } catch (e) { return []; } }
  const out = [];
  try { fs.readdirSync(DATA_DIR).forEach((f) => { if (!f.endsWith(".json") || f === "accounts.json") return; try { out.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"))); } catch (e) {} }); } catch (e) {}
  return out;
}

// GET /api/admin/learners
async function handleAdminLearners(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé à l'administrateur." });
  const users = await adminListUsers();
  const convs = await allConvs();
  const byUser = {};
  convs.forEach((c) => { if (!c || !c.userId) return; const b = byUser[c.userId] || (byUser[c.userId] = { projects: 0, published: 0 }); b.projects++; if (c.publishedUrl) b.published++; });
  const learners = users
    .filter((x) => !ADMIN_EMAILS.includes(normEmail(x.email)))
    .map((x) => ({ id: x.id, email: x.email, name: x.name, cohort: x.cohort || null, cohortId: x.cohort_id || null, status: (x.status || "active"), premium: x.premium === true, createdAt: x.created_at || null, projects: byUser[x.id] ? byUser[x.id].projects : 0, published: byUser[x.id] ? byUser[x.id].published : 0 }));
  const stats = {
    total: learners.length,
    active: learners.filter((l) => l.status === "active").length,
    pending: learners.filter((l) => l.status === "pending").length,
    finished: learners.filter((l) => l.status === "finished").length
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
  const user = await createUser({ email, name: p.name, password: p.password, status: "active", cohort, cohortId });
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
  const list = await listCohorts(); const counts = await cohortCounts();
  sendJson(res, 200, { cohorts: list.map((c) => ({ id: c.id, label: c.label, startDate: c.startDate, capacity: c.capacity, closed: !!c.closed, enrolled: counts[c.id] || 0 })) });
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
  if (!Object.keys(fields).length) return sendJson(res, 400, { error: "Rien à modifier." });
  const c = await updateCohortRec(p.id, fields);
  if (!c) return sendJson(res, 404, { error: "Session introuvable." });
  sendJson(res, 200, { ok: true });
}

// --- CERTIFICAT (simple) : une belle page imprimable en PDF ---
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
function frDate(iso) { try { const d = new Date(iso + "T00:00:00Z"); return JOURS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MOIS[d.getUTCMonth()] + " " + d.getUTCFullYear(); } catch (e) { return iso; } }

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
    dailyGoalMin: (s && s.dailyGoalMin != null) ? s.dailyGoalMin : (parseInt(process.env.DAILY_GOAL_MIN, 10) || 60)
  };
}
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
function waLink(number, text) { const n = String(number || "").replace(/[^0-9]/g, ""); return n ? ("https://wa.me/" + n + "?text=" + encodeURIComponent(text)) : ""; }
function mailtoLink(email, subject, body) { return email ? ("mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body)) : ""; }
// Envoi automatique si un service est configuré (webhooks) ; sinon le formateur envoie depuis l'outbox.
async function deliverReminder(resv, msg) {
  try {
    if (process.env.WA_WEBHOOK_URL && resv.whatsapp) { fetch(process.env.WA_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: resv.whatsapp, text: msg.wa }) }).catch(() => {}); }
    if (process.env.MAIL_WEBHOOK_URL && resv.email) { fetch(process.env.MAIL_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: resv.email, subject: msg.subject, text: msg.email }) }).catch(() => {}); }
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
  sendJson(res, 200, { open: true, currency: cfg.currency, sessions });
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
    if (name.length < 2) return sendJson(res, 400, { error: "Indiquez votre nom." });
    if (!validEmail(email)) return sendJson(res, 400, { error: "Adresse e-mail invalide." });
    if (whatsapp.replace(/[^0-9]/g, "").length < 6) return sendJson(res, 400, { error: "Numéro WhatsApp invalide." });
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || "?";
    if (!rateOk("resv:" + ip, 12, 60 * 60 * 1000)) return sendJson(res, 429, { error: "Trop de demandes. Réessayez plus tard." });
    const existing = (await listReservations(cohort.id)).find((r) => r.email === email && r.status !== "annule");
    let id;
    if (existing) { id = existing.id; if (existing.status === "file_attente") await updateReservation(id, { status: "en_attente" }); }
    else { id = crypto.randomUUID(); await addReservation({ id, cohortId: cohort.id, name, email, whatsapp, status: "en_attente", source: "en_ligne", createdAt: new Date().toISOString() }); }
    const price = cohortPrice(cohort, cfg);
    sendJson(res, 200, { id, session: { label: cohort.label, dateFr: frDate(cohort.startDate) }, price, currency: cfg.currency, payLink: waveLinkWithAmount(cfg.payLink, price) });
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// POST /api/reservations/declare : la personne déclare avoir payé (public) ; le formateur vérifiera
async function handleReserveDeclare(req, res) {
  try {
    let p = {}; try { p = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return sendJson(res, 400, { error: "Requête invalide." }); }
    const r = await getReservation(p.id);
    if (!r) return sendJson(res, 404, { error: "Réservation introuvable." });
    if (normEmail(p.email) !== r.email) return sendJson(res, 403, { error: "Cet e-mail ne correspond pas à la réservation." });
    if (r.status === "admis") return sendJson(res, 200, { ok: true, status: "admis" });
    await updateReservation(r.id, { status: "paiement_declare", declaredAt: new Date().toISOString() });
    sendJson(res, 200, { ok: true, status: "paiement_declare" });
  } catch (e) { sendJson(res, 500, { error: "Erreur serveur." }); }
}

// GET /api/formation/reservations?cohortId=  (formateur) : listes + outbox des rappels
async function handleFormationReservations(req, res) {
  const u = await currentUser(req); if (!isAdmin(u)) return sendJson(res, 403, { error: "Réservé au formateur." });
  const uo = new URL(req.url, "http://localhost"); const cid = uo.searchParams.get("cohortId");
  const cfg = formationConfig(await getSettings());
  const cohort = cid ? await getCohort(cid) : null;
  const list = await listReservations(cid || null);
  const outbox = [];
  if (cohort) {
    list.forEach((r) => {
      if (r.remindedAt && (r.status === "en_attente" || r.status === "file_attente")) {
        const m = reminderMessages(r, cohort, cfg);
        outbox.push({ id: r.id, name: r.name, email: r.email, whatsapp: r.whatsapp, wa: waLink(r.whatsapp, m.wa), mailto: mailtoLink(r.email, m.subject, m.email) });
      }
    });
  }
  sendJson(res, 200, { reservations: list, price: cohort ? cohortPrice(cohort, cfg) : cfg.price, currency: cfg.currency, capacity: cohort ? (cohort.capacity || 0) : 0, outbox });
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
  if (status === "admis") { try { access = await grantAccessForReservation(Object.assign({}, r, fields)); } catch (e) {} }
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
  const next = await setSettings(fields);
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
  let today = 0;
  if (!isAdmin(u)) {                                   // le formateur n'est pas suivi
    if (s > 0) today = await addActivity(u.id, s);
    else { const day = dayKey(new Date()); const m = await activityForUsers([u.id], [day]); today = (m[u.id] && m[u.id][day]) || 0; }
  }
  sendJson(res, 200, { ok: true, todaySeconds: today, goalMin: cfg.dailyGoalMin });
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
  const allDays = Array.from(new Set(week.concat([today])));
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
    return { id: x.id, name: x.name, email: x.email, cohort: x.cohort || null, status: x.status || "active", today: todaySec, metToday: todaySec >= goalSec, days, daysMetThisWeek: daysMet, weekTotal, progress: progressSummary(byUser[x.id] || []) };
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
    const fields = { status: "active" };
    if (cohort) { fields.cohort_id = cohort.id; fields.cohort = cohort.label; }
    try { await updateUser(existing.id, fields); } catch (e) {}
    return { created: false, email: resv.email };
  }
  const tempPass = genTempPassword();
  try { await createUser({ email: resv.email, name: resv.name, password: tempPass, status: "active", cohort: cohort ? cohort.label : null, cohortId: cohort ? cohort.id : null }); }
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
  .verify{ margin-top:20px; font-size:11px; color:#8394a8; }
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
      <div>Délivré le<b>${dateStr}</b></div>
      <div>Certificat n°<b>${num}</b></div>
    </div>
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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/app/")) { res.writeHead(204, corsHeaders()); return res.end(); }
  if (req.method === "POST" && req.url === "/api/start") return handleStart(req, res);
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/next") return handleNext(req, res);
  if (req.method === "POST" && req.url === "/api/publish") return handlePublish(req, res);
  if (req.method === "POST" && req.url === "/api/auth/register") return handleRegister(req, res);
  if (req.method === "POST" && req.url === "/api/auth/login") return handleLogin(req, res);
  if (req.method === "POST" && req.url === "/api/auth/logout") return handleLogout(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/auth/me")) return handleMe(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/projects")) return handleProjects(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/learners")) return handleAdminLearners(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/create") return handleAdminCreate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/update") return handleAdminUpdate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/learner/delete") return handleAdminDelete(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/admin/cohorts")) return handleAdminCohorts(req, res);
  if (req.method === "POST" && req.url === "/api/admin/cohort/generate") return handleAdminCohortGenerate(req, res);
  if (req.method === "POST" && req.url === "/api/admin/cohort/update") return handleAdminCohortUpdate(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/cohorts")) return handleCohorts(req, res);
  if (req.method === "POST" && req.url === "/api/app/submit") return handleSubmit(req, res);
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
  if (req.method === "GET" && req.url.startsWith("/api/formation/reservations")) return handleFormationReservations(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/status") return handleFormationReservationStatus(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/delete") return handleFormationReservationDelete(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/cash") return handleFormationCash(req, res);
  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/api/formation/settings")) return handleFormationSettings(req, res);
  if (req.method === "POST" && req.url === "/api/activity/ping") return handleActivityPing(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/formation/activity")) return handleFormationActivity(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/quiz/programmation")) return handleQuizGet(req, res);
  if (req.method === "POST" && req.url === "/api/quiz/programmation/submit") return handleQuizSubmit(req, res);
  if (req.method === "POST" && req.url === "/api/formation/run-maintenance") return handleFormationTick(req, res);
  if (req.method === "POST" && req.url === "/api/formation/reservation/access") return handleFormationAccess(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/cron/maintenance")) return handleCronMaintenance(req, res);
  if (req.method === "GET" && (req.url === "/reserver" || req.url.startsWith("/reserver?"))) return serveStatic(Object.assign(req, { url: "/reserver.html" }), res);
  if (req.method === "GET" && (req.url === "/accueil" || req.url.startsWith("/accueil?"))) return serveStatic(Object.assign(req, { url: "/accueil.html" }), res);
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
  console.log(`  Modèle : ${MODEL}${MODEL_LIGHT !== MODEL ? "  (discussion : " + MODEL_LIGHT + ")" : ""}`);
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
