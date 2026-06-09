import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function deriveBoardRootFromConfigDir(configDir) {
  return path.resolve(configDir, '..', '..');
}

export function deriveBoardRootFromModuleUrl(moduleUrl, serverDirRelativePath = '.') {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const serverDir = path.resolve(moduleDir, serverDirRelativePath);
  return path.resolve(serverDir, '..');
}