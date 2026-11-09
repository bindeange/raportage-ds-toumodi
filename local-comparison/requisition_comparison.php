<?php
session_start();
if (empty($_SESSION['user_id'])) { header('Location: login.php'); exit; }
if (($_SESSION['role'] ?? '') !== 'ADMIN') { http_response_code(403); exit('Accès réservé au district.'); }
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/requisitions_local.php';

if (isset($_GET['data'])) {
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store');
    try {
        [$start] = msupplyRequisitionMonth(is_string($_GET['month'] ?? null) ? $_GET['month'] : '');
        $month = (new DateTimeImmutable($start))->format('Y-m-d');
        $sql = file_get_contents(__DIR__ . '/requisition-comparison.sql');
        $statement = $pdo->prepare(preg_replace('/\$[12]/', '?', $sql));
        $statement->execute([$month, $month]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            foreach (['msupply', 'physical'] as $column) {
                $row[$column] = $row[$column] === null ? null : json_decode($row[$column], true, 512, JSON_THROW_ON_ERROR);
            }
        }
        unset($row);
        echo json_encode(['ok' => true, 'rows' => $rows], JSON_THROW_ON_ERROR);
    } catch (InvalidArgumentException $error) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => $error->getMessage()]);
    } catch (Throwable $error) {
        error_log('Comparaison mSupply : ' . $error->getCode());
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'Comparaison indisponible.']);
    }
    exit;
}

$settings = $pdo->query("SELECT cle, valeur FROM parametres WHERE cle IN ('mois_actif','annee_active')")->fetchAll(PDO::FETCH_KEY_PAIR);
$month = sprintf('%04d-%02d', (int)($settings['annee_active'] ?? gmdate('Y')), (int)($settings['mois_actif'] ?? gmdate('n')));
?>
<!doctype html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Écarts mSupply</title>
    <link rel="stylesheet" href="requisition-comparison.css">
</head>
<body>
<?php require __DIR__ . '/header.php'; ?>
<main id="comparison" style="padding:1rem"></main>
<script src="requisition-comparison-export.js?v=mensuel"></script>
<script src="requisition-comparison.js?v=mensuel"></script>
<script>
window.mountRequisitionComparison(document.getElementById('comparison'), {
    month: <?= json_encode($month) ?>,
    assets: { pdf: 'requisition-pdf.js', table: 'requisition-pdf-table.js', ppt: 'requisition-ppt.js' },
    async load(month) {
        const response = await fetch('requisition_comparison.php?data=1&month=' + encodeURIComponent(month),
            { signal: AbortSignal.timeout(20000) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Comparaison indisponible.');
        return result.rows;
    }
});
</script>
</body>
</html>
