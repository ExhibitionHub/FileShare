import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { FileStore } from "./storage.js";

const config = loadConfig();
const store = new FileStore(config.dataDir);
await store.init();

const app = createApp({ config, store });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`FileShare écoute sur http://0.0.0.0:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} reçu, arrêt de FileShare.`);
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
