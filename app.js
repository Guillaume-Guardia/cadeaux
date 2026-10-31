"use strict";

// ---------------------------------------------------------------------------
// Stockage local (préférences de ce navigateur : code, membre, dernier état)
// ---------------------------------------------------------------------------

const CLES = {
	cle: "cadeaux.cle",
	code: "cadeaux.code",
	membre: "cadeaux.membre",
	etat: "cadeaux.etat",
	onglet: "cadeaux.onglet",
	familles: "cadeaux.familles",
};

function lireFamillesActives() {
	try {
		return new Set(JSON.parse(lireStockage(CLES.familles) || "[]"));
	} catch {
		return new Set();
	}
}

function lireStockage(cle) {
	try {
		return localStorage.getItem(cle);
	} catch {
		return null;
	}
}

function ecrireStockage(cle, valeur) {
	try {
		if (valeur === null || valeur === undefined) localStorage.removeItem(cle);
		else localStorage.setItem(cle, valeur);
	} catch {
		// Stockage indisponible (navigation privée) : l'app marche, sans se souvenir.
	}
}

// ---------------------------------------------------------------------------
// État de l'app
// ---------------------------------------------------------------------------

const app = {
	/** Clé de connexion (QR code) : la seule chose qui identifie le membre. */
	cle: lireStockage(CLES.cle),
	/** Ancienne connexion (code famille + Id), le temps de recevoir une clé ; ou code d'inscription. */
	code: lireStockage(CLES.code),
	membreId: lireStockage(CLES.membre),
	/** { moi, familles, personnes, cadeaux, historique } renvoyé par l'API. */
	etat: null,
	/** Familles affichées (Famille, Disponibles) ; vide = toutes. */
	famillesActives: lireFamillesActives(),
	horsLigne: false,
	onglet: lireStockage(CLES.onglet) || "ma-liste",
	/** Personnes sélectionnées dans l'onglet Famille (une ou plusieurs). */
	personnesFamille: new Set(),
	filtreDisponibles: "",
	triDisponibles: "priorite",
	filtreHistorique: "",
	selection: new Set(),
	/** Idée en cours d'édition : { cadeau, pourIds }. */
	edition: null,
	/** Secret Santa dont le membre a affiché le tirage (masqué par défaut). */
	revele: new Set(),
	occupe: false,
};

try {
	const etat = JSON.parse(lireStockage(CLES.etat) || "null");
	if (etat?.moi && (app.cle || etat.moi.id === app.membreId) && Array.isArray(etat.secretSantas)) app.etat = etat;
} catch {
	// État en cache illisible : il sera rechargé.
}

// ---------------------------------------------------------------------------
// API (Web App Apps Script)
// ---------------------------------------------------------------------------

class ErreurReseau extends Error {}

/**
 * Appelle l'API. Corps en text/plain : pas de requête préalable CORS, que les Web Apps Apps Script
 * ne gèrent pas.
 */
let appelsEnCours = 0;

function signalerChargement(delta) {
	appelsEnCours += delta;
	$("#chargement").hidden = appelsEnCours === 0;
}

async function appelerApi(action, parametres = {}) {
	signalerChargement(1);
	try {
		return await appelerApiSansIndicateur(action, parametres);
	} finally {
		signalerChargement(-1);
	}
}

async function appelerApiSansIndicateur(action, parametres) {
	let reponse;
	try {
		reponse = await fetch(window.API_URL, {
			method: "POST",
			headers: { "Content-Type": "text/plain;charset=utf-8" },
			// Avec une clé, elle seule ; sinon l'ancienne connexion, qui en reçoit une (accepteCle).
			body: JSON.stringify({
				action,
				...(app.cle ? { cle: app.cle } : { code: app.code, membreId: app.membreId, accepteCle: true }),
				...parametres,
			}),
		});
	} catch {
		throw new ErreurReseau("Pas de connexion. Réessaie quand tu seras en ligne.");
	}
	let donnees;
	try {
		donnees = await reponse.json();
	} catch {
		throw new ErreurReseau("Le serveur ne répond pas correctement. Réessaie dans un instant.");
	}
	if (!donnees.ok) throw new Error(donnees.erreur || "Erreur inconnue.");
	if (donnees.cle) garderCle(donnees.cle);
	return donnees.data;
}

/** Garde la clé de connexion ; l'ancienne connexion (code + Id) ne sert plus. */
function garderCle(cle) {
	app.cle = cle;
	ecrireStockage(CLES.cle, cle);
	app.code = null;
	app.membreId = null;
	ecrireStockage(CLES.code, null);
	ecrireStockage(CLES.membre, null);
}

const estConnecte = () => Boolean(app.cle || (app.code && app.membreId));

function appliquerEtat(etat) {
	app.etat = etat;
	app.horsLigne = false;
	ecrireStockage(CLES.etat, JSON.stringify(etat));
	const ids = new Set(etat.cadeaux.map((c) => c.id));
	for (const id of app.selection) if (!ids.has(id)) app.selection.delete(id);
	afficherBandeauHorsLigne();
	rendre();
}

async function actualiser({ silencieux = false } = {}) {
	if (!estConnecte()) return;
	const bouton = $("#bouton-actualiser");
	bouton.classList.add("tourne");
	try {
		appliquerEtat(await appelerApi("etat"));
	} catch (erreur) {
		if (erreur instanceof ErreurReseau) {
			app.horsLigne = true;
			afficherBandeauHorsLigne();
			rendre();
			if (!silencieux) notifier(erreur.message, true);
		} else if (/Code famille|Membre inconnu|QR code|Compte introuvable/.test(erreur.message)) {
			deconnecter(erreur.message);
		} else {
			notifier(erreur.message, true);
		}
	} finally {
		bouton.classList.remove("tourne");
	}
}

/**
 * Lance une modification ; l'API renvoie { resultat, etat }.
 * @param surErreur affiche l'erreur (par défaut : une notification)
 * @return le résultat (true s'il n'y en a pas), ou null en cas d'échec
 */
async function modifier(action, parametres, messageSucces, surErreur = (message) => notifier(message, true)) {
	if (app.occupe) return null;
	if (app.horsLigne) {
		surErreur("Hors ligne : les modifications reviendront avec la connexion.");
		return null;
	}
	app.occupe = true;
	document.body.style.cursor = "progress";
	try {
		const { resultat, etat } = await appelerApi(action, parametres);
		appliquerEtat(etat);
		if (messageSucces) notifier(messageSucces);
		return resultat ?? true;
	} catch (erreur) {
		surErreur(erreur.message);
		if (erreur instanceof ErreurReseau) {
			app.horsLigne = true;
			afficherBandeauHorsLigne();
		}
		return null;
	} finally {
		app.occupe = false;
		document.body.style.cursor = "";
	}
}

// ---------------------------------------------------------------------------
// Outils d'affichage
// ---------------------------------------------------------------------------

const $ = (selecteur) => document.querySelector(selecteur);

/** Crée un élément ; les textes passent par des nœuds texte (aucun HTML injecté). */
function el(balise, attributs = {}, ...enfants) {
	const element = document.createElement(balise);
	for (const [nom, valeur] of Object.entries(attributs)) {
		if (valeur === false || valeur === null || valeur === undefined) continue;
		if (nom === "class") element.className = valeur;
		else if (nom.startsWith("on")) element.addEventListener(nom.slice(2), valeur);
		else if (valeur === true) element.setAttribute(nom, "");
		else element.setAttribute(nom, valeur);
	}
	for (const enfant of enfants.flat()) {
		if (enfant === null || enfant === undefined || enfant === false) continue;
		element.append(enfant instanceof Node ? enfant : document.createTextNode(String(enfant)));
	}
	return element;
}

const formatEuro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const prix = (valeur) => (typeof valeur === "number" ? formatEuro.format(valeur) : "");
const formatDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const ENVIES = { 1: "Très envie", 2: "Envie", 3: "Si possible" };
const formatAnniversaire = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });

/** « aaaa-mm-jj » d'une date, pour un champ date. */
function versChampDate(date) {
	if (!date) return "";
	const d = new Date(date);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Prochain anniversaire, avec l'âge que la personne aura ce jour-là (celui qui compte pour le
 * cadeau) : « 🎂 35 ans le 20 avril », « … (dans 12 jours) », « 🎂 35 ans aujourd'hui ! ».
 */
