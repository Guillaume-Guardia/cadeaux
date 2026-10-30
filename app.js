"use strict";

// ---------------------------------------------------------------------------
// Stockage local (préférences de ce navigateur : code, membre, dernier état)
// ---------------------------------------------------------------------------

const CLES = { code: "cadeaux.code", membre: "cadeaux.membre", etat: "cadeaux.etat", onglet: "cadeaux.onglet" };

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
	code: lireStockage(CLES.code),
	membreId: lireStockage(CLES.membre),
	/** { moi, membres, cadeaux } renvoyé par l'API. */
	etat: null,
	horsLigne: false,
	onglet: lireStockage(CLES.onglet) || "ma-liste",
	membreFamille: null,
	filtreDisponibles: "",
	triDisponibles: "priorite",
	selection: new Set(),
	cadeauEnEdition: null,
	occupe: false,
};

try {
	const etat = JSON.parse(lireStockage(CLES.etat) || "null");
	if (etat && etat.moi && etat.moi.id === app.membreId) app.etat = etat;
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
	app.horsLigne = false;
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
 * @return le résultat, ou null en cas d'échec
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
const ENVIES = { 1: "Très envie", 2: "Envie", 3: "Si possible" };

function notifier(message, erreur = false) {
	const toast = el("div", { class: `toast${erreur ? " erreur-toast" : ""}`, role: erreur ? "alert" : "status" }, message);
	$("#toasts").append(toast);
	setTimeout(() => toast.remove(), erreur ? 5000 : 3000);
}

function prenomDe(id) {
	return app.etat?.membres.find((m) => m.id === id)?.prenom ?? "quelqu'un";
}

function autresMembres() {
	return app.etat.membres.filter((m) => m.id !== app.etat.moi.id);
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
			el("button", { type: "button", class: "bouton petit", onclick: () => ouvrirFormulaire(cadeau) }, "Modifier"),
			el("button", { type: "button", class: "bouton petit danger", onclick: () => supprimer(cadeau) }, "Supprimer"),
		);
	} else if (retire) {
		etiquette = el("span", { class: "badge pris" }, `Retiré de la liste par ${prenomDe(cadeau.proprietaireId)}`);
		actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => annuler([cadeau.id], "Effacé de tes réservations.") }, "Effacer"));
	} else if (cadeau.reserveParId === app.etat.moi.id) {
		if (pour !== "reservation") etiquette = el("span", { class: "badge moi" }, "Tu l'offres");
		actions.append(el("button", { type: "button", class: "bouton petit", onclick: () => annuler([cadeau.id], "Réservation annulée.") }, "Annuler"));
	} else if (cadeau.reserveParId) {
		etiquette = el("span", { class: "badge pris" }, `Réservé par ${prenomDe(cadeau.reserveParId)}`);
	} else {
		etiquette = el("span", { class: "badge libre" }, "Disponible");
		actions.append(el("button", { type: "button", class: "bouton petit principal", onclick: () => reserver([cadeau.id]) }, "Je l'offre"));
	}

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

const TITRES = { "ma-liste": "Ma liste", famille: "La famille", disponibles: "Disponibles", reservations: "Ce que j'offre" };

function rendreMaListe() {
	const miens = app.etat.cadeaux.filter((c) => c.proprietaireId === app.etat.moi.id).sort(parPriorite);
	const ajouter = el("button", { type: "button", class: "bouton principal", onclick: () => ouvrirFormulaire(null) }, "+ Ajouter une idée");
	if (miens.length === 0) {
		return [vide("Ta liste est vide. Ajoute tes envies : la famille les verra, sans que tu saches qui offre quoi.", ajouter)];
	}
	return [
		el("div", { class: "barre-outils" }, el("p", { class: "discret" }, `${miens.length} idée(s). Tu ne vois pas ce qui est réservé : surprise !`)),
		...miens.map((c) => carteCadeau(c, { pour: "moi" })),
		el("div", {}, ajouter),
	];
}

function rendreFamille() {
	const autres = autresMembres();
	if (autres.length === 0) return [vide("Personne d'autre pour l'instant. Partage le lien et le code famille !")];
	if (!autres.some((m) => m.id === app.membreFamille)) app.membreFamille = autres[0].id;
	const puces = el(
		"div",
		{ class: "puces", role: "group", "aria-label": "Membre" },
		autres.map((m) =>
			el(
				"button",
				{
					type: "button",
					"aria-pressed": String(m.id === app.membreFamille),
					onclick: () => {
						app.membreFamille = m.id;
						rendre();
					},
				},
				m.prenom,
			),
		),
	);
	const sesCadeaux = app.etat.cadeaux
		.filter((c) => c.proprietaireId === app.membreFamille && c.statut !== "retiré")
		.sort(parPriorite);
	const libres = sesCadeaux.filter((c) => !c.reserveParId).length;
	return [
		puces,
		sesCadeaux.length === 0
			? vide(`${prenomDe(app.membreFamille)} n'a encore rien demandé.`)
			: el(
					"div",
					{ class: "groupe" },
					el("p", { class: "discret" }, `${sesCadeaux.length} idée(s), ${libres} disponible(s)`),
					sesCadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true })),
				),
	];
}

