# Bâtisseur — parcours complet (v1.6)

> **Nouveau modèle — Finaliser et publier le projet (page `/finaliser`)**
> Une fois le projet défini et structuré dans l'atelier, l'apprenant ouvre **`/finaliser`** pour :
> 1) **générer automatiquement le prompt complet** du projet (Markdown, téléchargeable en `.md` ou `.html`),
>    assemblé à partir de son plan, de ses contenus et de la version déjà construite ;
> 2) passer un **point de contrôle qualité** (checklist) avant l'envoi ;
> 3) **construire et publier avec Claude Code** via le **dépôt GitHub de Bâtisseur**
>    (chaque apprenant utilise son propre compte GitHub) ;
> 4) **recoller le lien du site publié** (enregistré pour le certificat) ;
> 5) suivre une **fiche projet traçable** (définition → prompt → GitHub → lien → certificat).
> Ajout **non destructif** : la publication Netlify existante reste disponible en parallèle, rien de l'existant n'est modifié.
> Deux routes API ajoutées (`POST /api/project/prompt`, `POST /api/project/published-link`) et une page `/finaliser`.
> Lien du dépôt affiché aux apprenants via la variable d'environnement **`BATISSEUR_GITHUB`** (facultative).

> **Page d'accueil publique & gestion des réservations**
> Nouvelle page vitrine à l'adresse **`/accueil`** : elle présente les deux formations,
> affiche les prochaines sessions et leurs frais (en direct), et renvoie vers `/reserver`
> et l'atelier. C'est le lien à partager pour le lancement. Côté formateur, chaque réservation
> a désormais un bouton **« Supprimer »** (pour annuler une réservation de test ou indésirable).
> Modèle Premium confirmé : identifiant Opus **`claude-opus-5-5`** (à mettre dans
> `ANTHROPIC_MODEL_PREMIUM`).

> **Espace « Premium learner » (applications avancées)**
> Un troisième espace, **réservé** : le formateur promeut certains apprenants (bouton
> **« Premium »** dans la liste des apprenants de l'Espace formateur). Seuls les apprenants
> promus voient l'option **« Application avancée (Premium) »** à l'écran de départ. Là,
> contrairement au parcours débutant, **l'IA écrit du vrai code** (HTML + CSS + JavaScript
> réel, dans un seul fichier), pour bâtir une application sur mesure — le kit débutant n'est pas
> injecté. Cet atelier utilise un **modèle plus puissant (Opus)**, réglable via
> `ANTHROPIC_MODEL_PREMIUM` (défaut `claude-opus-5-5`). L'application se prévisualise, se publie
> et s'installe comme les autres. Portée : applications qui tournent dans le navigateur
> (état, écrans multiples en JS, localStorage) ; le multi-utilisateur temps réel avec base
> centrale reste une étape ultérieure. Nouvelle colonne `premium` sur `users` (voir `schema.sql`).

