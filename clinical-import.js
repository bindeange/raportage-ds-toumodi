/**
 * Import / export du tableau de dispensation (fichier Excel), pour les structures
 * à file active élevée : au lieu de passer par chaque rendez-vous un par un,
 * on télécharge un modèle (ou la liste actuelle), on le complète hors ligne,
 * puis on le réimporte. La validation de chaque ligne réutilise exactement
 * les mêmes règles que la fiche patient (clinical-fields.normalize), pour que
 * l'import ne puisse jamais enregistrer une donnée que la saisie manuelle refuserait.
 */
const ExcelJS = require('exceljs');
const F = require('./clinical-fields');

// Colonnes du tableau. `field` relie la colonne à une clé de clinical-fields.js ;
// les colonnes sans `field` (N°, CODE ETS, SITES, Periode) sont informatives et ignorées à l'import.
const COLUMNS = [
    { label: 'N°', key: 'n' },
    { label: 'REGION', key: 'region', field: 'region', type: 'text' },
    { label: 'DISTRICT', key: 'district', field: 'district', type: 'text' },
    { label: 'CODE ETS', key: 'code_ets' },
    { label: 'SITES', key: 'sites' },
    { label: 'Periode', key: 'periode' },
    { label: 'CODE IDENTIFIANT', key: 'patient_code', field: 'patient_code', type: 'text' },
    { label: 'SEXE', key: 'sexe', field: 'sexe', type: 'sexe' },
    { label: 'AGE', key: 'age', field: 'age', type: 'number' },
    { label: 'POIDS', key: 'poids', field: 'poids', type: 'number' },
    { label: 'Nouvelle inclusion', key: 'nouvelle_inclusion', field: 'nouvelle_inclusion', type: 'bool' },
    { label: 'Transfert-In', key: 'transfert_in', field: 'transfert_in', type: 'bool' },
    { label: 'Retour dans les soins', key: 'retour_soins', field: 'retour_soins', type: 'bool' },
    { label: 'TB / VIH', key: 'tb_vih', field: 'tb_vih', type: 'bool' },
    { label: 'Type de VIH', key: 'type_vih', field: 'type_vih', type: 'choice' },
    { label: 'Ligne thérapeutique', key: 'ligne_therapeutique', field: 'ligne_therapeutique', type: 'ligne' },
    { label: 'Date de la dernière dispensation', key: 'derniere_dispensation', field: 'derniere_dispensation', type: 'date' },
    { label: 'Nombre de jours dispensés', key: 'jours_dispenses', field: 'jours_dispenses', type: 'integer' },
    { label: 'REGIME', key: 'regime', field: 'regime', type: 'choice' },
    { label: 'STABLE', key: 'stable', field: 'stable', type: 'choice' },
    { label: 'Transfert Out', key: 'transfert_out', field: 'transfert_out', type: 'bool' },
    { label: 'Décès', key: 'deces', field: 'deces', type: 'bool' },
    { label: 'Arrêt TARV', key: 'arret_tarv', field: 'arret_tarv', type: 'bool' },
    { label: 'Servi ailleurs', key: 'servi_ailleurs', field: 'servi_ailleurs', type: 'bool' }
];
const FIELD_COLUMNS = COLUMNS.filter((c) => c.field);

const normalizeHeader = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const trimmed = (v) => (v == null ? '' : String(v).trim());

