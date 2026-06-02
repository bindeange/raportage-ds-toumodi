/**
 * SYGESS TOUMODI — Serveur proxy local
 * 
 * INSTALLATION (une seule fois) :
 *   npm install pg express cors
 *
 * LANCEMENT :
 *   node server.js
 *
 * Puis ouvrir : http://localhost:3000
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error("DATABASE_URL manquant. Ajoutez la variable d'environnement sur Render.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

app.use((req, _res, next) => {
    if (req.path.startsWith('/api/')) {
        const entry = {
            at: new Date().toISOString(),
            method: req.method,
            path: req.path,
            query: req.query,
            bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
            bodyPreview: JSON.stringify(req.body || {}).slice(0, 1000)
        };
        fs.appendFile(path.join(__dirname, 'sync-debug.log'), JSON.stringify(entry) + '\n', () => {});
    }
    next();
});

function previousPeriod(mois, annee) {
    const m = Number(mois);
    const a = Number(annee);
    return m === 1
        ? { mois: 12, annee: a - 1 }
        : { mois: m - 1, annee: a };
}

async function getActivePeriod() {
    const result = await pool.query(`
        SELECT cle, valeur
        FROM parametres
        WHERE cle IN ('mois_actif', 'annee_active')
    `);
    const params = Object.fromEntries(result.rows.map((row) => [row.cle, row.valeur]));
    const mois = Number(params.mois_actif);
    const annee = Number(params.annee_active);
    if (!mois || !annee) {
        throw new Error("Periode active introuvable dans parametres");
    }
    return { mois, annee };
}

const NEON_COLUMNS = {
    entites: ['id', 'nom_entite', 'login', 'role', 'code_structure', 'mot_de_passe'],
    familles: ['id', 'nom_famille', 'est_pnlp'],
    medicaments: ['id', 'famille_id', 'dci', 'unite_comptage', 'code1', 'code2', 'code3', 'code4', 'code5', 'cmm_theorique'],
    indicateurs: ['id', 'nom_indicateur', 'famille_id', 'est_pnsme', 'type_saisie'],
    indicateur_meds: ['indicateur_id', 'medicament_id'],
    agents_asc: ['code_asc', 'code_espc', 'libelle'],
    cmm_structures: ['id', 'code_structure', 'medicament_id', 'valeur_cmm_theorique'],
    parametres: ['cle', 'valeur'],
    rapports: ['id', 'entite_id', 'mois', 'annee', 'statut', 'famille_id', 'date_soumission'],
    rapport_stock_details: ['id', 'rapport_id', 'medicament_id', 'stock_initial', 'quantite_recue', 'quantite_distribuee', 'pertes_ajustements', 'stock_disponible', 'commentaire'],
    rapport_indicateurs: ['id', 'rapport_id', 'indicateur_id', 'val_unique', 'val_nouvelle', 'val_ancienne'],
    livraisons_district: ['id', 'code_structure', 'code_med', 'quantite_livree', 'mois', 'annee', 'num_facture', 'date_livraison']
};

function normalizeRecord(table, record) {
    const normalized = { ...record };
    if (table === 'rapports' && normalized.date_saisie && !normalized.date_soumission) {
        normalized.date_soumission = normalized.date_saisie;
    }
    delete normalized.date_saisie;

    const allowed = NEON_COLUMNS[table];
    if (!allowed) return normalized;
    return Object.fromEntries(
        Object.entries(normalized).filter(([key]) => allowed.includes(key))
    );
}

function conflictColumns(table, record) {
    if (table === 'parametres') return ['cle'];
    if (table === 'agents_asc') return ['code_asc'];
    if (table === 'indicateur_meds') return ['indicateur_id', 'medicament_id'];
    if (record.id !== undefined && record.id !== null && record.id !== '') return ['id'];
    if (table === 'rapports') return ['entite_id', 'mois', 'annee', 'famille_id'];
    if (table === 'rapport_stock_details') return ['rapport_id', 'medicament_id'];
    if (table === 'rapport_indicateurs') return ['rapport_id', 'indicateur_id'];
    return null;
}

async function upsertRecord(client, table, rawRecord) {
    if (!NEON_COLUMNS[table]) {
        throw new Error(`Table non autorisee: ${table}`);
    }
    const record = normalizeRecord(table, rawRecord);
    const target = conflictColumns(table, record);
    if (!target) {
        throw new Error(`Conflit introuvable pour ${table}`);
    }
    for (const column of target) {
        if (!(column in record)) throw new Error(`Colonne de conflit manquante ${table}.${column}`);
    }

    const columns = Object.keys(record);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updates = columns
        .filter((column) => !target.includes(column))
        .map((column) => `${column} = EXCLUDED.${column}`);
    const sql = `
        INSERT INTO ${table} (${columns.join(',')})
        VALUES (${placeholders.join(',')})
        ON CONFLICT (${target.join(',')})
        ${updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING'}
    `;
    await client.query(sql, columns.map((column) => record[column]));
}

async function upsertRecordBatch(client, table, rawRecords) {
    if (!rawRecords.length) return 0;
    if (!NEON_COLUMNS[table]) {
        throw new Error(`Table non autorisee: ${table}`);
    }

    const records = rawRecords.map((record) => normalizeRecord(table, record));
    const target = conflictColumns(table, records[0]);
    if (!target) throw new Error(`Conflit introuvable pour ${table}`);
    for (const record of records) {
        for (const column of target) {
            if (!(column in record)) throw new Error(`Colonne de conflit manquante ${table}.${column}`);
        }
    }

    const allowed = NEON_COLUMNS[table];
    const columns = allowed.filter((column) => records.some((record) => column in record));
    const values = [];
    const rowsSql = records.map((record) => {
        const placeholders = columns.map((column) => {
            values.push(record[column] ?? null);
            return `$${values.length}`;
        });
        return `(${placeholders.join(',')})`;
    });

    const updates = columns
        .filter((column) => !target.includes(column))
        .map((column) => `${column} = EXCLUDED.${column}`);
    const sql = `
        INSERT INTO ${table} (${columns.join(',')})
        VALUES ${rowsSql.join(',')}
        ON CONFLICT (${target.join(',')})
        ${updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING'}
    `;
    await client.query(sql, values);
    return records.length;
}

// Test de connexion au démarrage
pool.query('SELECT NOW()')
    .then(() => console.log('✅ Connexion Neon établie avec succès'))
    .catch(e => console.error('❌ Connexion Neon échouée :', e.message));

// Point d'entrée SQL unique
app.post('/api/query', async (req, res) => {
    const { query, params = [] } = req.body;
    if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Requête invalide' });
    }
    try {
        const result = await pool.query(query, params);
        res.json({ rows: result.rows });
    } catch (err) {
        console.error('❌ Erreur SQL :', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sync/bulk-upsert', async (req, res) => {
    const { table, records } = req.body || {};
    if (!NEON_COLUMNS[table]) {
        return res.status(400).json({ ok: false, error: `Table non autorisee: ${table}` });
    }
    if (!Array.isArray(records)) {
        return res.status(400).json({ ok: false, error: 'records doit etre un tableau' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let imported = 0;
        for (let i = 0; i < records.length; i += 250) {
            imported += await upsertRecordBatch(client, table, records.slice(i, i + 250));
        }
        await client.query('COMMIT');
        res.json({ ok: true, table, imported });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Erreur bulk ${table}:`, err.message);
        res.status(500).json({ ok: false, table, error: err.message });
    } finally {
        client.release();
    }
});

// Perimetre de synchronisation attendu depuis la base locale/PHP vers Neon.
// Le mois M-1 est inclus pour alimenter le stock initial de la saisie ESPC.
app.get('/api/sync/scope', async (_req, res) => {
    try {
        const activePeriod = await getActivePeriod();
        const previous = previousPeriod(activePeriod.mois, activePeriod.annee);
        res.json({
            ok: true,
            activePeriod,
            previousPeriod: previous,
            tables: {
                referentiel: ['entites', 'familles', 'medicaments', 'indicateurs', 'indicateur_meds', 'agents_asc', 'cmm_structures'],
                moisActif: [
                    { table: 'livraisons_district', mois: activePeriod.mois, annee: activePeriod.annee }
                ],
                moisPrecedent: [
                    { table: 'rapports', mois: previous.mois, annee: previous.annee },
                    { table: 'rapport_stock_details', mois: previous.mois, annee: previous.annee }
                ],
                retoursEspc: ['rapports', 'rapport_stock_details', 'rapport_indicateurs']
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Import des stocks disponibles du mois M-1.
// Chaque ligne attend au minimum: code_structure OU entite_id, medicament_id, stock_disponible.
// famille_id est optionnel si le medicament existe dans Neon.
app.post('/api/sync/import-m1-stocks', async (req, res) => {
    const client = await pool.connect();
    try {
        const activePeriod = await getActivePeriod();
        const period = req.body.period || previousPeriod(activePeriod.mois, activePeriod.annee);
        const rows = Array.isArray(req.body.records) ? req.body.records : [];
        if (!rows.length) {
            return res.status(400).json({ ok: false, error: 'Aucun stock M-1 a importer' });
        }

        await client.query('BEGIN');
        let imported = 0;
        const skipped = [];

        for (const [index, row] of rows.entries()) {
            const medicamentId = Number(row.medicament_id);
            const stockDisponible = Number(row.stock_disponible ?? row.stock ?? row.quantite ?? 0);
            if (!medicamentId || Number.isNaN(stockDisponible)) {
                skipped.push({ index, reason: 'medicament_id ou stock_disponible invalide' });
                continue;
            }

            let entiteId = row.entite_id ? Number(row.entite_id) : null;
            if (!entiteId && row.code_structure) {
                const entite = await client.query(
                    'SELECT id FROM entites WHERE code_structure = $1 LIMIT 1',
                    [String(row.code_structure)]
                );
                entiteId = entite.rows[0]?.id || null;
            }
            if (!entiteId) {
                skipped.push({ index, reason: 'entite introuvable' });
                continue;
            }

            let familleId = row.famille_id ? Number(row.famille_id) : null;
            if (!familleId) {
                const med = await client.query(
                    'SELECT famille_id FROM medicaments WHERE id = $1 LIMIT 1',
                    [medicamentId]
                );
                familleId = med.rows[0]?.famille_id || null;
            }
            if (!familleId) {
                skipped.push({ index, reason: 'famille introuvable pour le medicament' });
                continue;
            }

            const rapport = await client.query(`
                INSERT INTO rapports (entite_id, famille_id, mois, annee, statut, date_soumission)
                VALUES ($1, $2, $3, $4, 'TRANSMIS', NOW())
                ON CONFLICT (entite_id, famille_id, mois, annee)
                DO UPDATE SET statut = 'TRANSMIS', date_soumission = NOW()
                RETURNING id
            `, [entiteId, familleId, Number(period.mois), Number(period.annee)]);

            await client.query(`
                INSERT INTO rapport_stock_details
                    (rapport_id, medicament_id, stock_initial, quantite_recue, quantite_distribuee, pertes_ajustements, stock_disponible, commentaire)
                VALUES ($1, $2, 0, 0, 0, 0, $3, 'Import stock M-1 depuis base locale')
                ON CONFLICT (rapport_id, medicament_id)
                DO UPDATE SET stock_disponible = EXCLUDED.stock_disponible,
                              commentaire = EXCLUDED.commentaire
            `, [rapport.rows[0].id, medicamentId, stockDisponible]);

            imported += 1;
        }

        await client.query('COMMIT');
        res.json({ ok: true, period, imported, skipped });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erreur import M-1 :', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        client.release();
    }
});


// Export des retours saisis dans Neon vers la base locale/PHP.
// Important: le client local ne doit pas reutiliser les id Neon. Il doit retrouver
// le rapport local par code_structure + famille_id + mois + annee puis inserer les lignes.
app.get('/api/sync/export-retours', async (req, res) => {
    try {
        const activePeriod = await getActivePeriod();
        const mois = Number(req.query.mois || activePeriod.mois);
        const annee = Number(req.query.annee || activePeriod.annee);

        const [rapports, stockDetails, indicateurs] = await Promise.all([
            pool.query(`
                SELECT
                    r.id AS neon_rapport_id,
                    r.entite_id,
                    e.code_structure,
                    e.nom_entite,
                    r.famille_id,
                    f.nom_famille,
                    r.mois,
                    r.annee,
                    r.statut,
                    r.date_soumission
                FROM rapports r
                JOIN entites e ON e.id = r.entite_id
                LEFT JOIN familles f ON f.id = r.famille_id
                WHERE r.mois = $1
                  AND r.annee = $2
                ORDER BY e.nom_entite, r.famille_id NULLS LAST, r.id
            `, [mois, annee]),
            pool.query(`
                SELECT
                    r.id AS neon_rapport_id,
                    r.entite_id,
                    e.code_structure,
                    r.famille_id,
                    r.mois,
                    r.annee,
                    d.medicament_id,
                    m.code1 AS code_med,
                    d.stock_initial,
                    d.quantite_recue,
                    d.quantite_distribuee,
                    d.pertes_ajustements,
                    d.stock_disponible,
                    d.commentaire
                FROM rapports r
                JOIN entites e ON e.id = r.entite_id
                JOIN rapport_stock_details d ON d.rapport_id = r.id
                JOIN medicaments m ON m.id = d.medicament_id
                WHERE r.mois = $1
                  AND r.annee = $2
                ORDER BY e.nom_entite, r.famille_id NULLS LAST, m.dci
            `, [mois, annee]),
            pool.query(`
                SELECT
                    r.id AS neon_rapport_id,
                    r.entite_id,
                    e.code_structure,
                    r.famille_id,
                    r.mois,
                    r.annee,
                    ri.indicateur_id,
                    i.nom_indicateur,
                    i.est_pnsme,
                    ri.val_unique,
                    ri.val_nouvelle,
                    ri.val_ancienne
                FROM rapports r
                JOIN entites e ON e.id = r.entite_id
                JOIN rapport_indicateurs ri ON ri.rapport_id = r.id
                JOIN indicateurs i ON i.id = ri.indicateur_id
                WHERE r.mois = $1
                  AND r.annee = $2
                ORDER BY e.nom_entite, r.famille_id NULLS LAST, i.id
            `, [mois, annee])
        ]);

        res.json({
            ok: true,
            period: { mois, annee },
            counts: {
                rapports: rapports.rows.length,
                rapport_stock_details: stockDetails.rows.length,
                rapport_indicateurs: indicateurs.rows.length
            },
            rapports: rapports.rows,
            rapport_stock_details: stockDetails.rows,
            rapport_indicateurs: indicateurs.rows
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n🏥 Serveur SYGESS TOUMODI démarré');
    console.log('👉 Ouvrez : http://localhost:' + PORT + '\n');
});
