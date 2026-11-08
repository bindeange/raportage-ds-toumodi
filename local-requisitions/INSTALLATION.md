## Réquisitions mSupply dans le rapportage de Toumodi

Le menu district **Réquisitions** affiche les 14 champs ainsi que le numéro et la date de création. Choisissez un mois et utilisez **Importer / actualiser depuis mSupply** dans la version en ligne. Les identifiants saisis servent à la connexion mSupply pour cet import. La sélection suit la date de création en UTC.

Le serveur Render crée la table `msupply_requisition_lines` dans Neon lors du premier accès autorisé. Le magasin est celui de Toumodi. La variable d’environnement `MSUPPLY_STORE_ID` permet de changer le magasin si le déploiement l’exige.

Une fois la version en ligne déployée, copiez les fichiers du dossier `local-requisitions` et `requisitions.sql` dans un même dossier de préparation sur le serveur local. Utilisez PHP CLI et Python 3.8 ou plus récent. Remplacez `/chemin/du/rapportage` par le dossier où se trouve le `login.php` effectivement servi.

```sh
python3 installer.py /chemin/du/rapportage --check
sudo python3 installer.py /chemin/du/rapportage
```

Dans le logiciel local, choisissez le mois dans la synchronisation habituelle et lancez **Récupérer les saisies**. Le journal doit confirmer le nombre de lignes de réquisition récupérées. Le menu **Réquisitions** consulte ensuite la base locale, même sans accès Internet. L’import en ligne et la synchronisation locale peuvent être relancés pour actualiser les valeurs d’un mois déjà traité.

La procédure conserve une sauvegarde des fichiers qu’elle remplace et vérifie la syntaxe PHP avant installation. Le compte PostgreSQL local doit pouvoir créer la table lors du premier accès.
