export function createLogger(scope) {
  return {
    info: (msg, ...args) => console.log(`[${scope}] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[${scope}] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${scope}] ${msg}`, ...args),
  };
}
