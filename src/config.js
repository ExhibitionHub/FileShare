import "dotenv/config";
import { resolve } from "node:path";

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} doit être un booléen.`);
}

function url(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} doit être une URL HTTP(S).`);
  }
  return parsed.href.replace(/\/$/, "");
}

function origins() {
  const raw = process.env.CORS_ORIGINS?.trim() || "*";
  if (raw === "*") return "*";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function storageDriver() {
  const value = process.env.STORAGE_DRIVER?.trim().toLowerCase() || "filesystem";
  if (!["filesystem", "s3"].includes(value)) throw new Error("STORAGE_DRIVER doit valoir filesystem ou s3.");
  return value;
}

function optional(name) {
  return process.env[name]?.trim() || null;
}

function apiKeys() {
  const combined = [process.env.UPLOAD_API_KEY, process.env.UPLOAD_API_KEYS]
    .filter(Boolean)
    .join(",");
  return [...new Set(combined.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function loadConfig() {
  const driver = storageDriver();
  const defaultTtlHours = integer("DEFAULT_TTL_HOURS", 168, { min: 0, max: 24 * 365 });
  const maxTtlHours = integer("MAX_TTL_HOURS", 720, { min: 1, max: 24 * 365 });
  const allowPermanentFiles = boolean("ALLOW_PERMANENT_FILES", false);
  const uploadApiKeys = apiKeys();
  const allowPublicUploads = boolean("ALLOW_PUBLIC_UPLOADS", process.env.NODE_ENV !== "production");
  if (!allowPermanentFiles && defaultTtlHours === 0) {
    throw new Error("DEFAULT_TTL_HOURS doit être supérieur à zéro lorsque ALLOW_PERMANENT_FILES=false.");
  }
  if (defaultTtlHours > maxTtlHours) throw new Error("DEFAULT_TTL_HOURS ne peut pas dépasser MAX_TTL_HOURS.");

  const config = {
    port: integer("PORT", 3101, { min: 1, max: 65535 }),
    storageDriver: driver,
    dataDir: resolve(process.env.DATA_DIR?.trim() || "data"),
    publicBaseUrl: url("PUBLIC_BASE_URL"),
    passportBaseUrl: url("PASSPORT_BASE_URL"),
    corsOrigins: origins(),
    uploadApiKeys,
    allowPublicUploads,
    maxImageBytes: integer("MAX_IMAGE_BYTES", 5 * 1024 * 1024, {
      min: 1024,
      max: 25 * 1024 * 1024,
    }),
    defaultTtlHours,
    maxTtlHours,
    allowPermanentFiles,
    cleanupEnabled: boolean("CLEANUP_ENABLED", true),
    cleanupIntervalMinutes: integer("CLEANUP_INTERVAL_MINUTES", 15, { min: 1, max: 1440 }),
    cleanupBatchSize: integer("CLEANUP_BATCH_SIZE", 500, { min: 1, max: 10_000 }),
    rateLimitWindowMs: integer("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000, max: 3_600_000 }),
    readRateLimit: integer("READ_RATE_LIMIT", 3000, { min: 1, max: 100_000 }),
    uploadRateLimit: integer("UPLOAD_RATE_LIMIT", 300, { min: 1, max: 100_000 }),
    maxConcurrentUploads: integer("MAX_CONCURRENT_UPLOADS", 20, { min: 1, max: 1000 }),
    maxQueuedUploads: integer("MAX_QUEUED_UPLOADS", 100, { min: 0, max: 10_000 }),
    uploadQueueTimeoutMs: integer("UPLOAD_QUEUE_TIMEOUT_MS", 5000, { min: 100, max: 120_000 }),
    trustProxyHops: integer("TRUST_PROXY_HOPS", 1, { min: 0, max: 10 }),
    requestTimeoutMs: integer("REQUEST_TIMEOUT_MS", 20_000, { min: 1000, max: 300_000 }),
    s3: {
      bucket: optional("S3_BUCKET"),
      region: optional("S3_REGION") || "auto",
      endpoint: optional("S3_ENDPOINT"),
      forcePathStyle: boolean("S3_FORCE_PATH_STYLE", false),
      accessKeyId: optional("S3_ACCESS_KEY_ID"),
      secretAccessKey: optional("S3_SECRET_ACCESS_KEY"),
      prefix: (process.env.S3_PREFIX?.trim() || "fileshare/").replace(/^\/+/, "").replace(/\/*$/, "/"),
    },
  };

  if (driver === "s3") {
    if (!config.s3.bucket) throw new Error("S3_BUCKET est obligatoire avec STORAGE_DRIVER=s3.");
    if (Boolean(config.s3.accessKeyId) !== Boolean(config.s3.secretAccessKey)) {
      throw new Error("S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY doivent être définis ensemble.");
    }
  }
  if (!allowPublicUploads && uploadApiKeys.length === 0) {
    throw new Error("UPLOAD_API_KEY/UPLOAD_API_KEYS est obligatoire lorsque ALLOW_PUBLIC_UPLOADS=false.");
  }
  return config;
}
