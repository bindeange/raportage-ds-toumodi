<?php

function msupplyRequisitionSchema(PDO $pdo): void {
    $schema = file_get_contents(__DIR__ . '/requisitions.sql');
    if ($schema === false) throw new RuntimeException('Schéma des réquisitions introuvable.');
    $pdo->exec($schema);
}

function msupplyRequisitionMonth(string $month): array {
    if (!preg_match('/\A20\d{2}-(0[1-9]|1[0-2])\z/', $month)) {
        throw new InvalidArgumentException('Sélectionnez un mois valide.');
    }
    $start = new DateTimeImmutable($month . '-01', new DateTimeZone('UTC'));
    return [$start->format(DATE_ATOM), $start->modify('+1 month')->format(DATE_ATOM)];
}

function pullMsupplyRequisitions(PDO $pdo, int $month, int $year): string {
    $period = sprintf('%04d-%02d', $year, $month);
    try {
        [$start, $end] = msupplyRequisitionMonth($period);
        $export = cloudRequest('/api/requisitions?month=' . rawurlencode($period));
        if (($export['ok'] ?? false) !== true || ($export['month'] ?? '') !== $period || !is_array($export['rows'] ?? null)) {
            throw new RuntimeException('Réponse du serveur en ligne invalide.');
        }
        $rows = $export['rows'];
        $seen = [];
        foreach ($rows as $row) {
            $id = $row['requisition_id'] ?? null;
            $line = $row['line_id'] ?? null;
            $fields = $row['fields'] ?? null;
            if (!is_string($id) || $id === '' || !is_string($line) || $line === '' ||
                !is_string($row['created_at'] ?? null) || !is_string($row['imported_at'] ?? null) ||
                !preg_match('/\A[0-9]+\z/', (string)($row['requisition_number'] ?? '')) ||
                !is_array($fields) || count($fields) !== 14 || array_keys($fields) !== range(0, 13)) {
                throw new RuntimeException('Une ligne reçue est incomplète.');
            }
            $created = new DateTimeImmutable($row['created_at']);
            new DateTimeImmutable($row['imported_at']);
            if ($created < new DateTimeImmutable($start) || $created >= new DateTimeImmutable($end)) {
                throw new RuntimeException('Une ligne reçue est hors période.');
            }
            foreach ($fields as $i => $field) {
                if ($i < 4 ? !is_string($field) : (!is_int($field) && !is_float($field))) {
                    throw new RuntimeException('Un champ reçu est invalide.');
                }
            }
            $key = json_encode([$id, $line], JSON_THROW_ON_ERROR);
            if (isset($seen[$key])) throw new RuntimeException('Une ligne reçue est en double.');
            $seen[$key] = true;
        }

        msupplyRequisitionSchema($pdo);
        $pdo->beginTransaction();
        try {
            $statement = $pdo->prepare(
                'INSERT INTO msupply_requisition_lines (requisition_id,line_id,created_at,requisition_number,fields,imported_at)
                 VALUES (:req,:line,:created,:number,CAST(:fields AS jsonb),:imported)
                 ON CONFLICT (requisition_id,line_id) DO UPDATE SET created_at=EXCLUDED.created_at,
                   requisition_number=EXCLUDED.requisition_number,fields=EXCLUDED.fields,imported_at=EXCLUDED.imported_at
                 WHERE msupply_requisition_lines.imported_at <= EXCLUDED.imported_at'
            );
            foreach ($rows as $row) {
                $statement->execute([
                    'req' => $row['requisition_id'], 'line' => $row['line_id'], 'created' => $row['created_at'],
                    'number' => $row['requisition_number'], 'fields' => json_encode($row['fields'], JSON_THROW_ON_ERROR),
                    'imported' => $row['imported_at'],
                ]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        return 'Réquisitions : ' . count($rows) . " ligne(s) synchronisée(s) pour $period.\n";
    } catch (Throwable $e) {
        return "Réquisitions : synchronisation impossible pour $period. Vérifiez la disponibilité de la version en ligne.\n";
    }
}