function anniversaire(naissance) {
	if (!naissance) return null;
	const date = new Date(naissance);
	const maintenant = new Date();
	const aujourdhui = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate());
	let prochain = new Date(aujourdhui.getFullYear(), date.getMonth(), date.getDate());
	if (prochain < aujourdhui) prochain = new Date(aujourdhui.getFullYear() + 1, date.getMonth(), date.getDate());
	const age = prochain.getFullYear() - date.getFullYear();
	const ans = `${age} an${age > 1 ? "s" : ""}`;
	const jours = Math.round((prochain - aujourdhui) / 86400000);
	if (jours === 0) return `🎂 ${ans} aujourd'hui !`;
	return `🎂 ${ans} le ${formatAnniversaire.format(prochain)}${jours <= 30 ? ` (dans ${jours} jour${jours > 1 ? "s" : ""})` : ""}`;
}

function notifier(message, erreur = false) {
	const toast = el("div", { class: `toast${erreur ? " erreur-toast" : ""}`, role: erreur ? "alert" : "status" }, message);
	$("#toasts").append(toast);
	setTimeout(() => toast.remove(), erreur ? 5000 : 3000);
}

const moi = () => app.etat.moi.id;
const personne = (id) => app.etat?.personnes.find((p) => p.id === id);
const prenomDe = (id) => (id === app.etat?.moi.id ? "toi" : (personne(id)?.prenom ?? "quelqu'un"));

/** Familles affichées : celles activées, ou toutes si aucune ne l'est. */
function famillesActives() {
	const { familles } = app.etat;
	const actives = familles.filter((f) => app.famillesActives.has(f.id));
	return actives.length ? actives : familles;
}

const nomsFamilles = (familles) => familles.map((f) => f.nom).join(" + ");

/** Personnes des familles affichées (sans doublon), sans le membre connecté. */
function autresDeLaFamille() {
	const ids = new Set(famillesActives().flatMap((f) => f.membreIds));
	ids.delete(moi());
	return [...ids]
		.map(personne)
		.filter(Boolean)
		.sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
}

/** « Léa », « Léa et Tom », « Léa, Tom et Zoé ». */
function prenoms(ids) {
	const noms = ids.map(prenomDe);
	return noms.length > 1 ? `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}` : (noms[0] ?? "");
}

const estPourMoi = (cadeau) => cadeau.pourIds.includes(moi());
const offreurs = (cadeau) => cadeau.reserveParIds ?? [];

/**
 * Même règle que le serveur : ses idées et suggestions, les souhaits communs dont on est
 * destinataire, et les idées des proches sans compte.
 */
function peutModifier(cadeau) {
	if (cadeau.ajouteParId === moi()) return true;
	if (estPourMoi(cadeau)) return cadeau.pourIds.includes(cadeau.ajouteParId);
	return cadeau.pourIds.every((id) => personne(id)?.compte === false);
}

function parPriorite(a, b) {
	return a.priorite - b.priorite || a.titre.localeCompare(b.titre, "fr");
}

// ---------------------------------------------------------------------------
// Cartes de cadeau
// ---------------------------------------------------------------------------

function lienCadeau(cadeau) {
	if (!/^https?:\/\//i.test(cadeau.lien)) return null;
	let hote = cadeau.lien;
	try {
		hote = new URL(cadeau.lien).hostname.replace(/^www\./, "");
	} catch {
		// Lien affiché tel quel.
	}
	return el("a", { class: "carte-lien", href: cadeau.lien, target: "_blank", rel: "noopener noreferrer" }, `Voir sur ${hote} ↗`);
}

/**
 * @param options.pour "moi" (ma liste), "autre" (liste d'un autre) ou "reservation"
 * @param options.selectionnable case à cocher pour la réservation multiple
 */
function carteCadeau(cadeau, { pour, selectionnable = false }) {
	const selectionne = app.selection.has(cadeau.id);
	const retire = cadeau.statut === "retiré";
	const actions = el("div", { class: "carte-actions" });
	let partage = null;
	let etiquette = el("span", { class: `badge envie-${cadeau.priorite}` }, ENVIES[cadeau.priorite] ?? "");

	if (pour === "moi") {
		actions.append(
			el("button", { type: "button", class: "bouton petit", onclick: () => ouvrirFormulaireCadeau(cadeau) }, "Modifier"),
			el("button", { type: "button", class: "bouton petit danger", onclick: () => supprimer(cadeau) }, "Supprimer"),
		);
	} else if (retire) {
		etiquette = el("span", { class: "badge pris" }, "Retiré de la liste");
		actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => annuler([cadeau.id], "Effacé de tes réservations.") }, "Effacer"));
	} else {
		if (pour === "autre" && peutModifier(cadeau)) {
			actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => ouvrirFormulaireCadeau(cadeau) }, "Modifier"));
		}
		const autres = offreurs(cadeau).filter((id) => id !== moi());
		if (offreurs(cadeau).includes(moi())) {
			const avec = autres.length ? ` avec ${prenoms(autres)}` : "";
			if (pour !== "reservation") etiquette = el("span", { class: "badge moi" }, `Tu l'offres${avec}`);
			else if (autres.length) etiquette = el("span", { class: "badge moi" }, `Avec ${prenoms(autres)}`);
			actions.append(
				el(
					"button",
					{ type: "button", class: "bouton petit", onclick: () => annuler([cadeau.id], autres.length ? "Tu ne participes plus." : "Réservation annulée.") },
					autres.length ? "Me retirer" : "Annuler",
				),
			);
			// Cadeau groupé : d'autres ne peuvent participer que si l'un de ceux qui l'offrent le partage.
			partage = el(
				"label",
				{ class: "case-partage" },
				el("input", { type: "checkbox", checked: Boolean(cadeau.partage), onchange: (e) => partager(cadeau, e.target.checked) }),
				"Partager : d'autres peuvent participer",
			);
		} else if (autres.length) {
			etiquette = el("span", { class: "badge pris" }, `Réservé par ${prenoms(autres)}${cadeau.partage ? " · partagé" : ""}`);
			if (cadeau.partage) {
				actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => participer([cadeau.id]) }, "Participer"));
			}
		} else {
			etiquette = el("span", { class: "badge libre" }, "Disponible");
			actions.append(el("button", { type: "button", class: "bouton petit principal", onclick: () => reserver([cadeau.id]) }, "Je l'offre"));
		}
	}

	const suggestion =
		pour !== "moi" && cadeau.ajouteParId && !cadeau.pourIds.includes(cadeau.ajouteParId)
			? el("p", { class: "carte-note" }, cadeau.ajouteParId === moi() ? "Ta suggestion" : `Suggéré par ${prenomDe(cadeau.ajouteParId)}`)
			: null;
	const commun =
		cadeau.pourIds.length > 1
			? el(
					"p",
					{ class: "carte-note commun" },
					pour === "moi" ? `Cadeau commun avec ${prenoms(cadeau.pourIds.filter((id) => id !== moi()))}` : `Pour ${prenoms(cadeau.pourIds)}`,
				)
			: null;
	const part =
		pour === "reservation" && offreurs(cadeau).length > 1 && typeof cadeau.prix === "number"
			? el("p", { class: "carte-note" }, `Ta part ≈ ${prix(cadeau.prix / offreurs(cadeau).length)}`)
			: null;
	const libre = pour !== "moi" && !retire && offreurs(cadeau).length === 0;
	return el(
		"article",
		{ class: `carte${selectionne ? " selectionnee" : ""}${retire ? " retire" : ""}` },
		selectionnable && libre
			? el(
					"label",
					{ class: "case" },
					el("input", {
						type: "checkbox",
						checked: selectionne,
						"aria-label": `Sélectionner ${cadeau.titre}`,
						onchange: (e) => basculerSelection(cadeau.id, e.target.checked),
					}),
				)
			: null,
		el(
			"div",
			{ class: "carte-corps" },
			el("div", { class: "carte-haut" }, el("h3", { class: "carte-titre" }, cadeau.titre), el("span", { class: "carte-prix" }, prix(cadeau.prix))),
			cadeau.description ? el("p", { class: "carte-description" }, cadeau.description) : null,
			lienCadeau(cadeau),
			commun,
			suggestion,
			part,
			el("div", { class: "carte-bas" }, etiquette, actions),
			partage,
		),
	);
}

