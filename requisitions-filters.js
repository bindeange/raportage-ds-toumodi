(() => {
    const normalize = value => value.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const decimal = value => value.replace(/\s/g, '').replace(',', '.');

    function matches(value, term, numeric) {
        if (!numeric) return normalize(value).includes(term);
        const number = decimal(term);
        return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(number) && Number(decimal(value)) === Number(number);
    }

    window.attachRequisitionFilters = (table, controls) => {
        const body = table.tBodies[0];
        const inputs = [...table.tHead.rows[0].cells].map((cell, index) => {
            const input = document.createElement('input');
            input.type = 'search';
            input.placeholder = 'Filtrer';
            input.autocomplete = 'off';
            input.setAttribute('aria-label', 'Filtrer par ' + cell.textContent.trim());
            if (index >= 6) input.inputMode = 'decimal';
            input.style.cssText = 'display:block;width:100%;min-width:5rem;margin-top:.35rem;box-sizing:border-box;color:#172b3a;background:#fff';
            cell.appendChild(input);
            return input;
        });
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Effacer les filtres';
        const count = document.createElement('span');
        count.setAttribute('role', 'status');
        controls.append(clear, ' ', count);

        function refresh() {
            const filters = inputs.flatMap((input, index) => {
                const term = normalize(input.value);
                return term ? [{ index, term }] : [];
            });
            let visible = 0;
            for (const row of body.rows) {
                row.hidden = !filters.every(({ index, term }) => matches(row.cells[index].textContent, term, index >= 6));
                if (!row.hidden) visible++;
            }
            clear.disabled = filters.length === 0;
            count.textContent = `${visible} / ${body.rows.length} lignes affichées`;
        }

        inputs.forEach(input => input.addEventListener('input', refresh));
        clear.addEventListener('click', () => {
            inputs.forEach(input => { input.value = ''; });
            refresh();
            inputs[0].focus();
        });
        refresh();
        return refresh;
    };
})();
