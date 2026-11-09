(() => {
    const scripts = new Map();
    function loadScript(url) {
        if (!scripts.has(url)) {
            const loading = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = url;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            }).catch(error => { scripts.delete(url); throw error; });
            scripts.set(url, loading);
        }
        return scripts.get(url);
    }

    const title = 'Rapport des écarts mSupply';
    const clean = value => String(value ?? '—').replace(/[\u202f\u00a0]/g, ' ').replace(/−/g, '-');
    const filename = report => 'Ecarts-mSupply-' + (report.rows[0]?.month || report.month);
    const structureHeaders = ['Structure', 'Comparables', 'En écart', 'Non comparables'];
    const gapHeaders = ['Structure', 'Médicament / code', 'Champ / résultat', 'SYGESS', 'mSupply', 'Écart', 'Réquisition', 'Transmission'];

    function structureRows(groups) {
        return groups.map(group => [group.label, group.comparable, group.differences, group.unresolved]);
    }

    function gapRows(report) {
        return report.rows.flatMap(row => {
            const item = [row.item, row.code].filter(Boolean).join(' / ');
            const requisitions = [...new Set(row.msupply.map(source => source.number))].join(', ') || '—';
            const sent = row.msupply.length === 1 ? report.dateLabel(row.msupply[0].sent) : '—';
            if (!row.deltas) return [[row.structure, item, row.mapping_issue || report.statuses[row.status], '—', '—', '—', requisitions, sent]];
            return row.deltas.flatMap((delta, i) => delta === 0 ? [] : [[row.structure, item, report.fields[i],
                report.valueLabel(row.physical[0].values[i]), report.valueLabel(row.msupply[0].values[i]),
                report.deltaLabel(delta), requisitions, sent]]);
        });
    }

    function kpi(report) {
        const s = report.summarize(report.rows);
        const rate = s.comparable ? (100 * s.differences / s.comparable).toFixed(1).replace('.', ',') + ' %' : '—';
        return `${s.transmitted} ligne(s) avec date de transmission · ${s.comparable} comparable(s) · ${s.differences} en écart (${rate}) · ${s.unresolved} non comparable(s)`;
    }

    async function pdf(report) {
        await loadScript(report.assets.pdf);
        await loadScript(report.assets.table);
        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const label = (text, x, y, size = 10) => {
            doc.setFontSize(size);
            doc.text(clean(text), x, y, { maxWidth: 270 });
        };
        const grid = (head, body, startY) => doc.autoTable({
            head: [head.map(clean)], body: body.map(row => row.map(clean)), startY, margin: { top: 16, left: 12, right: 12 },
            styles: { fontSize: 8, overflow: 'linebreak', cellPadding: 2.3 }, headStyles: { fillColor: [24, 68, 93] },
            alternateRowStyles: { fillColor: [241, 247, 250] }
        });
        label(title, 12, 15, 21);
        label(report.title, 12, 24, 13);
        label(kpi(report), 12, 33);
        label('Écart = SYGESS - mSupply. Le rapport est comparé aux réquisitions créées le mois suivant.', 12, 40);
        const peak = Math.max(1, ...report.trend.flatMap(month => report.series.map(series => month[series.key])));
        const step = Math.max(1, Math.ceil(peak / 4));
        const x = i => 28 + i * 48;
        const y = value => 126 - value * 72 / (step * 4);
        for (let tick = 0; tick <= 4; tick++) {
            const count = tick * step;
            doc.setDrawColor('#dbe5ec');
            doc.line(22, y(count), 276, y(count));
            label(count, 12, y(count) + 1, 8);
        }
        report.series.forEach((series, index) => {
            doc.setDrawColor(series.color);
            doc.setLineWidth(.6);
            report.trend.slice(1).forEach((month, i) => doc.line(x(i), y(report.trend[i][series.key]), x(i + 1), y(month[series.key])));
            doc.line(13 + index * 67, 148, 18 + index * 67, 148);
            label(series.label, 20 + index * 67, 149, 8);
        });
        report.trend.forEach((month, index) => label(report.monthLabel(month.month), x(index) - 8, 136, 8));
        doc.addPage();
        label('Compilation par structure', 12, 13, 14);
        grid(structureHeaders, structureRows(report.groups), 18);
        doc.addPage();
        label('Détail des écarts et des lignes non comparables', 12, 13, 14);
        const details = gapRows(report);
        if (details.length) grid(gapHeaders, details, 18);
        else label('Aucun écart ni ligne non comparable dans cette sélection.', 12, 24);
        for (let page = 1; page <= doc.getNumberOfPages(); page++) {
            doc.setPage(page);
            label(`${page} / ${doc.getNumberOfPages()}`, 273, 204, 8);
        }
        doc.save(filename(report) + '.pdf');
    }

    async function powerpoint(report) {
        await loadScript(report.assets.ppt);
        const ppt = new window.PptxGenJS();
        ppt.layout = 'LAYOUT_WIDE';
        ppt.title = title;
        ppt.lang = 'fr-FR';
        const blue = '18445D';
        function slide(heading, subtitle) {
            const page = ppt.addSlide();
            page.addText(heading, { x: .55, y: .4, w: 12.25, h: .5, fontSize: 24, bold: true, color: blue });
            if (subtitle) page.addText(clean(subtitle), { x: .55, y: 1, w: 12.15, h: .5, fontSize: 12, color: '475F72' });
            return page;
        }
        function grid(page, head, body, widths) {
            page.addTable([head.map(text => ({ text, options: { bold: true, color: 'FFFFFF', fill: blue } })),
                ...body.map(row => row.map(clean))], {
                x: .55, y: 1.55, w: 12.15, colW: widths, fontFace: 'Arial', fontSize: 10, margin: .06,
                rowH: .34, border: { color: 'D9E4ED', pt: .6 }, color: '192F43'
            });
        }
        const cover = slide(title, report.title);
        cover.addText(clean(kpi(report)), { x: .55, y: 1.65, w: 12, h: .7, fontSize: 21, bold: true, color: blue });
        cover.addText('Écart = SYGESS - mSupply\nLes réquisitions créées le mois suivant sont comparées au rapport du mois d’activité.',
            { x: .55, y: 2.55, w: 12, h: 1, fontSize: 15, color: '475F72' });
        const trend = slide('De la transmission aux écarts', 'Nombre de lignes sur six mois');
        trend.addChart(ppt.ChartType.line, report.series.map(series => ({
            name: series.label, labels: report.trend.map(month => report.monthLabel(month.month)),
            values: report.trend.map(month => month[series.key])
        })), {
            x: .65, y: 1.55, w: 11.9, h: 5.35, chartColors: report.series.map(series => series.color.slice(1)),
            showLegend: true, legendPos: 'b', valAxisMinVal: 0, lineSize: 2
        });
        const structures = structureRows(report.groups);
        for (let offset = 0; offset < structures.length; offset += 12) {
            const page = slide('Compilation par structure', `${offset + 1}–${Math.min(offset + 12, structures.length)} sur ${structures.length} structures`);
            grid(page, structureHeaders, structures.slice(offset, offset + 12), [6.7, 1.8, 1.7, 1.95]);
        }
        const details = gapRows(report);
        for (let offset = 0; offset < Math.min(details.length, 24); offset += 8) {
            const page = slide('Détail des écarts et des rapprochements', `${offset + 1}–${Math.min(offset + 8, details.length)} sur ${details.length} entrées · Détail complet dans le PDF`);
            grid(page, gapHeaders, details.slice(offset, offset + 8), [2, 2.8, 2.5, .75, .75, .65, 1.2, 1.5]);
        }
        await ppt.writeFile({ fileName: filename(report) + '.pptx' });
    }

    window.downloadRequisitionComparison = (format, report) => format === 'pdf' ? pdf(report) : powerpoint(report);
})();