function vide(message, ...enfants) {
	return el("div", { class: "vide" }, el("p", {}, message), ...enfants);
}

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------

const TITRES = {
	"ma-liste": "Ma liste",
	famille: "La famille",
	disponibles: "Disponibles",
	reservations: "Ce que j'offre",
	historique: "Déjà offert",
};

function rendreMaListe() {
	const miens = app.etat.cadeaux.filter(estPourMoi).sort(parPriorite);
	const ajouter = el("button", { type: "button", class: "bouton principal", onclick: () => ouvrirFormulaireCadeau(null, [moi()]) }, "+ Ajouter une idée");
	if (miens.length === 0) {
		return [vide("Ta liste est vide. Ajoute tes envies : tes familles les verront, sans que tu saches qui offre quoi.", ajouter)];
	}
	return [
		el("p", { class: "discret" }, `${miens.length} idée(s). Tu ne vois ni ce qui est réservé, ni ce que les autres te suggèrent : surprise !`),
		...miens.map((c) => carteCadeau(c, { pour: "moi" })),
		el("div", {}, ajouter),
	];
}

function dejaOffertA(id, prenom = null) {
	const entrees = app.etat.historique.filter((e) => e.destinataires.some((d) => d.id === id));
	if (entrees.length === 0) return null;
	return el(
		"details",
		{ class: "deja-offert" },
		el("summary", {}, prenom ? `Déjà offert à ${prenom} (${entrees.length})` : `Tu lui as déjà offert (${entrees.length})`),
		el(
			"ul",
			{},
			entrees.map((e) => el("li", {}, el("span", { class: "discret" }, `${e.date ? new Date(e.date).getFullYear() : "?"} · ${e.occasion}`), " ", e.details)),
		),
	);
}

function rendreFamille() {
	const autres = autresDeLaFamille();
	if (autres.length === 0) {
		return [
			vide(
				`Personne d'autre dans ${nomsFamilles(famillesActives())} pour l'instant. Partage le code (menu en haut à droite), ou ajoute un proche qui n'utilisera pas l'app (enfant, grands-parents…).`,
				el("button", { type: "button", class: "bouton", onclick: ouvrirAjoutPersonne }, "Ajouter une personne"),
			),
		];
	}
	// Une ou plusieurs personnes : leurs listes réunies, et une idée commune possible.
	const selection = new Set([...app.personnesFamille].filter((id) => autres.some((p) => p.id === id)));
	if (selection.size === 0) selection.add(autres[0].id);
	app.personnesFamille = selection;
	const choisies = autres.filter((p) => selection.has(p.id));
	const ids = choisies.map((p) => p.id);
	const basculer = (id) => {
		if (selection.has(id)) {
			if (selection.size > 1) selection.delete(id);
		} else {
			selection.add(id);
		}
		rendre();
	};
	const puces = el(
		"div",
		{ class: "puces", role: "group", "aria-label": "Personnes (une ou plusieurs)" },
		autres.map((p) => el("button", { type: "button", "aria-pressed": String(selection.has(p.id)), onclick: () => basculer(p.id) }, p.prenom)),
		el("button", { type: "button", class: "puce-ajout", onclick: ouvrirAjoutPersonne, "aria-label": "Ajouter une personne sans compte" }, "+ Personne"),
	);
	const leursCadeaux = app.etat.cadeaux
		.filter((c) => c.pourIds.some((id) => selection.has(id)) && !estPourMoi(c) && c.statut !== "retiré")
		.sort(parPriorite);
	const libres = leursCadeaux.filter((c) => offreurs(c).length === 0).length;
	const seule = choisies.length === 1 ? choisies[0] : null;
	const avecCompte = choisies.filter((p) => p.compte);
	const ajouter = el(
		"button",
		{ type: "button", class: "bouton", onclick: () => ouvrirFormulaireCadeau(null, ids) },
		seule
			? seule.compte
				? `+ Suggérer une idée pour ${seule.prenom}`
				: `+ Ajouter une idée pour ${seule.prenom}`
			: `+ Idée commune pour ${prenoms(ids)}`,
	);
	return [
		puces,
		choisies.length === 1 ? null : el("p", { class: "discret" }, "Touche un prénom pour l'ajouter ou le retirer : leurs listes sont réunies."),
		el(
			"div",
			{ class: "groupe-titre" },
			el("h2", {}, seule?.nom ? `${seule.prenom} ${seule.nom}` : prenoms(ids)),
			el("span", { class: "discret" }, leursCadeaux.length ? `${libres} disponible(s) sur ${leursCadeaux.length}` : ""),
		),
		choisies
			.filter((p) => p.naissance)
			.map((p) => el("p", { class: "anniversaire" }, seule ? anniversaire(p.naissance) : `${p.prenom} : ${anniversaire(p.naissance)}`)),
		choisies
			.filter((p) => !p.compte)
			.map((p) =>
				el(
					"div",
					{ class: "sans-compte" },
					el("p", { class: "discret" }, `${p.prenom} n'utilise pas l'app : la famille tient sa liste.`),
					el("button", { type: "button", class: "lien-bouton", onclick: () => inviter(p) }, `Inviter ${p.prenom} (QR code)`),
				),
			),
		leursCadeaux.length === 0
			? vide(seule ? `${seule.prenom} n'a encore rien demandé.` : "Rien de demandé pour l'instant.")
			: el("div", { class: "groupe" }, leursCadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true }))),
		el(
			"div",
			{ class: "pile" },
			ajouter,
			avecCompte.length ? el("p", { class: "discret" }, `${prenoms(avecCompte.map((p) => p.id))} ne ${avecCompte.length > 1 ? "verront" : "verra"} pas tes suggestions.`) : null,
		),
		choisies.map((p) => dejaOffertA(p.id, seule ? null : p.prenom)),
	];
}

function rendreDisponibles() {
	const autres = autresDeLaFamille();
	const ids = new Set(autres.map((p) => p.id));
	let libres = app.etat.cadeaux.filter(
		(c) => c.pourIds.some((id) => ids.has(id)) && !estPourMoi(c) && c.statut !== "retiré" && offreurs(c).length === 0,
	);
	if (app.filtreDisponibles) libres = libres.filter((c) => c.pourIds.includes(app.filtreDisponibles));
	const tris = {
		priorite: parPriorite,
		"prix-croissant": (a, b) => (a.prix ?? Infinity) - (b.prix ?? Infinity),
		"prix-decroissant": (a, b) => (b.prix ?? -1) - (a.prix ?? -1),
	};
	libres.sort(tris[app.triDisponibles]);

	const filtres = el(
		"div",
		{ class: "barre-outils" },
		el(
			"select",
			{
				"aria-label": "Pour qui",
				onchange: (e) => {
					app.filtreDisponibles = e.target.value;
					rendre();
				},
			},
			el("option", { value: "" }, "Tout le monde"),
			autres.map((p) => el("option", { value: p.id, selected: p.id === app.filtreDisponibles }, `Pour ${p.prenom}`)),
		),
		el(
			"select",
			{
				"aria-label": "Trier",
				onchange: (e) => {
					app.triDisponibles = e.target.value;
					rendre();
				},
			},
			el("option", { value: "priorite", selected: app.triDisponibles === "priorite" }, "Les plus attendus"),
			el("option", { value: "prix-croissant", selected: app.triDisponibles === "prix-croissant" }, "Prix croissant"),
			el("option", { value: "prix-decroissant", selected: app.triDisponibles === "prix-decroissant" }, "Prix décroissant"),
		),
	);
	// Cadeaux réservés par d'autres mais partagés : on peut encore y participer.
	let aPartager = app.etat.cadeaux.filter(
		(c) =>
			c.pourIds.some((id) => ids.has(id)) &&
			!estPourMoi(c) &&
			c.statut !== "retiré" &&
			c.partage &&
			offreurs(c).length > 0 &&
			!offreurs(c).includes(moi()),
	);
	if (app.filtreDisponibles) aPartager = aPartager.filter((c) => c.pourIds.includes(app.filtreDisponibles));
	const sectionPartage = aPartager.length
		? el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, "À partager"), el("span", { class: "discret" }, `${aPartager.length}`)),
				el("p", { class: "discret" }, "Déjà réservés, mais ceux qui les offrent acceptent que tu participes."),
				aPartager.sort(parPriorite).map((c) => carteCadeau(c, { pour: "autre" })),
			)
		: null;
	if (libres.length === 0) return [filtres, sectionPartage ?? vide("Plus aucun cadeau disponible ici. Tout est déjà réservé !")];

	// Un groupe par destinataire, ou par groupe de destinataires pour un cadeau commun.
	const groupes = new Map();
	for (const c of libres) {
		const cle = [...c.pourIds].sort().join(",");
		if (!groupes.has(cle)) groupes.set(cle, { titre: `Pour ${prenoms(c.pourIds)}`, cadeaux: [] });
		groupes.get(cle).cadeaux.push(c);
	}
	return [
		filtres,
		el("p", { class: "discret" }, "Coche plusieurs cadeaux pour les réserver d'un coup."),
		sectionPartage,
		[...groupes.values()]
			.sort((a, b) => a.titre.localeCompare(b.titre, "fr"))
			.map((g) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, g.titre), el("span", { class: "discret" }, `${g.cadeaux.length}`)),
				g.cadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true })),
			),
		),
	];
}

