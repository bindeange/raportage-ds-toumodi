(() => {
    const element = id => document.getElementById(`requisitions-${id}`);
    const labels = ['Réquisition', 'Créée le', 'Nom du client', 'Programme', 'Code', 'Nom du médicament',
        'Stock initial', 'Entrant', 'Sortant', 'Perte', 'Ajouts', 'Disponible', 'CMM',
        'Demandé', 'Déjà livré', 'Reste à livrer'];
    const dateLabel = timestamp => timestamp.slice(0, 10).split('-').reverse().join('/');
    const header = element('head').insertRow();
    for (const label of labels) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        header.appendChild(cell);
    }

    async function request(path, data) {
        const options = { headers: { Authorization: `Bearer ${window.clinicalToken}` } };
        if (data) {
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(data);
        }
        const response = await fetch(path, options);
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Opération impossible.');
        return result;
    }

    async function load(month) {
        const { rows } = await request(`/api/requisitions?month=${encodeURIComponent(month)}`);
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
            const tr = document.createElement('tr');
            for (const value of [row.requisition_number, dateLabel(row.created_at), ...row.fields]) {
                tr.insertCell().textContent = String(value);
            }
            fragment.appendChild(tr);
        }
        element('body').replaceChildren(fragment);
        return rows.length;
    }

    let running = false;
    async function run(importRequested) {
        if (!isDistrict() || running || !element('month').reportValidity()) return;
        running = true;
        const month = element('month').value;
        const buttons = [element('read'), element('import').querySelector('button')];
        buttons.forEach(button => { button.disabled = true; });
        element('month').disabled = true;
        element('body').replaceChildren();
        const status = element('status');
        status.textContent = importRequested ? 'Lecture des réquisitions dans mSupply…' : 'Chargement des réquisitions…';
        let imported;
        try {
            if (importRequested) {
                const password = element('password').value;
                element('password').value = '';
                imported = await request('/api/requisitions/import', { month, username: element('user').value, password });
            }
            const count = await load(month);
            status.textContent = imported
                ? `${imported.requisitions} réquisition(s) lue(s). ${count} ligne(s) enregistrée(s) pour ${month}.`
                : `${count} ligne(s) enregistrée(s) pour ${month}.`;
        } catch (err) {
            status.textContent = imported ? `Import enregistré. Affichage impossible : ${err.message}` : err.message;
        } finally {
            buttons.forEach(button => { button.disabled = false; });
            element('month').disabled = false;
            running = false;
        }
    }

    element('read').addEventListener('click', () => run(false));
    element('month').addEventListener('change', () => run(false));
    element('import').addEventListener('submit', event => { event.preventDefault(); run(true); });
    window.showDistrictRequisitions = () => {
        if (!isDistrict()) return;
        setDistrictTab('requisitions');
        if (!element('month').value) element('month').value = `${currentA}-${String(currentM).padStart(2, '0')}`;
        run(false);
    };
})();
