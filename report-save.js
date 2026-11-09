// One connection and one transaction: never replace a report partially.
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const locked = status => ['TRANSMIS', 'Saisi', 'SAISI', 'Valide', 'Validé', 'VALIDE', 'VALIDÉ'].includes(status);
function number(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(label + ' invalide.');
    return value;
}
// Imports supply explicit IDs, which do not advance PostgreSQL serial sequences.
// Repair only a proven collision on the sole ID primary key, never a business key.
async function repairIdSequence(pool, error) {
    if (error.code !== '23505' || !['rapports', 'rapport_stock_details', 'rapport_indicateurs'].includes(error.table)
        || error.schema && error.schema !== 'public' || !error.constraint) return false;
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query(`LOCK TABLE public.${error.table} IN SHARE ROW EXCLUSIVE MODE`);
        const meta = await c.query(`SELECT pg_get_serial_sequence(format('%I.%I', n.nspname, t.relname), 'id') AS sequence_name
            FROM pg_constraint p JOIN pg_class t ON t.oid=p.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='id'
            WHERE n.nspname='public' AND t.relname=$1 AND p.conname=$2
              AND p.contype='p' AND p.conkey=ARRAY[a.attnum]::smallint[]`, [error.table, error.constraint]);
        const sequence = meta.rows[0]?.sequence_name;
        if (!sequence) { await c.query('ROLLBACK'); return false; }
        // Never move a counter backwards, even if a concurrent writer advanced it.
        await c.query(`SELECT setval($1::regclass,
            GREATEST(COALESCE((SELECT MAX(id) FROM public.${error.table}),0),
                     COALESCE(pg_sequence_last_value($1::regclass),0))+1, false)`, [sequence]);
        await c.query('COMMIT');
        console.info('Repaired report ID sequence:', error.table);
        return true;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally { c.release(); }
}
async function saveReport(pool, actor, body) {
    const repaired = new Set();
    for (;;) {
        try { return await saveReportOnce(pool, actor, body); }
        catch (e) {
            if (repaired.has(e.table) || !await repairIdSequence(pool, e)) throw e;
            repaired.add(e.table);
        }
    }
}
async function saveReportOnce(pool, actor, body) {
    if (!actor || !['ADMIN', 'USER'].includes(actor.role)) throw fail('Connexion requise.', 401);
    const { entite_id, famille_id, mois, annee, stocks, indicateurs } = body;
    for (const v of [entite_id, famille_id, mois, annee]) if (!Number.isInteger(v) || v <= 0) throw fail('Structure, famille ou période invalide.');
    if (mois > 12 || annee < 2020 || annee > 2100) throw fail('Période invalide.');
    if (actor.role !== 'ADMIN' && Number(actor.id) !== entite_id) throw fail('Accès limité à votre structure.', 403);
    if (!Array.isArray(stocks) || !Array.isArray(indicateurs) || stocks.length > 2000 || indicateurs.length > 2000 || !stocks.length && !indicateurs.length) throw fail('Le rapport ne contient aucune ligne valide.');
    for (const [rows, key] of [[stocks, 'medicament_id'], [indicateurs, 'indicateur_id']]) {
        if (rows.some(r => !r || !Number.isInteger(r[key]) || r[key] <= 0) || new Set(rows.map(r => r[key])).size !== rows.length) throw fail('Lignes invalides ou en double.');
    }
    for (const row of stocks) {
        for (const k of ['stock_initial', 'quantite_recue', 'quantite_distribuee', 'stock_disponible']) {
            if (number(row[k], k) < 0) throw fail('Les quantités de stock doivent être positives ou nulles.');
        }
        if (number(row.perte, 'Perte') < 0) throw fail('La perte doit être positive ou nulle.');
        if (number(row.ajustement, 'Ajout') < 0) throw fail('L’ajout doit être positif ou nul.');
        const expected = row.stock_initial + row.quantite_recue - row.quantite_distribuee - row.perte + row.ajustement;
        if (Math.round(expected * 1000) !== Math.round(row.stock_disponible * 1000)) {
            throw fail('Bilan de stock incorrect pour le médicament ' + row.medicament_id
                + ' : disponible attendu ' + Number(expected.toFixed(3)) + ', saisi ' + row.stock_disponible
                + '. Règle : initial + reçu - distribué - perte + ajout.');
        }
        for (const [quantity, label] of [['perte', 'la perte'], ['ajustement', 'l’ajout']]) {
            const reason = row['justification_' + quantity];
            if (reason != null && (typeof reason !== 'string' || reason.length > 10000)) throw fail('Justification invalide.');
            if (row[quantity] !== 0 && !reason?.trim()) throw fail('Justifiez ' + label + ' pour le médicament ' + row.medicament_id + '.');
        }
    }
    for (const row of indicateurs) for (const k of ['val_unique', 'val_nouvelle', 'val_ancienne']) if (number(row[k], k) < 0) throw fail('Indicateur négatif.');
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stock-report:' + [entite_id, famille_id, mois, annee].join(':')]);
        if (!(await c.query('SELECT id FROM entites WHERE id=$1', [entite_id])).rows.length) throw fail('Structure introuvable.');
        if (!(await c.query('SELECT id FROM familles WHERE id=$1', [famille_id])).rows.length) throw fail('Famille introuvable.');
        if (actor.role !== 'ADMIN') {
            const p = (await c.query("SELECT cle,valeur FROM parametres WHERE cle IN ('mois_actif','annee_active')")).rows;
            if (Number(p.find(x => x.cle === 'mois_actif')?.valeur) !== mois || Number(p.find(x => x.cle === 'annee_active')?.valeur) !== annee) throw fail('La période active a changé. Rechargez le rapport.', 409);
            const existing = await c.query('SELECT statut FROM rapports WHERE entite_id=$1 AND (famille_id=$2 OR famille_id IS NULL) AND mois=$3 AND annee=$4 FOR UPDATE', [entite_id, famille_id, mois, annee]);
            if (existing.rows.some(r => locked(r.statut))) throw fail('Ce rapport est verrouillé. Le district doit le rouvrir.', 409);
        }
        for (const [rows, table, key] of [[stocks, 'medicaments', 'medicament_id'], [indicateurs, 'indicateurs', 'indicateur_id']]) {
            const valid = await c.query(`SELECT id FROM ${table} WHERE famille_id=$1 AND id=ANY($2::int[])`, [famille_id, rows.map(r => r[key])]);
            if (valid.rows.length !== rows.length) throw fail('Une ligne ne correspond pas à cette famille. Rechargez le rapport.');
        }
        const result = await c.query(`INSERT INTO rapports (entite_id,famille_id,mois,annee,statut,date_soumission)
            VALUES ($1,$2,$3,$4,'TRANSMIS',NOW()) ON CONFLICT (entite_id,famille_id,mois,annee)
            DO UPDATE SET statut='TRANSMIS',date_soumission=NOW() RETURNING id`, [entite_id, famille_id, mois, annee]);
        const id = result.rows[0]?.id;
        if (!id) throw Error('En-tête non enregistré.');
        await c.query('DELETE FROM rapport_stock_details WHERE rapport_id=$1', [id]);
        await c.query('DELETE FROM rapport_indicateurs WHERE rapport_id=$1', [id]);
        for (const r of stocks) {
            const saved = await c.query(`INSERT INTO rapport_stock_details
                (rapport_id,medicament_id,stock_initial,quantite_recue,quantite_distribuee,perte,ajustement,stock_disponible,justification_perte,justification_ajustement)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING medicament_id`,
            [id, r.medicament_id, r.stock_initial, r.quantite_recue, r.quantite_distribuee, r.perte, r.ajustement,
                r.stock_disponible, r.justification_perte?.trim() || null, r.justification_ajustement?.trim() || null]);
            if (saved.rowCount !== 1) throw Error('Ligne de stock non enregistrée.');
        }
        for (const r of indicateurs) {
            const saved = await c.query('INSERT INTO rapport_indicateurs (rapport_id,indicateur_id,val_unique,val_nouvelle,val_ancienne) VALUES ($1,$2,$3,$4,$5) RETURNING indicateur_id', [id, r.indicateur_id, r.val_unique, r.val_nouvelle, r.val_ancienne]);
            if (saved.rowCount !== 1) throw Error('Indicateur non enregistré.');
        }
        await c.query('COMMIT');
        return { ok: true, rapport_id: id, stocks: stocks.length, indicateurs: indicateurs.length };
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally { c.release(); }
}
module.exports = { saveReport, repairIdSequence };