function carteSecretSanta(s) {
	const familles = app.etat.familles.filter((f) => s.familleIds.includes(f.id));
	const organisateur = s.organisateurId === moi();
	const revele = app.revele.has(s.id);
	const receveur = s.monReceveurId ? personne(s.monReceveurId) : null;
	const basculer = () => {
		if (revele) app.revele.delete(s.id);
		else app.revele.add(s.id);
		rendre();
	};
	return el(
		"article",
		{ class: "carte secret-santa" },
		el(
			"div",
			{ class: "carte-corps" },
			el(
				"div",
				{ class: "carte-haut" },
				el("h3", { class: "carte-titre" }, `🎅 ${s.nom}`),
				el("span", { class: "carte-prix" }, s.budget ? `${prix(s.budget)} max` : ""),
			),
			el(
				"p",
				{ class: "carte-description" },
				[
					familles.length ? `${familles.length > 1 ? "Familles" : "Famille"} ${nomsFamilles(familles)}` : "",
					`${s.participantIds.length} participants`,
					organisateur ? "organisé par toi" : `organisé par ${prenomDe(s.organisateurId)}`,
				]
					.filter(Boolean)
					.join(" · "),
			),
			s.monReceveurId
				? el(
						"div",
						{ class: "tirage" },
						el("span", {}, "Tu offres à "),
						el("strong", { class: revele ? "" : "masque" }, revele ? (receveur?.prenom ?? "?") : "••••••"),
						el("button", { type: "button", class: "lien-bouton", onclick: basculer }, revele ? "Masquer" : "Afficher"),
					)
				: el("p", { class: "discret" }, "Tu ne participes pas : tu ne vois aucun tirage."),
			el(
				"div",
				{ class: "carte-actions" },
				s.monReceveurId && revele && receveur
					? el("button", { type: "button", class: "bouton petit principal", onclick: () => voirListe(s.familleIds, receveur.id) }, "Voir sa liste")
					: null,
				organisateur ? el("button", { type: "button", class: "bouton petit", onclick: () => relancerTirage(s) }, "Relancer le tirage") : null,
				organisateur ? el("button", { type: "button", class: "bouton petit danger", onclick: () => supprimerSecretSanta(s) }, "Supprimer") : null,
			),
		),
	);
}

function rendreSecretSantas() {
	return el(
		"section",
		{ class: "groupe" },
		el(
			"div",
			{ class: "groupe-titre" },
			el("h2", {}, "Secret Santa"),
			el("button", { type: "button", class: "lien-bouton", onclick: ouvrirFormulaireSecretSanta }, "+ Organiser"),
		),
		app.etat.secretSantas.map(carteSecretSanta),
	);
}

function rendreReservations() {
	const miennes = app.etat.cadeaux.filter((c) => offreurs(c).includes(moi()));
	if (miennes.length === 0) {
		return [
			rendreSecretSantas(),
			vide(
				"Tu n'offres encore rien.",
				el("button", { type: "button", class: "bouton principal", onclick: () => changerOnglet("disponibles") }, "Voir les cadeaux disponibles"),
			),
		];
	}
	const actifs = miennes.filter((c) => c.statut !== "retiré");
	// Cadeau groupé : seule sa part compte dans le total.
	const total = actifs.reduce((somme, c) => somme + (c.prix ?? 0) / offreurs(c).length, 0);
	const groupes = new Map();
	for (const c of miennes) {
		const cle = [...c.pourIds].sort().join(",");
		if (!groupes.has(cle)) groupes.set(cle, { titre: `Pour ${prenoms(c.pourIds)}`, cadeaux: [] });
		groupes.get(cle).cadeaux.push(c);
	}
	return [
		rendreSecretSantas(),
		el("div", { class: "total" }, el("span", {}, `${actifs.length} cadeau(x)`), el("span", {}, `≈ ${prix(total)}`)),
		[...groupes.values()].map((g) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, g.titre)),
				g.cadeaux.sort(parPriorite).map((c) => carteCadeau(c, { pour: "reservation" })),
			),
		),
		el("p", { class: "discret" }, "Le 26 décembre, ces cadeaux passent dans ton historique."),
	];
}

function rendreHistorique() {
	const ajouter = el("button", { type: "button", class: "bouton principal", onclick: ouvrirFormulaireHistorique }, "+ Ajouter");
	const toutes = app.etat.historique;
	if (toutes.length === 0) {
		return [vide("Ton historique est vide. Les cadeaux que tu offres y arrivent chaque 26 décembre ; tu peux aussi en ajouter.", ajouter)];
	}
	const cle = (d) => d.id ?? `texte:${d.nom}`;
	const destinataires = new Map();
	for (const e of toutes) for (const d of e.destinataires) destinataires.set(cle(d), d.nom);
	const entrees = app.filtreHistorique ? toutes.filter((e) => e.destinataires.some((d) => cle(d) === app.filtreHistorique)) : toutes;
	const annees = new Map();
	for (const e of entrees) {
		const annee = e.date ? String(new Date(e.date).getFullYear()) : "Sans date";
		if (!annees.has(annee)) annees.set(annee, []);
		annees.get(annee).push(e);
	}
	return [
		el(
			"div",
			{ class: "barre-outils" },
			el(
				"select",
				{
					"aria-label": "Pour qui",
					onchange: (e) => {
						app.filtreHistorique = e.target.value;
						rendre();
					},
				},
				el("option", { value: "" }, "Tout le monde"),
				[...destinataires]
					.sort((a, b) => a[1].localeCompare(b[1], "fr"))
					.map(([valeur, nom]) => el("option", { value: valeur, selected: valeur === app.filtreHistorique }, `Pour ${nom}`)),
			),
			ajouter,
		),
		el("p", { class: "discret" }, "Visible de toi seul."),
		[...annees].map(([annee, liste]) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, annee), el("span", { class: "discret" }, `${liste.length}`)),
				liste.map((e) =>
					el(
						"article",
						{ class: "carte compacte" },
						el(
							"div",
							{ class: "carte-corps" },
							el("div", { class: "carte-haut" }, el("h3", { class: "carte-titre" }, e.details), el("span", { class: "carte-prix" }, prix(e.prix))),
							el(
								"p",
								{ class: "carte-description" },
								[
									e.occasion,
									`pour ${e.destinataires.map((d) => d.nom).join(", ")}`,
									e.avec.length ? `avec ${e.avec.join(", ")}` : "",
									e.date ? formatDate.format(new Date(e.date)) : "",
								]
									.filter(Boolean)
									.join(" · "),
							),
						),
						el("button", { type: "button", class: "icone-supprimer", "aria-label": `Supprimer ${e.details}`, onclick: () => supprimerEntree(e) }, "×"),
					),
				),
			),
		),
	];
}

const RENDUS = {
	"ma-liste": rendreMaListe,
	famille: rendreFamille,
	disponibles: rendreDisponibles,
	reservations: rendreReservations,
	historique: rendreHistorique,
};

