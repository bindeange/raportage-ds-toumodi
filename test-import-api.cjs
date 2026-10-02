// Test d'intégration des routes d'import en lot, avec une base simulée en mémoire (y compris les transactions).
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const importer = require('./clinical-import');

const entites = [
    { id: 1, nom_entite: 'DISTRICT', role: 'ADMIN', code_structure: 'DS', code_dhis2: null, mot_de_passe: 'admin-secret' },
    { id: 2, nom_entite: 'ESPC A', role: 'USER', code_structure: 'A', code_dhis2: 'DA', mot_de_passe: 'pw-a' },
    { id: 3, nom_entite: 'ESPC B', role: 'USER', code_structure: 'B', code_dhis2: 'DB', mot_de_passe: 'pw-b' }
];
const params = [{ cle: 'mois_actif', valeur: '9' }, { cle: 'annee_active', valeur: '2026' }];
const OPTIONS = {
    sexe: [{ value: 'F', active: true }, { value: 'M', active: true }],
    type_vih: [{ value: 'VIH1', active: true }, { value: 'VIH2', active: true }],
    ligne_therapeutique: [{ value: '1', active: true }, { value: '2', active: true }, { value: '3', active: true }],
    regime: [{ value: 'TDF/3TC/DTG', active: true }, { value: 'ABC/3TC/ATV-r', active: true }],
    stable: [{ value: 'Oui', active: true }, { value: 'Non', active: true }]
};
const basePatient = (code, o = {}) => ({ patient_code: code, sexe: 'F', age: '30', poids: '55', type_vih: 'VIH1', ligne_therapeutique: '1', regime: 'TDF/3TC/DTG', derniere_dispensation: '2026-08-10', jours_dispenses: '90', stable: 'Oui', file_active: '1', nouvelle_inclusion: '0', transfert_in: '0', retour_soins: '0', transfert_out: '0', deces: '0', arret_tarv: '0', ...o });
let clinicalReports;

function makeQuery() {
    return async (sql, p = []) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q) || /pg_advisory_xact_lock/.test(q)) return { rows: [] };
        if (/FROM entites WHERE id=\$1/.test(q)) { const e = entites.find((x) => x.id === p[0]); return { rows: e ? [q.startsWith('SELECT *') ? e : { id: e.id, nom_entite: e.nom_entite, role: e.role, code_structure: e.code_structure, code_dhis2: e.code_dhis2 }] : [] }; }
        if (/FROM entites WHERE code_dhis2=\$1 AND role='USER'/.test(q)) { const e = entites.find((x) => x.code_dhis2 === p[0] && x.role === 'USER'); return { rows: e ? [{ id: e.id, nom_entite: e.nom_entite, role: e.role, code_structure: e.code_structure, code_dhis2: e.code_dhis2 }] : [] }; }
        if (/SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE role='USER'/.test(q)) return { rows: entites.filter((e) => e.role === 'USER').map(({ id, nom_entite, role, code_structure, code_dhis2 }) => ({ id, nom_entite, role, code_structure, code_dhis2 })) };
        if (/SELECT id,nom_entite,role FROM entites WHERE role IN/.test(q)) return { rows: entites.map(({ id, nom_entite, role }) => ({ id, nom_entite, role })) };
        if (/cle='mot_de_passe_global'/.test(q)) return { rows: [] };
        if (/FROM parametres WHERE cle IN/.test(q)) return { rows: params };
        if (/FROM familles/.test(q)) return { rows: [] };
        if (/SELECT payload FROM clinical_options WHERE id=1/.test(q)) return { rows: [{ payload: OPTIONS }] };
        if (/SELECT \* FROM clinical_reports WHERE code_dhis2=\$1 AND \(annee</.test(q)) { const [code, y, m] = p; return { rows: clinicalReports.filter((r) => r.code_dhis2 === code && (r.annee < y || (r.annee === y && r.mois <= m))).sort((a, b) => a.annee - b.annee || a.mois - b.mois) }; }
        if (/INSERT INTO clinical_reports/.test(q)) { const [code, m, y, rows_json, summary_json, status] = p; let rec = clinicalReports.find((r) => r.code_dhis2 === code && r.mois === m && r.annee === y); if (!rec) { rec = { code_dhis2: code, mois: m, annee: y, revision: 0 }; clinicalReports.push(rec); } rec.rows_json = JSON.parse(rows_json); rec.summary_json = summary_json; rec.status = status; rec.revision = (rec.revision || 0) + 1; return { rows: [{ revision: rec.revision }] }; }
        return { rows: [{ name: null }] };
    };
}
const fakePool = { query: makeQuery(), connect: async () => ({ query: makeQuery(), release() {} }) };

