# FileShare

Service HTTP minimal pour publier des images PNG, JPEG ou WebP, les partager par URL/QR et alimenter Dino Passport. Les images sont conservées sur le disque local ; aucun service cloud n'est requis.

## Démarrage

Prérequis : Node.js 20 ou plus récent.

```sh
npm ci
copy .env.example .env
npm start
```

Le service écoute par défaut sur `http://localhost:3101`. `GET /health` permet de vérifier son état.

Avec Docker :

```sh
docker compose up --build
```

## API

Les écritures utilisent `X-API-Key` ou `Authorization: Bearer ...` lorsque `UPLOAD_API_KEY` est configurée. Les lectures sont publiques afin que les QR et Dino Passport fonctionnent sans compte.

Publier une image générique :

```sh
curl -X POST http://localhost:3101/v1/files \
  -F "file=@image.webp" \
  -F "application=create-your-dino" \
  -F "label=Mon dinosaure"
```

Publier une création Dino :

```sh
curl -X POST http://localhost:3101/creations \
  -F "image=@dino.png" \
  -F "prefabId=tyrannosaurus-atavisme" \
  -F "backgroundId=jungle-volcanique" \
  -F "personality=curious" \
  -F "roar=deep"
```

Le client Create Your Dino existant peut aussi envoyer ses sélections dans un unique champ `metadata` JSON. Cette forme est acceptée sans adaptation du client : `image=@dino.webp` et `metadata={"prefabId":"...","backgroundId":"...","personality":"...","roar":"..."}`.

La réponse contient `id`, `imageUrl`, `shareUrl`, `qrCodeUrl` et `passportUrl`. Le contrat attendu par Dino Passport est disponible sur `GET /creations/:id` :

```json
{
  "id": "identifiant",
  "imageUrl": "https://files.example.com/images/identifiant"
}
```

Routes principales :

| Méthode | Route | Usage |
| --- | --- | --- |
| `POST` | `/v1/files` | publier une image |
| `GET` | `/v1/files/:id` | lire ses métadonnées |
| `GET` | `/v1/files/:id/qr` | obtenir son QR en PNG |
| `POST` | `/creations` | publier une création Dino |
| `GET` | `/creations/:id` | contrat Dino Passport |
| `GET` | `/creations/:id/qr` | QR vers Dino Passport |
| `GET` | `/images/:id` | contenu brut de l'image |
| `GET` | `/s/:id` | page publique de partage |
| `DELETE` | `/v1/files/:id` | supprimer l'image |

`expiresInHours` est facultatif sur les uploads. La valeur `0` signifie aucune expiration.

## Mise en production

Définir au minimum :

- `PUBLIC_BASE_URL=https://files.votre-domaine.tld` ;
- `PASSPORT_BASE_URL=https://passport.votre-domaine.tld/` ;
- `UPLOAD_API_KEY` avec une valeur aléatoire si les clients savent l'envoyer ; le client navigateur Create Your Dino actuel nécessite de laisser cette variable vide ou de passer par un proxy serveur ;
- `CORS_ORIGINS` avec les origines exactes des applications.

Le volume `DATA_DIR` doit être sauvegardé et persistant. Le reverse proxy doit fournir HTTPS : Dino Passport exige une URL d'API et une URL d'image HTTPS sur la même origine.

### Branchement des applications Dino

Une fois le domaine FileShare connu, utiliser la même base HTTPS dans les deux projets :

- Create Your Dino, `public/config/runtime-config.json` : `publicationApiUrl: "https://files.votre-domaine.tld/"` ;
- Dino Passport, `public/config/runtime-config.json` : `creationApiUrl: "https://files.votre-domaine.tld/"` ;
- Create Your Dino, `passportUrl` : l'URL HTTPS publique de Dino Passport.

Le client Create Your Dino publie alors l'image sur `POST /creations`, ajoute l'identifiant retourné à son QR et Dino Passport récupère exactement cette image avec `GET /creations/:id`.

Pour lancer la validation : `npm run check`.
