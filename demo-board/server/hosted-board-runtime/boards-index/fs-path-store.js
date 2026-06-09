import fs from 'node:fs';
import path from 'node:path';

export function createFsPathBoardsStore({ registry }) {
  const ref = registry?.boardsIndexRef;
  const dir = path.normalize(ref.value);
  const deprecatedContainerRef = registry?.deprecatedContainerRef;
  const deprecatedDir = deprecatedContainerRef?.kind === 'fs-path' && typeof deprecatedContainerRef.value === 'string' && deprecatedContainerRef.value.trim()
    ? path.normalize(deprecatedContainerRef.value)
    : '';

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function filePath(id) {
    return path.join(dir, `${id}.json`);
  }

  function formatArchiveStamp(date = new Date()) {
    const pad2 = (value) => String(value).padStart(2, '0');
    return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  }

  function reserveArchiveBase(id) {
    fs.mkdirSync(deprecatedDir, { recursive: true });
    const stamp = formatArchiveStamp();
    let suffix = '';
    let attempt = 1;
    while (true) {
      const archiveBase = `${id}-${stamp}${suffix}`;
      const archiveRecordPath = path.join(deprecatedDir, `${archiveBase}.json`);
      const archiveWorkspaceDir = path.join(deprecatedDir, archiveBase);
      if (!fs.existsSync(archiveRecordPath) && !fs.existsSync(archiveWorkspaceDir)) {
        return { archiveBase, archiveRecordPath, archiveWorkspaceDir };
      }
      attempt += 1;
      suffix = `-${attempt}`;
    }
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

  async function set(id, record) {
    ensureDir();
    fs.writeFileSync(filePath(id), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'w' });
  }

  async function deprecate(id, options = {}) {
    const sourceRecordPath = filePath(id);
    if (!fs.existsSync(sourceRecordPath)) {
      return null;
    }
    const workspaceDir = typeof options.workspaceDir === 'string' && options.workspaceDir.trim()
      ? path.normalize(options.workspaceDir)
      : '';
    if (!deprecatedDir) {
      fs.rmSync(sourceRecordPath, { force: true });
      if (workspaceDir && fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      return {
        archiveId: '',
        archiveRecordPath: '',
        archiveWorkspaceDir: '',
      };
    }

    const { archiveBase, archiveRecordPath, archiveWorkspaceDir } = reserveArchiveBase(id);
    fs.renameSync(sourceRecordPath, archiveRecordPath);

    let movedWorkspaceDir = '';
    if (workspaceDir && fs.existsSync(workspaceDir)) {
      fs.renameSync(workspaceDir, archiveWorkspaceDir);
      movedWorkspaceDir = archiveWorkspaceDir;
    }

    return {
      archiveId: archiveBase,
      archiveRecordPath,
      archiveWorkspaceDir: movedWorkspaceDir,
    };
  }

  return { kind: 'fs-path', list, get, has, put, set, deprecate };
}
