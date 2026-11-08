#!/usr/bin/env python3
"""Installe l'onglet local et le raccordement au bouton SYNCHRO."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def modifications(root):
    here = Path(__file__).resolve().parent
    changes = {name: (here / name).read_bytes() for name in ('requisitions.php', 'requisitions_local.php')}
    schema = here / 'requisitions.sql'
    if not schema.is_file():
        schema = here.parent / 'requisitions.sql'
    changes['requisitions.sql'] = schema.read_bytes()

    header = (root / 'header.php').read_text(encoding='utf-8-sig')
    if 'href="requisitions.php"' not in header:
        marker = re.search(r'''<\?php if\s*\(\s*\$_SESSION\['role'\]\s*===\s*'ADMIN'\s*\)\s*:\s*\?>''', header)
        if not marker:
            raise ValueError('Menu administrateur introuvable dans header.php.')
        header = header[:marker.end()] + '\n            <a href="requisitions.php">Réquisitions</a>' + header[marker.end():]
    changes['header.php'] = header.encode('utf-8')

    sync = (root / 'sync_logic.php').read_text(encoding='utf-8-sig')
    if 'function pullRapportsRetoursFromCloud(' not in sync:
        marker = re.compile(r'(?m)^function pullRetoursFromCloud\(\$pdo,\s*\$m,\s*\$a\)\s*\{')
        if len(marker.findall(sync)) != 1 or 'cloud_auth.php' not in sync:
            raise ValueError('Version de sync_logic.php non reconnue. Installation arrêtée.')
        wrapper = '''require_once __DIR__ . '/requisitions_local.php';

function pullRetoursFromCloud($pdo, $m, $a) {
    $reportLog = pullRapportsRetoursFromCloud($pdo, $m, $a);
    return $reportLog . pullMsupplyRequisitions($pdo, (int)$m, (int)$a);
}

function pullRapportsRetoursFromCloud($pdo, $m, $a) {'''
        sync = marker.sub(lambda _: wrapper, sync, count=1)
    changes['sync_logic.php'] = sync.encode('utf-8')
    return changes


def write_atomic(target, data):
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=target.suffix, delete=False) as file:
        temporary = Path(file.name)
        file.write(data)
    try:
        mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
        temporary.chmod(mode)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Dossier qui contient login.php, header.php et sync_logic.php')
    parser.add_argument('--check', action='store_true', help='Vérifie les points d’intégration sans modifier le site')
    args = parser.parse_args()
    root = args.directory.resolve(strict=True)
    if not (root / 'login.php').is_file() or not (root / 'db.php').is_file():
        parser.error('Ce dossier ne ressemble pas à une installation locale de rapportage.')
    changes = modifications(root)
    php = shutil.which('php')
    if not php and not args.check:
        parser.error('PHP CLI est nécessaire pour vérifier les fichiers avant l’installation.')
    with tempfile.TemporaryDirectory(prefix='sygess-req-check-') as scratch:
        for name, data in changes.items():
            staged = Path(scratch) / name
            staged.write_bytes(data)
            if php and staged.suffix == '.php':
                subprocess.run([php, '-l', str(staged)], check=True)
    if args.check:
        print('Points d’intégration vérifiés.' if php else 'Points d’intégration vérifiés. PHP CLI absent, syntaxe PHP non vérifiée.')
        return

    backup = Path(tempfile.mkdtemp(prefix='sygess-req-backup-'))
    written = []
    for name in changes:
        if (root / name).exists():
            shutil.copy2(root / name, backup / name)
    try:
        for name, data in changes.items():
            write_atomic(root / name, data)
            written.append(name)
    except Exception:
        for name in reversed(written):
            if (backup / name).exists():
                write_atomic(root / name, (backup / name).read_bytes())
            else:
                (root / name).unlink(missing_ok=True)
        raise
    print(f'Installation terminée. Sauvegarde des fichiers : {backup}')


if __name__ == '__main__':
    main()
