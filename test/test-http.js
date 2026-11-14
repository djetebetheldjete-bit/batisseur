"use strict";
/**
 * test-http.js — tests automatiques de Bâtisseur.
 *
 *   npm test            (ou : node test/test-http.js)
 *
 * Démarre le vrai serveur dans un dossier de données jetable et vérifie, par de
 * vraies requêtes : les pages, la sécurité, les comptes, les accès réservés, le
 * mot de passe oublié et les limites anti-abus.
 * Zéro dépendance. Aucun accès à la base de production, à l'IA ou aux e-mails.
 * Code de sortie : 0 si tout passe, 1 sinon (utilisable en intégration continue).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startServer, cookieOf, createRunner, checkHtml } = require("./harness");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const ADMIN = "admin@test.ci";

async function main() {
  const t = createRunner("Bâtisseur — tests automatiques (serveur réel, données jetables)");
  // Clé IA factice : elle permet de vérifier les contrôles d'accès ; aucun test n'atteint un appel à l'IA.
  const srv = await startServer(ROOT, { ADMIN_EMAILS: ADMIN, CRON_KEY: "cle-cron-de-test", ANTHROPIC_API_KEY: "cle-factice-pour-les-tests" });
  const { req } = srv;

  // Petits raccourcis
  const register = (email, password, ip, extra) => req("POST", "/api/auth/register", { json: Object.assign({ email, password, name: "Test" }, extra || {}), ip });
  const login = (email, password, ip) => req("POST", "/api/auth/login", { json: { email, password }, ip });

  try {
    // ---------------------------------------------------------------- Pages
    t.section("Pages");
    for (const [url, mustContain] of [["/", "Bâtisseur"], ["/accueil", "Bâtisseur"], ["/reserver", "<html"], ["/reset", "<html"], ["/feedback", "<html"]]) {
      await t.test("la page " + url + " s'affiche", async () => {
        const r = await req("GET", url);
        assert.strictEqual(r.status, 200, "statut " + r.status);
        assert.ok(/text\/html/.test(r.headers["content-type"] || ""), "type de contenu : " + r.headers["content-type"]);
        assert.ok(r.text.includes(mustContain), "contenu attendu absent : " + mustContain);
      });
    }
    await t.test("une page inconnue renvoie 404", async () => {
      const r = await req("GET", "/cette-page-n-existe-pas.html");
      assert.strictEqual(r.status, 404);
    });
    for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith(".html"))) {
      await t.test("public/" + f + " : structure et JavaScript valides", async () => {
        const problems = checkHtml(path.join(PUBLIC, f));
        assert.deepStrictEqual(problems, [], problems.join(" ; "));
      });
    }
    await t.test("la page d'accueil garde son menu mobile et ses champs nommés", async () => {
      const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
      assert.ok(html.includes('id="topMenuBtn"') && html.includes('id="topMenu"'), "menu mobile absent");
      for (const id of ["authEmail", "authPass", "authName"]) {
        const tag = (html.match(new RegExp("<input[^>]*id=\"" + id + "\"[^>]*>")) || [""])[0];
        assert.ok(/aria-label=/.test(tag) || new RegExp('<label[^>]*for="' + id + '"').test(html), "champ sans nom accessible : " + id);
      }
    });

    // ------------------------------------------------------------- Sécurité
    t.section("Sécurité de base");
    await t.test("les en-têtes de sécurité sont envoyés", async () => {
      const r = await req("GET", "/");
      assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
      assert.strictEqual(r.headers["x-frame-options"], "SAMEORIGIN");
      assert.ok(r.headers["referrer-policy"], "Referrer-Policy absent");
    });
    for (const bad of ["/%", "/%E0%A4%A", "/api/%zz"]) {
      await t.test("une adresse mal formée (" + bad + ") ne fait pas tomber le serveur", async () => {
        const r = await req("GET", bad);
        assert.ok(r.status === 400 || r.status === 404, "statut " + r.status);
        assert.ok(srv.alive(), "le serveur s'est arrêté");
        assert.strictEqual((await req("GET", "/")).status, 200, "le serveur ne répond plus");
      });
    }
    await t.test("un cookie mal formé est ignoré sans erreur", async () => {
      const r = await req("GET", "/api/auth/me", { cookie: "x=%E0%A4%A; bat_session=%" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.user, null);
      assert.ok(srv.alive());
    });
    await t.test("un corps JSON invalide est refusé proprement (400)", async () => {
      const r = await req("POST", "/api/auth/login", { body: "{pas du json", headers: { "content-type": "application/json" } });
      assert.strictEqual(r.status, 400);
    });
    for (const p of ["/../server.js", "/..%2f..%2fserver.js", "/%2e%2e/%2e%2e/package.json", "/..%5c..%5cserver.js", "/data/accounts.json", "/.env", "/..%2f.env"]) {
      await t.test("fichier interne inaccessible : " + p, async () => {
        const r = await req("GET", p);
        assert.notStrictEqual(r.status, 200, "le fichier a été servi !");
        assert.ok(!/require\(|SUPABASE_KEY|"scripts"/.test(r.text), "contenu interne exposé");
      });
    }

    // --------------------------------------------------------------- Comptes
    t.section("Comptes");
    await t.test("sans connexion, /api/auth/me renvoie user = null", async () => {
      const r = await req("GET", "/api/auth/me");
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user, null);
    });
    await t.test("inscription refusée avec un e-mail invalide", async () => {
      assert.strictEqual((await register("pas-un-email", "secret123", "10.0.0.1")).status, 400);
    });
    await t.test("inscription refusée avec un mot de passe trop court", async () => {
      assert.strictEqual((await register("court@test.ci", "123", "10.0.0.1")).status, 400);
    });
    let learnerCookie = "";
    await t.test("inscription : le compte est créé « en attente » et la session est ouverte", async () => {
      const r = await register("Apprenant@Test.ci", "secret123", "10.0.0.1");
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.user.email, "apprenant@test.ci", "l'e-mail doit être normalisé en minuscules");
      assert.strictEqual(r.json.user.status, "pending");
      assert.strictEqual(r.json.user.isAdmin, false);
      assert.ok(!("pass" in r.json.user), "le mot de passe ne doit jamais être renvoyé");
      const sc = (r.headers["set-cookie"] || []).join(";");
      assert.ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), "cookie de session mal protégé : " + sc);
      learnerCookie = cookieOf(r);
      assert.ok(learnerCookie, "pas de cookie de session");
    });
    await t.test("les données de test vont dans le dossier jetable (jamais la vraie base)", async () => {
      const f = path.join(srv.dataDir, "accounts.json");
      assert.ok(fs.existsSync(f), "accounts.json absent du dossier de test");
      const raw = fs.readFileSync(f, "utf8");
      assert.ok(raw.includes("apprenant@test.ci"));
      assert.ok(!raw.includes("secret123"), "mot de passe stocké en clair !");
    });
    await t.test("un e-mail déjà utilisé est refusé (409)", async () => {
      assert.strictEqual((await register("apprenant@test.ci", "autre-secret", "10.0.0.1")).status, 409);
    });
    await t.test("avec le cookie, /api/auth/me reconnaît le compte", async () => {
      const r = await req("GET", "/api/auth/me", { cookie: learnerCookie });
      assert.strictEqual(r.json.user.email, "apprenant@test.ci");
    });
    await t.test("un mauvais mot de passe est refusé (401), sans dire si le compte existe", async () => {
      const a = await login("apprenant@test.ci", "mauvais", "10.0.0.2");
      const b = await login("inconnu@test.ci", "mauvais", "10.0.0.2");
      assert.strictEqual(a.status, 401); assert.strictEqual(b.status, 401);
      assert.strictEqual(a.json.error, b.json.error, "le message ne doit pas révéler l'existence du compte");
    });
    await t.test("connexion avec le bon mot de passe", async () => {
      const r = await login("APPRENANT@test.ci", "secret123", "10.0.0.2");
      assert.strictEqual(r.status, 200); assert.ok(cookieOf(r));
    });
    await t.test("après déconnexion, l'ancienne session ne fonctionne plus", async () => {
      const r1 = await login("apprenant@test.ci", "secret123", "10.0.0.2");
      const c = cookieOf(r1);
      assert.strictEqual((await req("GET", "/api/auth/me", { cookie: c })).json.user.email, "apprenant@test.ci");
      assert.strictEqual((await req("POST", "/api/auth/logout", { cookie: c })).status, 200);
      assert.strictEqual((await req("GET", "/api/auth/me", { cookie: c })).json.user, null);
    });
    await t.test("un cookie de session inventé ne donne aucun accès", async () => {
      const name = learnerCookie.split("=")[0];
      const r = await req("GET", "/api/auth/me", { cookie: name + "=" + "a".repeat(48) });
      assert.strictEqual(r.json.user, null);
    });

    // ------------------------------------------------------- Accès réservés
    t.section("Accès réservés");
    const adminGets = ["/api/admin/learners", "/api/admin/ai-stats", "/api/admin/export", "/api/admin/premium-board", "/api/admin/cohorts",
      "/api/admin/visits", "/api/admin/visits.pdf", "/api/admin/certificates", "/api/admin/feedback", "/api/formation/roster", "/api/formation/reservations"];
    const adminPosts = ["/api/admin/learner/create", "/api/admin/learner/update", "/api/admin/learner/delete", "/api/admin/cohort/generate",
      "/api/admin/cohort/update", "/api/admin/cohort/launch", "/api/admin/publish", "/api/admin/activity/reset", "/api/admin/workcap/reset"];
    await t.test("visiteur non connecté : toutes les routes du formateur sont fermées", async () => {
      for (const u of adminGets) { const r = await req("GET", u); assert.ok(r.status === 401 || r.status === 403, u + " → " + r.status); }
      for (const u of adminPosts) { const r = await req("POST", u, { json: {} }); assert.ok(r.status === 401 || r.status === 403, u + " → " + r.status); }
    });
    await t.test("apprenant connecté : toutes les routes du formateur sont fermées", async () => {
      for (const u of adminGets) { const r = await req("GET", u, { cookie: learnerCookie }); assert.ok(r.status === 401 || r.status === 403, u + " → " + r.status); }
      for (const u of adminPosts) { const r = await req("POST", u, { json: {}, cookie: learnerCookie }); assert.ok(r.status === 401 || r.status === 403, u + " → " + r.status); }
    });
    await t.test("visiteur non connecté : pas de liste de projets (401)", async () => {
      assert.strictEqual((await req("GET", "/api/projects")).status, 401);
    });
    await t.test("sans compte validé, impossible de démarrer un projet ou de parler à l'IA", async () => {
      for (const c of ["", learnerCookie]) {
        const who = c ? "apprenant en attente" : "visiteur";
        const a = await req("POST", "/api/start", { json: {}, cookie: c });
        assert.ok(a.status === 401 || a.status === 403, who + " /api/start → " + a.status);
        const b = await req("POST", "/api/chat", { json: { id: "00000000-0000-0000-0000-000000000000", message: "bonjour" }, cookie: c });
        assert.ok(b.status === 401 || b.status === 403 || b.status === 404, who + " /api/chat → " + b.status);
      }
    });
    let adminCookie = "";
    await t.test("le formateur (e-mail déclaré dans ADMIN_EMAILS) accède à son espace", async () => {
      const r = await register(ADMIN, "admin-secret", "10.0.0.3");
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.user.isAdmin, true);
      adminCookie = cookieOf(r);
      const list = await req("GET", "/api/admin/learners", { cookie: adminCookie });
      assert.strictEqual(list.status, 200);
      assert.ok(JSON.stringify(list.json).includes("apprenant@test.ci"), "l'apprenant doit apparaître dans la liste");
      assert.ok(!/"pass"\s*:/.test(list.text), "les mots de passe ne doivent pas sortir de l'API");
    });
    await t.test("la tâche planifiée est refusée sans clé", async () => {
      for (const u of ["/api/cron/maintenance", "/api/cron/maintenance?key=devine"]) {
        const r = await req("GET", u);
        assert.strictEqual(r.status, 403, u + " → " + r.status);
      }
    });

    // ------------------------------------------------- Données publiques
    t.section("Données publiques");
    await t.test("/api/formation/sessions répond en JSON", async () => {
      const r = await req("GET", "/api/formation/sessions");
      assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.json.sessions));
    });
    await t.test("/api/cohorts et /api/config répondent en JSON", async () => {
      for (const u of ["/api/cohorts", "/api/config"]) { const r = await req("GET", u); assert.strictEqual(r.status, 200, u); assert.ok(r.json && typeof r.json === "object", u); }
    });

    // --------------------------------------------- Mot de passe oublié
    t.section("Mot de passe oublié");
    const readResets = () => { try { return (JSON.parse(fs.readFileSync(path.join(srv.dataDir, "accounts.json"), "utf8")).resets) || {}; } catch (e) { return {}; } };
    await t.test("la réponse est identique que le compte existe ou non", async () => {
      const a = await req("POST", "/api/auth/forgot", { json: { email: "inconnu@test.ci" } });
      const b = await req("POST", "/api/auth/forgot", { json: { email: "apprenant@test.ci" } });
      assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
      assert.strictEqual(a.text, b.text);
    });
    await t.test("un lien invalide est refusé", async () => {
      assert.strictEqual((await req("POST", "/api/auth/reset", { json: { token: "faux-lien", password: "nouveau-secret" } })).status, 400);
    });
    await t.test("le lien reçu permet de choisir un nouveau mot de passe, une seule fois", async () => {
      const tokens = Object.keys(readResets());
      assert.strictEqual(tokens.length, 1, "un lien (et un seul) doit avoir été créé");
      const token = tokens[0];
      assert.strictEqual((await req("POST", "/api/auth/reset", { json: { token, password: "123" } })).status, 400, "mot de passe trop court accepté");
      const again = Object.keys(readResets());
      const tk = again.length ? again[0] : null;
      // Un essai avec mot de passe trop court ne doit pas « brûler » le lien.
      assert.strictEqual(tk, token, "le lien a été consommé par un essai invalide");
      assert.strictEqual((await req("POST", "/api/auth/reset", { json: { token, password: "nouveau-secret" } })).status, 200);
      assert.strictEqual((await login("apprenant@test.ci", "nouveau-secret", "10.0.0.4")).status, 200, "le nouveau mot de passe ne fonctionne pas");
      assert.strictEqual((await login("apprenant@test.ci", "secret123", "10.0.0.4")).status, 401, "l'ancien mot de passe fonctionne encore");
      assert.strictEqual((await req("POST", "/api/auth/reset", { json: { token, password: "encore-un-autre" } })).status, 400, "le lien a pu servir deux fois");
    });

    // -------------------------------------------------- Limites anti-abus
    t.section("Limites anti-abus");
    await t.test("après 10 essais de mot de passe sur un compte, la connexion est bloquée (429)", async () => {
      await register("cible@test.ci", "bon-secret", "10.0.0.5");
      for (let i = 0; i < 10; i++) { const r = await login("cible@test.ci", "essai-" + i, "10.0.1." + i); assert.strictEqual(r.status, 401, "essai " + (i + 1) + " → " + r.status); }
      const blocked = await login("cible@test.ci", "bon-secret", "10.0.1.99");
      assert.strictEqual(blocked.status, 429, "le 11e essai devait être bloqué");
      assert.strictEqual((await login("apprenant@test.ci", "nouveau-secret", "10.0.1.100")).status, 200, "les autres comptes ne doivent pas être bloqués");
    });
    await t.test("après 30 essais depuis une même connexion, celle-ci est bloquée (429)", async () => {
      let last = 0;
      for (let i = 0; i < 31; i++) { last = (await login("personne" + i + "@test.ci", "x", "10.9.9.9")).status; }
      assert.strictEqual(last, 429);
    });
    await t.test("au-delà de 10 créations de compte par heure et par connexion : refus (429)", async () => {
      let ok = 0, last = 0;
      for (let i = 0; i < 11; i++) { last = (await register("serie" + i + "@test.ci", "secret123", "10.7.7.7")).status; if (last === 200) ok++; }
      assert.strictEqual(ok, 10, "10 créations devaient passer, " + ok + " sont passées");
      assert.strictEqual(last, 429);
    });

    // ------------------------------------------------------------- Bilan
    t.section("Santé du serveur en fin de série");
    await t.test("le serveur tourne toujours et n'a journalisé aucune erreur fatale", async () => {
      assert.ok(srv.alive(), "le serveur s'est arrêté pendant les tests");
      assert.strictEqual((await req("GET", "/")).status, 200);
      assert.ok(!/Rejet non géré|Exception non gérée|Requête en erreur/i.test(srv.logs()), "erreur inattendue dans le journal :\n" + srv.logs().slice(-800));
    });
  } finally {
    await srv.stop();
  }
  process.exit(t.summary() ? 1 : 0);
}

main().catch((e) => { console.error("Erreur d'exécution des tests :", e); process.exit(2); });
