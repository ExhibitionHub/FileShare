# FileShare

Service HTTP pour publier des images PNG, JPEG ou WebP, les partager par URL/QR et alimenter Dino Passport. Il utilise le disque local pour un déploiement simple ou un stockage S3-compatible pour plusieurs instances et régions.

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

`expiresInHours` est facultatif sur les uploads. Par défaut, une image expire après **7 jours**. Un nettoyage s'exécute au démarrage puis toutes les 15 minutes. `ALLOW_PERMANENT_FILES=false` empêche un client de demander la valeur `0`.

## Mise en production

Définir au minimum :

- `PUBLIC_BASE_URL=https://files.votre-domaine.tld` ;
- `PASSPORT_BASE_URL=https://passport.votre-domaine.tld/` ;
- `UPLOAD_API_KEY`/`UPLOAD_API_KEYS` avec des valeurs aléatoires si les clients savent les envoyer ;
- `CORS_ORIGINS` avec les origines exactes des applications.

Le reverse proxy doit fournir HTTPS : Dino Passport exige une URL d'API et une URL d'image HTTPS sur la même origine.

### Déploiement mondial et forte charge

Pour plusieurs instances, utiliser `STORAGE_DRIVER=s3`. Les instances deviennent interchangeables et partagent les mêmes images :

```env
STORAGE_DRIVER=s3
S3_BUCKET=exhibitionhub-files
S3_REGION=auto
S3_ENDPOINT=https://endpoint-s3-compatible
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=fileshare/
```

Le compte objet doit pouvoir lire, écrire, lister et supprimer uniquement ce bucket/préfixe. Sur AWS, préférer un rôle IAM/workload identity et laisser les deux variables de clé vides. En production importante, configurer également une règle de cycle de vie du bucket correspondant à la durée maximale : elle sert de second filet de nettoyage.

Les protections applicatives sont actives par défaut :

- limite par adresse avec réponses `429` ;
- 20 uploads simultanés et 100 en attente maximum ;
- réponse `503` avec `Retry-After` lorsque la file est pleine ;
- taille d'image limitée à 5 Mo et délai maximal des requêtes ;
- cache public court pour les images expirables ;
- en-têtes HTTP défensifs.

En production, les uploads publics sont refusés tant qu'une clé n'est pas configurée. Le client navigateur Create Your Dino actuel ne peut pas conserver un secret : la meilleure configuration est un petit proxy serveur par site avec une clé propre. À défaut, `ALLOW_PUBLIC_UPLOADS=true` active explicitement les uploads sans clé ; conserver alors des limites strictes au niveau du CDN et restreindre `CORS_ORIGINS`.

Pour une charge mondiale, placer plusieurs instances derrière un CDN/load balancer et appliquer aussi les limites au niveau du CDN. Les limites Node sont volontairement locales à chaque instance. Lancer le nettoyage sur une seule instance (`CLEANUP_ENABLED=true`) et le désactiver sur les autres, ou s'appuyer principalement sur le cycle de vie S3.

Avec `STORAGE_DRIVER=filesystem`, le volume `DATA_DIR` doit être persistant et une seule instance doit l'utiliser.

### Branchement des applications Dino

Une fois le domaine FileShare connu, utiliser la même base HTTPS dans les deux projets :

- Create Your Dino, `public/config/runtime-config.json` : `publicationApiUrl: "https://files.votre-domaine.tld/"` ;
- Dino Passport, `public/config/runtime-config.json` : `creationApiUrl: "https://files.votre-domaine.tld/"` ;
- Create Your Dino, `passportUrl` : l'URL HTTPS publique de Dino Passport.

Le client Create Your Dino publie alors l'image sur `POST /creations`, ajoute l'identifiant retourné à son QR et Dino Passport récupère exactement cette image avec `GET /creations/:id`.

Pour lancer la validation : `npm run check`.
