"use strict";

// ---------------------------------------------------------------------------
// Stockage local (préférences de ce navigateur : code, membre, dernier état)
// ---------------------------------------------------------------------------

const CLES = {
	code: "cadeaux.code",
	membre: "cadeaux.membre",
	etat: "cadeaux.etat",
	onglet: "cadeaux.onglet",
	famille: "cadeaux.famille",
};

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
	/** Code de la famille avec laquelle le membre s'est connecté. */
	code: lireStockage(CLES.code),
	membreId: lireStockage(CLES.membre),
	/** { moi, familles, personnes, cadeaux, historique } renvoyé par l'API. */
	etat: null,
	/** Famille affichée (Famille, Disponibles). */
	familleId: lireStockage(CLES.famille),
	horsLigne: false,
	onglet: lireStockage(CLES.onglet) || "ma-liste",
	personneFamille: null,
	filtreDisponibles: "",
	triDisponibles: "priorite",
	filtreHistorique: "",
	selection: new Set(),
	/** Idée en cours d'édition : { cadeau, pourId }. */
	edition: null,
	occupe: false,
};

try {
	const etat = JSON.parse(lireStockage(CLES.etat) || "null");
	if (etat?.moi && etat.moi.id === app.membreId && Array.isArray(etat.familles)) app.etat = etat;
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
async function appelerApi(action, parametres = {}) {
	let reponse;
	try {
		reponse = await fetch(window.API_URL, {
			method: "POST",
			headers: { "Content-Type": "text/plain;charset=utf-8" },
			body: JSON.stringify({ action, code: app.code, membreId: app.membreId, ...parametres }),
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
	return donnees.data;
}

function appliquerEtat(etat) {
	app.etat = etat;
	app.membreId = etat.moi.id;
	app.horsLigne = false;
	ecrireStockage(CLES.membre, etat.moi.id);
	ecrireStockage(CLES.etat, JSON.stringify(etat));
	const ids = new Set(etat.cadeaux.map((c) => c.id));
	for (const id of app.selection) if (!ids.has(id)) app.selection.delete(id);
	afficherBandeauHorsLigne();
	rendre();
}

async function actualiser({ silencieux = false } = {}) {
	if (!app.code || !app.membreId) return;
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
		} else if (/Code famille|Membre inconnu/.test(erreur.message)) {
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

function notifier(message, erreur = false) {
	const toast = el("div", { class: `toast${erreur ? " erreur-toast" : ""}`, role: erreur ? "alert" : "status" }, message);
	$("#toasts").append(toast);
	setTimeout(() => toast.remove(), erreur ? 5000 : 3000);
}

const moi = () => app.etat.moi.id;
const personne = (id) => app.etat?.personnes.find((p) => p.id === id);
const prenomDe = (id) => (id === app.etat?.moi.id ? "toi" : (personne(id)?.prenom ?? "quelqu'un"));

function familleCourante() {
	const { familles } = app.etat;
	return familles.find((f) => f.id === app.familleId) ?? familles[0] ?? null;
}

/** Personnes de la famille affichée, sans le membre connecté. */
function autresDeLaFamille() {
	const famille = familleCourante();
	if (!famille) return [];
	return famille.membreIds.filter((id) => id !== moi()).map(personne).filter(Boolean);
}

/** Même règle que le serveur : ses idées et suggestions, et les listes des proches sans compte. */
function peutModifier(cadeau) {
	if (cadeau.ajouteParId === moi()) return true;
	return cadeau.proprietaireId !== moi() && personne(cadeau.proprietaireId)?.compte === false;
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
		if (cadeau.reserveParId === moi()) {
			if (pour !== "reservation") etiquette = el("span", { class: "badge moi" }, "Tu l'offres");
			actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => annuler([cadeau.id], "Réservation annulée.") }, "Annuler"));
		} else if (cadeau.reserveParId) {
			etiquette = el("span", { class: "badge pris" }, `Réservé par ${prenomDe(cadeau.reserveParId)}`);
		} else {
			etiquette = el("span", { class: "badge libre" }, "Disponible");
			actions.append(el("button", { type: "button", class: "bouton petit principal", onclick: () => reserver([cadeau.id]) }, "Je l'offre"));
		}
	}

	const suggestion =
		pour !== "moi" && cadeau.ajouteParId && cadeau.ajouteParId !== cadeau.proprietaireId
			? el("p", { class: "carte-note" }, cadeau.ajouteParId === moi() ? "Ta suggestion" : `Suggéré par ${prenomDe(cadeau.ajouteParId)}`)
			: null;
	const libre = pour !== "moi" && !retire && !cadeau.reserveParId;
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
			suggestion,
			el("div", { class: "carte-bas" }, etiquette, actions),
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
	const miens = app.etat.cadeaux.filter((c) => c.proprietaireId === moi()).sort(parPriorite);
	const ajouter = el("button", { type: "button", class: "bouton principal", onclick: () => ouvrirFormulaireCadeau(null, moi()) }, "+ Ajouter une idée");
	if (miens.length === 0) {
		return [vide("Ta liste est vide. Ajoute tes envies : tes familles les verront, sans que tu saches qui offre quoi.", ajouter)];
	}
	return [
		el("p", { class: "discret" }, `${miens.length} idée(s). Tu ne vois ni ce qui est réservé, ni ce que les autres te suggèrent : surprise !`),
		...miens.map((c) => carteCadeau(c, { pour: "moi" })),
		el("div", {}, ajouter),
	];
}

function dejaOffertA(id) {
	const entrees = app.etat.historique.filter((e) => e.destinataires.some((d) => d.id === id));
	if (entrees.length === 0) return null;
	return el(
		"details",
		{ class: "deja-offert" },
		el("summary", {}, `Tu lui as déjà offert (${entrees.length})`),
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
				`Personne d'autre dans la famille ${familleCourante()?.nom ?? ""} pour l'instant. Partage le code (menu en haut à droite), ou ajoute un proche qui n'utilisera pas l'app (enfant, grands-parents…).`,
				el("button", { type: "button", class: "bouton", onclick: ouvrirAjoutPersonne }, "Ajouter une personne"),
			),
		];
	}
	if (!autres.some((p) => p.id === app.personneFamille)) app.personneFamille = autres[0].id;
	const choisie = personne(app.personneFamille);
	const puces = el(
		"div",
		{ class: "puces", role: "group", "aria-label": "Personne" },
		autres.map((p) =>
			el(
				"button",
				{
					type: "button",
					"aria-pressed": String(p.id === app.personneFamille),
					onclick: () => {
						app.personneFamille = p.id;
						rendre();
					},
				},
				p.prenom,
			),
		),
		el("button", { type: "button", class: "puce-ajout", onclick: ouvrirAjoutPersonne, "aria-label": "Ajouter une personne sans compte" }, "+ Personne"),
	);
	const sesCadeaux = app.etat.cadeaux
		.filter((c) => c.proprietaireId === choisie.id && c.statut !== "retiré")
		.sort(parPriorite);
	const libres = sesCadeaux.filter((c) => !c.reserveParId).length;
	const ajouter = el(
		"button",
		{ type: "button", class: "bouton", onclick: () => ouvrirFormulaireCadeau(null, choisie.id) },
		choisie.compte ? `+ Suggérer une idée pour ${choisie.prenom}` : `+ Ajouter une idée pour ${choisie.prenom}`,
	);
	return [
		puces,
		el(
			"div",
			{ class: "groupe-titre" },
			el("h2", {}, choisie.nom ? `${choisie.prenom} ${choisie.nom}` : choisie.prenom),
			el("span", { class: "discret" }, sesCadeaux.length ? `${libres} disponible(s) sur ${sesCadeaux.length}` : ""),
		),
		choisie.compte ? null : el("p", { class: "discret" }, `${choisie.prenom} n'utilise pas l'app : la famille tient sa liste.`),
		sesCadeaux.length === 0
			? vide(`${choisie.prenom} n'a encore rien demandé.`)
			: el("div", { class: "groupe" }, sesCadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true }))),
		el("div", { class: "pile" }, ajouter, choisie.compte ? el("p", { class: "discret" }, `${choisie.prenom} ne verra pas tes suggestions.`) : null),
		dejaOffertA(choisie.id),
	];
}

