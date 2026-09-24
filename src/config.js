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

export function loadConfig() {
  return {
    port: integer("PORT", 3101, { min: 1, max: 65535 }),
    dataDir: resolve(process.env.DATA_DIR?.trim() || "data"),
    publicBaseUrl: url("PUBLIC_BASE_URL"),
    passportBaseUrl: url("PASSPORT_BASE_URL"),
    corsOrigins: origins(),
    uploadApiKey: process.env.UPLOAD_API_KEY?.trim() || null,
    maxImageBytes: integer("MAX_IMAGE_BYTES", 5 * 1024 * 1024, {
      min: 1024,
      max: 25 * 1024 * 1024,
    }),
    defaultTtlHours: integer("DEFAULT_TTL_HOURS", 0, {
      min: 0,
      max: 24 * 365,
    }),
    trustProxy: boolean("TRUST_PROXY", true),
  };
}
