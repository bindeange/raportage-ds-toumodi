(() => {
    const fields = ['Stock initial', 'Reçu', 'Dispensé', 'Stock disponible'];
    const monthFormat = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'UTC' });
    const fmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
    const monthLabel = month => monthFormat.format(new Date(month + '-01T00:00:00Z'));
    const dateLabel = value => value ? dateFormat.format(new Date(value)) : 'Non renseignée';
    const valueLabel = value => value == null ? '—' : fmt.format(value);
    const deltaLabel = value => (value > 0 ? '+' : '') + valueLabel(value);
    const searchKey = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const series = [
        { key: 'received', label: 'Lignes mSupply', color: '#147d82', includes: row => row.msupply?.length },
        { key: 'transmitted', label: 'Transmission datée', color: '#3959a1', includes: row => row.msupply?.some(source => source.sent) },
        { key: 'entered', label: 'Lignes saisies dans SYGESS', color: '#68559b', includes: row => row.physical?.length },
        { key: 'comparable', label: 'Lignes comparables', color: '#28764d', includes: row => row.deltas !== null },
        { key: 'differences', label: 'Lignes en écart', color: '#b42318', includes: row => row.status === 'different' }
    ];
    const statuses = {
        different: 'Écart', equal: 'Conforme', 'missing-msupply': 'Réquisition absente',
        'missing-physical': 'Saisie SYGESS absente', ambiguous: 'Plusieurs sources possibles',
        unmapped: 'Rapprochement nécessaire', incomplete: 'Valeur manquante'
    };

    function classify(row) {
        const msupply = row.msupply ?? [];
        const physical = row.physical ?? [];
        let status;
        let deltas = null;
        if (row.mapping_issue) status = 'unmapped';
        else if (msupply.length > 1 || physical.length > 1) status = 'ambiguous';
        else if (!msupply.length) status = 'missing-msupply';
        else if (!physical.length) status = 'missing-physical';
        else if (![msupply[0].values, physical[0].values].every(values =>
            Array.isArray(values) && values.length === fields.length && values.every(Number.isFinite))) status = 'incomplete';
        else {
            deltas = fields.map((_, i) => (Math.round(physical[0].values[i] * 1000) - Math.round(msupply[0].values[i] * 1000)) / 1000);
            status = deltas.some(value => value !== 0) ? 'different' : 'equal';
        }
        return { ...row, msupply, physical, status, deltas };
    }

    function summarize(rows) {
        const comparable = rows.filter(row => row.deltas).length;
        return {
            total: rows.length, comparable, unresolved: rows.length - comparable,
            ...Object.fromEntries(series.map(item => [item.key, rows.filter(item.includes).length]))
        };
    }

    function groupStructures(rows) {
        const groups = new Map();
        for (const row of rows) {
            const id = row.structure_id ? String(row.structure_id) : 'name:' + row.structure;
            const group = groups.get(id) || { id, label: row.structure || 'Structure inconnue', rows: [] };
            group.rows.push(row);
            groups.set(id, group);
        }
        return [...groups.values()].map(group => ({ ...group, ...summarize(group.rows) }))
            .sort((a, b) => b.differences - a.differences || b.unresolved - a.unresolved || a.label.localeCompare(b.label, 'fr'));
    }

    function table(host, headers, lines) {
        const wrapper = document.createElement('div');
        wrapper.className = 'rc-scroll';
        const grid = document.createElement('table');
        const header = grid.createTHead().insertRow();
        headers.forEach(label => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = label;
            header.appendChild(th);
        });
        const body = grid.createTBody();
        for (const line of lines) {
            const tr = body.insertRow();
            line.forEach(value => {
                const cell = tr.insertCell();
                cell.textContent = String(value ?? '—');
            });
        }
        wrapper.appendChild(grid);
        host.replaceChildren(wrapper);
    }

    function chart(host, stats, month, choose) {
        const svg = (name, attrs) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', name);
            Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
            return element;
        };
        const plot = svg('svg', { viewBox: '0 0 720 224', role: 'group', 'aria-label': 'Graphique interactif · ' + monthLabel(month) });
        const peak = Math.max(1, ...series.map(item => stats[item.key]));
        const text = (group, label, xValue, yValue, anchor) => {
            const node = svg('text', { x: xValue, y: yValue, 'text-anchor': anchor, fill: '#4e6274', 'font-size': 12 });
            node.textContent = label;
            group.appendChild(node);
        };
        series.forEach((item, index) => {
            const count = stats[item.key];
            const y = 14 + index * 42;
            const width = count * 410 / peak;
            const bar = svg('g', {
                role: 'button', tabindex: 0, 'aria-label': `${monthLabel(month)}, ${item.label} : ${count}`
            });
            const tip = svg('title', {});
            tip.textContent = `${item.label} · ${count}`;
            bar.append(tip, svg('rect', { x: 206, y, width: 410, height: 25, rx: 4, fill: '#e7eff4' }));
            if (count) bar.appendChild(svg('rect', { x: 206, y, width: Math.max(2, width), height: 25, rx: 4, fill: item.color }));
            text(bar, item.label, 195, y + 17, 'end');
            text(bar, fmt.format(count), 216 + width, y + 17, 'start');
            bar.addEventListener('click', () => choose(item));
            bar.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(item); }
            });
            plot.appendChild(bar);
        });
        host.replaceChildren(plot);
    }

    const markup = `
        <h2>Écarts mSupply</h2>
        <p>Contrôle de cohérence entre les valeurs rapportées dans mSupply et celles recueillies dans SYGESS. Les réquisitions sont créées le mois suivant. Écart = SYGESS − mSupply.</p>
        <div class="rc-filters">
            <label>Mois d’activité <input data-rc="month" type="month" required></label>
            <label>Structure <select data-rc="structure"><option value="">Toutes</option></select></label>
            <label>Programme <select data-rc="programme"><option value="">Tous</option></select></label>
            <label>Médicament ou code <input data-rc="item" type="search"></label>
        </div>
        <p data-rc="status" role="status"></p>
        <div class="rc-kpis" data-rc="kpis"></div>
        <section class="rc-panel">
            <h3>De la transmission aux écarts</h3>
            <div class="rc-chart" data-rc="chart"></div>
            <p class="rc-caption">Cliquez sur une barre ou un chiffre pour ouvrir les sources du mois sélectionné.</p>
            <div data-rc="timeline"></div>
        </section>
        <section class="rc-panel"><h3>Comparaison par structure</h3><div data-rc="structures"></div></section>
        <section class="rc-panel" data-rc="details" hidden>
            <h3 data-rc="detail-title" tabindex="-1"></h3>
            <div class="rc-actions">
                <button type="button" data-view="differences">Comparaison</button>
                <button type="button" data-view="msupply">Source mSupply</button>
                <button type="button" data-view="physical">Source SYGESS</button>
                <button type="button" data-rc="pdf">Télécharger le PDF</button>
                <button type="button" data-rc="ppt">Télécharger le PowerPoint</button>
            </div>
            <p data-rc="detail-count" role="status"></p>
            <div data-rc="table"></div>
            <div class="rc-actions"><button type="button" data-rc="prev">Précédent</button><button type="button" data-rc="next">Suivant</button></div>
        </section>`;

    window.mountRequisitionComparison = (root, options) => {
        root.classList.add('rc');
        root.innerHTML = markup;
        const el = name => root.querySelector('[data-rc="' + name + '"]');
        const month = el('month');
        let rows = [];
        let chosen;
        let monthStats;
        let view = 'differences';
        let page = 0;
        let generation = 0;
        let loaded = false;
        month.value = options.month;

        const structureKey = row => row.structure_id ? String(row.structure_id) : 'name:' + row.structure;
        const programmeKey = row => row.programme_id ? String(row.programme_id) : 'name:' + row.programme;
        function fillSelect(select, key, label, empty) {
            const previous = select.value;
            const entries = [...new Map(rows.map(row => [key(row), row[label] || 'Non rapproché']))];
            entries.sort((a, b) => a[1].localeCompare(b[1], 'fr'));
            select.replaceChildren(new Option(empty, ''), ...entries.map(([id, name]) => new Option(name, id)));
            if (entries.some(([id]) => id === previous)) select.value = previous;
        }

        const baseColumns = ['Structure', 'Programme', 'Code', 'Médicament'];
        const prefix = row => [row.structure, row.programme, row.code, row.item];
        function detailRows() {
            if (view === 'msupply') return {
                headers: [...baseColumns, 'Réquisition', 'Créée le', 'Transmise le', 'Statut', ...fields],
                lines: chosen.rows.flatMap(row => row.msupply.map(source =>
                    [...prefix(row), source.number, dateLabel(source.created), dateLabel(source.sent), source.status || 'Non renseigné',
                        ...source.values.map(valueLabel)]))
            };
            if (view === 'physical') return {
                headers: [...baseColumns, 'Rapport', 'Date de saisie', 'Statut', ...fields],
                lines: chosen.rows.flatMap(row => row.physical.map(source =>
                    [...prefix(row), source.id, dateLabel(source.date), source.status, ...source.values.map(valueLabel)]))
            };
            return {
                headers: [...baseColumns, 'Résultat', 'Réquisitions', ...fields.map(field => 'Δ ' + field)],
                lines: chosen.rows.map(row => [...prefix(row), row.mapping_issue || statuses[row.status],
                    [...new Set(row.msupply.map(source => source.number))].join(', ') || '—',
                    ...(row.deltas ? row.deltas.map(deltaLabel) : fields.map(() => '—'))])
            };
        }

        function drawDetail() {
            const { headers, lines } = detailRows();
            const offset = page * 30;
            table(el('table'), headers, lines.slice(offset, offset + 30));
            el('detail-count').textContent = lines.length
                ? `${offset + 1}–${Math.min(offset + 30, lines.length)} sur ${lines.length} lignes` : 'Aucune ligne dans cette vue.';
            el('prev').disabled = page === 0;
            el('next').disabled = offset + 30 >= lines.length;
            el('pdf').disabled = el('ppt').disabled = chosen.rows.length === 0;
            root.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
        }

        function showDetails(title, selected, newView, focus = false) {
            chosen = { title, rows: selected };
            view = newView;
            page = 0;
            el('details').hidden = false;
            el('detail-title').textContent = title;
            drawDetail();
            if (focus) {
                el('detail-title').focus({ preventScroll: true });
                el('details').scrollIntoView({ block: 'nearest' });
            }
        }

        function buttonGrid(host, headers, items) {
            table(host, headers, items.map(item => item.map(cell => typeof cell === 'object' ? cell.label : cell)));
            [...host.querySelectorAll('tbody tr')].forEach((row, i) => {
                items[i].forEach((cell, j) => {
                    if (typeof cell !== 'object') return;
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = cell.label;
                    button.disabled = cell.disabled || false;
                    button.addEventListener('click', cell.click);
                    row.cells[j].replaceChildren(button);
                });
            });
        }

        function render() {
            if (!loaded) return;
            const search = searchKey(el('item').value.trim());
            const visible = rows.filter(row => (!el('structure').value || structureKey(row) === el('structure').value) &&
                (!el('programme').value || programmeKey(row) === el('programme').value) &&
                searchKey([row.item, row.code, ...row.msupply.map(source => source.code)].join(' ')).includes(search));
            const current = visible.filter(row => row.month === month.value);
            const stats = monthStats = summarize(current);
            const rate = stats.comparable ? fmt.format(100 * stats.differences / stats.comparable) + ' %' : '—';
            el('kpis').replaceChildren(...[
                ['Transmission datée', stats.transmitted], ['Lignes comparables', stats.comparable],
                ['Lignes en écart', stats.differences], ['Taux d’écart', rate], ['Non comparables', stats.unresolved]
            ].map(([label, value]) => {
                const card = document.createElement('div');
                const amount = document.createElement('strong');
                amount.textContent = value;
                card.append(amount, document.createTextNode(label));
                return card;
            }));
            const choose = item => showDetails(`${item.label} · ${monthLabel(month.value)}`,
                current.filter(item.includes),
                item.key === 'entered' ? 'physical' : ['comparable', 'differences'].includes(item.key) ? 'differences' : 'msupply', true);
            chart(el('chart'), stats, month.value, choose);
            buttonGrid(el('timeline'), ['Mois', ...series.map(item => item.label)], [[
                monthLabel(month.value), ...series.map(item => ({ label: String(stats[item.key]), click: () => choose(item) }))
            ]]);
            const groups = groupStructures(current);
            buttonGrid(el('structures'), ['Structure', 'Comparables', 'En écart', 'Non comparables'], groups.map(group => [
                { label: group.label, click: () => showDetails(`${group.label} · ${monthLabel(month.value)}`, group.rows, 'differences', true) },
                group.comparable, group.differences, group.unresolved
            ]));
            showDetails('Détail · ' + monthLabel(month.value), current, 'differences');
        }

        async function load() {
            if (!month.reportValidity()) return;
            const sequence = ++generation;
            loaded = false;
            el('status').textContent = 'Chargement des données…';
            el('details').hidden = true;
            ['kpis', 'chart', 'timeline', 'structures'].forEach(name => el(name).replaceChildren());
            try {
                const result = await options.load(month.value);
                if (sequence !== generation) return;
                rows = result.map(classify);
                fillSelect(el('structure'), structureKey, 'structure', 'Toutes');
                fillSelect(el('programme'), programmeKey, 'programme', 'Tous');
                el('status').textContent = rows.length ? '' : 'Aucune donnée pour cette période.';
                loaded = true;
                render();
            } catch (error) {
                if (sequence === generation) el('status').textContent = error.message || 'Impossible de charger la comparaison.';
            }
        }

        month.addEventListener('change', load);
        ['structure', 'programme'].forEach(name => el(name).addEventListener('change', render));
        el('item').addEventListener('input', render);
        root.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
            view = button.dataset.view; page = 0; drawDetail();
        }));
        el('prev').addEventListener('click', () => { page--; drawDetail(); });
        el('next').addEventListener('click', () => { page++; drawDetail(); });
        ['pdf', 'ppt'].forEach(format => el(format).addEventListener('click', async () => {
            el('pdf').disabled = el('ppt').disabled = true;
            try {
                await window.downloadRequisitionComparison(format, {
                    title: chosen.title, rows: chosen.rows, monthStats, groups: groupStructures(chosen.rows), fields, series, statuses, summarize,
                    monthLabel, dateLabel, deltaLabel, valueLabel, month: month.value, assets: options.assets
                });
            } catch (error) {
                el('status').textContent = 'L’export n’a pas pu être créé. Réessayez.';
            } finally {
                el('pdf').disabled = el('ppt').disabled = !chosen.rows.length;
            }
        }));
        load();
        return load;
    };
})();