function rendreEntete() {
	const { moi: membre, familles } = app.etat;
	$("#titre-onglet").textContent = TITRES[app.onglet];
	$("#bouton-menu").textContent = membre.prenom.charAt(0).toUpperCase();
	$("#menu-nom").textContent = `Connecté en tant que ${membre.prenom}`;

	// Plusieurs familles : des pastilles dans l'en-tête, chacune s'active ou se désactive (plusieurs
	// à la fois). Une seule : son nom au-dessus du titre.
	const actives = new Set(famillesActives().map((f) => f.id));
	const plusieurs = familles.length > 1;
	$("#libelle-famille").textContent = plusieurs ? "Cadeaux de Noël" : familles[0] ? `Famille ${familles[0].nom}` : "Cadeaux de Noël";
	const pastilles = $("#familles-entete");
	pastilles.hidden = !plusieurs;
	pastilles.replaceChildren(
		...(plusieurs
			? familles.map((f) =>
					el("button", { type: "button", "aria-pressed": String(actives.has(f.id)), onclick: () => basculerFamille(f.id) }, f.nom),
				)
			: []),
	);

	$("#menu-familles").replaceChildren(
		...familles.map((f) =>
			el(
				"button",
				{ type: "button", role: "menuitem", class: "menu-code", onclick: () => copierCode(f) },
				el("span", {}, `Code ${f.nom}`),
				el("strong", {}, f.code),
			),
		),
	);
}

function rendre() {
	if (!app.etat) return;
	rendreEntete();
	for (const bouton of document.querySelectorAll(".onglets button")) {
		if (bouton.dataset.onglet === app.onglet) bouton.setAttribute("aria-current", "page");
		else bouton.removeAttribute("aria-current");
	}
	const nbReservations = app.etat.cadeaux.filter((c) => offreurs(c).includes(moi())).length;
	const pastille = $("#compteur-reservations");
	pastille.hidden = nbReservations === 0;
	pastille.textContent = String(nbReservations);

	$("#contenu").replaceChildren(...RENDUS[app.onglet]().flat().filter(Boolean));
	rendreSelection();
}

function changerOnglet(onglet) {
	app.onglet = onglet;
	ecrireStockage(CLES.onglet, onglet);
	rendre();
	window.scrollTo({ top: 0 });
}

function enregistrerFamillesActives(ids) {
	app.famillesActives = new Set(ids);
	app.personnesFamille = new Set();
	app.filtreDisponibles = "";
	app.selection.clear();
	ecrireStockage(CLES.familles, JSON.stringify([...ids]));
	rendre();
}

/** Active ou désactive une famille ; la dernière active le reste. */
function basculerFamille(id) {
	const actives = new Set(famillesActives().map((f) => f.id));
	if (actives.has(id)) {
		if (actives.size === 1) return;
		actives.delete(id);
	} else {
		actives.add(id);
	}
	enregistrerFamillesActives(actives);
}

/** Affiche aussi ces familles (famille rejointe ou créée, liste d'un Secret Santa). */
function activerFamille(...ids) {
	enregistrerFamillesActives(new Set([...famillesActives().map((f) => f.id), ...ids]));
}

// ---------------------------------------------------------------------------
// Réservations (une ou plusieurs)
// ---------------------------------------------------------------------------

function basculerSelection(id, coche) {
	if (coche) app.selection.add(id);
	else app.selection.delete(id);
	rendre();
}

function rendreSelection() {
	const visible = app.selection.size > 0 && (app.onglet === "disponibles" || app.onglet === "famille");
	$("#barre-selection").hidden = !visible;
	$("#ecran-app").classList.toggle("avec-selection", visible);
	if (!visible) return;
	const choisis = app.etat.cadeaux.filter((c) => app.selection.has(c.id));
	const total = choisis.reduce((somme, c) => somme + (c.prix ?? 0), 0);
	$("#resume-selection").textContent = `${choisis.length} sélectionné(s)${total ? ` · ${prix(total)}` : ""}`;
	$("#bouton-offrir-selection").textContent = choisis.length > 1 ? "Je les offre" : "Je l'offre";
}

function messageRefus(resultat) {
	const titre = (id) => app.etat.cadeaux.find((c) => c.id === id)?.titre ?? "Un cadeau";
	return resultat.refuses.map((r) => `${titre(r.id)} : ${r.raison}`).join("\n");
}

async function reserver(ids) {
	const resultat = await modifier("reserver", { cadeauIds: ids });
	if (!resultat) return;
	for (const id of ids) app.selection.delete(id);
	rendre();
	if (resultat.faits.length) notifier(resultat.faits.length > 1 ? `${resultat.faits.length} cadeaux réservés. 🎁` : "Cadeau réservé. 🎁");
	if (resultat.refuses.length) notifier(messageRefus(resultat), true);
}

/** Rejoindre ceux qui offrent déjà un cadeau (cadeau groupé). */
async function participer(ids) {
	const resultat = await modifier("reserver", { cadeauIds: ids, participer: true });
	if (!resultat) return;
	if (resultat.faits.length) notifier("Tu participes à ce cadeau. 🎁");
	if (resultat.refuses.length) notifier(messageRefus(resultat), true);
}

async function partager(cadeau, partage) {
	const reussi = await modifier(
		"partager-cadeau",
		{ cadeauId: cadeau.id, partage },
		partage ? "Cadeau partagé : d'autres peuvent participer." : "Cadeau plus partagé.",
	);
	if (!reussi) rendre();
}

async function annuler(ids, message) {
	const resultat = await modifier("annuler-reservation", { cadeauIds: ids });
	if (!resultat) return;
	if (resultat.faits.length) notifier(message);
	if (resultat.refuses.length) notifier(messageRefus(resultat), true);
}

// ---------------------------------------------------------------------------
// Idées : ajout (pour soi ou pour un proche), modification, suppression
// ---------------------------------------------------------------------------

/** @param pourIds destinataires de l'idée (plusieurs : idée commune) */
function ouvrirFormulaireCadeau(cadeau, pourIds = cadeau?.pourIds ?? [moi()]) {
	app.edition = { cadeau, pourIds };
	const form = $("#form-cadeau");
	form.reset();
	const pourMoi = pourIds.includes(moi());
	const comptes = pourIds.filter((id) => id !== moi() && personne(id)?.compte);
	$("#titre-dialogue").textContent = cadeau
		? "Modifier l'idée"
		: pourIds.length === 1 && pourMoi
			? "Nouvelle idée"
			: `Idée pour ${prenoms(pourIds)}`;
	$("#aide-dialogue").textContent =
		cadeau || pourMoi
			? ""
			: comptes.length
				? `${prenoms(comptes)} ne ${comptes.length > 1 ? "verront" : "verra"} pas cette idée ; les autres pourront la réserver.`
				: "Personne sans compte : l'idée rejoint sa liste.";
	$("#erreur-cadeau").textContent = "";
	$("#bouton-supprimer-cadeau").hidden = !cadeau;
	if (cadeau) {
		form.titre.value = cadeau.titre;
		form.description.value = cadeau.description;
		form.lien.value = cadeau.lien;
		form.prix.value = cadeau.prix ?? "";
		form.priorite.value = String(cadeau.priorite);
	}
	$("#dialogue-cadeau").showModal();
	form.titre.focus();
}

async function enregistrerCadeau(evenement) {
	evenement.preventDefault();
	const form = evenement.target;
	const cadeau = {
		titre: form.titre.value,
		description: form.description.value,
		lien: form.lien.value,
		prix: form.prix.value,
		priorite: Number(form.priorite.value),
	};
	const { cadeau: existant, pourIds } = app.edition;
	$("#erreur-cadeau").textContent = "";
	const reussi = await modifier(
		existant ? "modifier-cadeau" : "ajouter-cadeau",
		existant ? { cadeauId: existant.id, cadeau } : { cadeau, pourIds },
		existant ? "Idée modifiée." : pourIds.length === 1 && pourIds[0] === moi() ? "Idée ajoutée à ta liste." : `Idée ajoutée pour ${prenoms(pourIds)}.`,
		(message) => {
			$("#erreur-cadeau").textContent = message;
		},
	);
	if (reussi) $("#dialogue-cadeau").close();
}

async function supprimer(cadeau) {
	if (!confirm(`Supprimer « ${cadeau.titre} » ?`)) return false;
	return Boolean(await modifier("supprimer-cadeau", { cadeauId: cadeau.id }, "Idée supprimée."));
}