function rendreDisponibles() {
	const autres = autresDeLaFamille();
	const ids = new Set(autres.map((p) => p.id));
	let libres = app.etat.cadeaux.filter((c) => ids.has(c.proprietaireId) && c.statut !== "retiré" && !c.reserveParId);
	if (app.filtreDisponibles) libres = libres.filter((c) => c.proprietaireId === app.filtreDisponibles);
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
	if (libres.length === 0) return [filtres, vide("Plus aucun cadeau disponible ici. Tout est déjà réservé !")];

	const groupes = autres
		.map((p) => ({ personne: p, cadeaux: libres.filter((c) => c.proprietaireId === p.id) }))
		.filter((g) => g.cadeaux.length > 0);
	return [
		filtres,
		el("p", { class: "discret" }, "Coche plusieurs cadeaux pour les réserver d'un coup."),
		groupes.map((g) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, `Pour ${g.personne.prenom}`), el("span", { class: "discret" }, `${g.cadeaux.length}`)),
				g.cadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true })),
			),
		),
	];
}

function rendreReservations() {
	const miennes = app.etat.cadeaux.filter((c) => c.reserveParId === moi());
	if (miennes.length === 0) {
		return [
			vide(
				"Tu n'offres encore rien.",
				el("button", { type: "button", class: "bouton principal", onclick: () => changerOnglet("disponibles") }, "Voir les cadeaux disponibles"),
			),
		];
	}
	const actifs = miennes.filter((c) => c.statut !== "retiré");
	const total = actifs.reduce((somme, c) => somme + (c.prix ?? 0), 0);
	const destinataires = [...new Set(miennes.map((c) => c.proprietaireId))];
	return [
		el("div", { class: "total" }, el("span", {}, `${actifs.length} cadeau(x)`), el("span", {}, `≈ ${prix(total)}`)),
		destinataires.map((id) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, `Pour ${prenomDe(id)}`)),
				miennes
					.filter((c) => c.proprietaireId === id)
					.sort(parPriorite)
					.map((c) => carteCadeau(c, { pour: "reservation" })),
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

	const choix = $("#choix-famille");
	const plusieurs = familles.length > 1;
	choix.hidden = !plusieurs;
	$("#libelle-famille").textContent = plusieurs ? "Famille" : familles[0] ? `Famille ${familles[0].nom}` : "Cadeaux de Noël";
	if (plusieurs) {
		choix.replaceChildren(...familles.map((f) => el("option", { value: f.id, selected: f.id === familleCourante()?.id }, f.nom)));
	}

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
	const nbReservations = app.etat.cadeaux.filter((c) => c.reserveParId === moi()).length;
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

function changerFamille(id) {
	app.familleId = id;
	app.personneFamille = null;
	app.filtreDisponibles = "";
	app.selection.clear();
	ecrireStockage(CLES.famille, id);
	rendre();
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

async function annuler(ids, message) {
	const resultat = await modifier("annuler-reservation", { cadeauIds: ids });
	if (!resultat) return;
	if (resultat.faits.length) notifier(message);
	if (resultat.refuses.length) notifier(messageRefus(resultat), true);
}

// ---------------------------------------------------------------------------
// Idées : ajout (pour soi ou pour un proche), modification, suppression
// ---------------------------------------------------------------------------

function ouvrirFormulaireCadeau(cadeau, pourId = cadeau?.proprietaireId) {
	app.edition = { cadeau, pourId };
	const form = $("#form-cadeau");
	form.reset();
	const pourMoi = pourId === moi();
	const destinataire = personne(pourId);
	$("#titre-dialogue").textContent = cadeau ? "Modifier l'idée" : pourMoi ? "Nouvelle idée" : `Idée pour ${destinataire?.prenom}`;
	$("#aide-dialogue").textContent =
		pourMoi || !destinataire
			? ""
			: destinataire.compte
				? `${destinataire.prenom} ne verra pas cette idée ; les autres pourront la réserver.`
				: `${destinataire.prenom} n'utilise pas l'app : l'idée rejoint sa liste.`;
	$("#erreur-cadeau").textContent = "";
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
	const { cadeau: existant, pourId } = app.edition;
	$("#erreur-cadeau").textContent = "";
	const reussi = await modifier(
		existant ? "modifier-cadeau" : "ajouter-cadeau",
		existant ? { cadeauId: existant.id, cadeau } : { cadeau, pourId },
		existant ? "Idée modifiée." : pourId === moi() ? "Idée ajoutée à ta liste." : `Idée ajoutée pour ${prenomDe(pourId)}.`,
		(message) => {
			$("#erreur-cadeau").textContent = message;
		},
	);
	if (reussi) $("#dialogue-cadeau").close();
}

async function supprimer(cadeau) {
	if (!confirm(`Supprimer « ${cadeau.titre} » ?`)) return;
	await modifier("supprimer-cadeau", { cadeauId: cadeau.id }, "Idée supprimée.");
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
// Familles : rejoindre, créer, ajouter une personne sans compte
// ---------------------------------------------------------------------------

/**
 * Ouvre le petit formulaire générique.
 * @param champs [{ nom, libelle, maxlength?, requis? }]
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
			el("input", { id: `simple-${c.nom}`, name: c.nom, type: "text", maxlength: c.maxlength ?? 60, required: c.requis !== false, autocomplete: "off" }),
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
			changerFamille(famille.id);
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
			changerFamille(famille.id);
			return true;
		},
	});
}

function ouvrirAjoutPersonne() {
	const famille = familleCourante();
	if (!famille) return;
	ouvrirDialogueSimple({
		titre: `Ajouter à la famille ${famille.nom}`,
		aide: "Pour un proche qui n'utilisera pas l'app (enfant, grands-parents…) : toute la famille pourra tenir sa liste. S'il s'y met plus tard, il choisira son prénom à la connexion.",
		champs: [
			{ nom: "prenom", libelle: "Prénom", maxlength: 40 },
			{ nom: "nom", libelle: "Nom (facultatif)", maxlength: 60, requis: false },
		],
		bouton: "Ajouter",
		valider: async ({ prenom, nom }, erreur) => {
			const ajoutee = await modifier("ajouter-personne", { familleId: famille.id, prenom, nom }, `${prenom.trim()} ajouté(e).`, erreur);
			if (!ajoutee) return false;
			app.personneFamille = ajoutee.id;
			changerOnglet("famille");
			return true;
		},
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
// Connexion
// ---------------------------------------------------------------------------

function afficherEcran(nom) {
	$("#ecran-connexion").hidden = nom !== "connexion";
	$("#ecran-app").hidden = nom !== "app";
}

function afficherChoixMembre({ famille, personnes }) {
	$("#form-code").hidden = true;
	$("#choix-membre").hidden = false;
	$("#titre-choix").textContent = `Famille ${famille.nom} : qui es-tu ?`;
	const prenoms = personnes.map((p) => p.prenom);
	$("#liste-membres").replaceChildren(
		...personnes.map((p) =>
			el(
				"button",
				{ type: "button", class: "bouton", onclick: () => connecter("choisir", { personneId: p.id }) },
				// Deux prénoms identiques : le nom les distingue.
				prenoms.filter((x) => x === p.prenom).length > 1 && p.nom ? `${p.prenom} ${p.nom}` : p.prenom,
			),
		),
	);
	if (personnes.length === 0) $("#champ-prenom").focus();
}

function afficherSaisieCode(message = "") {
	afficherEcran("connexion");
	$("#form-code").hidden = false;
	$("#choix-membre").hidden = true;
	$("#erreur-connexion").textContent = message;
	$("#champ-code").focus();
}

async function validerCode(evenement) {
	evenement.preventDefault();
	const bouton = evenement.submitter;
	if (bouton) bouton.disabled = true;
	$("#erreur-connexion").textContent = "";
	app.code = $("#champ-code").value.trim();
	try {
		const famille = await appelerApi("famille");
		ecrireStockage(CLES.code, app.code);
		afficherChoixMembre(famille);
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	} finally {
		if (bouton) bouton.disabled = false;
	}
}

/** Choisit (« choisir ») ou crée (« ajouter-moi ») le membre, puis ouvre l'app. */
async function connecter(action, parametres) {
	$("#erreur-connexion").textContent = "";
	app.membreId = null;
	app.selection.clear();
	try {
		appliquerEtat(await appelerApi(action, parametres));
		const familleDuCode = app.etat.familles.find((f) => f.code.toLowerCase() === app.code.toLowerCase());
		if (familleDuCode) changerFamille(familleDuCode.id);
		afficherEcran("app");
		if (!app.etat.cadeaux.some((c) => c.proprietaireId === moi())) {
			changerOnglet("ma-liste");
			notifier(`Bienvenue ${app.etat.moi.prenom} ! Commence par ajouter tes idées.`);
		}
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	}
}

async function ajouterMoi(evenement) {
	evenement.preventDefault();
	await connecter("ajouter-moi", { prenom: $("#champ-prenom").value });
}

async function changerDePersonne() {
	fermerMenu();
	app.membreId = null;
	app.etat = null;
	ecrireStockage(CLES.membre, null);
	ecrireStockage(CLES.etat, null);
	afficherEcran("connexion");
	$("#erreur-connexion").textContent = "";
	try {
		afficherChoixMembre(await appelerApi("famille"));
	} catch (erreur) {
		afficherSaisieCode(erreur.message);
	}
}

function deconnecter(message = "") {
	fermerMenu();
	app.code = null;
	app.membreId = null;
	app.etat = null;
	for (const cle of Object.values(CLES)) ecrireStockage(cle, null);
	$("#champ-code").value = "";
	afficherSaisieCode(message);
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
	$("#bouton-autre-code").addEventListener("click", () => deconnecter());
	$("#form-cadeau").addEventListener("submit", enregistrerCadeau);
	$("#form-historique").addEventListener("submit", enregistrerHistorique);
	for (const bouton of document.querySelectorAll("[data-fermer]")) {
		bouton.addEventListener("click", () => bouton.closest("dialog").close());
	}
	$("#bouton-actualiser").addEventListener("click", () => actualiser());
	$("#choix-famille").addEventListener("change", (e) => changerFamille(e.target.value));
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
	$("#menu-rejoindre").addEventListener("click", ouvrirRejoindre);
	$("#menu-creer").addEventListener("click", ouvrirCreer);
	$("#menu-installer").addEventListener("click", installer);
	$("#menu-changer").addEventListener("click", changerDePersonne);
	$("#menu-deconnecter").addEventListener("click", () => deconnecter());
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
	if (!RENDUS[app.onglet]) app.onglet = "ma-liste";
	brancherEvenements();
	enregistrerServiceWorker();
	if (estIos && !estInstallee) $("#menu-installer").hidden = false;
	if (!window.API_URL) {
		afficherSaisieCode("L'adresse de l'API n'est pas configurée (config.js).");
		return;
	}
	if (!app.code) {
		afficherSaisieCode();
	} else if (!app.membreId) {
		afficherEcran("connexion");
		changerDePersonne();
	} else {
		if (app.etat) {
			afficherEcran("app");
			rendre();
		}
		actualiser({ silencieux: true }).then(() => {
			if (app.etat) afficherEcran("app");
			else if (app.code) afficherSaisieCode("Impossible de charger les listes. Vérifie ta connexion.");
		});
	}
}

demarrer();
