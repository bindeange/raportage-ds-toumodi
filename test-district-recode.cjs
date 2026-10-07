// Test d'intégration : vue district combinée, correction de code, perdus de vue / codes en erreur.
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');

const entites = [
    { id: 1, nom_entite: 'DISTRICT', role: 'ADMIN', code_structure: 'DS', code_dhis2: null, mot_de_passe: 'admin-secret' },
    { id: 2, nom_entite: 'ESPC A', role: 'USER', code_structure: 'A', code_dhis2: 'DA', mot_de_passe: 'pw-a' },
    { id: 3, nom_entite: 'ESPC B', role: 'USER', code_structure: 'B', code_dhis2: 'DB', mot_de_passe: 'pw-b' }
];
const params = [{ cle: 'mois_actif', valeur: '9' }, { cle: 'annee_active', valeur: '2026' }];
const TODAY = '2026-09-20';
const p = (code, o = {}) => ({ patient_code: code, sexe: 'F', age: '30', poids: '55', type_vih: 'VIH1', ligne_therapeutique: '1', regime: 'TDF/3TC/DTG', derniere_dispensation: '2026-09-01', jours_dispenses: '90', stable: 'Oui', file_active: '1', nouvelle_inclusion: '0', transfert_in: '0', retour_soins: '0', transfert_out: '0', deces: '0', arret_tarv: '0', perdu_vue: '0', code_ok: '1', ...o });

let clinicalReports;
function makeQuery() {
    return async (sql, params_) => {
        const q = sql.replace(/\s+/g, ' ').trim(), pr = params_ || [];
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q) || /pg_advisory_xact_lock/.test(q)) return { rows: [] };
        if (/FROM entites WHERE id=\$1/.test(q)) { const e = entites.find((x) => x.id === pr[0]); return { rows: e ? [q.startsWith('SELECT *') ? e : { id: e.id, nom_entite: e.nom_entite, role: e.role, code_structure: e.code_structure, code_dhis2: e.code_dhis2 }] : [] }; }
        if (/FROM entites WHERE code_dhis2=\$1 AND role='USER'/.test(q)) { const e = entites.find((x) => x.code_dhis2 === pr[0] && x.role === 'USER'); return { rows: e ? [{ id: e.id, nom_entite: e.nom_entite, role: e.role, code_structure: e.code_structure, code_dhis2: e.code_dhis2 }] : [] }; }
        if (/SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE role='USER'/.test(q)) return { rows: entites.filter((e) => e.role === 'USER').map(({ id, nom_entite, role, code_structure, code_dhis2 }) => ({ id, nom_entite, role, code_structure, code_dhis2 })) };
        if (/SELECT id,nom_entite,role FROM entites WHERE role IN/.test(q)) return { rows: entites.map(({ id, nom_entite, role }) => ({ id, nom_entite, role })) };
        if (/cle='mot_de_passe_global'/.test(q)) return { rows: [] };
        if (/FROM parametres WHERE cle IN/.test(q)) return { rows: params };
        if (/SELECT payload FROM clinical_options WHERE id=1/.test(q)) return { rows: [{ payload: {} }] };
        if (/SELECT \* FROM clinical_reports WHERE code_dhis2=\$1 AND \(annee</.test(q)) { const [code, y, m] = pr; return { rows: clinicalReports.filter((r) => r.code_dhis2 === code && (r.annee < y || (r.annee === y && r.mois <= m))).sort((a, b) => a.annee - b.annee || a.mois - b.mois) }; }
        if (/SELECT mois,annee,rows_json,revision FROM clinical_reports WHERE code_dhis2=\$1/.test(q)) return { rows: clinicalReports.filter((r) => r.code_dhis2 === pr[0]) };
        if (/UPDATE clinical_reports SET rows_json=\$1,revision=revision\+1/.test(q)) { const [rows_json, code, mois, annee] = pr; const rec = clinicalReports.find((r) => r.code_dhis2 === code && r.mois === mois && r.annee === annee); rec.rows_json = JSON.parse(rows_json); rec.revision = (rec.revision || 0) + 1; return { rows: [] }; }
        if (/INSERT INTO clinical_reports/.test(q)) { const [code, m, y, rows_json, summary_json, status] = pr; let rec = clinicalReports.find((r) => r.code_dhis2 === code && r.mois === m && r.annee === y); if (!rec) { rec = { code_dhis2: code, mois: m, annee: y, revision: 0 }; clinicalReports.push(rec); } rec.rows_json = JSON.parse(rows_json); rec.summary_json = summary_json; rec.status = status; rec.revision = (rec.revision || 0) + 1; return { rows: [{ revision: rec.revision }] }; }
        return { rows: [{ name: null }] };
    };
}
const fakePool = { query: makeQuery(), connect: async () => ({ query: makeQuery(), release() {} }) };

