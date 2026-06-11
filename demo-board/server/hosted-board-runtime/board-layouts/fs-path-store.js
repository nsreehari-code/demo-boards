import fs from 'node:fs';
import path from 'node:path';

export function createFsPathBoardLayoutsStore({ registry }) {
  const ref = registry?.boardsLayoutRef;
  const dir = path.normalize(ref.value);

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function filePath(id) {
    return path.join(dir, `${id}.json`);
  }

  async function get(id) {
    const fp = filePath(id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }

  async function set(id, layout) {
    ensureDir();
    fs.writeFileSync(filePath(id), JSON.stringify(layout, null, 2), { encoding: 'utf8', flag: 'w' });
  }

  async function remove(id) {
    const fp = filePath(id);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }

  return { kind: 'fs-path', get, set, remove };
}