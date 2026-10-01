# Mon projet — exporté depuis Bâtisseur

Félicitations : ce dossier est **votre application, indépendante**. Elle n'a plus besoin de Bâtisseur pour fonctionner — elle a son propre « cerveau » (le fichier `server.js`).

## Ce qu'il y a dans le dossier
- `public/index.html` — votre application (l'écran que voient les utilisateurs).
- `server.js` — le mini-serveur qui fournit les données partagées, les comptes membres, etc. **Pur Node.js, rien à installer.**
- `schema.sql` — à exécuter dans Supabase si vous voulez une vraie base permanente.
- `package.json` — décrit comment démarrer le projet.

---

## 1) Essayer sur votre ordinateur (2 minutes)

Il faut avoir **Node.js** installé (nodejs.org). Ensuite, dans ce dossier :

```
node server.js
```

Ouvrez **http://localhost:3000** : votre application tourne, avec ses données.
Au début, les données sont gardées dans un simple fichier `data.json` (parfait pour tester).

---

## 2) Mettre en ligne gratuitement (Render)

1. Créez un dépôt sur **GitHub** et déposez-y tout ce dossier.
2. Sur **render.com**, cliquez **New → Web Service**, choisissez votre dépôt.
3. Réglages : **Build Command** = (laisser vide) · **Start Command** = `node server.js`.
4. Déployez. Render vous donne une adresse `https://...onrender.com` : votre site est en ligne !

---

## 3) Une vraie base permanente (Supabase) — recommandé pour de vrai

Le fichier local `data.json` suffit pour tester, mais sur un hébergement gratuit il peut être remis à zéro. Pour des données **permanentes et partagées** :

1. Créez un projet gratuit sur **supabase.com**.
2. Dans **SQL Editor**, collez le contenu de `schema.sql` et cliquez **Run**.
3. Dans Supabase → **Project Settings → API**, copiez :
   - l'**URL du projet** (Project URL)
   - la clé **service_role** (secrète).
4. Sur Render → votre service → **Environment**, ajoutez deux variables :
   - `SUPABASE_URL` = l'URL du projet
   - `SUPABASE_KEY` = la clé service_role
5. Redéployez. Vos données vivent maintenant dans Supabase.

> ⚠️ Gardez la clé `service_role` **secrète** : ne la mettez jamais dans le code ni sur une page publique, seulement dans les variables d'environnement de Render.

---

## Comment l'application parle à son serveur

Votre `index.html` utilise les mêmes commandes que dans l'atelier Bâtisseur :

```
await Batisseur.save('public_annonces', { titre: '...', prix: 500 });
const liste = await Batisseur.list('public_annonces');
await Batisseur.signup(email, nom, motdepasse);
await Batisseur.login(email, motdepasse);
```

- une collection dont le nom commence par **`public_`** est visible par tout le monde ;
- toute autre collection est **privée** (chaque membre ne voit que ses propres données).

Bravo — vous avez un vrai projet, à vous. 🎓
