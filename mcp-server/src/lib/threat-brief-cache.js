import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const caches = new Map();

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function createThreatBriefCache(filePath) {
  const resolvedPath = path.resolve(filePath);
  const existing = caches.get(resolvedPath);
  if (existing) return existing;

  let entries;
  let writeOperation = Promise.resolve();

  async function load() {
    if (entries) return entries;
    try {
      const parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
      entries = new Map(Object.entries(parsed));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      entries = new Map();
    }
    return entries;
  }

  const cache = {
    async get(key) {
      const loaded = await load();
      const value = loaded.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      const loaded = await load();
      loaded.set(key, structuredClone(value));
      writeOperation = writeOperation.then(() => atomicWrite(
        resolvedPath,
        `${JSON.stringify(Object.fromEntries(loaded), null, 2)}\n`,
      ));
      await writeOperation;
    },
  };

  caches.set(resolvedPath, cache);
  return cache;
}
