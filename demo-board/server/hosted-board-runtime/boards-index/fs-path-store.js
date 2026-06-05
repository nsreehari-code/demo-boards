import fs from 'node:fs';
import path from 'node:path';

export function createFsPathBoardsStore({ ref }) {
  const dir = path.normalize(ref.value);

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function filePath(id) {
    return path.join(dir, `${id}.json`);
  }

  async function list() {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      out.push({ id, record: JSON.parse(raw) });
    }
    return out;
  }

  async function get(id) {
    const fp = filePath(id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }

  async function has(id) {
    return fs.existsSync(filePath(id));
  }

  async function put(id, record) {
    ensureDir();
    fs.writeFileSync(filePath(id), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
  }

  return { kind: 'fs-path', list, get, has, put };
}
