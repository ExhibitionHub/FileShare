import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Readable } from "node:stream";
import { FileStore, S3FileStore } from "../src/storage.js";

test("le nettoyage supprime les images expirées", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fileshare-cleanup-"));
  try {
    const store = new FileStore(directory);
    await store.init();
    const metadata = await store.create(Buffer.from("image"), {
      kind: "file",
      mimeType: "image/png",
      extension: "png",
      size: 5,
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const result = await store.cleanupExpired({ limit: 10 });
    assert.deepEqual(result, { scanned: 1, deleted: 1, errors: 0 });
    await assert.rejects(readFile(store.metadataPath(metadata.id)));
    await assert.rejects(readFile(store.imagePath(metadata)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("le stockage S3 partage et nettoie les objets entre instances", async () => {
  const objects = new Map();
  const client = {
    async send(command) {
      const name = command.constructor.name;
      if (name === "HeadBucketCommand") return {};
      if (name === "PutObjectCommand") {
        objects.set(command.input.Key, Buffer.from(command.input.Body));
        return {};
      }
      if (name === "GetObjectCommand") {
        const body = objects.get(command.input.Key);
        if (!body) return Promise.reject(Object.assign(new Error("missing"), { name: "NoSuchKey" }));
        return { Body: Readable.from([body]) };
      }
      if (name === "DeleteObjectsCommand") {
        for (const object of command.input.Delete.Objects) objects.delete(object.Key);
        return {};
      }
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [...objects.keys()].filter((key) => key.startsWith(command.input.Prefix)).map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      throw new Error(`Commande inattendue : ${name}`);
    },
  };
  const config = { bucket: "test", prefix: "fileshare/", region: "auto", forcePathStyle: false };
  const writer = new S3FileStore(config, client);
  const reader = new S3FileStore(config, client);
  await writer.init();
  const metadata = await writer.create(Buffer.from("image"), {
    kind: "file",
    mimeType: "image/png",
    extension: "png",
    size: 5,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  assert.equal(objects.size, 2);
  const result = await reader.cleanupExpired({ limit: 10 });
  assert.deepEqual(result, { scanned: 1, deleted: 1, errors: 0 });
  assert.equal(objects.size, 0);
  await assert.rejects(reader.get(metadata.id));
});
