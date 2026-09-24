import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createStore } from "./storage.js";

const config = loadConfig();
const store = createStore(config);
await store.init();

const app = createApp({ config, store });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`FileShare écoute sur http://0.0.0.0:${config.port} (stockage ${store.driver})`);
});
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = Math.min(config.requestTimeoutMs, 15_000);
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;

let cleanupRunning = false;
async function cleanup() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const result = await store.cleanupExpired({ limit: config.cleanupBatchSize });
    if (result.deleted || result.errors) console.log("Nettoyage FileShare:", result);
  } catch (error) {
    console.error("Échec du nettoyage FileShare:", error.message);
  } finally {
    cleanupRunning = false;
  }
}
const cleanupTimer = config.cleanupEnabled
  ? setInterval(cleanup, config.cleanupIntervalMinutes * 60_000)
  : null;
cleanupTimer?.unref();
if (config.cleanupEnabled) void cleanup();

function shutdown(signal) {
  console.log(`${signal} reçu, arrêt de FileShare.`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
