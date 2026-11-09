WITH bounds AS (
    SELECT $1::date AS first_month, $2::date AS last_month
), structures AS (
    SELECT id, nom_entite, code_structure, upper(btrim(code_structure)) AS code,
           regexp_replace(translate(upper(nom_entite),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS nom
    FROM entites WHERE role = 'USER'
), items AS (
    SELECT m.id, m.dci, m.code1, m.famille_id, f.nom_famille,
           array_remove(ARRAY[upper(btrim(m.code1)), upper(btrim(m.code2)), upper(btrim(m.code3)),
               upper(btrim(m.code4)), upper(btrim(m.code5))], '') AS codes,
           regexp_replace(translate(upper(f.nom_famille),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS programme
    FROM medicaments m JOIN familles f ON f.id=m.famille_id
), requisitions AS (
    SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'UTC') - interval '1 month','YYYY-MM') AS month,
           r.requisition_id, r.line_id, r.requisition_number, r.created_at, r.transmitted_at, r.requisition_status,
           r.fields, upper(btrim(r.client_code)) AS client_code,
           regexp_replace(translate(upper(r.fields->>0),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS client_name,
           upper(btrim(r.fields->>2)) AS item_code,
           regexp_replace(translate(upper(r.fields->>1),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS programme
    FROM msupply_requisition_lines r CROSS JOIN bounds b
    WHERE r.created_at >= (b.first_month + interval '1 month') AT TIME ZONE 'UTC'
      AND r.created_at < (b.last_month + interval '2 months') AT TIME ZONE 'UTC'
), mapped AS (
    SELECT r.*,
           CASE WHEN sc.n = 1 THEN sc.id WHEN sc.n = 0 AND sn.n = 1 THEN sn.id END AS structure_id,
           CASE WHEN mc.n = 1 THEN mc.id WHEN mc.pn = 1 THEN mc.pid END AS item_id,
           jsonb_build_object('number',r.requisition_number::text,'id',r.requisition_id,'created',r.created_at,
               'sent',r.transmitted_at,'status',r.requisition_status,'client',r.fields->>0,
               'code',r.fields->>2,'name',r.fields->>3,'programme',r.fields->>1,
               'values',jsonb_build_array(r.fields->4,r.fields->5,r.fields->6,r.fields->9)) AS source
    FROM requisitions r
    CROSS JOIN LATERAL (SELECT count(*) n, min(id) id FROM structures WHERE code <> '' AND code=r.client_code) sc
    CROSS JOIN LATERAL (SELECT count(*) n, min(id) id FROM structures WHERE sc.n=0 AND nom <> '' AND nom=r.client_name) sn
    CROSS JOIN LATERAL (
        SELECT count(*) n, min(id) id, count(*) FILTER (WHERE programme=r.programme AND r.programme<>'') pn,
               min(id) FILTER (WHERE programme=r.programme AND r.programme<>'') pid
        FROM items WHERE r.item_code <> '' AND r.item_code=ANY(codes)
    ) mc
), grouped_requisitions AS (
    SELECT month, structure_id, item_id,
           jsonb_agg(source ORDER BY created_at DESC, requisition_number DESC, line_id) AS msupply
    FROM mapped WHERE structure_id IS NOT NULL AND item_id IS NOT NULL
    GROUP BY month, structure_id, item_id
), physical AS (
    SELECT to_char(make_date(r.annee,r.mois,1),'YYYY-MM') AS month,
           r.entite_id AS structure_id, d.medicament_id AS item_id,
           jsonb_agg(jsonb_build_object('id',r.id,'date',r.date_soumission,'status',r.statut,'values',
               jsonb_build_array(d.stock_initial,d.quantite_recue,d.quantite_distribuee,d.stock_disponible))
               ORDER BY r.date_soumission DESC NULLS LAST,r.id) AS physical
    FROM rapports r JOIN rapport_stock_details d ON d.rapport_id=r.id
    JOIN structures s ON s.id=r.entite_id CROSS JOIN bounds b
    WHERE r.annee * 12 + r.mois BETWEEN extract(year FROM b.first_month)*12+extract(month FROM b.first_month)
                                   AND extract(year FROM b.last_month)*12+extract(month FROM b.last_month)
    GROUP BY 1,r.entite_id,d.medicament_id
), pairs AS (
    SELECT COALESCE(p.month,r.month) AS month, COALESCE(p.structure_id,r.structure_id) AS structure_id,
           COALESCE(p.item_id,r.item_id) AS item_id, r.msupply, p.physical
    FROM physical p FULL JOIN grouped_requisitions r USING (month,structure_id,item_id)
)
SELECT p.month, s.id AS structure_id, s.nom_entite AS structure, i.famille_id AS programme_id,
       i.nom_famille AS programme, i.code1 AS code, i.dci AS item, p.msupply, p.physical, NULL::text AS mapping_issue
FROM pairs p JOIN structures s ON s.id=p.structure_id JOIN items i ON i.id=p.item_id
UNION ALL
SELECT r.month, s.id, COALESCE(s.nom_entite,r.fields->>0), i.famille_id, COALESCE(i.nom_famille,r.fields->>1),
       r.fields->>2, r.fields->>3, jsonb_build_array(r.source), NULL::jsonb,
       CASE WHEN r.structure_id IS NULL THEN 'Structure à rapprocher' ELSE 'Code médicament à rapprocher' END
FROM mapped r LEFT JOIN structures s ON s.id=r.structure_id LEFT JOIN items i ON i.id=r.item_id
WHERE r.structure_id IS NULL OR r.item_id IS NULL
ORDER BY month, structure, programme, item;