async function supprimerDepuisFormulaire() {
	const { cadeau } = app.edition;
	if (cadeau && (await supprimer(cadeau))) $("#dialogue-cadeau").close();
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

function ouvrirFormulaireHistorique() {
	const form = $("#form-historique");
	form.reset();
	$("#erreur-historique").textContent = "";
	form.date.value = new Date().toISOString().slice(0, 10);
	const proches = app.etat.personnes.filter((p) => p.id !== moi()).sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
	$("#historique-personnes").replaceChildren(
		...proches.map((p) => el("label", { class: "case-texte" }, el("input", { type: "checkbox", name: "destinataire", value: p.id }), p.prenom)),
	);
	$("#dialogue-historique").showModal();
	form.details.focus();
}

async function enregistrerHistorique(evenement) {
	evenement.preventDefault();
	const form = evenement.target;
	const entree = {
		details: form.details.value,
		date: form.date.value,
		occasion: form.occasion.value,
		destinataireIds: [...form.querySelectorAll("input[name=destinataire]:checked")].map((c) => c.value),
		autresDestinataires: form.autres.value,
		prix: form.prix.value,
	};
	const reussi = await modifier("ajouter-historique", { entree }, "Ajouté à ton historique.", (message) => {
		$("#erreur-historique").textContent = message;
	});
	if (reussi) $("#dialogue-historique").close();
}

async function supprimerEntree(entree) {
	if (!confirm(`Retirer « ${entree.details} » de ton historique ?`)) return;
	await modifier("supprimer-historique", { entreeId: entree.id }, "Retiré de ton historique.");
}

// ---------------------------------------------------------------------------
// Secret Santa
// ---------------------------------------------------------------------------

function voirListe(familleIds, personneId) {
	activerFamille(...familleIds);
	app.personnesFamille = new Set([personneId]);
	changerOnglet("famille");
}

function ajouterLigneExclusion(participants) {
	const options = () => participants.map((p) => el("option", { value: p.id }, p.prenom));
	const ligne = el(
		"div",
		{ class: "ligne exclusion" },
		el("select", { "aria-label": "Personne" }, options()),
		el("span", { class: "discret" }, "↔"),
		el("select", { "aria-label": "Ne tire pas" }, options()),
		el("button", { type: "button", class: "icone-supprimer", "aria-label": "Retirer l'exclusion", onclick: () => ligne.remove() }, "×"),
	);
	$("#secret-santa-exclusions").append(ligne);
}

/** Participants (tous cochés) et exclusions du formulaire, pour les familles cochées. */
function remplirParticipants() {
	const familleIds = [...document.querySelectorAll("input[name=famille-secret-santa]:checked")].map((c) => c.value);
	const ids = new Set(app.etat.familles.filter((f) => familleIds.includes(f.id)).flatMap((f) => f.membreIds));
	const participants = [...ids]
		.map(personne)
		.filter(Boolean)
		.sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
	$("#secret-santa-participants").replaceChildren(
		...participants.map((p) =>
			el("label", { class: "case-texte" }, el("input", { type: "checkbox", name: "participant", value: p.id, checked: true }), p.prenom),
		),
	);
	$("#secret-santa-exclusions").replaceChildren();
	$("#bouton-ajouter-exclusion").onclick = () => ajouterLigneExclusion(participants);
	app.edition = { familleIds };
}

function ouvrirFormulaireSecretSanta() {
	const { familles } = app.etat;
	if (familles.length === 0) return;
	const actives = new Set(famillesActives().map((f) => f.id));
	const form = $("#form-secret-santa");
	form.reset();
	$("#erreur-secret-santa").textContent = "";
	form.nom.value = `Secret Santa Noël ${new Date().getFullYear()}`;
	// Toutes ses familles au choix (les familles affichées cochées) : les participants viennent de chacune.
	$("#champ-famille-secret-santa").hidden = familles.length < 2;
	$("#secret-santa-familles").replaceChildren(
		...familles.map((f) =>
			el(
				"label",
				{ class: "case-texte" },
				el("input", { type: "checkbox", name: "famille-secret-santa", value: f.id, checked: actives.has(f.id), onchange: remplirParticipants }),
				f.nom,
			),
		),
	);
	remplirParticipants();
	$("#dialogue-secret-santa").showModal();
}

async function enregistrerSecretSanta(evenement) {
	evenement.preventDefault();
	const form = evenement.target;
	const secretSanta = {
		familleIds: app.edition.familleIds,
		nom: form.nom.value,
		budget: form.budget.value,
		participantIds: [...form.querySelectorAll("input[name=participant]:checked")].map((c) => c.value),
		exclusions: [...$("#secret-santa-exclusions").querySelectorAll(".exclusion")]
			.map((ligne) => [...ligne.querySelectorAll("select")].map((s) => s.value))
			.filter(([a, b]) => a !== b),
	};
	if (secretSanta.familleIds.length === 0) {
		$("#erreur-secret-santa").textContent = "Choisis au moins une famille.";
		return;
	}
	if (secretSanta.participantIds.length < 3) {
		$("#erreur-secret-santa").textContent = "Il faut au moins 3 participants.";
		return;
	}
	const cree = await modifier("creer-secret-santa", { secretSanta }, "Tirage fait ! Chacun découvre sa personne dans « J'offre ».", (message) => {
		$("#erreur-secret-santa").textContent = message;
	});
	if (cree) $("#dialogue-secret-santa").close();
}

async function relancerTirage(s) {
	if (!confirm(`Refaire le tirage de « ${s.nom} » ? Chacun aura une nouvelle personne : préviens les participants.`)) return;
	app.revele.delete(s.id);
	await modifier("relancer-tirage", { secretSantaId: s.id }, "Nouveau tirage fait.");
}

async function supprimerSecretSanta(s) {
	if (!confirm(`Supprimer « ${s.nom} » et son tirage ?`)) return;
	await modifier("supprimer-secret-santa", { secretSantaId: s.id }, "Secret Santa supprimé.");
}

// ---------------------------------------------------------------------------
// Familles : rejoindre, créer, ajouter une personne sans compte
// ---------------------------------------------------------------------------

/**
 * Ouvre le petit formulaire générique.
 * @param champs [{ nom, libelle, type?, valeur?, maxlength?, requis?, options? }] : avec `options`
 * ([{ valeur, libelle }]), une liste de choix au lieu d'un texte
 * @param valider (valeurs, afficherErreur) => Promise<boolean> : vrai pour fermer
 */
function ouvrirDialogueSimple({ titre, aide = "", champs, bouton = "Valider", valider }) {
	fermerMenu();
	$("#simple-titre").textContent = titre;
	$("#simple-aide").textContent = aide;
	$("#simple-valider").textContent = bouton;
	$("#erreur-simple").textContent = "";
	$("#simple-champs").replaceChildren(
		...champs.flatMap((c) => [
			el("label", { for: `simple-${c.nom}` }, c.libelle),
			c.options
				? el("select", { id: `simple-${c.nom}`, name: c.nom }, c.options.map((o) => el("option", { value: o.valeur }, o.libelle)))
				: el("input", {
						id: `simple-${c.nom}`,
						name: c.nom,
						type: c.type ?? "text",
						value: c.valeur ?? "",
						max: c.type === "date" ? versChampDate(new Date()) : null,
						maxlength: c.type === "date" ? null : (c.maxlength ?? 60),
						required: c.requis !== false,
						autocomplete: "off",
					}),
		]),
	);
	const form = $("#form-simple");
	form.onsubmit = async (evenement) => {
		evenement.preventDefault();
		const valeurs = Object.fromEntries(champs.map((c) => [c.nom, form.elements[c.nom].value]));
		const reussi = await valider(valeurs, (message) => {
			$("#erreur-simple").textContent = message;
		});
		if (reussi) $("#dialogue-simple").close();
	};
	$("#dialogue-simple").showModal();
	form.querySelector("input")?.focus();
}

function ouvrirRejoindre() {
	ouvrirDialogueSimple({
		titre: "Rejoindre une famille",
		aide: "Demande son code à un membre de la famille. Ta liste y sera visible et tu verras celles de ses membres.",
		champs: [{ nom: "code", libelle: "Code de la famille", maxlength: 40 }],
		bouton: "Rejoindre",
		valider: async ({ code }, erreur) => {
			const famille = await modifier("rejoindre-famille", { nouveauCode: code }, null, erreur);
			if (!famille) return false;
			notifier(`Bienvenue dans la famille ${famille.nom} !`);
			activerFamille(famille.id);
			return true;
		},
	});
}

function ouvrirCreer() {
	ouvrirDialogueSimple({
		titre: "Créer une famille",
		aide: "Tu en feras partie. Donne ensuite le code aux autres membres.",
		champs: [
			{ nom: "nom", libelle: "Nom de la famille", maxlength: 60 },
			{ nom: "code", libelle: "Code (4 caractères au moins)", maxlength: 40 },
		],
		bouton: "Créer",
		valider: async ({ nom, code }, erreur) => {
			const famille = await modifier("creer-famille", { nom, nouveauCode: code }, null, erreur);
			if (!famille) return false;
			notifier(`Famille ${famille.nom} créée.`);
			activerFamille(famille.id);
			return true;
		},
	});
}

function ouvrirAjoutPersonne() {
	const familles = famillesActives();
	if (familles.length === 0) return;
	ouvrirDialogueSimple({
		titre: familles.length > 1 ? "Ajouter une personne" : `Ajouter à la famille ${familles[0].nom}`,
		aide: "Pour un proche qui n'utilisera pas l'app (enfant, grands-parents…) : toute la famille pourra tenir sa liste. S'il s'y met plus tard, il choisira son prénom à la connexion.",
		champs: [
			{ nom: "prenom", libelle: "Prénom", maxlength: 40 },
			{ nom: "nom", libelle: "Nom (facultatif)", maxlength: 60, requis: false },
			{ nom: "naissance", libelle: "Anniversaire (facultatif)", type: "date", requis: false },
			...(familles.length > 1 ? [{ nom: "familleId", libelle: "Famille", options: familles.map((f) => ({ valeur: f.id, libelle: f.nom })) }] : []),
		],
		bouton: "Ajouter",
		valider: async ({ prenom, nom, naissance, familleId = familles[0].id }, erreur) => {
			const ajoutee = await modifier("ajouter-personne", { familleId, prenom, nom, naissance }, `${prenom.trim()} ajouté(e).`, erreur);
			if (!ajoutee) return false;
			app.personnesFamille = new Set([ajoutee.id]);
			changerOnglet("famille");
			return true;
		},
	});
}

function ouvrirProfil() {
	const membre = app.etat.moi;
	ouvrirDialogueSimple({
		titre: `Mon profil : ${membre.prenom}`,
		aide: "Ton anniversaire s'affiche sur ta fiche, pour les membres de tes familles.",
		champs: [
			{ nom: "nom", libelle: "Nom (facultatif)", maxlength: 60, requis: false, valeur: membre.nom },
			{ nom: "naissance", libelle: "Anniversaire", type: "date", requis: false, valeur: versChampDate(membre.naissance) },
		],
		bouton: "Enregistrer",
		valider: async (profil, erreur) => Boolean(await modifier("modifier-profil", { profil }, "Profil enregistré.", erreur)),
	});
}

async function copierCode(famille) {
	fermerMenu();
	try {
		await navigator.clipboard.writeText(famille.code);
		notifier(`Code de la famille ${famille.nom} copié : ${famille.code}`);
	} catch {
		notifier(`Code de la famille ${famille.nom} : ${famille.code}`);
	}
}

// ---------------------------------------------------------------------------
// Connexion : QR code (clé), ou code famille pour un nouveau venu
// ---------------------------------------------------------------------------

function afficherEcran(nom) {
	$("#ecran-connexion").hidden = nom !== "connexion";
	$("#ecran-app").hidden = nom !== "app";
}

function afficherAccueil(message = "") {
	afficherEcran("connexion");
	$("#accueil-connexion").hidden = false;
	$("#choix-membre").hidden = true;
	$("#erreur-connexion").textContent = message;
}

/** Code famille d'un nouveau venu : on vérifie le code, puis il s'ajoute. */
async function validerCode(evenement) {
	evenement.preventDefault();
	const bouton = evenement.submitter;
	if (bouton) bouton.disabled = true;
	$("#erreur-connexion").textContent = "";
	app.code = $("#champ-code").value.trim();
	try {
		const famille = await appelerApi("famille");
		$("#accueil-connexion").hidden = true;
		$("#choix-membre").hidden = false;
		$("#titre-choix").textContent = `Famille ${famille.nom} : ajoute-toi`;
		$("#champ-prenom").focus();
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	} finally {
		if (bouton) bouton.disabled = false;
	}
}

/** Ouvre l'app avec l'état reçu (inscription, QR code scanné). */
function ouvrirApp(etat) {
	app.selection.clear();
	appliquerEtat(etat);
	afficherEcran("app");
	if (!app.etat.cadeaux.some(estPourMoi)) {
		changerOnglet("ma-liste");
		notifier(`Bienvenue ${app.etat.moi.prenom} ! Commence par ajouter tes idées.`);
	}
}

async function ajouterMoi(evenement) {
	evenement.preventDefault();
	const bouton = evenement.submitter;
	if (bouton) bouton.disabled = true;
	$("#erreur-connexion").textContent = "";
	try {
		// La réponse apporte la clé du nouveau membre (gardée par appelerApi).
		ouvrirApp(await appelerApi("ajouter-moi", { prenom: $("#champ-prenom").value, naissance: $("#champ-naissance").value }));
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	} finally {
		if (bouton) bouton.disabled = false;
	}
}

/** Connexion avec une clé (lien du QR code, ou QR code scanné dans l'app). */
async function connecterAvecCle(cle) {
	garderCle(cle);
	app.etat = null;
	ecrireStockage(CLES.etat, null);
	afficherAccueil();
	$("#erreur-connexion").textContent = "Connexion…";
	try {
		ouvrirApp(await appelerApi("etat"));
	} catch (erreur) {
		deconnecter(erreur.message);
	}
}

/** Clé contenue dans un lien de QR code (…/#cle=…), ou null. */
function cleDuLien(texte) {
	const trouve = /[#&]cle=([A-Za-z0-9]+)/.exec(String(texte));
	return trouve ? trouve[1] : null;
}

/** Lien à mettre dans un QR code : l'app, avec la clé après « # » (jamais envoyée au serveur web). */
function lienDeConnexion(cle) {
	return `${location.origin}${location.pathname}#cle=${cle}`;
}

function afficherQr(titre, aide, cle) {
	fermerMenu();
	const qr = qrcode(0, "M");
	qr.addData(lienDeConnexion(cle));
	qr.make();
	$("#qr-titre").textContent = titre;
	$("#qr-aide").textContent = aide;
	$("#qr-image").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
	$("#dialogue-qr").showModal();
}

function afficherMonQr() {
	if (!app.cle) {
		notifier("Ton QR code arrive au prochain chargement : touche Actualiser.", true);
		return;
	}
	afficherQr(
		"Mon QR code",
		"Scanne-le avec ton autre appareil (appareil photo, ou « Scanner mon QR code » dans l'app). Ne le montre à personne d'autre : il ouvre ton compte.",
		app.cle,
	);
}

async function inviter(personneInvitee) {
	const cle = await modifier("inviter", { personneId: personneInvitee.id });
	if (!cle) return;
	afficherQr(
		`Inviter ${personneInvitee.prenom}`,
		`Fais scanner ce QR code à ${personneInvitee.prenom} : il ouvre son compte sur son téléphone. Un nouveau QR code remplace le précédent.`,
		cle,
	);
}

async function revoquer() {
	fermerMenu();
	if (!confirm("Déconnecter tous tes autres appareils ? Pour les reconnecter, il faudra scanner ton nouveau QR code.")) return;
	await modifier("revoquer", {}, "Autres appareils déconnectés. Ton QR code a changé.");
}

// Lecture d'un QR code : BarcodeDetector quand le navigateur l'a, sinon jsQR (chargé au besoin).
let scanner = null;

function chargerJsQr() {
	if (window.jsQR) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const script = el("script", { src: "vendor/jsQR.min.js" });
		script.onload = resolve;
		script.onerror = () => reject(new Error("Lecteur de QR code indisponible."));
		document.head.append(script);
	});
}

