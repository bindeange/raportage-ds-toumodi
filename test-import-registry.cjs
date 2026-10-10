const test = require('node:test'), assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const importer = require('./clinical-import');

async function buildRegistry({ rows = [], attrition = [] }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Registre de dispensation');
    ws.getCell('A1').value = 'Date limite :'; ws.getCell('K1').value = 'Code Ets :'; ws.getCell('M1').value = '01089';
    ws.mergeCells('A1:B1');
    const headers = ['N°', 'Date de dispensation (JJ/MM/AA)', 'Code identifiant patient (si déjà concaténé et respectant la structure)', 'Code Ets', 'Code site', 'Année', 'Num ordre', 'E', 'CODE IDENTIFIANT', 'SEXE', 'AGE', 'POIDS', 'Nouveau', 'AES \n(Ou cas particulier)', 'Nombre de jours dispensés', 'REGIME', 'Patient Stable', 'TB/VIH', 'Type de VIH', 'Ligne thérapeutique', 'Transféré In', 'Servi ailleurs', 'Patient mobile'];
    ws.getRow(4).values = [, ...headers];
    rows.forEach((r, i) => { ws.getRow(5 + i).values = [, , r.date, r.code, , , , , , r.code, r.sexe, r.age, r.poids, r.nouveau, r.aes, r.jours, r.regime, r.stable, r.tb, r.type_vih, r.ligne, r.transfert_in, r.servi, r.mobile]; });
    const attr = wb.addWorksheet('ATTRITION');
    attr.getRow(3).values = [, , 'N°', 'CODE_IDENTIFIANT', 'STATUT \n(Décédé, Transféré ou Arrêt de TARV)'];
    attrition.forEach((a, i) => { attr.getRow(4 + i).values = [, , i + 1, a.code, a.statut]; });
    return wb.xlsx.writeBuffer();
}

test('Détection du format Registre de dispensation (en-têtes non alignées en ligne 1)', async () => {
    const buf = await buildRegistry({ rows: [{ date: new Date('2026-09-02'), code: 'P1', sexe: 'F', age: 30, poids: 55, nouveau: 'Non', aes: 'Non', jours: 90, regime: 'TDF/3TC/DTG', stable: 'Oui', tb: 'Non', type_vih: 'VIH1', ligne: '1', transfert_in: 'Non', servi: 'Non', mobile: 'Non' }] });
    const parsed = await importer.parseWorkbook(buf);
    assert.match(parsed.format, /Registre de dispensation/);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].raw.patient_code, 'P1');
    assert.equal(parsed.rows[0].raw.cas_aes, 'Non');
});

test('Un même code saisi deux fois dans le mois : jours dispensés cumulés, date la plus récente retenue', async () => {
    const buf = await buildRegistry({ rows: [
        { date: new Date('2026-09-02'), code: 'P1', sexe: 'F', age: 30, poids: 55, nouveau: 'Non', jours: 30, regime: 'TDF/3TC/DTG', stable: 'Oui', tb: 'Non', type_vih: 'VIH1', ligne: '1', mobile: 'Non' },
        { date: new Date('2026-09-20'), code: 'P1', sexe: 'F', age: 30, poids: 56, nouveau: 'Non', jours: 60, regime: 'TDF/3TC/DTG', stable: 'Oui', tb: 'Non', type_vih: 'VIH1', ligne: '1', mobile: 'Non' }
    ] });
    const parsed = await importer.parseWorkbook(buf);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].raw.jours_dispenses, 90);
    assert.equal(parsed.rows[0].raw.poids, 56); // valeurs de la dispensation la plus récente
});

test('Feuille ATTRITION : fusionnée avec la ligne du mois, ou ajoutée seule si le code n’y figure pas', async () => {
    const buf = await buildRegistry({
        rows: [{ date: new Date('2026-09-02'), code: 'P1', sexe: 'F', age: 30, poids: 55, nouveau: 'Non', jours: 90, regime: 'TDF/3TC/DTG', stable: 'Oui', tb: 'Non', type_vih: 'VIH1', ligne: '1', mobile: 'Non' }],
        attrition: [{ code: 'P1', statut: 'Décédé' }, { code: 'P2', statut: 'Transféré' }, { code: 'P3', statut: 'Arrêt de TARV' }]
    });
    const parsed = await importer.parseWorkbook(buf);
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows.find((r) => r.raw.patient_code === 'P1').raw.deces, 1);
    assert.equal(parsed.rows.find((r) => r.raw.patient_code === 'P2').raw.transfert_out, 1);
    assert.equal(parsed.rows.find((r) => r.raw.patient_code === 'P3').raw.arret_tarv, 1);
});

test('Lignes vides du modèle (formule sans résultat, au-delà des données réelles) ignorées', async () => {
    const buf = await buildRegistry({ rows: [{ date: new Date('2026-09-02'), code: 'P1', sexe: 'F', age: 30, poids: 55, jours: 90 }] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Registre de dispensation');
    ws.getRow(6).getCell(9).value = { formula: 'I5', sharedFormula: 'I5' }; // pas de "result" mis en cache
    const parsed = await importer.parseWorkbook(await wb.xlsx.writeBuffer());
    assert.equal(parsed.rows.length, 1);
});

test('La grille standard reste reconnue et fonctionne sans changement', async () => {
    const buf = await importer.buildWorkbook({ structure: { code_dhis2: 'D1', nom_entite: 'ESPC' }, mois: 9, annee: 2026, mode: 'template' });
    const parsed = await importer.parseWorkbook(buf);
    assert.equal(parsed.format, 'grille standard');
    assert.equal(parsed.rows.length, 1);
});
