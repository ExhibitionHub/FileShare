import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export class FileNotFoundError extends Error {}

function newId() {
  return randomBytes(18).toString("base64url");
}

function expired(metadata) {
  return Boolean(metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now());
}

async function bodyToString(body) {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString("utf-8");
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export class FileStore {
  constructor(rootDirectory) {
    this.driver = "filesystem";
    this.rootDirectory = rootDirectory;
    this.imageDirectory = join(rootDirectory, "images");
    this.metadataDirectory = join(rootDirectory, "metadata");
    this.cleanupOffset = 0;
  }

  async init() {
    await Promise.all([
      mkdir(this.imageDirectory, { recursive: true }),
      mkdir(this.metadataDirectory, { recursive: true }),
    ]);
  }

  metadataPath(id) {
    return join(this.metadataDirectory, `${id}.json`);
  }

  imagePath(metadata) {
    return join(this.imageDirectory, `${metadata.id}.${metadata.extension}`);
  }

  async create(buffer, attributes) {
    const id = newId();
    const metadata = { id, ...attributes };
    const imagePath = this.imagePath(metadata);
    const metadataPath = this.metadataPath(id);
    const temporaryMetadataPath = `${metadataPath}.${randomBytes(5).toString("hex")}.tmp`;

    await writeFile(imagePath, buffer, { flag: "wx" });
    try {
      await writeFile(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryMetadataPath, metadataPath);
    } catch (error) {
      await Promise.allSettled([rm(imagePath, { force: true }), rm(temporaryMetadataPath, { force: true })]);
      throw error;
    }
    return metadata;
  }

  async get(id) {
    try {
      const metadata = JSON.parse(await readFile(this.metadataPath(id), "utf8"));
      if (expired(metadata)) {
        await this.delete(id, metadata);
        throw new FileNotFoundError(id);
      }
      return metadata;
    } catch (error) {
      if (error instanceof FileNotFoundError || error?.code === "ENOENT") throw new FileNotFoundError(id);
      throw error;
    }
  }

  async openReadStream(metadata) {
    return createReadStream(this.imagePath(metadata));
  }

  async delete(id, knownMetadata = null) {
    let metadata = knownMetadata;
    if (!metadata) metadata = await this.get(id);
    await Promise.all([
      rm(this.imagePath(metadata), { force: true }),
      rm(this.metadataPath(id), { force: true }),
    ]);
  }

  async cleanupExpired({ limit = 500 } = {}) {
    let scanned = 0;
    let deleted = 0;
    let errors = 0;
    const names = (await readdir(this.metadataDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    if (this.cleanupOffset >= names.length) this.cleanupOffset = 0;
    const selected = names.slice(this.cleanupOffset, this.cleanupOffset + limit);
    this.cleanupOffset = this.cleanupOffset + selected.length >= names.length ? 0 : this.cleanupOffset + selected.length;
    for (const name of selected) {
      scanned += 1;
      try {
        const metadata = JSON.parse(await readFile(join(this.metadataDirectory, name), "utf8"));
        if (expired(metadata)) {
          await this.delete(metadata.id, metadata);
          deleted += 1;
        }
      } catch {
        errors += 1;
      }
    }
    return { scanned, deleted, errors };
  }
}

export class S3FileStore {
  constructor(config, client = null) {
    this.driver = "s3";
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.cleanupToken = undefined;
    const options = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.accessKeyId ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } } : {}),
    };
    this.client = client || new S3Client(options);
  }

  imageKey(id) {
    return `${this.prefix}images/${id}`;
  }

  metadataKey(id) {
    return `${this.prefix}metadata/${id}.json`;
  }

  async init() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async create(buffer, attributes) {
    const id = newId();
    const metadata = { id, ...attributes };
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.imageKey(id),
      Body: buffer,
      ContentType: metadata.mimeType,
      CacheControl: metadata.expiresAt ? "public, max-age=3600" : "public, max-age=31536000, immutable",
    }));
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.metadataKey(id),
        Body: `${JSON.stringify(metadata)}\n`,
        ContentType: "application/json",
        CacheControl: "no-store",
      }));
    } catch (error) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: [{ Key: this.imageKey(id) }], Quiet: true },
      })).catch(() => {});
      throw error;
    }
    return metadata;
  }

  async get(id) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.metadataKey(id) }));
      const metadata = JSON.parse(await bodyToString(result.Body));
      if (expired(metadata)) {
        await this.delete(id);
        throw new FileNotFoundError(id);
      }
      return metadata;
    } catch (error) {
      if (error instanceof FileNotFoundError || error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
        throw new FileNotFoundError(id);
      }
      throw error;
    }
  }

  async openReadStream(metadata) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.imageKey(metadata.id) }));
    return result.Body;
  }

  async delete(id) {
    await this.client.send(new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: [{ Key: this.imageKey(id) }, { Key: this.metadataKey(id) }], Quiet: true },
    }));
  }

  async cleanupExpired({ limit = 500 } = {}) {
    const page = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `${this.prefix}metadata/`,
      MaxKeys: limit,
      ContinuationToken: this.cleanupToken,
    }));
    this.cleanupToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    let scanned = 0;
    let deleted = 0;
    let errors = 0;
    for (const item of page.Contents || []) {
      const match = item.Key?.match(/\/([^/]+)\.json$/);
      if (!match) continue;
      scanned += 1;
      try {
        await this.get(match[1]);
      } catch (error) {
        if (error instanceof FileNotFoundError) deleted += 1;
        else errors += 1;
      }
    }
    return { scanned, deleted, errors };
  }
}

export function createStore(config) {
  return config.storageDriver === "s3" ? new S3FileStore(config.s3) : new FileStore(config.dataDir);
}
