import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { deriveBoardRootFromModuleUrl } from '../../shared/board-root.js';

const BOARD_ROOT = deriveBoardRootFromModuleUrl(import.meta.url, '../..');

export const HOSTED_SERVER_LOG_PATH = path.join(BOARD_ROOT, 'logs', 'hosted-server.log');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return `${MONTHS[date.getMonth()] || '???'}${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  return util.inspect(arg, { depth: 6, breakLength: Infinity, compact: true });
}

function appendLogLine(filePath, line) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch {
    // Logging must never break request handling.
  }
}

export function createLogger(scope, options = {}) {
  const normalizedScope = typeof scope === 'string' && scope.trim() ? scope.trim() : 'runtime';
  const filePath = typeof options.filePath === 'string' && options.filePath.trim() ? options.filePath.trim() : '';
  const mirrorToConsole = options.mirrorToConsole === true;

  function write(method, msg, args) {
    const text = typeof msg === 'string' ? msg : formatArg(msg);
    const suffix = args.length > 0 ? ` ${args.map(formatArg).join(' ')}` : '';
    const line = `${formatTimestamp()} [${normalizedScope}] ${text}${suffix}`;
    if (mirrorToConsole) {
      console[method](line);
    }
    appendLogLine(filePath, line);
  }

  return {
    child(childScope) {
      const suffix = typeof childScope === 'string' && childScope.trim() ? childScope.trim() : '';
      return createLogger(suffix ? suffix : normalizedScope, { filePath, mirrorToConsole });
    },
    info(msg, ...args) {
      write('log', msg, args);
    },
    warn(msg, ...args) {
      write('warn', msg, args);
    },
    error(msg, ...args) {
      write('error', msg, args);
    },
  };
}
