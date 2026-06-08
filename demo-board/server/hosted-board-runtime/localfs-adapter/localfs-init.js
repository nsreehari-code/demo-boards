import { createWatchpartyFileRegistry } from './watchparty-file-registry.js';

export async function initializeLocalFsServices(options = {}) {
  return {
    watchpartyFileRegistry: createWatchpartyFileRegistry({
      onWarn: typeof options?.onWarn === 'function'
        ? options.onWarn
        : (message) => console.warn(message),
    }),
  };
}