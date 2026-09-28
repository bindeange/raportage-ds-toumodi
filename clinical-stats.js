/**
 * Agrégats PVVIH du tableau de bord.
 *
 * - Calcul côté serveur : le navigateur ne reçoit que des effectifs agrégés,
 *   jamais de code patient.
 * - Une structure = un code DHIS2. Le district = somme des structures
 *   (les codes patients peuvent se répéter d'une structure à l'autre : on ne
 *   fusionne donc jamais les patients, seulement les effectifs).
 * - Âges : toutes les personnes sont réparties en tranches (voir clinical-fields.js),
 *   aucun seuil unique n'est imposé. Âge ou sexe manquant = catégorie « non renseigné ».
 */
const model = require('./clinical-model');
const F = require('./clinical-fields');

const truth = F.truth;
const isActive = F.active;
const EXIT_FLAGS = ['deces', 'transfert_out', 'arret_tarv', 'perdu_vue'];
const BANDS = F.ageBandLabels.length; // l'index BANDS = « âge non renseigné »
const LATE_DAYS = 28; // seuil usuel de rupture de suivi (IIT)

const DURATIONS = ['1 mois', '2 mois', '3 mois', '4 mois', '5 mois', '6 mois', '> 6 mois', 'Non renseignée'];

// Durée de dispensation arrondie au mois le plus proche (30 j = 1 mois).
function months(days) {
    const n = Number(days);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 30) : 0;
}
const durationLabel = (mo) => (!mo ? 'Non renseignée' : mo > 6 ? '> 6 mois' : mo + ' mois');

function sexKey(r) {
    const s = String(r.sexe || '').trim().toUpperCase();
    return s === 'F' ? 'F' : s === 'M' || s === 'H' ? 'M' : 'NR';
}

function empty() {
    return {
        active: 0,
        known: 0,
        sex: { M: 0, F: 0, NR: 0 },
        ageSex: Array.from({ length: BANDS + 1 }, () => [0, 0, 0]), // [masculin, féminin, sexe n.r.]
        regimes: {},
        lignes: {},
        typesVih: {},
        durees: {},
        mmd: 0,
        dureeConnue: 0,
        stable: 0,
        stableConnu: 0,
        tbvih: 0,
        dtg: 0,
        regimeConnu: 0,
        mouv: {
            previous: 0, nouvelles: 0, transfertsIn: 0, retours: 0,
            transfertsOut: 0, deces: 0, arrets: 0, perdus: 0,
            entreesSansMotif: 0, sortiesSansMotif: 0
        },
        retard: { ge28: 0, de1a27: 0, sansDate: 0 },
        rdv: { dus: 0, servis: 0 },
        qualite: { fichesMois: 0, incompletes: 0, sansAge: 0, sansSexe: 0 }
    };
}

// Additionne deux structures de métriques (nombres, dictionnaires, tableaux).
function add(target, source) {
    for (const key of Object.keys(source)) {
        const v = source[key];
        if (Array.isArray(v)) {
            if (!target[key]) target[key] = v.map((x) => (Array.isArray(x) ? x.map(() => 0) : 0));
            v.forEach((x, i) => {
                if (Array.isArray(x)) x.forEach((y, j) => { target[key][i][j] += y; });
                else target[key][i] += x;
            });
        } else if (v && typeof v === 'object') {
            if (!target[key]) target[key] = {};
            add(target[key], v);
        } else {
            target[key] = (target[key] || 0) + v;
        }
    }
    return target;
}

const bump = (dict, key, by = 1) => { dict[key] = (dict[key] || 0) + by; };
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);

