WITH selection AS (
    SELECT $1::integer AS structure_id, $2::integer AS programme_id,
           $3::timestamptz AS debut, $4::timestamptz AS fin
), structures AS (
    SELECT id, upper(btrim(code_structure)) AS code,
           regexp_replace(translate(upper(nom_entite),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS nom
    FROM entites
    WHERE role = 'USER'
), reference AS (
    SELECT r.requisition_number, r.created_at, r.line_id, r.fields,
           upper(btrim(r.client_code)) AS code_structure,
           regexp_replace(translate(upper(r.fields->>0),
               'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'AAAEEEEIIOOUUUC'), '[^A-Z0-9]+', '', 'g') AS nom_structure,
           upper(btrim(r.fields->>2)) AS code_produit
    FROM msupply_requisition_lines r CROSS JOIN selection s
    WHERE r.created_at >= s.debut AND r.created_at < s.fin
)
SELECT produit.id AS medicament_id, r.requisition_number, r.fields
FROM reference r CROSS JOIN selection s
JOIN LATERAL (
    SELECT min(id) AS id, count(*) AS matches FROM structures
    WHERE code <> '' AND code = r.code_structure
) par_code ON true
JOIN LATERAL (
    SELECT min(id) AS id, count(*) AS matches FROM structures
    WHERE par_code.matches = 0 AND nom <> '' AND nom = r.nom_structure
) par_nom ON true
JOIN LATERAL (
    SELECT min(m.id) AS id FROM medicaments m
    WHERE m.famille_id = s.programme_id AND r.code_produit <> ''
      AND r.code_produit IN (upper(btrim(m.code1)), upper(btrim(m.code2)), upper(btrim(m.code3)),
                             upper(btrim(m.code4)), upper(btrim(m.code5)))
    HAVING count(*) = 1
) produit ON true
WHERE (par_code.matches = 1 AND par_code.id = s.structure_id)
   OR (par_code.matches = 0 AND par_nom.matches = 1 AND par_nom.id = s.structure_id)
ORDER BY r.created_at DESC, r.requisition_number DESC, r.line_id;
