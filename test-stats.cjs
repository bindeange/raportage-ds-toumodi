const test = require('node:test'), assert = require('node:assert/strict');
const S = require('./clinical-stats');

const p = (code, o = {}) => ({
    patient_code: code, sexe: 'F', age: '30', poids: '60', type_vih: 'VIH1', ligne_therapeutique: '1',
    regime: 'TDF/3TC/DTG', derniere_dispensation: '2026-08-10', jours_dispenses: '90', file_active: '1',
    nouvelle_inclusion: '0', transfert_in: '0', retour_soins: '0', transfert_out: '0', deces: '0', arret_tarv: '0', perdu_vue: '0',
    stable: 'Oui', ...o
});
const rep = (code, mois, annee, rows, status = 'VALIDE') => ({ code_dhis2: code, mois, annee, rows_json: rows, status });
const NOW = new Date('2026-09-20T10:00:00Z');

// Structure A : août puis septembre. Structure B : septembre seulement, avec des codes patients identiques à ceux de A.
const reports = [
    rep('A', 8, 2026, [
        p('A1', { age: '0.5', sexe: 'M', jours_dispenses: '30', regime: 'ABC/3TC/LPV-r', ligne_therapeutique: '2', nouvelle_inclusion: '1', derniere_dispensation: '2026-08-05' }),
        p('A2', { age: '8', sexe: 'F', jours_dispenses: '60', regime: 'ABC/3TC/DTG', tb_vih: '1' }),
        p('A3', { age: '34', sexe: 'F', jours_dispenses: '30', derniere_dispensation: '2026-08-20' }),
        p('A4', { age: '70', sexe: 'M' }),
        p('A5', { age: '', sexe: 'H' }),
        p('A6', { age: '45', sexe: 'F', derniere_dispensation: '2026-05-01', jours_dispenses: '30' })
    ]),
    rep('A', 9, 2026, [
        p('A3', { age: '34', derniere_dispensation: '2026-09-02', jours_dispenses: '90' }),
        p('A4', { age: '70', sexe: 'M', deces: '1' }),
        p('A7', { age: '15', sexe: 'M', nouvelle_inclusion: '1', derniere_dispensation: '2026-09-03', jours_dispenses: '30' }),
        p('A8', { age: '52', sexe: '', transfert_in: '1', derniere_dispensation: '2026-09-04', regime: 'TDF/3TC/EFV', stable: 'Non' })
    ], 'BROUILLON'),
    rep('B', 9, 2026, [
        p('A1', { age: '19', sexe: 'F', nouvelle_inclusion: '1', derniere_dispensation: '2026-09-01', jours_dispenses: '30' }),
        p('A2', { age: '66', sexe: 'M', derniere_dispensation: '2026-09-01', jours_dispenses: '180' })
    ])
];
const structures = [
    { id: 1, nom_entite: 'ESPC A', code_dhis2: 'A' },
    { id: 2, nom_entite: 'ESPC B', code_dhis2: 'B' },
    { id: 3, nom_entite: 'ESPC C', code_dhis2: 'C' },
    { id: 4, nom_entite: 'ESPC D', code_dhis2: null }
];
const data = S.build({ structures, reports, m: 9, y: 2026, now: NOW });
const get = (code) => data.structures.find((s) => s.code_dhis2 === code);
const sum = (rows) => rows.flat().reduce((a, b) => a + b, 0);

test('Chaque structure est comptée séparément et le district est leur somme', () => {
    assert.equal(get('A').metrics.active, 7);     // A1 A2 A3 A5 A6 A7 A8 (A4 décédé)
    assert.equal(get('A').metrics.known, 8);
    assert.equal(get('B').metrics.active, 2);     // mêmes codes que A mais autre structure : pas de fusion
    assert.equal(get('C').metrics.active, 0);
    assert.equal(data.combined.metrics.active, 9);
    assert.equal(sum(data.combined.metrics.ageSex), 9);
    assert.equal(data.combined.metrics.sex.M + data.combined.metrics.sex.F + data.combined.metrics.sex.NR, 9);
});

test('Les âges couvrent toute la population, sans seuil unique à 15 ans', () => {
    const m = get('A').metrics, bands = data.bands, at = (label) => m.ageSex[bands.indexOf(label)];
    assert.deepEqual(at('<1 an'), [1, 0, 0]);          // A1 : 6 mois
    assert.deepEqual(at('5–9 ans'), [0, 1, 0]);        // A2
    assert.deepEqual(at('15–19 ans'), [1, 0, 0]);      // A7 : 15 ans
    assert.deepEqual(at('30–34 ans'), [0, 1, 0]);      // A3
    assert.deepEqual(at('45–49 ans'), [0, 1, 0]);      // A6
    assert.deepEqual(at('50–54 ans'), [0, 0, 1]);      // A8 : sexe manquant
    assert.deepEqual(m.ageSex[bands.length], [1, 0, 0]); // A5 : âge manquant, sexe « H » compté masculin
    assert.equal(sum(m.ageSex), m.active);
    assert.equal(m.qualite.sansAge, 1);
    assert.equal(m.qualite.sansSexe, 1);
    assert.deepEqual(get('B').metrics.ageSex[bands.indexOf('65 ans et +')], [1, 0, 0]);
    assert.deepEqual(get('B').metrics.ageSex[bands.indexOf('15–19 ans')], [0, 1, 0]);
});

