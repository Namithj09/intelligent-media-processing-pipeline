// Filesystem storage adapter. The rest of the app talks to a "storage"
// interface so swapping in S3/GCS later is a one-file change.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config, ensureStorageDir } from "./config";

export interface StoredObject {
  // Path relative to storageDir — what we persist in the DB.
  storagePath: string;
  // Absolute path on disk for the worker to read.
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
}

export async function saveBuffer(
  originalFilename: string,
  data: Buffer,
): Promise<StoredObject> {
  ensureStorageDir();
  // Hash the bytes up-front: it doubles as an exact-duplicate signal and
  // lets us short-circuit duplicate uploads without re-reading from disk.
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  // Use the hash as the on-disk filename so identical uploads collide and
  // we can dedupe at the storage layer.
  const ext = path.extname(originalFilename).toLowerCase() || ".bin";
  const storagePath = path.join(sha256.slice(0, 2), `${sha256}${ext}`);
  const absolutePath = path.join(config.storageDir, storagePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  // Write atomically: write to a temp file then rename. Prevents partial
  // files from being picked up by a worker that polls quickly.
  const tmp = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, absolutePath);
  const stat = await fs.stat(absolutePath);
  return { storagePath, absolutePath, sizeBytes: stat.size, sha256 };
}

export async function readBuffer(absolutePath: string): Promise<Buffer> {
  return fs.readFile(absolutePath);
}

export function absolutePathFor(storagePath: string): string {
  return path.join(config.storageDir, storagePath);
}