// ---------- lecture d'une cellule « choix » : correspondance exacte, puis insensible à la casse ----------
function resolveChoice(raw, options) {
    const v = trimmed(raw);
    if (!v) return '';
    const opts = (options || []).filter((o) => o.active);
    const hit = opts.find((o) => String(o.value) === v) || opts.find((o) => String(o.value).toLowerCase() === v.toLowerCase());
    return hit ? hit.value : v;
}
const SEX_SYNONYMS = { homme: ['H', 'M'], masculin: ['H', 'M'], femme: ['F'], féminin: ['F'], feminin: ['F'] };
function resolveSex(raw, options) {
    const direct = resolveChoice(raw, options), opts = (options || []).filter((o) => o.active);
    if (!opts.length || opts.some((o) => String(o.value) === direct)) return direct;
    const candidates = SEX_SYNONYMS[trimmed(raw).toLowerCase()];
    const hit = candidates && opts.find((o) => candidates.includes(String(o.value)));
    return hit ? hit.value : direct;
}
// « Ligne 1 », « ligne1 », « 1 » doivent tous atteindre la même option configurée.
function resolveLigne(raw, options) {
    const v = trimmed(raw);
    if (!v) return '';
    const direct = resolveChoice(v, options), opts = (options || []).filter((o) => o.active);
    if (opts.some((o) => String(o.value) === direct)) return direct;
    const digits = v.match(/\d+/);
    if (digits) {
        const hit = opts.find((o) => String(o.value) === digits[0]);
        if (hit) return hit.value;
        if (!opts.length) return digits[0];
    }
    return direct;
}
function resolveBool(raw) {
    const v = trimmed(raw);
    if (!v) return '';
    if (/^oui$/i.test(v)) return 'oui';
    if (/^non$/i.test(v)) return 'non';
    return v;
}
function resolveDate(raw) {
    if (raw instanceof Date && !Number.isNaN(+raw)) return new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate())).toISOString().slice(0, 10);
    const v = trimmed(raw);
    if (!v) return '';
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return v;
}

/**
 * Convertit une ligne brute (valeurs de cellules, par clé de champ) en un objet partiel prêt pour
 * clinical-fields.normalize(). Une cellule vide est omise (ne modifie pas la valeur déjà enregistrée),
 * elle n'est jamais convertie en « valeur vide ». Les erreurs fines (format, option inconnue) restent
 * la responsabilité de normalize(), seule source de vérité, utilisée aussi par la saisie manuelle.
 */
// Type par champ, toutes grilles confondues (grille standard + Registre de dispensation), pour que coerceRow
// sache convertir n'importe quel champ produit par n'importe quel format de fichier pris en charge.
function typesByField() {
    const map = {};
    for (const c of [...FIELD_COLUMNS, ...REGISTRY_COLUMNS]) if (c.field && c.field !== 'patient_code' && !map[c.field]) map[c.field] = c.type;
    return map;
}
function coerceRow(raw, options) {
    const code = trimmed(raw.patient_code), input = {}, types = typesByField();
    for (const field of Object.keys(raw)) {
        if (field === 'patient_code') continue;
        const c = { field, type: types[field] };
        if (!c.type || !(c.field in raw)) continue;
        const cell = raw[c.field];
        if (cell == null || cell === '') continue;
        switch (c.type) {
            case 'text': input[c.field] = trimmed(cell); break;
            case 'number': case 'integer': { const n = typeof cell === 'number' ? cell : Number(trimmed(cell).replace(',', '.')); input[c.field] = Number.isFinite(n) ? n : trimmed(cell); break; }
            case 'bool': input[c.field] = typeof cell === 'number' ? cell : resolveBool(cell); break;
            case 'sexe': input[c.field] = resolveSex(cell, options.sexe); break;
            case 'choice': input[c.field] = resolveChoice(cell, options[c.field]); break;
            case 'ligne': input[c.field] = resolveLigne(cell, options[c.field]); break;
            case 'date': input[c.field] = resolveDate(cell); break;
        }
    }
    return { code, input };
}

