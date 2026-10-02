const test = require('node:test'), assert = require('node:assert/strict');
const importer = require('./clinical-import');

const OPTS = {
    sexe: [{ value: 'F', active: true }, { value: 'M', active: true }],
    type_vih: [{ value: 'VIH1', active: true }, { value: 'VIH2', active: true }],
    ligne_therapeutique: [{ value: '1', active: true }, { value: '2', active: true }, { value: '3', active: true }],
    regime: [{ value: 'TDF/3TC/DTG', active: true }, { value: 'ABC/3TC/ATV-r', active: true }],
    stable: [{ value: 'Oui', active: true }, { value: 'Non', active: true }]
};

test('coerceRow : cellule vide omise, ne force jamais une valeur nulle', () => {
    const { code, input } = importer.coerceRow({ patient_code: ' P1 ', sexe: 'F', age: null, poids: '' }, OPTS);
    assert.equal(code, 'P1');
    assert.equal(input.sexe, 'F');
    assert.ok(!('age' in input));
    assert.ok(!('poids' in input));
});

test('coerceRow : « Ligne 2 », « ligne2 » et 2 rejoignent tous l’option « 2 »', () => {
    for (const raw of ['Ligne 2', 'ligne2', 2, ' 2 ']) assert.equal(importer.coerceRow({ patient_code: 'x', ligne_therapeutique: raw }, OPTS).input.ligne_therapeutique, '2');
    // Sans options configurées, le chiffre brut est conservé tel quel.
    assert.equal(importer.coerceRow({ patient_code: 'x', ligne_therapeutique: 'Ligne 4' }, {}).input.ligne_therapeutique, '4');
});

test('coerceRow : sexe tolérant à Homme/Femme et à la casse', () => {
    assert.equal(importer.coerceRow({ patient_code: 'x', sexe: 'Homme' }, OPTS).input.sexe, 'M');
    assert.equal(importer.coerceRow({ patient_code: 'x', sexe: 'femme' }, OPTS).input.sexe, 'F');
    assert.equal(importer.coerceRow({ patient_code: 'x', sexe: 'f' }, OPTS).input.sexe, 'F');
});

test('coerceRow : booléens 0/1, Oui/Non, OUI/NON', () => {
    assert.equal(importer.coerceRow({ patient_code: 'x', deces: 1 }, OPTS).input.deces, 1);
    assert.equal(importer.coerceRow({ patient_code: 'x', deces: 0 }, OPTS).input.deces, 0);
    assert.equal(importer.coerceRow({ patient_code: 'x', tb_vih: 'OUI' }, OPTS).input.tb_vih, 'oui');
    assert.equal(importer.coerceRow({ patient_code: 'x', tb_vih: 'non' }, OPTS).input.tb_vih, 'non');
});

test('coerceRow : dates Excel et texte (ISO ou JJ/MM/AAAA)', () => {
    assert.equal(importer.coerceRow({ patient_code: 'x', derniere_dispensation: new Date(Date.UTC(2026, 8, 5)) }, OPTS).input.derniere_dispensation, '2026-09-05');
    assert.equal(importer.coerceRow({ patient_code: 'x', derniere_dispensation: '2026-09-05' }, OPTS).input.derniere_dispensation, '2026-09-05');
    assert.equal(importer.coerceRow({ patient_code: 'x', derniere_dispensation: '05/09/2026' }, OPTS).input.derniere_dispensation, '2026-09-05');
});

test('coerceRow : nombres avec virgule, texte non numérique transmis tel quel', () => {
    assert.equal(importer.coerceRow({ patient_code: 'x', poids: '60,5' }, OPTS).input.poids, 60.5);
    assert.equal(importer.coerceRow({ patient_code: 'x', poids: 'abc' }, OPTS).input.poids, 'abc');
});

test('Modèle : en-têtes complètes, une ligne d’exemple, feuille Lisez-moi', async () => {
    const buf = await importer.buildWorkbook({ structure: { code_dhis2: 'D1', nom_entite: 'ESPC Test' }, mois: 9, annee: 2026, mode: 'template' });
    const parsed = await importer.parseWorkbook(buf);
    assert.equal(parsed.missingColumns.length, 0);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].raw.patient_code, '12345/67/89/01234');
});

test('Export : les lignes réelles se relisent à l’identique (aller-retour)', async () => {
    const rows = [{ patient_code: 'A1', sexe: 'F', age: '30', poids: '60', nouvelle_inclusion: '1', tb_vih: '0', type_vih: 'VIH1', ligne_therapeutique: '1', derniere_dispensation: '2026-09-02', jours_dispenses: '90', regime: 'TDF/3TC/DTG', stable: 'Oui', transfert_out: '0', deces: '0', arret_tarv: '0', servi_ailleurs: '0', transfert_in: '0', retour_soins: '0' }];
    const buf = await importer.buildWorkbook({ structure: { code_dhis2: 'D1', nom_entite: 'ESPC Test' }, mois: 9, annee: 2026, mode: 'export', rows });
    const parsed = await importer.parseWorkbook(buf);
    assert.equal(parsed.rows.length, 1);
    const { code, input } = importer.coerceRow(parsed.rows[0].raw, OPTS);
    assert.equal(code, 'A1');
    assert.equal(input.sexe, 'F'); assert.equal(input.derniere_dispensation, '2026-09-02'); assert.equal(input.nouvelle_inclusion, 1); assert.equal(input.deces, 0);
});

test('Fichier sans colonne CODE IDENTIFIANT : erreur explicite', async () => {
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Patients');
    ws.addRow(['SEXE', 'AGE']); ws.addRow(['F', 30]);
    const buf = await wb.xlsx.writeBuffer();
    await assert.rejects(() => importer.parseWorkbook(buf), /CODE IDENTIFIANT/);
});

test('Lignes totalement vides ignorées (fin de feuille)', async () => {
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Patients');
    ws.addRow(['CODE IDENTIFIANT', 'SEXE']); ws.addRow(['P1', 'F']); ws.addRow([]); ws.addRow([]);
    const parsed = await importer.parseWorkbook(await wb.xlsx.writeBuffer());
    assert.equal(parsed.rows.length, 1);
});


