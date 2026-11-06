// Imported first by index.ts. When the container starts as root (the default on Unraid),
// docker-entrypoint.sh fixes ownership of /data and this drops to PUID:PGID (99:100,
// nobody:users) before anything touches the disk.
if (process.getuid?.() === 0 && process.env.PUID && process.setuid && process.setgid) {
  const uid = Number(process.env.PUID);
  const gid = Number(process.env.PGID ?? process.env.PUID);
  if (uid > 0) {
    process.setgroups?.([gid]);
    process.setgid(gid);
    process.setuid(uid);
  }
}

export {};