function arreterScanner() {
	if (scanner) {
		cancelAnimationFrame(scanner.boucle);
		for (const piste of scanner.flux.getTracks()) piste.stop();
		scanner = null;
	}
	if ($("#dialogue-scanner").open) $("#dialogue-scanner").close();
}

async function ouvrirScanner() {
	$("#erreur-connexion").textContent = "";
	$("#scanner-message").textContent = "Vise le QR code avec la caméra.";
	$("#dialogue-scanner").showModal();
	try {
		const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
		const video = $("#scanner-video");
		video.srcObject = flux;
		await video.play();
		const detecteur = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
		if (!detecteur) await chargerJsQr();
		const toile = document.createElement("canvas");
		const contexte = toile.getContext("2d", { willReadFrequently: true });
		scanner = { flux, boucle: 0 };
		const lire = async () => {
			if (!scanner) return;
			let texte = null;
			if (video.readyState >= 2) {
				if (detecteur) {
					texte = (await detecteur.detect(video))[0]?.rawValue ?? null;
				} else {
					toile.width = video.videoWidth;
					toile.height = video.videoHeight;
					contexte.drawImage(video, 0, 0);
					texte = window.jsQR(contexte.getImageData(0, 0, toile.width, toile.height).data, toile.width, toile.height)?.data ?? null;
				}
			}
			const cle = texte ? cleDuLien(texte) : null;
			if (cle) {
				arreterScanner();
				connecterAvecCle(cle);
			} else {
				if (texte) $("#scanner-message").textContent = "Ce n'est pas un QR code de l'app Cadeaux.";
				if (scanner) scanner.boucle = requestAnimationFrame(lire);
			}
		};
		lire();
	} catch (erreur) {
		arreterScanner();
		$("#erreur-connexion").textContent =
			erreur?.name === "NotAllowedError" ? "Autorise la caméra pour scanner le QR code." : (erreur?.message ?? "Caméra indisponible.");
	}
}

