import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { FileStore } from "../src/storage.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let directory;
let app;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fileshare-test-"));
  const store = new FileStore(directory);
  await store.init();
  app = createApp({
    store,
    config: {
      dataDir: directory,
      publicBaseUrl: "https://files.example.test",
      passportBaseUrl: "https://passport.example.test/app/",
      corsOrigins: "*",
      uploadApiKey: "test-key",
      maxImageBytes: 5 * 1024 * 1024,
      defaultTtlHours: 168,
      maxTtlHours: 720,
      allowPermanentFiles: false,
      rateLimitWindowMs: 60_000,
      readRateLimit: 10_000,
      uploadRateLimit: 10_000,
      maxConcurrentUploads: 4,
      maxQueuedUploads: 4,
      uploadQueueTimeoutMs: 1000,
      trustProxyHops: 0,
    },
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("publie une création compatible Dino Passport", async () => {
  const created = await request(app)
    .post("/creations")
    .set("x-api-key", "test-key")
    .field("prefabId", "tyrannosaurus-atavisme")
    .field("backgroundId", "jungle-volcanique")
    .field("personality", "curious")
    .attach("image", PNG, { filename: "dino.png", contentType: "image/png" })
    .expect(201);

  assert.match(created.body.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(created.body.imageUrl, `https://files.example.test/images/${created.body.id}`);
  assert.match(created.body.passportUrl, /^https:\/\/passport\.example\.test\/app\/#\/creation\?/);

  const creation = await request(app).get(`/creations/${created.body.id}`).expect(200);
  assert.equal(creation.body.imageUrl, created.body.imageUrl);

  const image = await request(app).get(`/images/${created.body.id}`).expect(200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.deepEqual(image.body, PNG);

  const qr = await request(app).get(`/creations/${created.body.id}/qr`).expect(200);
  assert.equal(qr.headers["content-type"], "image/png");
});

test("accepte le champ metadata envoyé par Create Your Dino", async () => {
  const created = await request(app)
    .post("/creations")
    .set("x-api-key", "test-key")
    .field("metadata", JSON.stringify({
      prefabId: "triceratops-pics",
      backgroundId: "jungle-volcanique",
      personality: "brave",
      roar: "deep",
      seed: 4,
    }))
    .attach("image", PNG, { filename: "dino.webp", contentType: "image/webp" })
    .expect(201);

  const creation = await request(app).get(`/creations/${created.body.id}`).expect(200);
  assert.equal(creation.body.prefabId, "triceratops-pics");
  assert.equal(creation.body.backgroundId, "jungle-volcanique");
});

test("protège les écritures quand une clé est configurée", async () => {
  await request(app)
    .post("/v1/files")
    .attach("file", PNG, { filename: "image.png", contentType: "image/png" })
    .expect(401);
});

test("refuse un contenu qui n'est pas une image acceptée", async () => {
  await request(app)
    .post("/v1/files")
    .set("authorization", "Bearer test-key")
    .attach("file", Buffer.from("not-an-image"), { filename: "fake.png", contentType: "image/png" })
    .expect(415);
});

test("supprime une image et ses métadonnées", async () => {
  const created = await request(app)
    .post("/v1/files")
    .set("x-api-key", "test-key")
    .attach("file", PNG, { filename: "image.png", contentType: "image/png" })
    .expect(201);

  await request(app).delete(`/v1/files/${created.body.id}`).set("x-api-key", "test-key").expect(204);
  await request(app).get(`/images/${created.body.id}`).expect(404);
  await assert.rejects(readFile(join(directory, "metadata", `${created.body.id}.json`)));
});

test("attribue une expiration automatique", async () => {
  const created = await request(app)
    .post("/v1/files")
    .set("x-api-key", "test-key")
    .attach("file", PNG, { filename: "image.png", contentType: "image/png" })
    .expect(201);
  const lifetime = Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt);
  assert.equal(lifetime, 168 * 3_600_000);
});