/** Lit un classeur .xlsx (Buffer) et renvoie les lignes de données, par numéro de ligne Excel. */
// Texte d'une cellule d'en-tête, à l'abri des cellules « esclaves » d'une fusion (merge) dont la lecture de
// `.text` lève une exception quand leur valeur sous-jacente est nulle.
function headerText(cell) {
    try { if (cell.text != null) return cell.text; } catch { /* cellule fusionnée sans valeur propre */ }
    const v = cell.value;
    return v && typeof v === 'object' ? (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : '') : v;
}
// Lit n'importe quelle ligne de cellule Excel (date, formule déjà calculée, texte enrichi…) en valeur brute.
function cellValue(row, colNumber) {
    let v = row.getCell(colNumber).value;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('result' in v) v = v.result;
        else if ('text' in v) v = v.text;
        else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
        else v = null; // formule sans résultat mis en cache (ligne vide du modèle, au-delà des données réelles)
    }
    return v;
}
// Repère, parmi les premières lignes d'une feuille, celle qui contient les en-têtes recherchés (recherche exacte
// sur le texte normalisé), pour s'adapter à une grille dont les en-têtes ne sont pas forcément en ligne 1.
function findHeaderRow(ws, requiredLabels, maxScan = 10) {
    const wanted = requiredLabels.map(normalizeHeader);
    for (let r = 1; r <= Math.min(maxScan, ws.rowCount); r++) {
        const found = new Set();
        ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => { const norm = normalizeHeader(headerText(cell)); if (wanted.includes(norm)) found.add(norm); });
        if (wanted.every((w) => found.has(w))) return r;
    }
    return null;
}

/** Grille simple (notre modèle) : une feuille, en-têtes en ligne 1, correspondance par libellé de colonne. */
function parseSimpleGrid(ws) {
    const colMap = new Map();
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const norm = normalizeHeader(headerText(cell));
        const def = COLUMNS.find((c) => normalizeHeader(c.label) === norm);
        if (def && def.field) colMap.set(colNumber, def);
    });
    if (![...colMap.values()].some((d) => d.field === 'patient_code')) throw new Error('Colonne « CODE IDENTIFIANT » introuvable. Utilisez l’un des modèles pris en charge, sans modifier les en-têtes.');
    const found = new Set([...colMap.values()].map((d) => d.field)), missingColumns = FIELD_COLUMNS.filter((c) => !found.has(c.field)).map((c) => c.label);
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const raw = {}; let hasAny = false;
        colMap.forEach((def, colNumber) => { const v = cellValue(row, colNumber); if (v != null && v !== '') hasAny = true; raw[def.field] = v; });
        if (hasAny) rows.push({ excelRow: rowNumber, raw });
    });
    return { rows, missingColumns, format: 'grille standard' };
}