let server, base;
test.before(async () => {
    process.env.SESSION_SECRET = 'district-test-secret-district-test-secret';
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '1mb' }));
    const inst = require('./clinical-api')(app, fakePool, 'postgres://u:p@localhost:5432/db', []);
    await inst.ready;
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());
test.beforeEach(() => {
    clinicalReports = [
        { code_dhis2: 'DA', mois: 7, annee: 2026, status: 'VALIDE', revision: 2, rows_json: [p('P1'), p('P2', { deces: '1' }), p('P3', { patient_code: '12345', code_ok: '0' })] },
        { code_dhis2: 'DB', mois: 9, annee: 2026, status: 'VALIDE', revision: 1, rows_json: [p('P1', { regime: 'ABC/3TC/DTG' }), p('P4', { derniere_dispensation: '2026-01-01', jours_dispenses: '30' })] }
    ];
});

const call = async (path, { token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json() };
};
const login = async (id, password) => (await call('/api/clinical/login', { body: { id, password } })).json;

test('Vue district : patients fusionnés par code, dernière structure retenue, historique des lieux', async () => {
    const admin = await login(1, 'admin-secret');
    const r = await call('/api/clinical/view', { token: admin.token, body: { code_dhis2: 'DISTRICT', mois: 9, annee: 2026 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.district, true);
    const p1 = r.json.patients.find((x) => x.patient_code === 'P1');
    assert.equal(p1._structure.code_dhis2, 'DB'); // vu en dernier à B (septembre), après A (juillet)
    assert.deepEqual(p1._location_history.map((h) => h.code_dhis2), ['DA', 'DB']);
    const p2 = r.json.patients.find((x) => x.patient_code === 'P2');
    assert.equal(p2._location_history.length, 1); // jamais changé de structure
    assert.equal(r.json.patients.length, 4); // P1,P2,P3,P4 — jamais fusionnés avec des codes différents
});

test('Vue district : codes en erreur et perdus de vue détectés sur l’ensemble du district', async () => {
    const admin = await login(1, 'admin-secret');
    const r = await call('/api/clinical/view', { token: admin.token, body: { code_dhis2: 'DISTRICT', mois: 9, annee: 2026 } });
    assert.ok(r.json.codes_erreur.some((x) => x.patient_code === '12345'));
    assert.ok(r.json.perdus_de_vue.some((x) => x.patient_code === 'P4'));
    assert.ok(!r.json.perdus_de_vue.some((x) => x.patient_code === 'P2')); // décédé, pas "perdu de vue"
});

test('Vue district réservée au district (403 pour un ESPC)', async () => {
    const a = await login(2, 'pw-a');
    const r = await call('/api/clinical/view', { token: a.token, body: { code_dhis2: 'DISTRICT', mois: 9, annee: 2026 } });
    assert.equal(r.status, 403);
});

test('Vue structure : perdus de vue, codes en erreur, journal AES/MOBILE du mois', async () => {
    const a = await login(2, 'pw-a');
    const r = await call('/api/clinical/view', { token: a.token, body: { code_dhis2: 'DA', mois: 7, annee: 2026 } });
    assert.ok(r.json.codes_erreur.some((x) => x.patient_code === '12345'));
    assert.deepEqual(r.json.specials, []);
});

test('Correction de code (district) : renomme sur tout l’historique de la structure', async () => {
    const admin = await login(1, 'admin-secret');
    const res = await call('/api/clinical/recode', { token: admin.token, body: { code_dhis2: 'DA', old_code: '12345', new_code: '22325/56/78/90123' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.months_updated, 1);
    const rec = clinicalReports.find((r) => r.code_dhis2 === 'DA' && r.mois === 7);
    const row = rec.rows_json.find((r) => r.patient_code === '22325/56/78/90123');
    assert.ok(row); assert.equal(row.code_ok, '1');
    assert.ok(!rec.rows_json.some((r) => r.patient_code === '12345'));
});

test('Correction de code : refusée pour un ESPC, code déjà pris, code introuvable, codes spéciaux', async () => {
    const admin = await login(1, 'admin-secret'), a = await login(2, 'pw-a');
    assert.equal((await call('/api/clinical/recode', { token: a.token, body: { code_dhis2: 'DA', old_code: '12345', new_code: '99999/00/00/00000' } })).status, 403);
    assert.equal((await call('/api/clinical/recode', { token: admin.token, body: { code_dhis2: 'DA', old_code: '12345', new_code: 'P1' } })).status, 409);
    assert.equal((await call('/api/clinical/recode', { token: admin.token, body: { code_dhis2: 'DA', old_code: 'INTROUVABLE', new_code: 'X' } })).status, 404);
    assert.equal((await call('/api/clinical/recode', { token: admin.token, body: { code_dhis2: 'DA', old_code: 'AES', new_code: 'X' } })).status, 400);
    assert.equal((await call('/api/clinical/recode', { token: admin.token, body: { code_dhis2: 'DA', old_code: '12345', new_code: 'MOBILE' } })).status, 400);
});
