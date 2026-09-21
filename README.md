# Bâtisseur — parcours complet (v1.5)

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
