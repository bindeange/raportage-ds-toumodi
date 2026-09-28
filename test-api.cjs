// Test d'intégration sans base de données : la couche SQL est simulée en mémoire.
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');

const entites = [
    { id: 1, nom_entite: 'DISTRICT', role: 'ADMIN', code_structure: 'DS', code_dhis2: null, mot_de_passe: 'admin-secret' },
    { id: 2, nom_entite: 'ESPC A', role: 'USER', code_structure: 'A', code_dhis2: 'DA', mot_de_passe: 'pw-a' },
    { id: 3, nom_entite: 'ESPC B', role: 'USER', code_structure: 'B', code_dhis2: 'DB', mot_de_passe: 'pw-b' },
    { id: 4, nom_entite: 'ESPC C', role: 'USER', code_structure: 'C', code_dhis2: null, mot_de_passe: 'pw-c' },
    { id: 5, nom_entite: 'ICCM Village', role: 'USER', code_structure: 'ICCM1', code_dhis2: null, mot_de_passe: 'x' }
];
const row = (code, o = {}) => ({ patient_code: code, sexe: 'F', age: '30', regime: 'TDF/3TC/DTG', derniere_dispensation: '2026-09-02', jours_dispenses: '90', file_active: '1', ...o });
const clinical = [
    { code_dhis2: 'DA', mois: 9, annee: 2026, status: 'VALIDE', rows_json: [row('P1'), row('P2', { age: '4' })] },
    { code_dhis2: 'DB', mois: 9, annee: 2026, status: 'BROUILLON', rows_json: [row('P1', { age: '71', sexe: 'M' })] }
];
const params = [{ cle: 'mois_actif', valeur: '9' }, { cle: 'annee_active', valeur: '2026' }];
const publicUsers = entites.filter((e) => e.role === 'USER' && !/ICCM/i.test(e.nom_entite));

const fakePool = {
    async query(sql, p = []) {
        const q = sql.replace(/\s+/g, ' ');
        if (/FROM entites WHERE id=\$1/.test(q)) {
            const e = entites.find((x) => x.id === p[0]);
            return { rows: e ? [q.startsWith('SELECT *') ? e : { id: e.id, nom_entite: e.nom_entite, role: e.role, code_structure: e.code_structure, code_dhis2: e.code_dhis2 }] : [] };
        }
        if (/SELECT id,nom_entite,role FROM entites WHERE role IN/.test(q)) return { rows: entites.filter((e) => !/ICCM/i.test(e.nom_entite)).map(({ id, nom_entite, role }) => ({ id, nom_entite, role })) };
        if (/SELECT id,nom_entite,role,code_structure,code_dhis2 FROM entites WHERE role='USER'/.test(q)) return { rows: publicUsers.map(({ mot_de_passe, ...e }) => e) };
        if (/cle='mot_de_passe_global'/.test(q)) return { rows: [] };
        if (/FROM parametres WHERE cle IN/.test(q)) return { rows: params };
        if (/FROM familles/.test(q)) return { rows: [{ id: 1, nom_famille: 'PNLS' }] };
        if (/SELECT DISTINCT r\.entite_id/.test(q)) return { rows: [{ entite_id: 2, famille_id: 1, statut: 'Validé' }, { entite_id: 3, famille_id: 1, statut: 'TRANSMIS' }].filter((r) => p[2] == null || r.entite_id === p[2]) };
        if (/SELECT code_dhis2,status FROM clinical_reports WHERE mois/.test(q)) return { rows: clinical.filter((c) => c.mois === p[0] && c.annee === p[1] && (p[2] == null || c.code_dhis2 === p[2])).map(({ code_dhis2, status }) => ({ code_dhis2, status })) };
        if (/FROM clinical_reports WHERE code_dhis2=ANY/.test(q)) return { rows: clinical.filter((c) => p[0].includes(c.code_dhis2) && (c.annee < p[1] || (c.annee === p[1] && c.mois <= p[2]))) };
        return { rows: [{ name: null }] }; // initialisation (DDL, GRANT, to_regclass…)
    }
};

let server, base;
test.before(async () => {
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '1mb' }));
    const install = require('./clinical-api');
    const inst = install(app, fakePool, 'postgres://u:p@localhost:5432/db', []);
    await inst.ready;
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

const call = async (path, { token, body, ip } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (ip) headers['X-Forwarded-For'] = ip;
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
};
const login = async (id, password, ip) => call('/api/clinical/login', { body: { id, password }, ip });

