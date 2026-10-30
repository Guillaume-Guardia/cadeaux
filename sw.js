// Service worker : l'app (fichiers de ce site) reste disponible hors ligne.
// Changer VERSION à chaque modification des fichiers pour proposer la mise à jour.
const VERSION = "cadeaux-v1";
const FICHIERS = [
	"./",
	"index.html",
	"style.css",
	"app.js",
	"config.js",
	"manifest.webmanifest",
	"icons/icon.svg",
	"icons/icon-192.png",
	"icons/apple-touch-icon.png",
];

self.addEventListener("install", (evenement) => {
	evenement.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FICHIERS)));
});

self.addEventListener("activate", (evenement) => {
	evenement.waitUntil(
		caches
			.keys()
			.then((cles) => Promise.all(cles.filter((cle) => cle !== VERSION).map((cle) => caches.delete(cle))))
			.then(() => self.clients.claim()),
	);
});

// L'app demande l'activation quand l'utilisateur accepte la mise à jour.
self.addEventListener("message", (evenement) => {
	if (evenement.data === "activer") self.skipWaiting();
});

// Fichiers du site : depuis le cache, rafraîchi en arrière-plan. L'API (autre origine, POST)
// n'est jamais mise en cache : les données hors ligne sont gardées par l'app elle-même.
self.addEventListener("fetch", (evenement) => {
	const requete = evenement.request;
	if (requete.method !== "GET" || new URL(requete.url).origin !== self.location.origin) return;
	evenement.respondWith(
		caches.open(VERSION).then(async (cache) => {
			const enCache = await cache.match(requete, { ignoreSearch: true });
			const reseau = fetch(requete)
				.then((reponse) => {
					if (reponse.ok) cache.put(requete, reponse.clone());
					return reponse;
				})
				.catch(() => enCache || cache.match("index.html"));
			if (enCache) {
				evenement.waitUntil(reseau);
				return enCache;
			}
			return reseau;
		}),
	);
});