let server, base;
test.before(async () => {
    process.env.SESSION_SECRET = 'import-test-secret-import-test-secret';
    const app = express();
    app.set('trust proxy', 1);
    app.use(['/api/clinical/import'], express.json({ limit: '10mb' }));
    app.use(express.json({ limit: '1mb' }));
    const inst = require('./clinical-api')(app, fakePool, 'postgres://u:p@localhost:5432/db', []);
    await inst.ready;
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());
test.beforeEach(() => { clinicalReports = [{ code_dhis2: 'DA', mois: 8, annee: 2026, status: 'VALIDE', revision: 3, rows_json: [basePatient('P1', { poids: '50' })] }]; });

const call = async (path, { token, body, method } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
};
const login = async (id, password) => (await call('/api/clinical/login', { body: { id, password } })).json;
const download = async (path, token) => { const r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } }); return { status: r.status, buffer: r.ok ? Buffer.from(await r.arrayBuffer()) : null, json: r.ok ? null : await r.json().catch(() => ({})) }; };

async function buildUploadRows(rows) {
    const buf = await importer.buildWorkbook({ structure: { code_dhis2: 'DA', nom_entite: 'ESPC A' }, mois: 9, annee: 2026, mode: 'export', rows });
    return buf.toString('base64');
}

test('Modèle et export : fichiers xlsx valides, scope refusé pour une autre structure', async () => {
    const a = await login(2, 'pw-a'), b = await login(3, 'pw-b');
    const tpl = await download(`/api/clinical/import/template?code_dhis2=DA&mois=9&annee=2026`, a.token);
    assert.equal(tpl.status, 200);
    const tplParsed = await importer.parseWorkbook(tpl.buffer);
    assert.equal(tplParsed.rows.length, 1); // la ligne d'exemple
    const exp = await download(`/api/clinical/import/export?code_dhis2=DA&mois=8&annee=2026`, a.token);
    assert.equal(exp.status, 200);
    const expParsed = await importer.parseWorkbook(exp.buffer);
    assert.equal(expParsed.rows[0].raw.patient_code, 'P1');
    assert.equal((await download(`/api/clinical/import/template?code_dhis2=DA&mois=9&annee=2026`, b.token)).status, 403);
});

test('Aperçu (commit=false) : renouvellement valide, nouvelle inclusion valide, fiche incomplète et doublon en erreur — rien n’est écrit', async () => {
    const a = await login(2, 'pw-a');
    const file_base64 = await buildUploadRows([
        basePatient('P1', { derniere_dispensation: '2026-09-05', jours_dispenses: '90', poids: '62' }), // renouvellement
        basePatient('P2', { nouvelle_inclusion: '1', derniere_dispensation: '2026-09-03', jours_dispenses: '30' }), // nouvelle inclusion complète
        { patient_code: 'P3', sexe: 'F', age: '20', type_vih: 'VIH1', ligne_therapeutique: '1', regime: 'TDF/3TC/DTG', derniere_dispensation: '2026-09-03', jours_dispenses: '30' }, // nouvelle inclusion : poids manquant
        basePatient('P1', { derniere_dispensation: '2026-09-06' }) // doublon du code P1 dans le fichier
    ]);
    const res = await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: false, file_base64 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 4);
    assert.equal(res.json.valid, 2);
    assert.equal(res.json.errors.length, 2);
    assert.ok(res.json.errors.some((e) => e.code === 'P3' && /Poids/.test(e.reason)));
    assert.ok(res.json.errors.some((e) => e.code === 'P1' && /double/.test(e.reason)));
    assert.equal(clinicalReports.length, 1); // aucune écriture en mode aperçu
});