test('Durées de dispensation, DMM, DTG, stabilité et TB/VIH', () => {
    const m = get('A').metrics;
    assert.deepEqual(m.durees, { '1 mois': 3, '2 mois': 1, '3 mois': 3 });
    assert.equal(m.dureeConnue, 7);
    assert.equal(m.mmd, 3);
    assert.equal(m.dtg, 5);              // tous sauf A1 (LPV/r) et A8 (EFV)
    assert.equal(m.regimeConnu, 7);
    assert.equal(m.stable, 6);
    assert.equal(m.stableConnu, 7);
    assert.equal(m.tbvih, 1);
    assert.equal(S.months(44), 1); assert.equal(S.months(45), 2); assert.equal(S.months(90), 3); assert.equal(S.months(195), 7); assert.equal(S.months(0), 0);
    assert.equal(data.combined.metrics.regimes['TDF/3TC/DTG'], 6);
    assert.equal(Object.values(data.combined.metrics.regimes).reduce((a, b) => a + b, 0), 9);
});

test('Retards de rendez-vous : jamais classés « perdus de vue » automatiquement', () => {
    const r = get('A').metrics.retard;
    assert.equal(r.ge28, 1);    // A6 : fin de traitement le 31 mai
    assert.equal(r.de1a27, 1);  // A1 : fin de traitement le 4 septembre, 16 jours de retard au 20 septembre
    assert.equal(r.sansDate, 0);
    assert.equal(get('A').metrics.mouv.perdus, 0);
    assert.equal(get('A').metrics.rdv.dus, 2);
    assert.equal(get('A').metrics.rdv.servis, 1);  // A3 servi le 2 septembre
});

test('Mouvements du mois et contrôle de cohérence', () => {
    const mv = get('A').metrics.mouv;
    assert.deepEqual([mv.previous, mv.nouvelles, mv.transfertsIn, mv.retours, mv.deces], [6, 1, 1, 0, 1]);
    assert.equal(mv.previous + mv.nouvelles + mv.transfertsIn + mv.retours - mv.deces, get('A').metrics.active);
    assert.equal(mv.entreesSansMotif + mv.sortiesSansMotif, 0);
    // B : le patient « A2 » est entré dans la file active sans nouvelle inclusion, transfert ni retour
    assert.equal(get('B').metrics.mouv.entreesSansMotif, 1);
    assert.equal(data.combined.metrics.mouv.entreesSansMotif, 1);
});

test('Évolution sur 6 mois, statuts et structures non rattachées', () => {
    const t = get('A').trend;
    assert.equal(t.length, 6);
    assert.deepEqual(t.map((x) => x.mois), [4, 5, 6, 7, 8, 9]);
    assert.deepEqual(t.map((x) => x.active), [0, 0, 0, 0, 6, 7]);
    assert.deepEqual(t.map((x) => x.saisi), [false, false, false, false, true, true]);
    assert.equal(t[5].nouvelles, 1); assert.equal(t[5].sorties, 1);
    assert.equal(data.combined.trend[5].active, 9);
    assert.equal(data.combined.trend[5].saisies, 2);
    assert.equal(get('A').status, 'BROUILLON');
    assert.equal(get('B').status, 'VALIDE');
    assert.equal(get('C').status, 'NON SAISI');
    assert.equal(get('C').derniere_saisie, null);
    assert.deepEqual(get('A').derniere_saisie, { mois: 9, annee: 2026 });
    const d = data.structures.find((s) => s.nom === 'ESPC D');
    assert.equal(d.rattachee, false);
    assert.equal(d.metrics, undefined);
});

test('Périodes passées : les retards sont jugés à la fin du mois demandé', () => {
    const aug = S.build({ structures: structures.slice(0, 1), reports, m: 8, y: 2026, now: NOW });
    assert.equal(aug.structures[0].metrics.active, 6);
    assert.equal(aug.structures[0].metrics.retard.ge28, 1);
    assert.equal(aug.structures[0].metrics.mouv.nouvelles, 1);
});

test('Aucun code patient ne sort dans la réponse du tableau de bord', () => {
    const json = JSON.stringify(data);
    assert.ok(!json.includes('patient_code'));
    assert.ok(!/"A[1-8]"/.test(json));
});
