<?php
session_start();
if (empty($_SESSION['user_id'])) { header('Location: login.php'); exit; }
if (($_SESSION['role'] ?? '') !== 'ADMIN') { http_response_code(403); exit('Accès réservé au district.'); }
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/requisitions_local.php';

$month = $_GET['month'] ?? gmdate('Y-m');
$rows = [];
$error = '';
try {
    [$start, $end] = msupplyRequisitionMonth(is_string($month) ? $month : '');
    msupplyRequisitionSchema($pdo);
    $statement = $pdo->prepare('SELECT requisition_number, created_at, fields FROM msupply_requisition_lines
        WHERE created_at >= ? AND created_at < ? ORDER BY created_at, requisition_number, line_id');
    $statement->execute([$start, $end]);
    $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
} catch (InvalidArgumentException $e) {
    $error = $e->getMessage();
} catch (Throwable $e) {
    $error = 'Le tableau local des réquisitions est indisponible.';
}
$escape = static fn($value) => htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$labels = ['Réquisition', 'Créée le', 'Nom du client', 'Programme', 'Code', 'Nom du médicament',
    'Stock initial', 'Entrant', 'Sortant', 'Perte', 'Ajouts', 'Disponible', 'CMM', 'Demandé', 'Déjà livré', 'Reste à livrer'];
?>
<!doctype html>
<html lang="fr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Réquisitions mSupply</title>
    <style>
        .req { padding: 1rem; }
        .req form { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
        .req-table { overflow: auto; max-height: 70vh; }
        .req table { border-collapse: collapse; width: 100%; }
        .req th,.req td { padding: .5rem; border: 1px solid #dce3e8; }
        .req th { position: sticky; top: 0; background: #1a4057; color: white; }
        .req td:nth-child(n+7) { text-align: right; }
    </style>
</head>
<body>
<?php require __DIR__ . '/header.php'; ?>
<main class="req">
    <h1>Réquisitions mSupply</h1>
    <form method="get">
        <label>Mois de création <input name="month" type="month" required value="<?= $escape(is_string($month) ? $month : '') ?>"></label>
        <button type="submit">Afficher</button>
        <a href="admin_synchro.php">Synchronisation</a>
    </form>
    <p><?= $error ? $escape($error) : count($rows) . ' ligne(s) enregistrée(s) en local.' ?></p>
    <div class="req-table">
        <table>
            <thead><tr><?php foreach ($labels as $label): ?><th scope="col"><?= $escape($label) ?></th><?php endforeach; ?></tr></thead>
            <tbody>
            <?php foreach ($rows as $row): ?>
                <tr>
                    <td><?= $escape($row['requisition_number']) ?></td>
                    <td><?= $escape((new DateTimeImmutable($row['created_at']))->setTimezone(new DateTimeZone('UTC'))->format('d/m/Y')) ?></td>
                    <?php foreach (json_decode($row['fields'], true, 512, JSON_THROW_ON_ERROR) as $value): ?><td><?= $escape($value) ?></td><?php endforeach; ?>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
</main>
</body>
</html>
