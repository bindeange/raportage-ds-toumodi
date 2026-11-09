const fs = require('node:fs');
const path = require('node:path');

const endpoint = 'https://ci-web.msupply.org/graphql';
const defaultStore = '51D5E6E0858F994EAC2EA2BA9CF50574';
const schema = fs.readFileSync(path.join(__dirname, 'requisitions.sql'), 'utf8');
const referenceSql = fs.readFileSync(path.join(__dirname, 'stock-reference.sql'), 'utf8');
const comparisonSql = fs.readFileSync(path.join(__dirname, 'requisition-comparison.sql'), 'utf8');
const loginQuery = `query ($username: String!, $password: String!) {
  authToken(username: $username, password: $password) {
    ... on AuthToken { token user { stores { nodes { id } } } }
  }
}`;
const listQuery = `query ($store: String!, $filter: RequisitionFilterInput, $page: PaginationInput) {
  requisitions(storeId: $store, filter: $filter, page: $page, sort: [{key: requisitionNumber, desc: false}]) {
    ... on RequisitionConnector { totalCount nodes {
      id requisitionNumber createdDatetime sentDatetime status type otherPartyName program { name }
      linkedRequisition { sentDatetime }
      otherParty(storeId: $store) { code }
      lines { totalCount nodes {
        id itemName item { code } initialStockOnHandUnits incomingUnits outgoingUnits lossInUnits additionInUnits
        averageMonthlyConsumption requestedQuantity alreadyIssued remainingQuantityToSupply
      } }
    } }
  }
}`;

function error(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function period(month) {
    if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
        throw error('Sélectionnez un mois valide.');
    }
    const [year, number] = month.split('-').map(Number);
    const start = `${month}-01T00:00:00Z`;
    const end = new Date(Date.UTC(year, number, 1)).toISOString();
    return { start, end };
}

function activityRequisitionPeriod(month) {
    const start = period(month).end;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start, end: end.toISOString() };
}

async function graphql(query, variables, token, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let result;
    try {
        const response = await fetch(endpoint, { method: 'POST', headers, signal, redirect: 'error',
            body: JSON.stringify({ query, variables }) });
        if (!response.ok) throw new Error('HTTP error');
        result = await response.json();
    } catch {
        throw error('mSupply ne répond pas. Réessayez.', 502);
    }
    if (result.errors?.length || !result.data) throw error('mSupply a refusé la lecture des réquisitions.', 502);
    return result.data;
}

function requisitionRows(requisition, bounds) {
    const date = new Date(requisition.createdDatetime);
    if (!requisition.id || !Number.isSafeInteger(requisition.requisitionNumber) ||
        !Number.isFinite(date.getTime()) || date < new Date(bounds.start) || date >= new Date(bounds.end) ||
        requisition.type !== 'RESPONSE' || !Array.isArray(requisition.lines?.nodes) ||
        requisition.lines.nodes.length !== requisition.lines.totalCount) {
        throw error('mSupply a renvoyé une réquisition incomplète ou hors période.', 502);
    }
    const lineIds = new Set();
    return requisition.lines.nodes.map(line => {
        const initial = line.initialStockOnHandUnits;
        const incoming = line.incomingUnits;
        const outgoing = line.outgoingUnits;
        const loss = line.lossInUnits;
        const additions = line.additionInUnits;
        const numbers = [initial, incoming, outgoing, loss, additions,
            initial + incoming - outgoing - loss + additions, line.averageMonthlyConsumption,
            line.requestedQuantity, line.alreadyIssued, line.remainingQuantityToSupply];
        if (!line.id || lineIds.has(line.id) || !numbers.every(Number.isFinite) ||
            ![requisition.otherPartyName, line.item?.code, line.itemName].every(value => typeof value === 'string')) {
            throw error('Une ligne mSupply est incomplète ou répétée.', 502);
        }
        lineIds.add(line.id);
        return {
            requisition_id: requisition.id, line_id: line.id, created_at: date.toISOString(),
            requisition_number: requisition.requisitionNumber,
            client_code: requisition.otherParty?.code ?? null,
            transmitted_at: requisition.linkedRequisition?.sentDatetime ?? requisition.sentDatetime ?? null,
            requisition_status: requisition.status ?? null,
            fields: [requisition.otherPartyName, requisition.program?.name ?? '', line.item.code, line.itemName, ...numbers]
        };
    });
}

async function readRequisitions(username, password, bounds) {
    const store = process.env.MSUPPLY_STORE_ID || defaultStore;
    const signal = AbortSignal.timeout(75000);
    const { authToken } = await graphql(loginQuery, { username, password }, null, signal);
    if (!authToken?.token) throw error('Identifiants mSupply refusés.', 401);
    if (!authToken.user?.stores?.nodes?.some(item => item.id === store)) {
        throw error('Ce compte mSupply ne donne pas accès au magasin du district.', 403);
    }
    const lastDay = new Date(new Date(bounds.end).getTime() - 86400000).toISOString().slice(0, 10);
    const filter = { type: { equalTo: 'RESPONSE' }, createdDatetime: {
        afterOrEqualTo: bounds.start, beforeOrEqualTo: `${lastDay}T23:59:59.999999Z`
    } };
    const ids = new Set();
    const rows = [];
    let expected;
    do {
        const { requisitions } = await graphql(listQuery, { store, filter, page: { first: 20, offset: ids.size } }, authToken.token, signal);
        expected ??= requisitions?.totalCount;
        if (!Number.isInteger(expected) || expected < 0 || requisitions?.totalCount !== expected ||
            !Array.isArray(requisitions.nodes) || (!requisitions.nodes.length && ids.size < expected)) {
            throw error('La liste mSupply est incomplète ou a changé pendant la lecture. Relancez l’import.', 502);
        }
        for (const requisition of requisitions.nodes) {
            if (ids.has(requisition.id)) throw error('La liste mSupply a changé pendant la lecture. Relancez l’import.', 502);
            ids.add(requisition.id);
            for (const row of requisitionRows(requisition, bounds)) rows.push(row);
        }
        if (ids.size > expected) throw error('Nombre de réquisitions mSupply incohérent.', 502);
    } while (ids.size < expected);
    return { rows, count: ids.size };
}

