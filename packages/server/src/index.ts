import "./privileges.js";
import { buildApp } from "./app.js";
import { restoreIfAsked } from "./backup.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
// A backup dropped in as <data>/restore.tar.gz is restored before the database opens.
await restoreIfAsked(config.dataDir);
const { app } = await buildApp(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
app.log.info(config.tls ? `HTTPS on, with the certificate in ${config.tls.cert}` : "Plain HTTP: put a reverse proxy with HTTPS in front, or set DENDROP_HTTPS, so encryption and calls work in browsers");
if (!config.publicUrl) app.log.warn("DENDROP_PUBLIC_URL isn't set: single sign-on is off and cookies aren't marked secure");
