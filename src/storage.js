import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class FileNotFoundError extends Error {}

export class FileStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.imageDirectory = join(rootDirectory, "images");
    this.metadataDirectory = join(rootDirectory, "metadata");
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
    const id = randomBytes(18).toString("base64url");
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
      if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) {
        await this.delete(id, metadata);
        throw new FileNotFoundError(id);
      }
      return metadata;
    } catch (error) {
      if (error instanceof FileNotFoundError || error?.code === "ENOENT") {
        throw new FileNotFoundError(id);
      }
      throw error;
    }
  }

  async delete(id, knownMetadata = null) {
    let metadata = knownMetadata;
    if (!metadata) metadata = await this.get(id);
    await Promise.all([
      rm(this.imagePath(metadata), { force: true }),
      rm(this.metadataPath(id), { force: true }),
    ]);
  }
}
