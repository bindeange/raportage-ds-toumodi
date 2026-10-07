/**
 * Page 2 — Tableau de bord (après connexion).
 *  - accès rapide aux pages de rapportage ;
 *  - PVVIH sous ARV : file active par localité (ESPC) et combinée pour le district ;
 *  - âges répartis en tranches couvrant toute la population (aucun seuil unique) ;
 *  - points d'attention, évolution, comparaison des structures, suivi des validations.
 * Les effectifs viennent de /api/clinical/dashboard (agrégés côté serveur, sans code patient).
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    const SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    const nf = new Intl.NumberFormat('fr-FR');
    const num = (v) => nf.format(Number(v) || 0);
    const pct = (a, b) => (b > 0 ? (Math.round((a / b) * 1000) / 10).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %' : '—');
    const width = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const validated = (s) => ['VALIDE', 'VALIDÉ', 'VALIDEE', 'VALIDÉE', 'NEANT', 'NÉANT'].includes(String(s).toUpperCase());
    const badge = (s) => `<span class="pill ${validated(s) ? 'pill-ok' : s ? 'pill-wait' : 'pill-empty'}">${validated(s) ? 'Validé' : s ? 'En cours' : 'Non saisi'}</span>`;
    const clinicalPill = (status) => `<span class="pill ${status === 'VALIDE' ? 'pill-ok' : status === 'BROUILLON' ? 'pill-wait' : 'pill-empty'}">${status === 'VALIDE' ? 'Validée' : status === 'BROUILLON' ? 'Brouillon' : 'Non saisie'}</span>`;

    let actor = null;
    let activePeriod = { m: null, y: null };
    let sequence = 0;
    const state = { data: null, tracking: null, code: '', detail: false, sort: { key: 'active', dir: -1 }, query: '' };

    async function api(path) {
        const response = await fetch('/api/clinical/' + path, { headers: { Authorization: 'Bearer ' + window.clinicalToken } });
        const json = await response.json().catch(() => ({}));
        if (response.status === 401 && window.sessionExpired) window.sessionExpired();
        if (!response.ok || !json.ok) throw new Error(json.error || 'Chargement impossible.');
        return json;
    }

    // ---------- métriques ----------
    const total = (triple) => sum(triple);
    const exits = (m) => m.mouv.transfertsOut + m.mouv.deces + m.mouv.arrets + m.mouv.perdus;
    const inflow = (m) => m.mouv.nouvelles + m.mouv.transfertsIn + m.mouv.retours;
    const bandRange = (m, from, to) => { let t = 0; for (let i = from; i <= to; i++) t += total(m.ageSex[i]); return t; };
    const AGE_GROUPS = [['0–14 ans', 0, 3], ['15–24 ans', 4, 5], ['25–49 ans', 6, 10], ['50 ans et +', 11, 14]];
    const lineLabel = (v) => (/^\d+$/.test(v) ? (v === '1' ? '1ère ligne' : v + 'ème ligne') : v);
    const periodLabel = () => { const p = state.data.periode; return MONTHS[p.mois - 1] + ' ' + p.annee; };
    const names = (list) => { const n = list.map((s) => s.nom); return n.slice(0, 6).join(', ') + (n.length > 6 ? ` et ${n.length - 6} autre(s)` : ''); };

    function current() {
        const d = state.data;
        if (!state.code) return { metrics: d.combined.metrics, trend: d.combined.trend, item: null };
        const item = d.structures.find((s) => s.code_dhis2 === state.code);
        return { metrics: item.metrics, trend: item.trend, item };
    }

    // ---------- chargement ----------
    function fillPeriod(m, y) {
        const now = new Date();
        let mm = Number(m) || now.getMonth() + 1, yy = Number(y) || now.getFullYear();
        const select = $('dash-period'), keep = select.value, periods = [];
        for (let i = 0; i < 18; i++) { periods.push([mm, yy]); if (--mm === 0) { mm = 12; yy--; } }
        select.innerHTML = periods.map(([a, b]) => `<option value="${a}/${b}">${MONTHS[a - 1]} ${b}</option>`).join('');
        if (keep && periods.some(([a, b]) => a + '/' + b === keep)) select.value = keep;
    }

    function fillScope() {
        const select = $('dash-scope'), items = state.data.structures.filter((s) => s.rattachee), admin = actor.role === 'ADMIN';
        const options = (admin ? [['', 'Tout le district (combiné)']] : []).concat(items.map((s) => [s.code_dhis2, s.nom]));
        if (!options.some((o) => o[0] === state.code)) state.code = options.length ? options[0][0] : '';
        select.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
        select.value = state.code;
        select.disabled = !admin;
    }

    async function load() {
        const mine = ++sequence, box = $('dash-result');
        const [m, y] = $('dash-period').value.split('/').map(Number);
        box.innerHTML = '<p role="status">Chargement du tableau de bord…</p>';
        try {
            const [data, tracking] = await Promise.all([
                api(`dashboard?mois=${m}&annee=${y}`),
                api(`tracking?mois=${m}&annee=${y}`).catch((e) => ({ error: e.message }))
            ]);
            if (mine !== sequence) return;
            state.data = data;
            state.tracking = tracking.ok ? tracking : null;
            state.trackingError = tracking.ok ? '' : tracking.error;
            fillScope();
            render();
        } catch (e) {
            if (mine !== sequence) return;
            box.innerHTML = `<p role="alert" class="portal-error">${esc(e.message)}</p><button type="button" id="dash-retry">Réessayer</button>`;
            $('dash-retry').onclick = load;
        }
    }

    // ---------- sections ----------
    function shortcuts() {
        const admin = actor.role === 'ADMIN', t = trackingCounts();
        const cards = admin
            ? [
                ['suivi', 'Suivi des rapports', 'Matrice ESPC × programmes, relances et validations.', t ? `${t.ok} / ${t.cells} rapports validés` : ''],
                ['rapports', 'Rapports par structure', 'Consulter, corriger, valider ou rouvrir un rapport.', ''],
                ['clinical', 'File active', 'Fiches patients, rendez-vous et synthèse mensuelle.', t ? `${t.clinicalOk} / ${t.structures} files validées` : ''],
                ['bilan', 'Bilan médicaments', 'Stocks et indicateurs du district par programme.', ''],
                ['livraisons', 'Livraisons', 'Livraisons mensuelles et urgentes.', ''],
                ['period', 'Période active', 'Mois de rapportage ouvert aux structures.', MONTHS[Number(activePeriod.m) - 1] ? `${MONTHS[Number(activePeriod.m) - 1]} ${activePeriod.y}` : ''],
                ['passwords', 'Mots de passe', 'Accès des structures.', '']
            ]
            : [
                ['rapports', 'Mes rapports à saisir', 'Stocks et indicateurs de votre structure.', t ? `${t.ok} / ${t.cells} rapports validés` : ''],
                ['clinical', 'File active', 'Vos patients, rendez-vous et nouvelles inclusions.', t ? `File active ${t.clinicalOk ? 'validée' : 'non validée'}` : '']
            ];
        return `<section class="dash-section" id="dash-sec-access" aria-labelledby="h-access"><h3 id="h-access">Accès aux rapports</h3><div class="shortcut-grid">${cards.map(([k, title, text, meta]) => `<button type="button" class="shortcut" data-go="${k}"><strong>${esc(title)}</strong><span>${esc(text)}</span>${meta ? `<em>${esc(meta)}</em>` : ''}</button>`).join('')}</div></section>`;
    }

    function trackingCounts() {
        const t = state.tracking;
        if (!t) return null;
        const reports = new Map();
        for (const r of t.reports) { const k = r.entite_id + ':' + r.famille_id; if (!reports.has(k) || validated(r.statut)) reports.set(k, r.statut); }
        const clinical = new Map(t.clinical.map((r) => [r.code_dhis2, r.status]));
        let cells = 0, ok = 0;
        for (const s of t.structures) for (const f of t.families) { cells++; if (validated(reports.get(s.id + ':' + f.id))) ok++; }
        return { cells, ok, structures: t.structures.length, clinicalOk: t.structures.filter((s) => s.code_dhis2 && clinical.get(s.code_dhis2) === 'VALIDE').length, reports, clinical };
    }

    function alerts(cur) {
        const d = state.data, m = cur.metrics, list = [];
        if (actor.role === 'ADMIN' && !state.code) {
            const linked = d.structures.filter((s) => s.rattachee), unlinked = d.structures.filter((s) => !s.rattachee);
            if (unlinked.length) list.push(['warn', `${unlinked.length} structure(s) sans code DHIS2 (${names(unlinked)}) : leurs patients ne sont pas comptés dans ce tableau.`]);
            const missing = linked.filter((s) => s.status === 'NON SAISI');
            if (missing.length) list.push(['warn', `${missing.length} structure(s) sans saisie de file active pour ${periodLabel()} : ${names(missing)}. Leurs effectifs reprennent la dernière situation connue.`]);
            const draft = linked.filter((s) => s.status === 'BROUILLON');
            if (draft.length) list.push(['info', `${draft.length} structure(s) en brouillon, non validées : ${names(draft)}.`]);
        } else if (cur.item) {
            if (cur.item.status === 'NON SAISI') list.push(['warn', `Aucune saisie de file active pour ${periodLabel()}${cur.item.derniere_saisie ? ` : les effectifs reprennent la situation de ${MONTHS[cur.item.derniere_saisie.mois - 1]} ${cur.item.derniere_saisie.annee}` : ' et aucune donnée antérieure'}.`]);
            else if (cur.item.status === 'BROUILLON') list.push(['info', `La file active de ${periodLabel()} est en brouillon (non validée).`]);
        }
        if (m.retard.ge28) list.push(['warn', `${num(m.retard.ge28)} patient(s) ont dépassé de 28 jours ou plus la fin de leur traitement. Ils ne sont pas classés perdus de vue : à rechercher avant toute décision.`]);
        if (m.qualite.sansAge || m.qualite.sansSexe) list.push(['info', `${num(m.qualite.sansAge)} patient(s) actif(s) sans âge et ${num(m.qualite.sansSexe)} sans sexe : ils sont comptés dans le total mais restent dans « non renseigné ».`]);
        if (m.mouv.entreesSansMotif || m.mouv.sortiesSansMotif) list.push(['warn', `Mouvements sans motif enregistré : ${num(m.mouv.entreesSansMotif)} entrée(s) sans inclusion, transfert in ou retour ; ${num(m.mouv.sortiesSansMotif)} sortie(s) sans transfert out, décès, arrêt ni perte de vue.`]);
        if (m.qualite.incompletes) list.push(['info', `${num(m.qualite.incompletes)} fiche(s) du mois à compléter avant validation.`]);
        if (m.retard.sansDate) list.push(['info', `${num(m.retard.sansDate)} patient(s) actif(s) sans date de dispensation ou durée : leur rendez-vous ne peut pas être calculé.`]);
        return `<section class="dash-section" id="dash-sec-alerts" aria-labelledby="h-alerts"><h3 id="h-alerts">Points d’attention</h3>${list.length ? `<ul class="alerts">${list.map(([lvl, text]) => `<li class="alert-${lvl}"><span class="alert-tag">${lvl === 'warn' ? 'À traiter' : 'À noter'}</span> ${esc(text)}</li>`).join('')}</ul>` : '<p class="muted">Aucun point d’attention pour cette période.</p>'}</section>`;
    }

    function kpis(cur) {
        const m = cur.metrics, delta = m.active - m.mouv.previous;
        const card = (value, label, sub) => `<article><strong>${value}</strong><span>${esc(label)}</span><small>${sub}</small></article>`;
        const arrow = delta === 0 ? 'Stable' : (delta > 0 ? '▲ +' : '▼ −') + num(Math.abs(delta));
        return `<section class="dash-section" id="dash-sec-kpi" aria-labelledby="h-kpi"><h3 id="h-kpi">Situation de la file active</h3><div class="kpi-grid">
            ${card(num(m.active), 'Patients en file active', `${arrow} vs mois précédent (${num(m.mouv.previous)})`)}
            ${card(num(inflow(m)), 'Entrées du mois', `${num(m.mouv.nouvelles)} inclusions · ${num(m.mouv.transfertsIn)} transferts in · ${num(m.mouv.retours)} retours`)}
            ${card(num(exits(m)), 'Sorties du mois', `${num(m.mouv.transfertsOut)} transferts out · ${num(m.mouv.deces)} décès · ${num(m.mouv.arrets)} arrêts · ${num(m.mouv.perdus)} perdus de vue`)}
            ${card(pct(m.mmd, m.dureeConnue), 'Dispensation de 3 mois et plus', `${num(m.mmd)} patients sur ${num(m.dureeConnue)} (durée connue)`)}
            ${card(pct(m.dtg, m.regimeConnu), 'Régimes à base de DTG', `${num(m.dtg)} patients sur ${num(m.regimeConnu)} (régime connu)`)}
            ${card(pct(m.stable, m.stableConnu), 'Patients stables', m.stableConnu ? `${num(m.stable)} patients sur ${num(m.stableConnu)} (statut connu)` : 'Statut de stabilité non renseigné')}
            ${card(num(m.retard.ge28), 'Retards de rendez-vous ≥ 28 jours', `${num(m.retard.de1a27)} autres patients en retard de 1 à 27 jours`)}
            ${card(pct(m.rdv.servis, m.rdv.dus), 'Rendez-vous honorés dans le mois', `${num(m.rdv.servis)} servis sur ${num(m.rdv.dus)} attendus`)}
        </div><p class="muted">Co-infection TB/VIH : ${num(m.tbvih)} patient(s) en file active · Patients connus : ${num(m.known)}, dont ${num(m.active)} actifs.</p></section>`;
    }

    function pyramid(cur) {
        const m = cur.metrics, bands = state.data.bands, n = bands.length;
        const rows = bands.map((label, i) => ({ label, m: m.ageSex[i][0], f: m.ageSex[i][1], nr: m.ageSex[i][2] })).reverse();
        const max = Math.max(1, ...rows.map((r) => Math.max(r.m, r.f)));
        const missing = m.ageSex[n];
        const line = (r) => `<div class="pyr-row"><span class="pyr-n">${num(r.m)}</span><span class="pyr-bar pyr-m"><i style="width:${width(r.m, max)}%"></i></span><span class="pyr-l">${esc(r.label)}</span><span class="pyr-bar pyr-f"><i style="width:${width(r.f, max)}%"></i></span><span class="pyr-n">${num(r.f)}</span><span class="pyr-t">${num(r.m + r.f + r.nr)}</span></div>`;
        const groups = AGE_GROUPS.map(([label, a, b]) => [label, bandRange(m, a, b)]).concat([['Âge non renseigné', total(missing)]]);
        return `<section class="dash-section" id="dash-sec-age" aria-labelledby="h-age"><h3 id="h-age">Âge et sexe</h3>
            <p class="muted">Tous les patients en file active sont répartis par tranche d’âge, de moins d’un an à 65 ans et plus.</p>
            <div class="pyramid">
                <div class="pyr-row pyr-head"><span class="pyr-n">Masculin</span><span class="pyr-bar"></span><span class="pyr-l">Âge</span><span class="pyr-bar"></span><span class="pyr-n">Féminin</span><span class="pyr-t">Total</span></div>
                ${rows.map(line).join('')}
                ${line({ label: 'Non renseigné', m: missing[0], f: missing[1], nr: missing[2] })}
                <div class="pyr-row pyr-foot"><span class="pyr-n">${num(m.sex.M)}</span><span class="pyr-bar"></span><span class="pyr-l">Total</span><span class="pyr-bar"></span><span class="pyr-n">${num(m.sex.F)}</span><span class="pyr-t">${num(m.active)}</span></div>
            </div>
            ${m.sex.NR ? `<p class="muted">${num(m.sex.NR)} patient(s) sans sexe renseigné sont inclus dans les totaux par tranche d’âge.</p>` : ''}
            <div class="chips">${groups.map(([label, v]) => `<span class="chip"><b>${num(v)}</b> ${esc(label)} <small>${pct(v, m.active)}</small></span>`).join('')}</div>
        </section>`;
    }

    function dist(title, dict, opts = {}) {
        let list = Object.entries(dict || {}), sumAll = sum(list.map((e) => e[1]));
        if (opts.order) list.sort((a, b) => opts.order.indexOf(a[0]) - opts.order.indexOf(b[0]));
        else list.sort((a, b) => b[1] - a[1]);
        if (opts.limit && list.length > opts.limit) { const rest = sum(list.slice(opts.limit).map((e) => e[1])); list = list.slice(0, opts.limit).concat([['Autres', rest]]); }
        const label = opts.label || ((k) => k), max = Math.max(1, ...list.map((e) => e[1]));
        return `<div class="dist"><h4>${esc(title)}</h4>${list.length ? list.map(([k, v]) => `<div class="dist-row"><span class="dist-l">${esc(label(k))}</span><span class="dist-bar"><i style="width:${width(v, max)}%"></i></span><span class="dist-n">${num(v)} <small>${pct(v, sumAll)}</small></span></div>`).join('') : '<p class="muted">Aucune donnée.</p>'}</div>`;
    }

    function treatment(cur) {
        const m = cur.metrics;
        return `<section class="dash-section" id="dash-sec-treatment" aria-labelledby="h-treat"><h3 id="h-treat">Traitement</h3><div class="dist-grid">
            ${dist('Régime ARV', m.regimes, { limit: 8 })}
            ${dist('Ligne thérapeutique', m.lignes, { label: lineLabel })}
            ${dist('Type de VIH', m.typesVih)}
            ${dist('Durée de dispensation', m.durees, { order: state.data.durations })}
        </div><p class="muted">Durée arrondie au mois le plus proche (30 jours = 1 mois).</p></section>`;
    }

    function evolution(cur) {
        const trend = cur.trend, max = Math.max(1, ...trend.map((t) => t.active)), m = cur.metrics;
        const entered = (t) => (t.saisi !== undefined ? t.saisi : t.saisies > 0);
        const chart = `<div class="trend" role="img" aria-label="Évolution de la file active sur ${trend.length} mois">${trend.map((t) => `<div class="trend-col${entered(t) ? '' : ' trend-empty'}"><span class="trend-v">${num(t.active)}</span><div class="trend-bar"><i style="height:${Math.max(2, width(t.active, max))}%"></i></div><span class="trend-l">${SHORT[t.mois - 1]} ${String(t.annee).slice(2)}</span></div>`).join('')}</div>`;
        const table = `<div class="table-scroll"><table class="public-table"><thead><tr><th scope="col">Mois</th><th scope="col">File active</th><th scope="col">Variation</th><th scope="col">Nouvelles inclusions</th><th scope="col">Sorties</th><th scope="col">Saisie</th></tr></thead><tbody>${trend.map((t, i) => { const dv = i ? t.active - trend[i - 1].active : null; return `<tr><th scope="row">${SHORT[t.mois - 1]} ${t.annee}</th><td>${num(t.active)}</td><td>${dv === null ? '—' : (dv > 0 ? '+' : dv < 0 ? '−' : '') + num(Math.abs(dv))}</td><td>${num(t.nouvelles)}</td><td>${num(t.sorties)}</td><td>${entered(t) ? (t.saisies !== undefined ? `${t.saisies} structure(s)` : 'Oui') : '<span class="muted">Non</span>'}</td></tr>`; }).join('')}</tbody></table></div>`;
        const mv = m.mouv, expected = mv.previous + inflow(m) - exits(m), gap = m.active - expected;
        const flow = `<div class="table-scroll"><table class="public-table"><caption>Mouvements de la file active — ${esc(periodLabel())}</caption><thead><tr><th scope="col">Mouvement</th><th scope="col">Patients</th></tr></thead><tbody>
            <tr><th scope="row">File active du mois précédent</th><td>${num(mv.previous)}</td></tr>
            <tr><th scope="row">+ Nouvelles inclusions</th><td>${num(mv.nouvelles)}</td></tr>
            <tr><th scope="row">+ Transferts in</th><td>${num(mv.transfertsIn)}</td></tr>
            <tr><th scope="row">+ Retours dans les soins</th><td>${num(mv.retours)}</td></tr>
            <tr><th scope="row">− Transferts out</th><td>${num(mv.transfertsOut)}</td></tr>
            <tr><th scope="row">− Décès</th><td>${num(mv.deces)}</td></tr>
            <tr><th scope="row">− Arrêts de traitement</th><td>${num(mv.arrets)}</td></tr>
            <tr><th scope="row">− Perdus de vue</th><td>${num(mv.perdus)}</td></tr>
            <tr class="clinical-total"><th scope="row">= File active du mois</th><td>${num(m.active)}</td></tr></tbody></table></div>
            <p class="muted">${gap === 0 ? 'Les mouvements expliquent exactement la variation de la file active.' : `Écart de ${gap > 0 ? '+' : '−'}${num(Math.abs(gap))} patient(s) entre les mouvements enregistrés et la file active : des fiches sont à vérifier.`}</p>`;
        return `<section class="dash-section" id="dash-sec-trend" aria-labelledby="h-trend"><h3 id="h-trend">Évolution et mouvements</h3><div class="two-col"><div><h4>File active sur ${trend.length} mois</h4>${chart}${table}</div><div><h4>Bilan du mois</h4>${flow}</div></div></section>`;
    }

    // ----- comparaison des localités (district) -----
    function localityColumns() {
        const bands = state.data.bands;
        const cols = [
            { k: 'nom', l: 'Structure', text: true, get: (s) => s.nom, fmt: (s) => esc(s.nom) },
            { k: 'rapport', l: 'File active saisie', get: (s) => ({ VALIDE: 2, BROUILLON: 1 }[s.status] || 0), fmt: (s) => clinicalPill(s.status) },
            { k: 'active', l: 'File active', get: (s) => s.metrics.active },
            { k: 'M', l: 'Masculin', get: (s) => s.metrics.sex.M },
            { k: 'F', l: 'Féminin', get: (s) => s.metrics.sex.F }
        ];
        if (state.detail) bands.forEach((b, i) => cols.push({ k: 'b' + i, l: b, get: (s) => total(s.metrics.ageSex[i]) }));
        else AGE_GROUPS.forEach(([l, a, b], j) => cols.push({ k: 'g' + j, l, get: (s) => bandRange(s.metrics, a, b) }));
        cols.push({ k: 'nr', l: 'Âge n. r.', get: (s) => total(s.metrics.ageSex[bands.length]) });
        cols.push(
            { k: 'new', l: 'Nouvelles inclusions', get: (s) => s.metrics.mouv.nouvelles },
            { k: 'out', l: 'Sorties', get: (s) => exits(s.metrics) },
            { k: 'mmd', l: '≥ 3 mois d’ARV', get: (s) => (s.metrics.dureeConnue ? s.metrics.mmd / s.metrics.dureeConnue : -1), fmt: (s) => pct(s.metrics.mmd, s.metrics.dureeConnue) },
            { k: 'dtg', l: 'Régime DTG', get: (s) => (s.metrics.regimeConnu ? s.metrics.dtg / s.metrics.regimeConnu : -1), fmt: (s) => pct(s.metrics.dtg, s.metrics.regimeConnu) },
            { k: 'late', l: 'Retards ≥ 28 j', get: (s) => s.metrics.retard.ge28 }
        );
        return cols;
    }

    function localities() {
        const d = state.data, cols = localityColumns(), linked = d.structures.filter((s) => s.rattachee), unlinked = d.structures.filter((s) => !s.rattachee);
        const { key, dir } = state.sort, col = cols.find((c) => c.k === key) || cols[2], q = state.query.toLocaleLowerCase('fr');
        const sorted = linked.filter((s) => s.nom.toLocaleLowerCase('fr').includes(q)).sort((a, b) => {
            const x = col.get(a), y = col.get(b);
            return (col.text ? String(x).localeCompare(String(y), 'fr') : x - y) * dir || a.nom.localeCompare(b.nom, 'fr');
        });
        const cell = (c, s) => `<td>${c.fmt ? c.fmt(s) : num(c.get(s))}</td>`;
        const head = cols.map((c) => `<th scope="col" aria-sort="${c.k === col.k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-sort" data-sort="${c.k}">${esc(c.l)}${c.k === col.k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
        const rows = sorted.map((s) => `<tr class="${s.code_dhis2 === state.code ? 'row-selected' : ''}">${cols.map((c, i) => (i === 0 ? `<th scope="row">${esc(s.nom)}</th>` : cell(c, s))).join('')}<td><button type="button" data-scope="${esc(s.code_dhis2)}">Voir</button></td></tr>`).join('');
        const totalRow = { nom: 'District (combiné)', status: '', metrics: d.combined.metrics };
        const foot = `<tr class="clinical-total"><th scope="row">District (combiné)</th>${cols.slice(1).map((c) => (c.k === 'rapport' ? '<td></td>' : cell(c, totalRow))).join('')}<td></td></tr>`;
        return `<section class="dash-section" id="dash-sec-places" aria-labelledby="h-places"><div class="section-heading"><div><h3 id="h-places">Comparaison des localités</h3><p>${esc(periodLabel())} · ${linked.length} structure(s) rattachée(s). Cliquez sur un titre de colonne pour trier.</p></div><label>Rechercher une structure<input id="dash-search" type="search" value="${esc(state.query)}" placeholder="Nom de l’ESPC"></label></div>
            <label class="inline-check"><input type="checkbox" id="dash-detail" ${state.detail ? 'checked' : ''}> Détail par tranche d’âge de 5 ans</label>
            <div class="table-scroll"><table class="public-table locality-table"><thead><tr>${head}<th scope="col">Détail</th></tr></thead><tbody>${rows || `<tr><td colspan="${cols.length + 1}">Aucune structure ne correspond.</td></tr>`}</tbody><tfoot>${foot}</tfoot></table></div>
            ${unlinked.length ? `<p class="muted">Sans code DHIS2, donc absentes de ce tableau : ${esc(names(unlinked))}.</p>` : ''}</section>`;
    }

    function tracking() {
        const t = state.tracking;
        let body;
        if (!t) body = `<p role="alert" class="portal-error">${esc(state.trackingError || 'Suivi indisponible.')}</p>`;
        else {
            const c = trackingCounts(), admin = actor.role === 'ADMIN';
            body = `<div class="section-heading"><div><h3 id="h-track">Suivi du rapportage</h3><p>${MONTHS[t.mois - 1]} ${t.annee} · ${c.ok} rapport(s) validé(s) sur ${c.cells} attendus · ${c.clinicalOk} file(s) active(s) validée(s) sur ${c.structures}.</p></div></div>
            <div class="table-scroll"><table class="public-table"><thead><tr><th scope="col">Structure</th><th scope="col">File active</th>${t.families.map((f) => `<th scope="col">${esc(f.nom_famille)}</th>`).join('')}<th scope="col">Accès</th></tr></thead><tbody>${t.structures.map((s) => `<tr><th scope="row">${esc(s.nom_entite)}</th><td>${s.code_dhis2 ? clinicalPill(c.clinical.get(s.code_dhis2)) : '<span class="muted">Non rattachée</span>'}</td>${t.families.map((f) => `<td>${badge(c.reports.get(s.id + ':' + f.id))}</td>`).join('')}<td><button type="button" data-open="${s.id}">${admin ? 'Ouvrir' : 'Mes rapports'}</button></td></tr>`).join('')}</tbody></table></div>`;
        }
        return `<section class="dash-section" id="dash-sec-track" aria-labelledby="h-track">${t ? '' : '<h3 id="h-track">Suivi du rapportage</h3>'}${body}</section>`;
    }

    // ---------- rendu ----------
    function render() {
        const d = state.data, cur = current(), admin = actor.role === 'ADMIN';
        if (!d.structures.some((s) => s.rattachee)) {
            $('dash-result').innerHTML = shortcuts() + `<p class="muted">${admin ? 'Aucune structure n’est rattachée à un code DHIS2 : la file active n’est pas encore disponible.' : 'Votre structure n’est pas encore rattachée à un code DHIS2. Contactez le district pour activer la file active.'}</p>` + tracking();
            bind();
            return;
        }
        const scopeLabel = state.code ? cur.item.nom : 'Tout le district (combiné)';
        const nav = [['access', 'Accès aux rapports'], ['alerts', 'Points d’attention'], ['kpi', 'File active'], ['age', 'Âge et sexe'], ['treatment', 'Traitement'], ['trend', 'Évolution']].concat(admin ? [['places', 'Localités']] : []).concat([['track', 'Rapportage']]);
        $('dash-result').innerHTML = `<div class="dash-context"><p class="eyebrow">PVVIH SOUS ARV</p><h2>${esc(scopeLabel)}</h2><p>${esc(periodLabel())}${state.code ? '' : ` · ${d.structures.filter((s) => s.rattachee).length} structure(s) combinées`}</p></div>
            <nav class="dash-anchors" aria-label="Sections du tableau de bord">${nav.map(([k, l]) => `<a href="#dash-sec-${k}">${esc(l)}</a>`).join('')}</nav>
            ${shortcuts()}${alerts(cur)}${kpis(cur)}${pyramid(cur)}${treatment(cur)}${evolution(cur)}${admin ? localities() : ''}${tracking()}`;
        bind();
    }

    function bind() {
        const root = $('dash-result');
        root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
        root.querySelectorAll('[data-scope]').forEach((b) => (b.onclick = () => { state.code = b.dataset.scope; $('dash-scope').value = state.code; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
        root.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { const k = b.dataset.sort; state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'nom' ? 1 : -1 }; refreshPlaces(`[data-sort="${k}"]`); }));
        root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => (actor.role === 'ADMIN' ? window.showDistrictHome({ view: 'rapports', keepEspcId: b.dataset.open }) : window.showHome())));
        const detail = $('dash-detail');
        if (detail) detail.onchange = () => { state.detail = detail.checked; refreshPlaces('#dash-detail'); };
        const search = $('dash-search');
        if (search) search.oninput = () => { state.query = search.value; const pos = search.selectionStart; refreshPlaces('#dash-search'); const again = $('dash-search'); if (again) again.setSelectionRange(pos, pos); };
    }

    function refreshPlaces(focusSelector) {
        const section = $('dash-sec-places');
        if (!section) return;
        section.outerHTML = localities();
        bind();
        const el = focusSelector && document.querySelector(focusSelector);
        if (el) el.focus();
    }

    function go(target) {
        const admin = actor.role === 'ADMIN';
        if (target === 'clinical') return window.clinicalHome(actor, activePeriod.m, activePeriod.y);
        if (!admin) return window.showHome();
        const view = { suivi: undefined, rapports: 'rapports', bilan: 'bilan', livraisons: 'livraisons', period: 'period', passwords: 'passwords' }[target];
        return window.showDistrictHome(view ? { view } : {});
    }

    window.dashboardHome = async (user, m, y) => {
        actor = user;
        activePeriod = { m, y };
        fillPeriod(m, y);
        $('dash-period').onchange = load;
        $('dash-refresh').onclick = load;
        $('dash-scope').onchange = (e) => { state.code = e.target.value; if (state.data) render(); };
        $('dash-print').onclick = () => window.printDashboard && window.printDashboard();
        await load();
    };
})();
