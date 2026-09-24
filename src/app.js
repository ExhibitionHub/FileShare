import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import cors from "cors";
import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { FileNotFoundError } from "./storage.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const SAFE_DINO_ID = /^[A-Za-z0-9_-]{1,80}$/;

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function safeEqual(received, expected) {
  const left = Buffer.from(received || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeAuthorization(config) {
  return (request, response, next) => {
    if (!config.uploadApiKey) return next();
    const bearer = request.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const key = request.get("x-api-key") || bearer;
    if (!safeEqual(key, config.uploadApiKey)) {
      return response.status(401).json({ error: "unauthorized", message: "Clé API absente ou invalide." });
    }
    return next();
  };
}

function baseUrl(request, config) {
  return config.publicBaseUrl || `${request.protocol}://${request.get("host")}`;
}

function publicUrls(request, config, metadata) {
  const base = baseUrl(request, config);
  return {
    imageUrl: `${base}/images/${metadata.id}`,
    shareUrl: `${base}/s/${metadata.id}`,
    qrCodeUrl: `${base}/${metadata.kind === "creation" ? "creations" : "v1/files"}/${metadata.id}/qr`,
  };
}

function passportUrl(config, metadata, fallback) {
  if (metadata.kind !== "creation" || !config.passportBaseUrl) return fallback;
  const url = new URL(config.passportBaseUrl);
  const query = new URLSearchParams({ p: metadata.prefabId, b: metadata.backgroundId, id: metadata.id });
  if (metadata.personality) query.set("personality", metadata.personality);
  if (metadata.roar) query.set("roar", metadata.roar);
  url.hash = `/creation?${query}`;
  return url.href;
}

function parseTtl(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 24 * 365) {
    const error = new Error("expiresInHours doit être compris entre 0 et 8760.");
    error.status = 400;
    error.code = "invalid_expiration";
    throw error;
  }
  return value;
}

function text(value, maxLength) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requireDinoId(value, field) {
  const normalized = text(value, 80);
  if (!normalized || !SAFE_DINO_ID.test(normalized)) {
    const error = new Error(`${field} est absent ou invalide.`);
    error.status = 400;
    error.code = "invalid_creation";
    throw error;
  }
  return normalized;
}

function creationFields(body) {
  let metadata = {};
  if (body.metadata !== undefined && body.metadata !== "") {
    try {
      metadata = JSON.parse(body.metadata);
    } catch {
      throw new RequestError("invalid_creation", "metadata doit être un objet JSON valide.");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new RequestError("invalid_creation", "metadata doit être un objet JSON.");
    }
  }
  return {
    prefabId: requireDinoId(body.prefabId ?? metadata.prefabId, "prefabId"),
    backgroundId: requireDinoId(body.backgroundId ?? metadata.backgroundId, "backgroundId"),
    personality: text(body.personality ?? metadata.personality, 80),
    roar: text(body.roar ?? metadata.roar, 80),
  };
}

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function corsOptions(origins) {
  if (origins === "*") return { origin: true, credentials: false };
  return {
    origin(origin, callback) {
      callback(null, !origin || origins.includes(origin));
    },
  };
}

export function createApp({ config, store }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(cors(corsOptions(config.corsOrigins)));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxImageBytes, files: 1, fields: 12 },
  }).fields([{ name: "file", maxCount: 1 }, { name: "image", maxCount: 1 }]);
  const authorizeWrite = writeAuthorization(config);

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "fileshare" });
  });

  async function createFile(request, response, kind) {
    const file = request.files?.image?.[0] || request.files?.file?.[0];
    if (!file) return response.status(400).json({ error: "missing_file", message: "Envoyez un champ image ou file." });
    const detected = detectImage(file.buffer);
    if (!detected) {
      return response.status(415).json({ error: "unsupported_image", message: "Formats acceptés : PNG, JPEG et WebP." });
    }

    const ttlHours = parseTtl(request.body.expiresInHours, config.defaultTtlHours);
    const now = new Date();
    const common = {
      kind,
      ...detected,
      size: file.size,
      originalName: text(file.originalname, 180) || `image.${detected.extension}`,
      application: text(request.body.application, 80),
      label: text(request.body.label, 160),
      createdAt: now.toISOString(),
      expiresAt: ttlHours ? new Date(now.getTime() + ttlHours * 3_600_000).toISOString() : null,
    };
    const attributes = kind === "creation" ? { ...common, ...creationFields(request.body) } : common;

    const metadata = await store.create(file.buffer, attributes);
    const urls = publicUrls(request, config, metadata);
    response.status(201).json({
      id: metadata.id,
      ...urls,
      ...(kind === "creation" ? { passportUrl: passportUrl(config, metadata, urls.shareUrl) } : {}),
      mimeType: metadata.mimeType,
      size: metadata.size,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
    });
  }

  app.post("/v1/files", authorizeWrite, upload, (request, response, next) => {
    createFile(request, response, "file").catch(next);
  });
  for (const route of ["/creations", "/v1/creations"]) {
    app.post(route, authorizeWrite, upload, (request, response, next) => {
      createFile(request, response, "creation").catch(next);
    });
  }

  app.get("/images/:id", async (request, response, next) => {
    try {
      if (!ID_PATTERN.test(request.params.id)) throw new FileNotFoundError(request.params.id);
      const metadata = await store.get(request.params.id);
      response.type(metadata.mimeType);
      response.set({
        "Cache-Control": metadata.expiresAt ? "public, max-age=3600" : "public, max-age=31536000, immutable",
        "Content-Length": String(metadata.size),
        "Content-Disposition": `inline; filename="${metadata.id}.${metadata.extension}"`,
      });
      createReadStream(store.imagePath(metadata)).on("error", next).pipe(response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/files/:id", async (request, response, next) => {
    try {
      const metadata = await store.get(request.params.id);
      response.json({ ...metadata, ...publicUrls(request, config, metadata) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/creations/:id", async (request, response, next) => {
    try {
      const metadata = await store.get(request.params.id);
      if (metadata.kind !== "creation") throw new FileNotFoundError(request.params.id);
      const urls = publicUrls(request, config, metadata);
      response.json({
        id: metadata.id,
        imageUrl: urls.imageUrl,
        shareUrl: urls.shareUrl,
        qrCodeUrl: urls.qrCodeUrl,
        passportUrl: passportUrl(config, metadata, urls.shareUrl),
        prefabId: metadata.prefabId,
        backgroundId: metadata.backgroundId,
        createdAt: metadata.createdAt,
        expiresAt: metadata.expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  async function sendQr(request, response, next) {
    try {
      const metadata = await store.get(request.params.id);
      const urls = publicUrls(request, config, metadata);
      const target = passportUrl(config, metadata, urls.shareUrl);
      response.type("image/png");
      response.set("Cache-Control", "public, max-age=3600");
      response.send(await QRCode.toBuffer(target, { errorCorrectionLevel: "M", margin: 2, width: 640 }));
    } catch (error) {
      next(error);
    }
  }
  app.get("/v1/files/:id/qr", sendQr);
  app.get("/creations/:id/qr", sendQr);

  app.get("/s/:id", async (request, response, next) => {
    try {
      const metadata = await store.get(request.params.id);
      const { imageUrl } = publicUrls(request, config, metadata);
      const label = htmlEscape(metadata.label || "Image partagée");
      response.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${label}</title><meta property="og:title" content="${label}"><meta property="og:image" content="${htmlEscape(imageUrl)}">
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;font:16px system-ui}main{max-width:1000px;padding:24px;text-align:center}img{max-width:100%;max-height:85vh;border-radius:12px}a{color:#fff}</style></head>
<body><main><h1>${label}</h1><a href="${htmlEscape(imageUrl)}" download><img src="${htmlEscape(imageUrl)}" alt="${label}"></a></main></body></html>`);
    } catch (error) {
      next(error);
    }
  });

  for (const route of ["/v1/files/:id", "/creations/:id"]) {
    app.delete(route, authorizeWrite, async (request, response, next) => {
      try {
        await store.delete(request.params.id);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found", message: "Route inconnue." });
  });
  app.use((error, _request, response, _next) => {
    if (error instanceof FileNotFoundError) {
      return response.status(404).json({ error: "not_found", message: "Image introuvable ou expirée." });
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(413).json({ error: "file_too_large", message: `L'image dépasse ${config.maxImageBytes} octets.` });
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return response.status(status).json({ error: error.code || "internal_error", message: status >= 500 ? "Erreur interne." : error.message });
  });
  return app;
}