function rendreDisponibles() {
	const autres = autresMembres();
	let libres = app.etat.cadeaux.filter(
		(c) => c.proprietaireId !== app.etat.moi.id && c.statut !== "retiré" && !c.reserveParId,
	);
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
			autres.map((m) => el("option", { value: m.id, selected: m.id === app.filtreDisponibles }, `Pour ${m.prenom}`)),
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
		.map((m) => ({ membre: m, cadeaux: libres.filter((c) => c.proprietaireId === m.id) }))
		.filter((g) => g.cadeaux.length > 0);
	return [
		filtres,
		el("p", { class: "discret" }, "Coche plusieurs cadeaux pour les réserver d'un coup."),
		groupes.map((g) =>
			el(
				"section",
				{ class: "groupe" },
				el("div", { class: "groupe-titre" }, el("h2", {}, `Pour ${g.membre.prenom}`), el("span", { class: "discret" }, `${g.cadeaux.length}`)),
				g.cadeaux.map((c) => carteCadeau(c, { pour: "autre", selectionnable: true })),
			),
		),
	];
}

function rendreReservations() {
	const miennes = app.etat.cadeaux.filter((c) => c.reserveParId === app.etat.moi.id);
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
	];
}

const RENDUS = { "ma-liste": rendreMaListe, famille: rendreFamille, disponibles: rendreDisponibles, reservations: rendreReservations };

function rendre() {
	if (!app.etat) return;
	const { moi } = app.etat;
	$("#titre-onglet").textContent = TITRES[app.onglet];
	$("#bouton-menu").textContent = moi.prenom.charAt(0).toUpperCase();
	$("#menu-nom").textContent = `Connecté en tant que ${moi.prenom}`;
	for (const bouton of document.querySelectorAll(".onglets button")) {
		if (bouton.dataset.onglet === app.onglet) bouton.setAttribute("aria-current", "page");
		else bouton.removeAttribute("aria-current");
	}
	const nbReservations = app.etat.cadeaux.filter((c) => c.reserveParId === moi.id).length;
	const pastille = $("#compteur-reservations");
	pastille.hidden = nbReservations === 0;
	pastille.textContent = String(nbReservations);

	$("#contenu").replaceChildren(...RENDUS[app.onglet]().flat());
	rendreSelection();
}

function changerOnglet(onglet) {
	app.onglet = onglet;
	ecrireStockage(CLES.onglet, onglet);
	rendre();
	window.scrollTo({ top: 0 });
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
// Ma liste : ajout, modification, suppression
// ---------------------------------------------------------------------------

function ouvrirFormulaire(cadeau) {
	app.cadeauEnEdition = cadeau;
	const form = $("#form-cadeau");
	form.reset();
	$("#titre-dialogue").textContent = cadeau ? "Modifier l'idée" : "Nouvelle idée";
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
	const enEdition = app.cadeauEnEdition;
	$("#erreur-cadeau").textContent = "";
	const reussi = await modifier(
		enEdition ? "modifier-cadeau" : "ajouter-cadeau",
		enEdition ? { cadeauId: enEdition.id, cadeau } : { cadeau },
		enEdition ? "Idée modifiée." : "Idée ajoutée à ta liste.",
		(message) => {
			$("#erreur-cadeau").textContent = message;
		},
	);
	if (reussi) $("#dialogue-cadeau").close();
}

async function supprimer(cadeau) {
	if (!confirm(`Supprimer « ${cadeau.titre} » de ta liste ?`)) return;
	await modifier("supprimer-cadeau", { cadeauId: cadeau.id }, "Idée supprimée.");
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

function afficherEcran(nom) {
	$("#ecran-connexion").hidden = nom !== "connexion";
	$("#ecran-app").hidden = nom !== "app";
}

function afficherChoixMembre(membres) {
	$("#form-code").hidden = true;
	$("#choix-membre").hidden = false;
	$("#liste-membres").replaceChildren(
		...membres.map((m) => el("button", { type: "button", class: "bouton", onclick: () => choisirMembre(m.id) }, m.prenom)),
	);
	if (membres.length === 0) $("#champ-prenom").focus();
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
	bouton.disabled = true;
	$("#erreur-connexion").textContent = "";
	app.code = $("#champ-code").value.trim();
	try {
		const membres = await appelerApi("membres");
		ecrireStockage(CLES.code, app.code);
		afficherChoixMembre(membres);
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	} finally {
		bouton.disabled = false;
	}
}

async function ajouterMembre(evenement) {
	evenement.preventDefault();
	$("#erreur-connexion").textContent = "";
	try {
		const membre = await appelerApi("ajouter-membre", { prenom: $("#champ-prenom").value });
		await choisirMembre(membre.id);
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	}
}

async function choisirMembre(id) {
	app.membreId = id;
	ecrireStockage(CLES.membre, id);
	app.etat = null;
	app.selection.clear();
	try {
		appliquerEtat(await appelerApi("etat"));
		afficherEcran("app");
		if (app.onglet === "ma-liste" && !app.etat.cadeaux.some((c) => c.proprietaireId === id)) {
			notifier(`Bienvenue ${app.etat.moi.prenom} ! Commence par ajouter tes idées.`);
		}
	} catch (erreur) {
		$("#erreur-connexion").textContent = erreur.message;
	}
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
		afficherChoixMembre(await appelerApi("membres"));
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
	$("#form-nouveau-membre").addEventListener("submit", ajouterMembre);
	$("#bouton-autre-code").addEventListener("click", () => deconnecter());
	$("#form-cadeau").addEventListener("submit", enregistrerCadeau);
	$("#bouton-annuler-cadeau").addEventListener("click", () => $("#dialogue-cadeau").close());
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