function deconnecter(message = "") {
	fermerMenu();
	app.cle = null;
	app.code = null;
	app.membreId = null;
	app.etat = null;
	for (const cle of Object.values(CLES)) ecrireStockage(cle, null);
	$("#champ-code").value = "";
	afficherAccueil(message);
}

function seDeconnecter() {
	fermerMenu();
	if (!confirm("Te déconnecter de cet appareil ? Pour revenir, il faudra scanner ton QR code depuis un autre appareil connecté.")) return;
	deconnecter();
}

// ---------------------------------------------------------------------------
// Menu, bandeaux, PWA
// ---------------------------------------------------------------------------

function fermerMenu() {
	$("#menu").hidden = true;
	$("#bouton-menu").setAttribute("aria-expanded", "false");
}

function basculerMenu() {
	const ouvert = $("#menu").hidden;
	$("#menu").hidden = !ouvert;
	$("#bouton-menu").setAttribute("aria-expanded", String(ouvert));
}

function afficherBandeau(type, message, action) {
	const bandeau = $("#bandeau");
	bandeau.dataset.type = type;
	bandeau.replaceChildren(el("span", {}, message), action ? el("button", { type: "button", onclick: action.faire }, action.libelle) : null);
	bandeau.hidden = false;
}

function afficherBandeauHorsLigne() {
	if (app.horsLigne) {
		afficherBandeau("hors-ligne", "Hors ligne : dernières données connues, en lecture seule.", { libelle: "Réessayer", faire: () => actualiser() });
	} else if ($("#bandeau").dataset.type !== "maj") {
		$("#bandeau").hidden = true;
	}
}

let invitationInstallation = null;
const estIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const estInstallee = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (evenement) => {
	evenement.preventDefault();
	invitationInstallation = evenement;
	$("#menu-installer").hidden = false;
});

window.addEventListener("appinstalled", () => {
	invitationInstallation = null;
	$("#menu-installer").hidden = true;
	notifier("App installée.");
});

async function installer() {
	fermerMenu();
	if (invitationInstallation) {
		invitationInstallation.prompt();
		await invitationInstallation.userChoice;
		invitationInstallation = null;
		$("#menu-installer").hidden = true;
	} else if (estIos) {
		$("#dialogue-ios").showModal();
	}
}

function enregistrerServiceWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("sw.js").then((enregistrement) => {
		const proposerMiseAJour = (worker) => {
			afficherBandeau("maj", "Nouvelle version disponible.", {
				libelle: "Mettre à jour",
				faire: () => worker.postMessage("activer"),
			});
		};
		if (enregistrement.waiting && navigator.serviceWorker.controller) proposerMiseAJour(enregistrement.waiting);
		enregistrement.addEventListener("updatefound", () => {
			const worker = enregistrement.installing;
			worker?.addEventListener("statechange", () => {
				if (worker.state === "installed" && navigator.serviceWorker.controller) proposerMiseAJour(worker);
			});
		});
	});
	let recharge = false;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (recharge) return;
		recharge = true;
		window.location.reload();
	});
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

function brancherEvenements() {
	$("#form-code").addEventListener("submit", validerCode);
	$("#form-nouveau-membre").addEventListener("submit", ajouterMoi);
	$("#bouton-autre-code").addEventListener("click", () => afficherAccueil());
	$("#bouton-scanner").addEventListener("click", ouvrirScanner);
	$("#bouton-fermer-scanner").addEventListener("click", arreterScanner);
	$("#dialogue-scanner").addEventListener("cancel", arreterScanner);
	$("#bouton-supprimer-cadeau").addEventListener("click", supprimerDepuisFormulaire);
	$("#form-cadeau").addEventListener("submit", enregistrerCadeau);
	$("#form-historique").addEventListener("submit", enregistrerHistorique);
	$("#form-secret-santa").addEventListener("submit", enregistrerSecretSanta);
	for (const bouton of document.querySelectorAll("[data-fermer]")) {
		bouton.addEventListener("click", () => bouton.closest("dialog").close());
	}
	$("#bouton-actualiser").addEventListener("click", () => actualiser());
	$("#bouton-menu").addEventListener("click", (e) => {
		e.stopPropagation();
		basculerMenu();
	});
	document.addEventListener("click", (e) => {
		if (!$("#menu").hidden && !$("#menu").contains(e.target)) fermerMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") fermerMenu();
	});
	$("#menu-profil").addEventListener("click", ouvrirProfil);
	$("#menu-rejoindre").addEventListener("click", ouvrirRejoindre);
	$("#menu-creer").addEventListener("click", ouvrirCreer);
	$("#menu-installer").addEventListener("click", installer);
	$("#menu-qr").addEventListener("click", afficherMonQr);
	$("#menu-revoquer").addEventListener("click", revoquer);
	$("#menu-deconnecter").addEventListener("click", seDeconnecter);
	$("#bouton-offrir-selection").addEventListener("click", () => reserver([...app.selection]));
	for (const bouton of document.querySelectorAll(".onglets button")) {
		bouton.addEventListener("click", () => changerOnglet(bouton.dataset.onglet));
	}
	// Retour sur l'app (onglet ou téléphone) : les autres ont peut-être réservé entre-temps.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") actualiser({ silencieux: true });
	});
	window.addEventListener("online", () => actualiser({ silencieux: true }));
}

function demarrer() {
	for (const element of document.querySelectorAll(".version")) element.textContent = `Version ${window.VERSION_APP ?? "?"}`;
	$("#champ-naissance").max = versChampDate(new Date());
	if (!RENDUS[app.onglet]) app.onglet = "ma-liste";
	brancherEvenements();
	enregistrerServiceWorker();
	if (estIos && !estInstallee) $("#menu-installer").hidden = false;
	if (!window.API_URL) {
		afficherAccueil("L'adresse de l'API n'est pas configurée (config.js).");
		return;
	}
	// Lien d'un QR code (…/#cle=…) : connexion avec cette clé, retirée aussitôt de l'adresse.
	const cleLien = cleDuLien(location.hash);
	if (cleLien) {
		history.replaceState(null, "", location.pathname);
		connecterAvecCle(cleLien);
		return;
	}
	if (!estConnecte()) {
		afficherAccueil();
		return;
	}
	if (app.etat) {
		afficherEcran("app");
		rendre();
	}
	actualiser({ silencieux: true }).then(() => {
		if (app.etat) afficherEcran("app");
		else if (estConnecte()) afficherAccueil("Impossible de charger les listes. Vérifie ta connexion.");
	});
}

demarrer();