> **Réservations de session avec paiement (garder sa place)**
> Page publique **`/reserver`** : une personne choisit une session, laisse son **nom, e-mail et
> numéro WhatsApp**, réserve, puis **paie avec Wave** (lien du formateur, montant prérempli via
> `?amount=`) pour garder sa place. Elle clique « J'ai payé » ; le **formateur vérifie et valide**,
> ce qui l'ajoute à la **liste des admis** de la session (capacité 15). Le **paiement en espèces**
> est possible : le formateur l'enregistre, la personne est admise directement.
> - **Formateur** (reconnu par son e-mail via `ADMIN_EMAILS`) : bouton **« Réservations & paiement »**
>   dans l'Espace formateur — réglages (lien Wave, prix, ouverture), listes par statut
>   (paiement déclaré, en attente, admis, file d'attente), validation, ajout espèces, et **outbox**
>   des rappels (liens WhatsApp/e-mail prêts à envoyer).
> - **Rappels automatiques** : un planificateur interne envoie un rappel (au nom de Bâtisseur,
>   poli et professionnel) **12 h avant l'échéance** (la veille de la session) ; sans règlement,
>   le nom **passe en file d'attente**. Envoi automatique si `WA_WEBHOOK_URL` / `MAIL_WEBHOOK_URL`
>   sont configurés (POST `{to,text}`) ; sinon les messages restent dans l'outbox à envoyer en un clic.
> - **Lien Wave par défaut** = votre compte Imprim USP (`https://pay.wave.com/m/M_ci_JmZaF8F6GuC-/c/ci/`),
>   modifiable dans les réglages ou via `WAVE_FORMATION_LINK`. **Prix par défaut : 5000 FCFA**
>   (`FORMATION_PRICE`). Nouvelles tables `settings` et `reservations` (voir `schema.sql`).
>   Aucune dépendance npm.
> - **Admission → accès automatique** : quand le formateur valide un admis qui a un e-mail, la
>   plateforme **crée (ou réactive) son compte apprenant** (statut actif, session attribuée) et
>   renvoie **un mot de passe temporaire** à transmettre — l'apprenant peut alors se connecter et
>   suivre la formation. Bouton « Renvoyer l'accès » pour régénérer un mot de passe. Le paiement
>   espèces avec e-mail crée aussi l'accès.
> - **Rappels fiables même quand l'hébergeur dort** : une adresse externe protégée par clé,
>   `GET /api/cron/maintenance?key=CRON_KEY`, fait tourner les rappels/la file d'attente. Réglez
>   `CRON_KEY` dans Render, puis pointez un pinger gratuit (UptimeRobot, cron-job.org…) toutes les
>   ~15 min sur cette adresse : cela réveille l'app **et** déclenche la vérification. Le formateur
>   a aussi le bouton « Forcer la vérification ».

> **Deux formations au choix (nouveau)**
> À l'écran de départ, l'apprenant choisit sa filière :
> - **Créer un site / une application web** — le parcours complet existant (vitrine, boutique,
>   rendez-vous, espace membre, fichiers, paiement, publication…).
> - **Apprendre la programmation** — un tuteur IA guide l'apprenant **leçon par leçon**
>   (les bases puis la pratique), avec une **console intégrée** pour **écrire ET exécuter**
>   son code. Deux points de départ pour cette première version : **Algorithmique** et **Python**.
>   Chaque leçon a un objectif, une explication simple, un exemple, puis un **exercice** ;
>   l'apprenant avance avec le bouton « Leçon suivante → ». Le code s'exécute **dans le
>   navigateur** (Python via Pyodide, chargé à la première exécution) — **rien n'est exécuté
>   sur le serveur**, et la progression est enregistrée par projet. Programmes définis dans
>   `CURRICULA` (server.js) ; aucune dépendance npm ; aucun changement de base de données.

> **Base de données — où est le SQL ?**
> Tout le SQL est réuni dans un seul fichier à la racine du projet : **`schema.sql`**.
> Ce script est **idempotent** (exécutable plusieurs fois sans risque) et crée toutes les
> tables et colonnes nécessaires. Pour l'installer : Supabase → **SQL Editor** → coller le
> contenu de `schema.sql` → **Run**. Les blocs SQL répartis dans les sections ci-dessous
> restent à titre d'explication étape par étape, mais `schema.sql` les remplace tous.

> **Application installable (PWA)**
> Au moment de la publication, une case **« Installable sur téléphone »** apparaît à côté du
> bouton *Publier en ligne*. Cochée, le site est déployé comme une **vraie application** :
> icône sur l'écran d'accueil, ouverture en plein écran, fonctionnement même hors connexion.
> La plateforme génère et déploie automatiquement tout le nécessaire (icônes PNG 192 / 512,
> `manifest.webmanifest`, service worker `sw.js`) et injecte les balises dans la page —
> **l'apprenant n'écrit rien**. Tout est produit en Node natif dans `pwa.js`, **sans aucune
> dépendance npm** et **sans nouvelle variable d'environnement ni changement de base**.
> Installation côté visiteur : Android → menu du navigateur → « Ajouter à l'écran d'accueil » ;
> iPhone → bouton Partager → « Sur l'écran d'accueil ».

> **Envoi de fichiers par les visiteurs**
> Un visiteur peut **joindre un fichier** (photo, PDF, document Word / Excel / PowerPoint, texte)
> à une commande, un rendez-vous ou un message — utile par exemple pour un imprimeur qui reçoit
> le fichier à imprimer, ou un artisan qui reçoit une photo du projet. Pour l'activer, l'assistant
> ajoute simplement un champ `<input type="file" data-bat-file>` dans un formulaire ; **aucun code
> à écrire**. Les fichiers (max **3 Mo**, types contrôlés) sont stockés côté plateforme et **seul
> le propriétaire** peut les télécharger, depuis son tableau de bord « Données ». Nouvelle table
> `uploads` (voir `schema.sql`) ; endpoints publics `/api/app/upload` (dépôt) et privé
> `/api/upload` (téléchargement réservé au propriétaire). Toujours **sans dépendance npm**.

> **Paiement en ligne (Wave)**
> Le propriétaire d'un projet active le paiement depuis le bouton **« Paiement »** (en haut de
> l'aperçu). Deux modes, au choix :
> - **Lien Wave par apprenant** (recommandé, sans secret) : la personne colle **son propre lien
>   de paiement Wave**. Un bouton « Payer avec Wave » apparaît sur la boutique ; le bouton
>   « Commander » propose le règlement. La personne confirme l'encaissement dans son app Wave.
>   Aucune clé, aucune configuration technique.
> - **API Wave centralisée** (optionnel) : la plateforme crée une session Wave Checkout et redirige
>   le client. Les commandes payées sont marquées **« Payé »** dans le tableau de bord (via webhook).
>   Ce mode nécessite, **côté plateforme uniquement**, les variables d'environnement Render
>   `WAVE_API_KEY` (clé secrète Wave) et, pour la confirmation automatique, `WAVE_WEBHOOK_SECRET`
>   (le webhook pointe vers `POST /api/wave/webhook`, signature HMAC vérifiée). Sans `WAVE_API_KEY`,
>   seul le mode « lien » est proposé.
>
> L'assistant peut aussi placer un bouton de paiement dans une page : `<a data-bat-pay data-amount="5000">Payer</a>`.
> La clé secrète reste **exclusivement** dans les variables Render — jamais dans la discussion ni
> dans le code des sites. **Aucune dépendance npm**, **aucun changement de base** (la configuration
> de paiement est stockée sur le projet).

> **Nouveautés v1.5 — fiabilité**
> - **Une seule structure** : le site est une page unique (le mode « Plusieurs pages » a été
>   retiré). Plus de bascule qui fait tout perdre ou beuguer.
> - **Bouton « ⚡ Créer mon site » retiré** : il brûlait des étapes. À la place, la discussion
>   pousse la personne à donner vite l'essentiel (message, action, rubriques, un contact) ;
>   dès que l'assistant a ce minimum, il construit — puis tout reste modifiable au chat.
> - **Contact & Apparence, moins redondants** : le module Contact rend les coordonnées
>   *cliquables et visibles* (il ne redemande pas ce qui existe déjà) ; le module Apparence est
>   la passe dédiée « couleurs + mobile » qu'un débutant ne penserait pas à réclamer.
> - **Chaque module dit ce qu'on peut faire** : à chaque étape, l'assistant rappelle en une phrase
>   ce que la personne peut faire ou demander à ce stade (pour ceux qui n'y penseraient pas seuls).
> - **Publier, concret** : un bouton **« ⤓ Télécharger mon site »** (en haut de l'aperçu) donne
>   enfin le fichier en main, et le module Publier guide pas à pas la mise en ligne — voie la plus
>   simple d'abord (Netlify Drop : glisser-déposer, sans compte au début), GitHub Pages en option.
>   Jamais de mot de passe ni de clé à coller dans la discussion.
> - **Les modifications ne se perdent plus** : à chaque retouche, le code EXACT du site actuel
>   est réinjecté à Claude, qui renvoie la page entière à jour. Ajouter une rubrique conserve
>   tout le reste.
> - **Le code n'apparaît plus JAMAIS dans la discussion** : l'extraction est « blindée » — elle
>   attrape le HTML quel que soit le format (bloc nommé, simple, sans langage, sans balise de
>   bloc, ou même réponse coupée) et le retire toujours du message affiché.
> - **Espaces médias** : quand un espace n'est pas clair, l'assistant demande d'abord s'il est
>   pour des photos, du texte, ou des documents (PDF / Word / PowerPoint).
> - Test intégré : `npm run selftest` vérifie l'extraction (7 formats).
>
> (Historique plus bas.)

> **Nouveautés v1.4 — le générateur flexible**
> - **Rubriques 100 % libres** : le créateur choisit ses propres entrées (au-delà
>   d'Accueil, Services…) — Tarifs, Blog, FAQ, Équipe, Galerie… — et peut à tout moment
>   **ajouter, renommer, réordonner ou supprimer** n'importe quelle rubrique, juste en le demandant.
> - **Espaces réservés** : une rubrique pas encore remplie affiche un placeholder propre
>   (« Vos réalisations apparaîtront ici ») — jamais de page vide ni de lien cassé.
> - Tout reste **sans base de données** : c'est de la génération de fichiers.
>
> (Historique des correctifs plus bas.)

> **Nouveautés v1.2**
> - **⚡ Créer mon site tout de suite** : un bouton (au-dessus de la discussion) saute
>   directement à la construction pour voir le site vite et commencer à le modifier.
> - **Multi-pages fiable** : chaque entrée du menu a sa vraie page (Accueil, Services,
>   Réalisations, À propos, Contact) — plus de « site pas encore construit ». **Services**
>   est une entrée à part entière.
> - **Tout est modifiable à tout moment** : couleur du **texte** comme de **l'ensemble**,
>   numéro, email, textes… demandez-le dans la discussion, l'aperçu se met à jour.
> - **Bascule 1 page ↔ plusieurs pages silencieuse** : le changement se fait sans
>   message technique dans la discussion.
>
> Pensez à **« ↻ Recommencer »** après le lancement pour repartir sur cette version.
>
> **Contenu de chaque rubrique** — Accueil : accroche + aperçu + bouton d'action ·
> Services : la liste des prestations · Réalisations : la galerie des travaux ·
> À propos : qui vous êtes, votre histoire · Contact : coordonnées et moyens de contact.

Le parcours s'enchaîne d'un bout à l'autre, avec le **rail de progression** à gauche.

```
Diagnostic → M01 Clarifier → M02 Rassembler → M03 Bien parler →
M04 Page d'accueil → M05 Pages clés → M06 Contact → M07 Beau & mobile → M08 Mise en ligne
```

Les modules 04 à 07 font évoluer le MÊME site d'une page (l'aperçu se met à jour) ;
le M08 explique la mise en ligne (sans code).

Chaque étape a son propre « cerveau » (un prompt différent), mais **Claude se
souvient de tout** d'une étape à l'autre : le diagnostic nourrit la clarification,
qui nourrit la construction.

## Ce qui est réuni

- **Le rail** (à gauche) montre où on en est : étape faite ✓, étape en cours, à venir.
- **Le bouton « Étape suivante → »** (en haut de la discussion) fait passer à l'étape
  suivante quand vous êtes prêt.
- **L'aperçu vivant** (étape 4) s'affiche à droite dès qu'on arrive à la construction.
- **La mémoire** (étape 3) : on ferme, on revient, le parcours reprend à la bonne étape.

## Comment lancer

1. Copiez votre **`.env`** (avec la clé) à côté de `server.js`.
2. Fermez tout ancien serveur (Ctrl+C) pour libérer le port 3000.
3. `node server.js`, puis ouvrez **http://localhost:3000**.

## Mettre la plateforme en ligne (Palier 1)

L'app est prête à être hébergée : elle écoute sur le port fourni par l'hébergeur
(`process.env.PORT`), a un script `start`, et le fichier `render.yaml` configure
tout automatiquement. La clé API n'est **jamais** dans le code : on la saisit dans
le tableau de bord de l'hébergeur.

**Sur Render (recommandé, offre gratuite) :**

1. Mettez ce dossier dans un dépôt **GitHub** (compte gratuit → nouveau dépôt →
   « Add files » → glissez tous les fichiers **sauf** `.env`, qui doit rester privé).
2. Sur **render.com**, connectez-vous, puis **New + → Blueprint** et choisissez votre
   dépôt : Render lit `render.yaml` et prépare le service.
3. Dans les réglages, renseignez la variable **`ANTHROPIC_API_KEY`** (votre clé).
   Laissez `ANTHROPIC_MODEL` sur `claude-sonnet-5` (modifiable ensuite).
4. Lancez le déploiement. Au bout d'une minute, vous obtenez une adresse publique
   (ex. `https://batisseur.onrender.com`) : la plateforme est en ligne. 🎉

> **À savoir (important) :** sur l'offre gratuite, le stockage est *temporaire* — les
> conversations et sites générés peuvent être remis à zéro quand le service redémarre.
> C'est normal à ce stade : la **mémoire durable** arrive au **Palier 3** (base de
> données). L'objectif du Palier 1 est seulement que la plateforme soit *accessible en
> ligne*.

## Le bouton « Publier en ligne » (Palier 2)

Un bouton **« 🌐 Publier en ligne »** (en haut de l'aperçu) met le site de l'apprenant
en ligne d'un clic, **sans qu'il crée de compte** : c'est la plateforme qui publie, via
son propre compte Netlify. Après une modification, « ↻ Republier » met à jour la même
adresse. Le bouton n'apparaît que si la plateforme est configurée (sinon, l'app propose
la voie manuelle « Télécharger + Netlify Drop »).

**Pour l'activer (une fois) :**

1. Créez un compte gratuit sur **netlify.com**.
2. Générez un **jeton d'accès** : User settings → Applications → *Personal access tokens*
   → **New access token** → copiez-le.
3. Ajoutez-le à la plateforme comme variable d'environnement **`NETLIFY_TOKEN`** :
   - en local : dans le fichier `.env` (`NETLIFY_TOKEN=...`) ;
   - sur Render : *Environment* → *Add Environment Variable* → `NETLIFY_TOKEN`.
4. Relancez (en local) ou laissez Render redéployer. Le bouton apparaît.

> Les sites des apprenants sont publiés sous **votre** compte Netlify (adresses
> `xxxx.netlify.app`). L'offre gratuite a des limites de volume : pour beaucoup
> d'apprenants, prévoir une formule adaptée le moment venu.

## Certificat de réussite

À la fin du parcours (dernière étape atteinte), un bouton **« 🎓 Mon certificat »**
apparaît en haut de la discussion. Un **certificat de réussite** à la charte Bâtisseur
s'ouvre, prêt à **imprimer ou enregistrer en PDF** (bouton en haut de la page). Il porte
le **nom du compte** (nom vérifié, on ne peut pas émettre un certificat au nom d'un
autre), la date, un numéro unique, et — si le site a été publié — son adresse en ligne.
C'est une attestation de la formation Bâtisseur (pas un diplôme officiel accrédité).

**Certificat vérifiable.** Chaque certificat émis est enregistré, et le certificat imprime
un lien **`/verifier`**. N'importe qui peut aller sur cette page publique, saisir le numéro
(ex. `BÂT-1A2B3C4D`) et obtenir la confirmation : nom, date, session, et lien du site. La
recherche est tolérante (casse, accents, tirets). Cela permet à un tiers (employeur, etc.)
de confirmer l'authenticité d'un certificat.

> **Si vous utilisez Supabase**, créez la table des certificats (dans **SQL Editor**) :
>
> ```sql
> create table if not exists certificates (
>   num text primary key,
>   data jsonb,
>   created_at timestamptz default now()
> );
> ```

## Mémoire durable — base de données (Palier 3)

Par défaut, l'app stocke les conversations et les sites en **fichiers locaux** : sur un
hébergement gratuit, ils sont **remis à zéro** quand le service redémarre. En branchant
**Supabase** (gratuit pour démarrer), tout est **conservé durablement**. L'app bascule
automatiquement sur la base dès que `SUPABASE_URL` et `SUPABASE_KEY` sont présents
(sinon elle reste en fichiers — rien ne casse).

**Pour l'activer (une fois) :**

1. Créez un projet sur **supabase.com**.
2. Dans **SQL Editor**, exécutez ce script pour créer les deux tables :

   ```sql
   create table if not exists conversations (
     id text primary key,
     data jsonb,
     updated_at timestamptz default now()
   );
   create table if not exists sites (
     id text primary key,
     html text,
     updated_at timestamptz default now()
   );
   ```

3. Dans **Project Settings → API**, copiez :
   - **Project URL** → variable `SUPABASE_URL`
   - la clé **`service_role`** (secrète) → variable `SUPABASE_KEY`
4. Ajoutez ces deux variables à la plateforme :
   - en local : dans `.env` ;
   - sur Render : *Environment* → *Add Environment Variable* (× 2).
5. Enregistrez. Render redéploie. Au démarrage, la console indique
   `Mémoire : base de données (Supabase)`.

> La clé `service_role` a tous les droits : elle vit **uniquement** côté serveur
> (jamais dans le navigateur ni dans le code public). Elle est déjà utilisée ainsi ici.

## Comptes & espace membre (Palier 4)

Un apprenant peut **créer un compte** (bouton **« Se connecter »** en haut à droite).
Une fois connecté :

- ses **projets sont enregistrés sur son compte** et retrouvables depuis n'importe
  quel appareil — dans **« ◱ Mon espace »** (la liste de ses projets, avec l'étape en
  cours et le statut « site prêt » / « en ligne ») ;
- ses projets deviennent **privés** : l'aperçu, le téléchargement et le certificat ne
  sont accessibles qu'à lui (les autres comptes reçoivent un refus) ;
- son **certificat porte automatiquement son nom** de compte.

Les comptes sont **optionnels** : sans se connecter, on construit exactement comme avant
(le projet reste anonyme, retenu par le navigateur). Rien ne casse si personne ne crée
de compte.

**Comment ça marche (sans dépendance) :** les mots de passe ne sont **jamais** stockés en
clair — ils sont hachés avec `crypto.scrypt` (intégré à Node). La session est un **jeton
aléatoire** conservé côté serveur (base de données ou fichier) et déposé dans un cookie
`HttpOnly`. Comme le reste, ça bascule tout seul sur Supabase si la base est configurée,
sinon sur un fichier local (`data/accounts.json`).

**Si vous utilisez Supabase (Palier 3),** ajoutez les **deux tables** des comptes dans
**SQL Editor** :

```sql
create table if not exists users (
  id text primary key,
  email text unique,
  name text,
  pass text,
  created_at timestamptz default now()
);
create table if not exists sessions (
  token text primary key,
  user_id text,
  created_at timestamptz default now()
);
```

Aucune variable d'environnement supplémentaire n'est nécessaire : la fonctionnalité
s'appuie sur la base déjà branchée (ou sur les fichiers locaux à défaut).

## Types de projet & volets combinés (Paliers 5 et 6)

Au démarrage d'un nouveau projet, une fenêtre **« Que voulez-vous créer ? »** propose de
**cocher un ou plusieurs volets** :

- **🪧 Présentation** — présenter une activité, un métier, une association (site vitrine).
- **🛍️ Boutique en ligne** — une grille de produits (photo, nom, prix, description) et une
  rubrique « Comment commander » avec un contact cliquable ou un formulaire simple.
- **📅 Prise de rendez-vous** — des prestations (durée, prix), les horaires, et une rubrique
  « Demander un rendez-vous » avec un formulaire simple.

**Un projet peut en réunir plusieurs à la fois** (Palier 6) : par exemple *Présentation +
Boutique + Rendez-vous*. L'assistant construit alors **un seul site cohérent** où chaque
volet a sa section et son entrée de menu, avec une identité visuelle unique. Les volets
choisis **orientent tout le parcours** (le diagnostic comme la construction) : un badge les
affiche en haut de la discussion, et chaque projet de « Mon espace » indique sa composition.
On change de composition en cliquant **« ↻ Recommencer »**.

> **Version « vitrine intelligente ».** La boutique et la prise de rendez-vous sont
> **présentées** joliment, mais la commande / la demande de créneau se fait par **contact ou
> formulaire** (lien `mailto:`), sans paiement en ligne ni agenda interactif. Tout reste
> **100 % HTML/CSS, sans JavaScript** : c'est ce qui garde les sites increvables. Les vraies
> fonctions interactives (panier qui calcule, calendrier de réservation) sont une étape
> ultérieure.

Rien de nouveau à installer ni à configurer : ces fonctionnalités ne changent pas le moteur,
elles guident seulement l'assistant. Les anciens projets restent compatibles.

### Panier & réservation interactifs (côté visiteur)

Les volets **boutique** et **rendez-vous** sont **interactifs** pour le visiteur du site :

- **Boutique** — un vrai **panier** : le visiteur ajoute des produits, le **total se calcule**
  tout seul, et le bouton **« Commander »** prépare un message **pré-rempli** avec la commande,
  envoyé par **WhatsApp** (si un numéro figure sur le site) ou par **email**.
- **Rendez-vous** — le formulaire (prestation, date, heure, coordonnées) prépare une **demande
  pré-remplie** envoyée de la même façon.

Comment c'est fiable : la plateforme **injecte automatiquement** un petit script d'interactivité
(fixe et testé) dans ces sites ; l'assistant, lui, ne produit que du HTML avec des attributs
`data-bat-…`. Il n'écrit jamais de JavaScript lui-même — c'est ce qui évite les bugs. Ça reste
**100 % côté visiteur** : aucun paiement en ligne, aucune base de données, aucune donnée
enregistrée sur un serveur — la commande/demande part vers le vendeur par email ou WhatsApp.
Ça fonctionne sur le site **publié** (fichier statique) comme dans l'aperçu.

## Espace formateur & gestion des apprenants

Bâtisseur devient un **outil de formation géré** : vous inscrivez vos apprenants, vous leur
attribuez une **session** (leur mois / quinzaine de formation), et vous **contrôlez leur
accès**.

**Devenir formateur (admin).** Ajoutez une variable d'environnement **`ADMIN_EMAILS`** avec
votre (vos) adresse(s), séparées par des virgules :

```
ADMIN_EMAILS=djetebetheldjete@gmail.com
```

- en local : dans `.env` ;
- sur Render : *Environment* → *Add Environment Variable*.

Créez ensuite votre compte avec cette adresse (bouton « Se connecter » → « Créer un compte ») :
il est **actif d'emblée** et fait apparaître le bouton **« ◱ Espace formateur »** en haut.

**Ce que vous pouvez faire dans l'espace formateur :**

- **Inscrire un apprenant** (nom, email, session, mot de passe) — son compte est actif tout de
  suite, vous lui transmettez ses identifiants ;
- voir tous les apprenants, avec leur **session**, leur **statut** et le nombre de projets ;
- changer le **statut** d'un clic : **Actif** (accès complet), **En attente** (pas encore
  d'accès), **Terminé** (ne peut plus construire) ;
- modifier la **session** de chacun ;
- un **tableau de bord** : nombre d'apprenants actifs / en attente / terminés.

**Les trois statuts.**

- **En attente** — une personne qui s'inscrit elle-même arrive ainsi : elle n'a pas accès au
  parcours tant que vous ne l'avez pas validée (et affectée à une session).
- **Actif** — accès complet au parcours et à ses projets.
- **Terminé** — l'apprenant **ne peut plus construire ni modifier**, mais peut encore
  **consulter et télécharger** ses projets et récupérer son **certificat**. Repassez-le en
  **Actif** pour le réautoriser.

> **Important :** construire un site demande désormais un **compte actif**. La construction
> anonyme (sans compte) n'est plus possible — c'est ce qui permet de réserver Bâtisseur à vos
> apprenants inscrits.

**Si vous utilisez Supabase**, ajoutez les deux colonnes de statut à la table `users`
(dans **SQL Editor**) :

```sql
alter table users add column if not exists status text default 'active';
alter table users add column if not exists cohort text;
```

(Le défaut `active` garde l'accès à vos comptes déjà créés ; les nouvelles auto-inscriptions
sont mises « en attente » automatiquement par l'application.)

## Plusieurs clés API & modèle allégé (économie / robustesse)

- **Plusieurs clés** : en plus de `ANTHROPIC_API_KEY`, on peut renseigner `ANTHROPIC_API_KEYS`
  (des clés séparées par des virgules). L'app **bascule automatiquement** sur la clé suivante
  si l'une est saturée (limite atteinte) ou en erreur — pratique pendant une session en direct
  où plusieurs apprenants construisent en même temps. Avec une seule clé, rien ne change.
  > Attention : plusieurs clés d'un **même compte** Anthropic partagent la même limite de débit
  > (les limites sont au niveau de l'organisation). Ça apporte surtout de la **résilience** ; pour
  > vraiment plus de débit, il faut monter de palier d'usage, ou des clés de comptes distincts.
- **Modèle allégé par étape** : `ANTHROPIC_MODEL_LIGHT` (optionnel) sert pour les étapes de
  **discussion** (moins coûteux), tandis que `ANTHROPIC_MODEL` reste pour la **construction** du
  site. Par défaut les deux sont identiques. Ex. : `ANTHROPIC_MODEL_LIGHT=claude-haiku-4-5-…`.

## Sessions de formation (dates, places, réservation)

Le formateur publie des **sessions** datées, et chaque apprenant **réserve sa place** en
choisissant la sienne à l'inscription.

- Dans **« ◱ Espace formateur » → Sessions de formation**, un formulaire **génère** les sessions
  d'un coup : *date de début*, *intervalle* (14 jours), *nombre*, *places par session* (15).
  Chaque session est datée automatiquement (ex. « Session du samedi 10 octobre 2026 »).
- À l'inscription, l'apprenant **voit les sessions ouvertes avec les places restantes** et en
  choisit une. Quand une session est **complète**, elle n'est plus proposée (pas de surbooking).
- Le formateur peut **fermer/rouvrir** une session, **changer sa capacité**, et **affecter ou
  déplacer** un apprenant d'une session à l'autre (menu déroulant sur chaque apprenant).
- Une place occupée = un apprenant *en attente* ou *actif* dans la session.

> **Si vous utilisez Supabase**, créez la table des sessions et ajoutez la colonne de session à
> la table `users` (dans **SQL Editor**) :
>
> ```sql
> create table if not exists cohorts (
>   id text primary key,
>   data jsonb,
>   created_at timestamptz default now()
> );
> alter table users add column if not exists cohort_id text;
> ```

## Applications web — enregistrer les données (Niveau 2, Étape A)

Première brique des vraies applications : les **commandes** (boutique) et les **rendez-vous**
envoyés depuis un site publié sont désormais **enregistrés**, et l'apprenant les retrouve dans
un bouton **« 📋 Données »** (en haut de l'aperçu) — liste, détail, suppression.

- Fonctionne aussi sur le **site publié** (statique) : une petite « trousse de données » est
  injectée dans les sites boutique/rendez-vous ; elle envoie chaque commande / demande au
  moteur de données de la plateforme (en plus d'ouvrir l'e-mail ou WhatsApp comme avant).
- **Isolé par projet** : seul le propriétaire du projet voit ses données.
- **Garde-fous anti-abus** : limite de débit par visiteur et par jour, taille maximale,
  piège anti-robot invisible (champ `bat_hp`).

> **Si vous utilisez Supabase**, créez la table des données (dans **SQL Editor**) :
>
> ```sql
> create table if not exists submissions (
>   id text primary key,
>   project_id text,
>   collection text,
>   data jsonb,
>   status text default 'nouveau',
>   created_at timestamptz default now()
> );
> ```
>
> Si la table `submissions` existait déjà (avant le suivi de statut), ajoutez la colonne :
>
> ```sql
> alter table submissions add column if not exists status text default 'nouveau';
> ```

**Suivi de statut.** Chaque commande / rendez-vous / message a un statut que le propriétaire fait
évoluer d'un menu, dans « 📋 Données » : **Nouveau → En cours → Prêt → Terminé**.

**L'assistant propose les fonctions « appli ».** Pendant la discussion, quand le projet s'y prête
(vendre, prendre des commandes, un service, une communauté), l'assistant suggère de lui-même, en
langage simple, les possibilités adaptées (boutique + commandes suivies, rendez-vous, espace
membre…) et invite à cocher le bon volet.

## Applications web — espace membre (Niveau 2, Étape B)

Deuxième brique : les **visiteurs** d'un site créé peuvent **créer un compte et se connecter**
(espace client), et accéder à des **sections réservées**.

- Nouveau volet **« 🔐 Espace membre »** au choix, au démarrage d'un projet (combinable).
- L'assistant ajoute un bloc de connexion `<div data-bat-auth></div>` (la plateforme y affiche
  « Créer un compte / Se connecter », puis le nom du membre + « Se déconnecter »), et marque les
  sections privées avec `data-bat-members` (masquées tant qu'on n'est pas connecté).
- **Comptes isolés par application** : un même e-mail peut exister sur deux sites différents ;
  un compte d'un site ne donne aucun accès à un autre.
- **Sans cookie tiers** : l'authentification du visiteur utilise un jeton stocké dans son
  navigateur (adapté aux sites publiés sur un autre domaine).
- Les **commandes / rendez-vous** passés par un membre connecté lui sont **rattachés** (visibles
  dans « 📋 Données »), et le propriétaire voit la **liste de ses membres**.

> **Si vous utilisez Supabase**, créez les deux tables (dans **SQL Editor**) :
>
> ```sql
> create table if not exists app_users (
>   id text primary key,
>   app_id text,
>   email text,
>   name text,
>   pass text,
>   created_at timestamptz default now()
> );
> create table if not exists app_sessions (
>   token text primary key,
>   app_id text,
>   user_id text,
>   created_at timestamptz default now()
> );
> ```

Suite prévue (voir le document de plan) : **Étape C** — générateur d'applications sur mesure
(écrans reliés au moteur de données).

## Mettre à jour la plateforme déjà en ligne

Le service Render est relié à votre dépôt GitHub. Pour publier une nouvelle version :
remplacez les fichiers dans le dossier du dépôt, faites **Commit** puis **Push** (via
GitHub Desktop) — Render **redéploie tout seul** en une minute.

## Le test « bout en bout »

1. **Diagnostic** : Claude vous accueille, comprend votre projet (dites par ex.
   « un site pour ma menuiserie »), et propose un parcours.
2. Cliquez **« Étape suivante → »**. Vous passez à **Clarifier** : Claude définit avec
   vous le message, l'action et les pages, puis récapitule le plan.
3. Cliquez encore **« Étape suivante → »**. Vous passez à **Construction** : Claude
   génère votre site **à partir de tout ce qui précède**, et il s'affiche à droite. 🎉
4. Demandez des retouches (« ambiance bois », « ajoute mon numéro »…) : l'aperçu se met à jour.
5. Fermez, rouvrez : le parcours **reprend à la bonne étape**, avec le site.

C'est la démonstration que **tout le circuit tient** : orienter → clarifier → construire,
avec mémoire et aperçu, entièrement propulsé par Claude.

## Bon à savoir

- Les prompts de chaque étape sont dans `prompts/` (`diagnostic.txt`, `clarifier.txt`,
  `construire.txt`). Vous pouvez les ajuster librement.
- **Ajouter les modules manquants (02, 03, 05→08)** = ajouter un fichier de prompt et une
  entrée dans la liste `STEPS` de `server.js` (+ une ligne dans `STEP_LABELS` côté page).
  L'architecture est faite pour grandir sur le même rail.
- Chaque étape consomme du crédit d'API ; la construction un peu plus (page entière).

## Où on en est du projet

Le **MVP technique est complet** : les 5 étapes du plan « Passage au réel » fonctionnent.
La suite, ce sont des extensions : les autres modules, les vrais comptes utilisateurs, la
mise en ligne du site créé, et l'hébergement de la plateforme elle-même.