// Grille « Registre de dispensation » (OND-FACT, 3 feuillets) : en-têtes non alignées en ligne 1, une ligne par
// dispensation (un même patient peut apparaître plusieurs fois dans le mois : on cumule alors les jours
// dispensés et on retient la date la plus récente, comme l'indique la feuille « Instruction-Orientation »),
// et les sorties (décès, transferts, arrêts) listées séparément dans la feuille « ATTRITION ».
const REGISTRY_COLUMNS = [
    { label: 'CODE IDENTIFIANT', field: 'patient_code', type: 'text' },
    { label: 'Date de dispensation (JJ/MM/AA)', field: 'derniere_dispensation', type: 'date' },
    { label: 'SEXE', field: 'sexe', type: 'sexe' },
    { label: 'AGE', field: 'age', type: 'number' },
    { label: 'POIDS', field: 'poids', type: 'number' },
    { label: 'Nouveau', field: 'nouvelle_inclusion', type: 'bool' },
    { label: 'AES \n(Ou cas particulier)', field: 'cas_aes', type: 'bool' },
    { label: 'Nombre de jours dispensés', field: 'jours_dispenses', type: 'integer' },
    { label: 'REGIME', field: 'regime', type: 'choice' },
    { label: 'Patient Stable', field: 'stable', type: 'choice' },
    { label: 'TB/VIH', field: 'tb_vih', type: 'bool' },
    { label: 'Type de VIH', field: 'type_vih', type: 'choice' },
    { label: 'Ligne thérapeutique', field: 'ligne_therapeutique', type: 'ligne' },
    { label: 'Transféré In', field: 'transfert_in', type: 'bool' },
    { label: 'Servi ailleurs', field: 'servi_ailleurs', type: 'bool' },
    { label: 'Patient mobile', field: 'patient_mobile', type: 'bool' }
];
function parseRegistry(wb) {
    const ws = wb.worksheets.find((s) => normalizeHeader(s.name) === normalizeHeader('Registre de dispensation'));
    const headerRow = findHeaderRow(ws, ['CODE IDENTIFIANT']);
    if (!headerRow) throw new Error('Colonne « CODE IDENTIFIANT » introuvable dans la feuille « Registre de dispensation ».');
    const colMap = new Map();
    ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const norm = normalizeHeader(headerText(cell));
        // Correspondance exacte : « Code identifiant patient (si déjà concaténé…) » ne doit pas être pris pour « CODE IDENTIFIANT ».
        const def = REGISTRY_COLUMNS.find((c) => normalizeHeader(c.label) === norm);
        if (def && !colMap.has(def.field)) colMap.set(def.field, colNumber);
    });
    const byCode = new Map(), order = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r), codeCol = colMap.get('patient_code');
        const code = codeCol ? String(cellValue(row, codeCol) ?? '').trim() : '';
        if (!code) continue;
        const raw = {};
        for (const [field, colNumber] of colMap) raw[field] = cellValue(row, colNumber);
        if (byCode.has(code)) {
            // Même code saisi plusieurs fois ce mois-ci : on cumule les jours dispensés et on garde la dispensation la plus récente.
            const prev = byCode.get(code).raw, prevDate = String(prev.derniere_dispensation instanceof Date ? prev.derniere_dispensation.toISOString() : prev.derniere_dispensation || '');
            const newDate = String(raw.derniere_dispensation instanceof Date ? raw.derniere_dispensation.toISOString() : raw.derniere_dispensation || '');
            const sum = (Number(prev.jours_dispenses) || 0) + (Number(raw.jours_dispenses) || 0);
            const merged = newDate >= prevDate ? { ...raw } : { ...prev };
            merged.jours_dispenses = sum || merged.jours_dispenses;
            byCode.get(code).raw = merged;
        } else { const entry = { excelRow: r, raw }; byCode.set(code, entry); order.push(entry); }
    }
    const attrition = wb.worksheets.find((s) => normalizeHeader(s.name) === normalizeHeader('ATTRITION'));
    if (attrition) {
        const aHeader = findHeaderRow(attrition, ['CODE_IDENTIFIANT']) || findHeaderRow(attrition, ['CODE IDENTIFIANT']);
        if (aHeader) {
            const aCols = {};
            attrition.getRow(aHeader).eachCell({ includeEmpty: false }, (cell, colNumber) => {
                const norm = normalizeHeader(headerText(cell));
                if (norm === 'code_identifiant' || norm === 'code identifiant') aCols.code = colNumber;
                else if (norm.startsWith('statut')) aCols.statut = colNumber;
            });
            for (let r = aHeader + 1; r <= attrition.rowCount; r++) {
                const row = attrition.getRow(r), code = aCols.code ? String(cellValue(row, aCols.code) ?? '').trim() : '';
                if (!code) continue;
                const statut = normalizeHeader(aCols.statut ? cellValue(row, aCols.statut) : '');
                const field = /dece/.test(statut) ? 'deces' : /transfer/.test(statut) ? 'transfert_out' : /arret/.test(statut) ? 'arret_tarv' : null;
                if (!field) continue;
                if (byCode.has(code)) byCode.get(code).raw[field] = 1;
                else { const entry = { excelRow: r, raw: { patient_code: code, [field]: 1 } }; byCode.set(code, entry); order.push(entry); }
            }
        }
    }
    return { rows: order, missingColumns: [], format: 'Registre de dispensation (OND-FACT)' };
}

async function parseWorkbook(buffer) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { throw new Error('Fichier illisible. Vérifiez qu’il s’agit bien d’un fichier Excel (.xlsx) non corrompu.'); }
    if (wb.worksheets.some((s) => normalizeHeader(s.name) === normalizeHeader('Registre de dispensation'))) return parseRegistry(wb);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Le fichier ne contient aucune feuille de calcul.');
    return parseSimpleGrid(ws);
}

const EXAMPLE = { patient_code: '12345/67/89/01234', sexe: 'F', age: 34, poids: 58, nouvelle_inclusion: 0, transfert_in: 0, retour_soins: 0, tb_vih: 'Non', type_vih: 'VIH1', ligne_therapeutique: '1', jours_dispenses: 90, regime: 'TDF/3TC/DTG', stable: 'Oui', transfert_out: 0, deces: 0, arret_tarv: 0, servi_ailleurs: 0 };

