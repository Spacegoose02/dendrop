# Backups and restoring

Dendrop backs itself up: a snapshot of the database (taken safely while people chat) and,
by default, every uploaded file (pictures, attachments, emoji, stickers), as one
`dendrop-backup-<time>.tar.gz`. Super admins manage them in **Instance admin → Backups**.

## Where they go

Backups are written to `DENDROP_BACKUP_DIR`, or `/data/backups` without it. Keeping them on
the same disk as the data doesn't help much if that disk dies, so point it somewhere else:

- **Unraid:** the template has a **Backups** path, `/backups` in the container, on
  `/mnt/user/backups/dendrop` by default: a share on the array, while appdata usually lives on
  the cache pool. Existing installs: Docker tab → Dendrop → Edit, **Add another Path** (container
  `/backups`, host a share), and **Add another Variable** `DENDROP_BACKUP_DIR` = `/backups`.
- **docker compose:** `BACKUP_PATH` and `DENDROP_BACKUP_DIR` in `.env` (see `.env.example`).

The container makes the folder belong to `PUID:PGID` when it starts.

## Schedule

| Setting | Default | |
| --- | --- | --- |
| Make one every | day | 6 or 12 hours, a day, 2 days, a week, or never (by hand only). |
| Keep the newest | 7 | Older ones are deleted after each new backup. |
| Include uploaded files | on | Off: the database only, which is much smaller. |

**Back up now** makes one straight away. **Download** saves one to your computer, which is a
good habit before updating Dendrop. Every backup made, downloaded, restored or deleted shows
in the instance audit log.

The backup has everything the server keeps, including password hashes, sign-in secrets for
two-step sign-in, and DM messages (end-to-end encrypted ones stay encrypted). Keep backups
somewhere only you can read.

## Restoring

1. In **Instance admin → Backups**, pick a backup and **Restore…**. That copies it to
   `/data/restore.tar.gz`. (Or copy any backup there yourself, e.g. into
   `/mnt/user/appdata/dendrop/restore.tar.gz`.)
2. Restart the container (Unraid: Docker tab → Dendrop → Restart).

When Dendrop starts and finds `restore.tar.gz`, it checks it's a Dendrop backup, moves the
current database (and uploads, if the backup has them) to `/data/before-restore-<time>/`, puts
the backup's in place, and renames the file to `restore.tar.gz.done`. Nothing is deleted: if
it wasn't the backup you wanted, stop the container and move things back from that folder.
A file that isn't a Dendrop backup, or is from a newer Dendrop, is renamed to
`restore.tar.gz.failed` and nothing changes.

Moving to a new machine works the same way: install Dendrop there, drop the backup in as
`restore.tar.gz`, and start it.

### By hand

The backups are ordinary `.tar.gz` files. With the container stopped:

```sh
cd /mnt/user/appdata/dendrop
mkdir old && mv dendrop.db* uploads old/
tar xzf /mnt/user/backups/dendrop/dendrop-backup-....tar.gz dendrop.db uploads
chown -R 99:100 .
```

## Unraid's own backups

The **Appdata Backup** plugin also works: it stops the container, copies the appdata folder
and starts it again. Dendrop's own backups don't need the container stopped and can be
downloaded from the app, so the two go well together.