test('Import réel : met à jour le patient existant, ajoute la nouvelle inclusion, ignore les lignes en erreur', async () => {
    const a = await login(2, 'pw-a');
    const file_base64 = await buildUploadRows([
        basePatient('P1', { derniere_dispensation: '2026-09-05', jours_dispenses: '90', poids: '62' }),
        basePatient('P2', { nouvelle_inclusion: '1', derniere_dispensation: '2026-09-03', jours_dispenses: '30' }),
        { patient_code: 'P3', sexe: 'F', derniere_dispensation: '2026-09-03', jours_dispenses: '30' }
    ]);
    const res = await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: true, file_base64 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.imported, 2);
    assert.equal(res.json.skipped, 1);
    const sept = clinicalReports.find((r) => r.code_dhis2 === 'DA' && r.mois === 9);
    assert.equal(sept.status, 'BROUILLON');
    assert.equal(sept.revision, 1);
    const p1 = sept.rows_json.find((r) => r.patient_code === 'P1'), p2 = sept.rows_json.find((r) => r.patient_code === 'P2');
    assert.equal(p1.poids, '62'); assert.equal(p1.derniere_dispensation, '2026-09-05'); assert.equal(p1.nouvelle_inclusion, '0'); // patient déjà connu : pas une nouvelle inclusion
    assert.equal(p2.nouvelle_inclusion, '1'); assert.equal(p2.file_active, '1');
    assert.equal(sept.rows_json.length, 2);
});

test('Conflit de révision : un import concurrent est refusé (409), rien n’est écrit deux fois', async () => {
    const a = await login(2, 'pw-a');
    const file_base64 = await buildUploadRows([basePatient('P9', { nouvelle_inclusion: '1', derniere_dispensation: '2026-09-03', jours_dispenses: '30' })]);
    const first = await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: true, file_base64 } });
    assert.equal(first.status, 200);
    const second = await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: true, file_base64 } });
    assert.equal(second.status, 409);
    assert.equal(clinicalReports.find((r) => r.mois === 9).revision, 1);
});

test('Une structure ne peut pas importer pour une autre ; le district le peut pour chacune', async () => {
    const b = await login(3, 'pw-b');
    const file_base64 = await buildUploadRows([basePatient('X1', { nouvelle_inclusion: '1', derniere_dispensation: '2026-09-03', jours_dispenses: '30' })]);
    const refused = await call('/api/clinical/import', { token: b.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: true, file_base64 } });
    assert.equal(refused.status, 403);
    const admin = await login(1, 'admin-secret');
    const ok = await call('/api/clinical/import', { token: admin.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: true, file_base64 } });
    assert.equal(ok.status, 200);
});

test('Fichier manquant, vide ou sans colonne CODE IDENTIFIANT : erreur claire, rien n’est écrit', async () => {
    const a = await login(2, 'pw-a');
    assert.equal((await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: false, file_base64: '' } })).status, 400);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); wb.addWorksheet('Patients').addRow(['SEXE']);
    const bad = (await wb.xlsx.writeBuffer()).toString('base64');
    const res = await call('/api/clinical/import', { token: a.token, body: { code_dhis2: 'DA', mois: 9, annee: 2026, revision: 0, commit: false, file_base64: bad } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /CODE IDENTIFIANT/);
    assert.equal(clinicalReports.length, 1);
});
