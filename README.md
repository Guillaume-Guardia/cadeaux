# Cadeaux

PWA des listes de cadeaux de Noël de la famille : **https://guillaume-guardia.github.io/cadeaux/**

- **Ma liste** : ajouter, modifier, supprimer ses idées (titre, détails, lien, prix, envie). On ne voit jamais ce qui est réservé sur sa propre liste, ni ce que les autres y suggèrent.
- **Famille** : la liste de chaque membre, avec « Disponible », « Réservé par X » ou « Tu l'offres ». On peut toucher **plusieurs prénoms** : leurs listes sont réunies et on peut leur proposer une **idée commune** (ex. un couple). On peut y **suggérer une idée** pour quelqu'un (il ne la verra pas), ajouter un proche **sans compte** (enfant, grands-parents…) dont la famille tient la liste, et revoir ce qu'on lui a déjà offert.
- **Cadeaux groupés** : celui qui offre un cadeau peut cocher « Partager » ; les autres voient alors « Participer » et rejoignent ceux qui l'offrent. « J'offre » ne compte que sa part.
- **Disponibles** : tous les cadeaux encore libres de la famille, par personne, filtrables et triables. On en coche un ou plusieurs puis « Je les offre ».
- **J'offre** : ce qu'on offre, à qui, et le total. Un cadeau supprimé après réservation y apparaît « retiré de la liste ». En tête, ses **Secret Santa** : la personne tirée au sort (masquée jusqu'à « Afficher ») et un lien vers sa liste ; « + Organiser » en crée un sur une ou plusieurs de ses familles (participants, budget, exclusions comme un couple).
- **Historique** : les cadeaux qu'on a offerts, visibles de soi seul. Les réservations y passent chaque 26 décembre ; on peut aussi en ajouter.

Connexion : un **code famille**, puis son prénom (ou s'ajouter, avec son anniversaire si on veut). Le menu (initiale en haut à droite) donne les codes de ses familles, le **profil** (nom, anniversaire, affiché sur sa fiche) et permet de **rejoindre** ou de **créer** une famille. Avec plusieurs familles, des pastilles en haut des onglets Famille et Disponibles choisissent lesquelles afficher, une ou plusieurs à la fois. La version de l'app est affichée en bas du menu et de l'écran de connexion.

L'app s'installe sur le téléphone (Android/ordinateur : menu → Installer l'app ; iPhone : Safari → Partager → Sur l'écran d'accueil). Hors ligne, elle affiche les dernières listes chargées, en lecture seule.

## Fonctionnement

Site statique sans build (HTML, CSS, JavaScript), servi par GitHub Pages depuis `main`.

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css`, `app.js` | l'app |
| `config.js` | adresse de l'API (`window.API_URL`) |
| `version.js` | version de l'app (affichée, et nom du cache du service worker) |
| `manifest.webmanifest`, `icons/` | installation (PWA) |
| `sw.js` | service worker : fichiers en cache pour le hors ligne |

Les données sont dans un Google Sheet, derrière une **Web App Apps Script** : projet `projets/cadeaux` du monorepo privé AppScripts (actions de l'API et règles de visibilité documentées dans son README). L'app l'appelle en `POST` avec un corps JSON en `text/plain`, pour éviter la requête préalable CORS.

## Modifier l'app

1. Tester en local : `npx serve .` (le service worker demande `localhost` ou HTTPS) ;
2. **augmenter la version dans `version.js`** à chaque modification d'un fichier : les téléphones voient alors le bandeau « Nouvelle version disponible » ;
3. pousser sur `main` : GitHub Pages publie en une minute environ.