async function saveRows(client, rows, importedAt) {
    for (let i = 0; i < rows.length; i += 500) {
        await client.query(`INSERT INTO msupply_requisition_lines
            (requisition_id, line_id, created_at, requisition_number, fields, imported_at, client_code, transmitted_at, requisition_status)
            SELECT requisition_id, line_id, created_at, requisition_number, fields, $2::timestamptz, client_code, transmitted_at, requisition_status
            FROM jsonb_to_recordset($1::jsonb) AS r(requisition_id text, line_id text, created_at timestamptz,
                requisition_number bigint, fields jsonb, client_code text, transmitted_at timestamptz, requisition_status text)
            ON CONFLICT (requisition_id, line_id) DO UPDATE SET
                created_at=EXCLUDED.created_at, requisition_number=EXCLUDED.requisition_number,
                fields=EXCLUDED.fields, imported_at=EXCLUDED.imported_at,
                client_code=COALESCE(EXCLUDED.client_code, msupply_requisition_lines.client_code),
                transmitted_at=COALESCE(EXCLUDED.transmitted_at, msupply_requisition_lines.transmitted_at),
                requisition_status=COALESCE(EXCLUDED.requisition_status, msupply_requisition_lines.requisition_status)
            WHERE msupply_requisition_lines.imported_at <= EXCLUDED.imported_at`,
        [JSON.stringify(rows.slice(i, i + 500)), importedAt]);
    }
}

function installRequisitions(app, pool) {
    let ready;
    const route = (handler, adminOnly = true) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const role = req.clinicalActor?.role;
        if (role !== 'ADMIN' && (adminOnly || role !== 'USER')) return res.status(403).json({ ok: false, error: 'Accès refusé.' });
        try {
            ready ??= pool.query(schema).catch(err => { ready = null; throw err; });
            await ready;
            await handler(req, res);
        } catch (err) {
            if (!err.status) console.error('Réquisitions : erreur de base de données', err.code || 'inconnue');
            res.status(err.status || 500).json({ ok: false, error: err.status ? err.message : 'La base des réquisitions est indisponible.' });
        }
    };
    app.get('/api/clinical/requisition-stock', route(async (req, res) => {
        const { start, end } = activityRequisitionPeriod(req.query.month);
        const structure = Number(req.query.structure);
        const programme = Number(req.query.programme);
        if (![structure, programme].every(n => Number.isInteger(n) && n > 0 && n <= 2147483647)) {
            throw error('Structure ou programme invalide.');
        }
        const actor = req.clinicalActor;
        if (actor.role !== 'ADMIN' && Number(actor.id) !== structure) {
            const linked = await pool.query(`SELECT 1 FROM agents_asc a JOIN entites e ON e.code_structure=a.code_asc
                WHERE a.code_espc=$1 AND e.id=$2`, [actor.code_structure, structure]);
            if (!linked.rowCount) throw error('Accès limité à votre structure.', 403);
        }
        const { rows } = await pool.query(referenceSql, [structure, programme, start, end]);
        res.json({ ok: true, rows: rows.map(row => ({
            medicament_id: row.medicament_id, requisition_number: row.requisition_number, values: row.fields.slice(4, 10)
        })) });
    }, false));
    app.get('/api/requisitions/comparison', route(async (req, res) => {
        const { start } = period(req.query.month);
        const first = new Date(start);
        first.setUTCMonth(first.getUTCMonth() - 5);
        const { rows } = await pool.query(comparisonSql, [first.toISOString().slice(0, 10), start.slice(0, 10)]);
        res.json({ ok: true, rows });
    }));
    app.get('/api/requisitions', route(async (req, res) => {
        const { start, end } = period(req.query.month);
        const { rows } = await pool.query(`SELECT requisition_id,line_id,created_at,requisition_number,fields,imported_at,client_code,transmitted_at,requisition_status
            FROM msupply_requisition_lines WHERE created_at >= $1 AND created_at < $2
            ORDER BY created_at,requisition_number,line_id`, [start, end]);
        res.json({ ok: true, month: req.query.month, rows });
    }));
    app.post('/api/requisitions/import', route(async (req, res) => {
        const { month, username, password } = req.body || {};
        const bounds = period(month);
        if (typeof username !== 'string' || !username.trim() || username.length > 200 ||
            typeof password !== 'string' || !password || password.length > 512) throw error('Saisissez vos accès mSupply.');
        const importedAt = new Date().toISOString();
        const { rows, count } = await readRequisitions(username.trim(), password, bounds);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await saveRows(client, rows, importedAt);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.json({ ok: true, requisitions: count, lines: rows.length });
    }));
}

module.exports = { installRequisitions, period, requisitionRows, readRequisitions, saveRows };
