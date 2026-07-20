# Catalogue Dépôt — app hébergeable avec compte admin unique

Application web complète : catalogue public (lecture + panier + commande WhatsApp) et
espace admin protégé par un **seul compte** (identifiant + mot de passe), qui peut :
- ajouter / modifier / supprimer un article,
- **importer un fichier Excel (.xlsx/.xls/.csv)** pour mettre à jour tout le stock d'un coup.

Aucun autre visiteur ne peut se connecter ou modifier quoi que ce soit — tout le monde
d'autre ne fait que consulter et commander.

## 1. Configuration (30 secondes)

Copiez `.env.example` en `.env` et changez au minimum :
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=un_mot_de_passe_solide
SESSION_SECRET=une_longue_chaine_aleatoire
```
Générer une valeur aléatoire pour `SESSION_SECRET` :
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Lancer en local (pour tester)
```
npm install
npm start
```
Ouvrez http://localhost:3000 — cliquez sur le cadenas 🔒 en haut à droite pour vous
connecter en admin.

## 3. Héberger rapidement (production)

Le plus rapide, sans carte bancaire, en quelques minutes :

### Option A — Render.com (recommandé, gratuit pour démarrer)
1. Créez un dépôt GitHub avec ce dossier (ou utilisez "Upload" sur GitHub directement).
2. Sur https://render.com → **New +** → **Web Service** → connectez le dépôt.
3. Render détecte Node automatiquement. Réglages :
   - Build Command : `npm install`
   - Start Command : `node server.js`
4. Dans **Environment**, ajoutez `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`,
   `NODE_ENV=production`.
5. **Important (persistance des données)** : ajoutez un *Disk* Render (Render → onglet
   Disks) monté sur `/app/data` (quelques centaines de Mo suffisent). Sans disque
   persistant, les modifications sont perdues à chaque redéploiement du service.
6. Déployez — vous obtenez une URL publique en 2-3 minutes.

### Option B — Railway.app
1. https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Railway détecte Node et lance `npm start` automatiquement.
3. Ajoutez les mêmes variables d'environnement dans l'onglet **Variables**.
4. Ajoutez un **Volume** monté sur `/app/data` pour la persistance (Railway → Settings → Volumes).

### Option C — N'importe quel hébergeur Docker (VPS, Fly.io, etc.)
Un `Dockerfile` est fourni :
```
docker build -t catalogue-depot .
docker run -d -p 3000:3000 \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=... -e SESSION_SECRET=... -e NODE_ENV=production \
  -v $(pwd)/data:/app/data \
  catalogue-depot
```
Le volume `-v` garantit que le catalogue survit aux redémarrages du conteneur.

## 4. Utilisation de l'import Excel

Dans l'espace admin (bouton 📥), le fichier Excel doit avoir une **première ligne
d'en-têtes**. Colonnes reconnues (accents/majuscules ignorés) :

| Champ         | En-têtes acceptés                                  | Obligatoire |
|---------------|-----------------------------------------------------|-------------|
| Nom           | `name`, `nom`, `désignation`, `article`, `produit`  | ✅ |
| Catégorie     | `category`, `catégorie`                              | non |
| Marque        | `brand`, `marque`                                    | non |
| Quantité      | `qty`, `quantité`, `stock`                            | non |
| Prix de vente | `price`, `prix`, `prix vente`                         | non |
| Coût (achat)  | `cost`, `coût`, `prix achat`                          | non |
| Unité         | `unit`, `unité`                                       | non |
| Identifiant   | `id`, `ref`, `référence`                              | non |

Deux modes d'import :
- **Remplacer tout le catalogue** : le fichier devient la nouvelle base complète
  (tout ce qui n'est pas dans le fichier est supprimé). C'est le mode par défaut,
  adapté si votre Excel contient l'intégralité du stock.
- **Mettre à jour / fusionner** : les articles du fichier mettent à jour les articles
  existants (par id, sinon par nom+marque) et les nouveaux sont ajoutés ; le reste du
  catalogue n'est pas touché.

## 5. Sécurité

- Un seul compte admin existe (pas d'inscription, pas de gestion multi-utilisateurs).
- Le mot de passe est comparé en temps constant (`crypto.timingSafeEqual`) pour limiter
  les attaques par timing, et les tentatives de connexion sont limitées (8 essais / 15 min / IP).
- Le prix d'achat (`cost`) n'est jamais renvoyé par l'API publique, seulement dans
  l'espace admin.
- Mettez toujours `NODE_ENV=production` en ligne pour que les cookies de session soient
  marqués `secure` (HTTPS uniquement) — la plupart des hébergeurs (Render, Railway, Fly)
  fournissent le HTTPS automatiquement.

## Structure du projet
```
catalogue-app/
├── server.js           # API + serveur Express (auth, produits, import Excel)
├── public/index.html   # Interface catalogue + panier + espace admin
├── data/products.json  # Base de données du catalogue (fichier JSON)
├── package.json
├── Dockerfile
├── .env.example
└── README.md
```