/** Construit le classeur à télécharger : modèle vierge (un exemple) ou liste actuelle (mode « export »). */
async function buildWorkbook({ structure, mois, annee, mode, rows = [] }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SYGESS TOUMODI'; wb.created = new Date();
    const periodLabel = `${String(mois).padStart(2, '0')}/${annee}`, ws = wb.addWorksheet('Patients');
    ws.columns = COLUMNS.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 2) }));
    ws.getRow(1).font = { bold: true }; ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const base = { code_ets: structure.code_dhis2 || '', sites: structure.nom_entite || '', periode: periodLabel };
    const dateCell = (v) => (v ? new Date(v + 'T00:00:00Z') : null);

    if (mode === 'template') {
        ws.addRow({ ...base, n: 1, ...EXAMPLE, derniere_dispensation: dateCell(`${annee}-${String(mois).padStart(2, '0')}-05`) });
        ws.getRow(2).font = { italic: true, color: { argb: 'FF808080' } };
        const legend = wb.addWorksheet('Lisez-moi'); legend.columns = [{ width: 100 }];
        legend.addRows([
            ['Comment utiliser ce fichier'],
            ['1. Ne modifiez pas les en-têtes de la feuille « Patients ».'],
            ['2. La ligne 2 est un exemple : remplacez-la ou supprimez-la avant import.'],
            [`3. La colonne Periode est informative : à l’import, les données sont enregistrées dans la période choisie dans l’application (actuellement ${periodLabel}), pas dans celle écrite ici.`],
            ['4. CODE IDENTIFIANT identifie le patient : reprenez exactement le même code d’un mois à l’autre pour mettre à jour un patient existant. Un code jamais vu crée une nouvelle inclusion.'],
            ['5. Laissez une cellule vide pour ne pas modifier l’information déjà enregistrée pour ce patient : elle ne sera pas effacée.'],
            ['6. Cases Oui/Non ou 0/1 : Nouvelle inclusion, Transfert-In, Retour dans les soins, TB / VIH, Transfert Out, Décès, Arrêt TARV, Servi ailleurs.'],
            ['7. Date de la dernière dispensation au format AAAA-MM-JJ ou JJ/MM/AAAA.'],
            ['8. Après l’import, les lignes en erreur sont listées avec leur numéro et le motif : corrigez-les puis réimportez seulement si besoin, les lignes déjà importées ne sont pas dupliquées.']
        ]);
        legend.getRow(1).font = { bold: true, size: 13 };
        for (let i = 2; i <= 9; i++) legend.getRow(i).alignment = { wrapText: true, vertical: 'top' };
    } else {
        rows.forEach((r, i) => ws.addRow({
            ...base, n: i + 1, patient_code: r.patient_code, sexe: r.sexe || '', age: r.age ?? '', poids: r.poids ?? '',
            nouvelle_inclusion: F.truth(r.nouvelle_inclusion) ? 1 : 0, transfert_in: F.truth(r.transfert_in) ? 1 : 0, retour_soins: F.truth(r.retour_soins) ? 1 : 0,
            tb_vih: F.truth(r.tb_vih) ? 'Oui' : 'Non', type_vih: r.type_vih || '', ligne_therapeutique: r.ligne_therapeutique || '',
            derniere_dispensation: dateCell(r.derniere_dispensation), jours_dispenses: r.jours_dispenses ?? '', regime: r.regime || '', stable: r.stable || '',
            transfert_out: F.truth(r.transfert_out) ? 1 : 0, deces: F.truth(r.deces) ? 1 : 0, arret_tarv: F.truth(r.arret_tarv) ? 1 : 0, servi_ailleurs: F.truth(r.servi_ailleurs) ? 1 : 0
        }));
    }
    ws.getColumn('derniere_dispensation').numFmt = 'yyyy-mm-dd';
    return wb.xlsx.writeBuffer();
}

module.exports = { COLUMNS, parseWorkbook, coerceRow, buildWorkbook };