function structureMetrics(reports, m, y, today) {
    const out = empty();
    const patients = model.snapshot(reports, m, y);
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    const previous = model.snapshot(reports, pm, py);
    const current = reports.find((r) => Number(r.mois) === m && Number(r.annee) === y);
    const monthly = current?.rows_json || [];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const ref = today < monthEnd ? today : monthEnd; // on ne juge pas les retards dans le futur

    out.known = patients.length;
    const prevActive = new Set(previous.filter(isActive).map((r) => String(r.patient_code)));
    const nowActive = new Set();
    const monthlyByCode = new Map(monthly.map((r) => [String(r.patient_code), r]));

    for (const r of patients) {
        if (!isActive(r)) continue;
        const code = String(r.patient_code);
        nowActive.add(code);
        out.active++;

        const sx = sexKey(r);
        const bi = F.ageBandIndex(r.age);
        out.sex[sx]++;
        out.ageSex[bi < 0 ? BANDS : bi][sx === 'M' ? 0 : sx === 'F' ? 1 : 2]++;
        if (bi < 0) out.qualite.sansAge++;
        if (sx === 'NR') out.qualite.sansSexe++;

        const regime = String(r.regime || '').trim();
        bump(out.regimes, regime || 'Non renseigné');
        if (regime) { out.regimeConnu++; if (/DTG/i.test(regime)) out.dtg++; }
        bump(out.lignes, String(r.ligne_therapeutique || '').trim() || 'Non renseignée');
        bump(out.typesVih, String(r.type_vih || '').trim() || 'Non renseigné');

        const mo = months(r.jours_dispenses);
        bump(out.durees, durationLabel(mo));
        if (mo) { out.dureeConnue++; if (mo >= 3) out.mmd++; }

        if (String(r.stable ?? '').trim() !== '') { out.stableConnu++; if (truth(r.stable)) out.stable++; }
        if (truth(r.tb_vih)) out.tbvih++;

        const due = model.due(r);
        if (!due) out.retard.sansDate++;
        else {
            const late = daysBetween(due, ref);
            if (late >= LATE_DAYS) out.retard.ge28++;
            else if (late >= 1) out.retard.de1a27++;
        }
    }

    // Mouvements du mois (mêmes définitions que la synthèse mensuelle : fiches du mois).
    const mv = out.mouv;
    mv.previous = prevActive.size;
    for (const r of monthly) {
        out.qualite.fichesMois++;
        if (model.issues(r, m, y).length) out.qualite.incompletes++;
        if (truth(r.nouvelle_inclusion)) mv.nouvelles++;
        if (truth(r.transfert_in)) mv.transfertsIn++;
        if (truth(r.retour_soins)) mv.retours++;
        if (truth(r.transfert_out)) mv.transfertsOut++;
        if (truth(r.deces)) mv.deces++;
        if (truth(r.arret_tarv)) mv.arrets++;
        if (truth(r.perdu_vue)) mv.perdus++;
    }
    // Contrôle de cohérence : entrée/sortie de la file active sans motif enregistré ce mois-ci.
    for (const code of nowActive) {
        if (prevActive.has(code)) continue;
        const r = monthlyByCode.get(code);
        if (!r || !(truth(r.nouvelle_inclusion) || truth(r.transfert_in) || truth(r.retour_soins))) mv.entreesSansMotif++;
    }
    for (const code of prevActive) {
        if (nowActive.has(code)) continue;
        const r = monthlyByCode.get(code);
        if (!r || !EXIT_FLAGS.some((k) => truth(r[k]))) mv.sortiesSansMotif++;
    }

    const agenda = model.agenda(reports, m, y);
    out.rdv.dus = agenda.length;
    out.rdv.servis = agenda.filter((a) => a.statut === 'Servi').length;
    return out;
}

// Évolution sur n mois se terminant au mois demandé.
function trend(reports, m, y, n = 6) {
    const points = [];
    let mm = m, yy = y;
    for (let i = 0; i < n; i++) {
        const report = reports.find((r) => Number(r.mois) === mm && Number(r.annee) === yy);
        const rows = report?.rows_json || [];
        points.unshift({
            mois: mm,
            annee: yy,
            active: model.snapshot(reports, mm, yy).filter(isActive).length,
            nouvelles: rows.filter((r) => truth(r.nouvelle_inclusion)).length,
            sorties: rows.filter((r) => EXIT_FLAGS.some((k) => truth(r[k]))).length,
            saisi: Boolean(report)
        });
        mm -= 1;
        if (mm === 0) { mm = 12; yy -= 1; }
    }
    return points;
}

function build({ structures, reports, m, y, now = new Date() }) {
    const today = now.toISOString().slice(0, 10);
    const byCode = new Map();
    for (const r of reports) {
        const code = String(r.code_dhis2);
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(r);
    }

    const combined = empty();
    const combinedTrend = [];
    const items = [];
    for (const s of structures) {
        if (!s.code_dhis2) {
            items.push({ id: s.id, nom: s.nom_entite, code_dhis2: null, rattachee: false });
            continue;
        }
        const rs = (byCode.get(String(s.code_dhis2)) || []).sort((a, b) => a.annee - b.annee || a.mois - b.mois);
        const current = rs.find((r) => Number(r.mois) === m && Number(r.annee) === y);
        const last = rs.filter((r) => Number(r.annee) * 100 + Number(r.mois) <= y * 100 + m).pop();
        const metrics = structureMetrics(rs, m, y, today);
        const tr = trend(rs, m, y);
        items.push({
            id: s.id,
            nom: s.nom_entite,
            code_dhis2: String(s.code_dhis2),
            rattachee: true,
            status: current?.status || 'NON SAISI',
            derniere_saisie: last ? { mois: Number(last.mois), annee: Number(last.annee) } : null,
            metrics,
            trend: tr
        });
        add(combined, metrics);
        tr.forEach((p, i) => {
            const c = combinedTrend[i] || (combinedTrend[i] = { mois: p.mois, annee: p.annee, active: 0, nouvelles: 0, sorties: 0, saisies: 0 });
            c.active += p.active; c.nouvelles += p.nouvelles; c.sorties += p.sorties; c.saisies += p.saisi ? 1 : 0;
        });
    }
    return {
        periode: { mois: m, annee: y },
        bands: F.ageBandLabels,
        durations: DURATIONS,
        combined: { metrics: combined, trend: combinedTrend },
        structures: items,
        generated_at: now.toISOString()
    };
}

module.exports = { build, structureMetrics, trend, empty, add, months, LATE_DAYS };
