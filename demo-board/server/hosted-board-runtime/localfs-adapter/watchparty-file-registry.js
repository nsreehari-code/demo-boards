import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function noop() {}

function emitWarning(onWarn, message, error = null) {
  if (typeof onWarn !== 'function') {
    return;
  }
  if (error instanceof Error && error.message) {
    onWarn(`${message}: ${error.message}`);
    return;
  }
  onWarn(message);
}

function readTextFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function buildWatchpartyNotification(registration, text) {
  if (!text) {
    return {
      kind: 'card_watchparty',
      cardId: registration.cardId,
      channel: registration.channel,
      clear: true,
      sentAtMs: Date.now(),
    };
  }

  return {
    kind: 'card_watchparty',
    cardId: registration.cardId,
    channel: registration.channel,
    replace: registration.replace !== false,
    payload: { text },
    sentAtMs: Date.now(),
  };
}

async function postNotifications(notifyUrl, notifications) {
  const targetUrl = new URL(notifyUrl);
  const requestBody = JSON.stringify({ notifications });
  const transport = targetUrl.protocol === 'https:' ? https : http;

  await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          reject(new Error(responseBody || `HTTP ${status}`));
        });
      },
    );
    request.setTimeout(15000, () => {
      request.destroy(new Error('The operation was aborted due to timeout'));
    });
    request.on('error', reject);
    request.write(requestBody);
    request.end();
  });
}

function createDirectoryEntry(directoryPath, fileName, onWarn) {
  const entry = {
    key: `${directoryPath}::${fileName}`,
    directoryPath,
    fileName,
    registrations: new Set(),
    flushTimer: null,
    watcher: null,
  };

  try {
    entry.watcher = fs.watch(directoryPath, { persistent: false }, (_eventType, changedFileName) => {
      if (typeof changedFileName === 'string' && changedFileName && changedFileName !== entry.fileName) {
        return;
      }
      scheduleFlush(entry, onWarn);
    });
    entry.watcher.on('error', (error) => {
      emitWarning(onWarn, `[watchparty] fs.watch failed for ${entry.key}`, error);
    });
  } catch (error) {
    emitWarning(onWarn, `[watchparty] unable to start watcher for ${entry.key}`, error);
  }

  return entry;
}

function clearFlushTimer(entry) {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
}

function scheduleFlush(entry, onWarn) {
  clearFlushTimer(entry);
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    void flushEntry(entry, onWarn);
  }, 75);
}

async function emitRegistrationUpdate(registration, text, onWarn) {
  const normalizedText = typeof text === 'string' ? text : '';
  const nextHasValue = normalizedText.length > 0;
  if (registration.lastText === normalizedText && registration.lastHadValue === nextHasValue) {
    return;
  }

  registration.lastText = normalizedText;
  registration.lastHadValue = nextHasValue;

  try {
    await postNotifications(registration.notifyUrl, [buildWatchpartyNotification(registration, normalizedText)]);
  } catch (error) {
    emitWarning(onWarn, `[watchparty] notify failed for ${registration.filePath}`, error);
  }
}

async function flushEntry(entry, onWarn) {
  const filePath = path.join(entry.directoryPath, entry.fileName);
  const text = readTextFileIfPresent(filePath);
  await Promise.all(Array.from(entry.registrations, (registration) => emitRegistrationUpdate(registration, text, onWarn)));
}

export function createWatchpartyFileRegistry(options = {}) {
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : noop;
  const entries = new Map();
  const registrations = new Map();

  function getOrCreateEntry(filePath) {
    const directoryPath = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const key = `${directoryPath}::${fileName}`;
    let entry = entries.get(key);
    if (entry) {
      return entry;
    }
    entry = createDirectoryEntry(directoryPath, fileName, onWarn);
    entries.set(key, entry);
    return entry;
  }

  async function registerWatchpartyFile(descriptor = {}) {
    const filePath = typeof descriptor.filePath === 'string' ? descriptor.filePath.trim() : '';
    const notifyUrl = typeof descriptor.notifyUrl === 'string' ? descriptor.notifyUrl.trim() : '';
    const cardId = typeof descriptor.cardId === 'string' ? descriptor.cardId.trim() : '';
    const channel = typeof descriptor.channel === 'string' ? descriptor.channel.trim() : '';

    if (!filePath || !notifyUrl || !cardId || !channel) {
      return noop;
    }

    const entry = getOrCreateEntry(filePath);
    const registration = {
      id: randomUUID(),
      filePath,
      notifyUrl,
      cardId,
      channel,
      replace: descriptor.replace !== false,
      lastText: null,
      lastHadValue: null,
    };

    registrations.set(registration.id, registration);
    entry.registrations.add(registration);

    if (descriptor.clearOnRegister === true) {
      await emitRegistrationUpdate(registration, '', onWarn);
    }

    scheduleFlush(entry, onWarn);

    return async () => {
      const current = registrations.get(registration.id);
      if (!current) {
        return;
      }
      clearFlushTimer(entry);
      await flushEntry(entry, onWarn);
      registrations.delete(registration.id);
      entry.registrations.delete(current);
      if (entry.registrations.size > 0) {
        return;
      }
      if (entry.watcher) {
        try {
          entry.watcher.close();
        } catch {
        }
      }
      entries.delete(entry.key);
    };
  }

  function dispose() {
    for (const unregister of Array.from(registrations.keys(), (registrationId) => {
      const registration = registrations.get(registrationId);
      if (!registration) {
        return noop;
      }
      return () => {
        registrations.delete(registrationId);
      };
    })) {
      try {
        unregister();
      } catch {
      }
    }
    for (const entry of entries.values()) {
      clearFlushTimer(entry);
      if (entry.watcher) {
        try {
          entry.watcher.close();
        } catch {
        }
      }
    }
    entries.clear();
    registrations.clear();
  }

  return {
    registerWatchpartyFile,
    dispose,
  };
}