test('Page d’accès : la liste publique ne contient que id, nom et rôle (sans ICCM)', async () => {
    const r = await call('/api/clinical/bootstrap');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.structures[0]).sort(), ['id', 'nom_entite', 'role']);
    assert.ok(!r.json.structures.some((s) => /ICCM/.test(s.nom_entite)));
    assert.equal(r.json.params, undefined);
    assert.equal(r.json.families, undefined);
});

test('Le tableau de bord n’est plus public', async () => {
    for (const path of ['/api/clinical/dashboard?mois=9&annee=2026', '/api/clinical/tracking?mois=9&annee=2026', '/api/clinical/context', '/api/clinical/public-dashboard?mois=9&annee=2026']) {
        const r = await call(path);
        assert.equal(r.status, 401, path);
    }
});

test('Connexion : mauvais mot de passe, identifiant invalide, bon mot de passe', async () => {
    assert.equal((await login(2, 'faux', '10.0.0.1')).status, 401);
    assert.equal((await login('abc', 'x', '10.0.0.1')).status, 401);
    assert.equal((await login(2, '', '10.0.0.1')).status, 401);
    const ok = await login(2, 'pw-a', '10.0.0.1');
    assert.equal(ok.status, 200);
    assert.ok(ok.json.token);
    assert.equal(ok.json.user.nom_entite, 'ESPC A');
    assert.equal(ok.json.user.mot_de_passe, undefined);
});

test('District : voit toutes les structures rattachées, combinées', async () => {
    const { json: auth } = await login(1, 'admin-secret', '10.0.0.2');
    const ctx = await call('/api/clinical/context', { token: auth.token });
    assert.equal(ctx.json.structures.length, 3);
    assert.equal(ctx.json.params.length, 2);
    const d = await call('/api/clinical/dashboard?mois=9&annee=2026', { token: auth.token });
    assert.equal(d.status, 200);
    assert.equal(d.json.scope, 'district');
    assert.equal(d.json.combined.metrics.active, 3);
    assert.equal(d.json.structures.length, 3);
    assert.equal(d.json.structures.find((s) => s.nom === 'ESPC C').rattachee, false);
    assert.ok(!JSON.stringify(d.json).includes('patient_code'));
    const t = await call('/api/clinical/tracking?mois=9&annee=2026', { token: auth.token });
    assert.equal(t.json.structures.length, 3);
    assert.equal(t.json.reports.length, 2);
    assert.equal(t.json.clinical.length, 2);
});

test('ESPC : ne voit que sa propre structure (dashboard, suivi, contexte)', async () => {
    const { json: auth } = await login(3, 'pw-b', '10.0.0.3');
    const d = await call('/api/clinical/dashboard?mois=9&annee=2026', { token: auth.token });
    assert.equal(d.json.scope, 'structure');
    assert.equal(d.json.structures.length, 1);
    assert.equal(d.json.structures[0].nom, 'ESPC B');
    assert.equal(d.json.combined.metrics.active, 1);
    assert.equal(d.json.combined.metrics.ageSex[d.json.bands.indexOf('65 ans et +')][0], 1);
    const t = await call('/api/clinical/tracking?mois=9&annee=2026', { token: auth.token });
    assert.deepEqual(t.json.structures.map((s) => s.nom_entite), ['ESPC B']);
    assert.deepEqual(t.json.reports.map((r) => r.entite_id), [3]);
    assert.deepEqual(t.json.clinical.map((c) => c.code_dhis2), ['DB']);
    const ctx = await call('/api/clinical/context', { token: auth.token });
    assert.deepEqual(ctx.json.structures.map((s) => s.nom_entite), ['ESPC B']);
});

test('Période invalide refusée, jeton falsifié refusé', async () => {
    const { json: auth } = await login(1, 'admin-secret', '10.0.0.4');
    assert.equal((await call('/api/clinical/dashboard?mois=13&annee=2026', { token: auth.token })).status, 400);
    assert.equal((await call('/api/clinical/dashboard?mois=9&annee=1999', { token: auth.token })).status, 400);
    const [payload] = auth.token.split('.');
    assert.equal((await call('/api/clinical/dashboard?mois=9&annee=2026', { token: payload + '.signature-bidon' })).status, 401);
});

test('Limitation des tentatives : 10 essais par adresse et par compte', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await login(2, 'mauvais', '10.9.9.9');
    assert.equal(last.status, 429);
    // un autre poste n'est pas bloqué
    assert.equal((await login(2, 'pw-a', '10.9.9.10')).status, 200);
});
