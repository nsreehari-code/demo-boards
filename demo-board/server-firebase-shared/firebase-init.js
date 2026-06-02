import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireFromShared = createRequire(import.meta.url);
const firebaseResolutionPaths = [
  path.resolve(__dirname, '../server-controlface-firebase'),
  path.resolve(__dirname, '../server-queue-runner-firebase'),
  process.cwd(),
];

let firebaseCompatPromise = null;

async function loadFirebaseCompat() {
  if (!firebaseCompatPromise) {
    firebaseCompatPromise = (async () => {
      const appModulePath = requireFromShared.resolve('firebase/compat/app', { paths: firebaseResolutionPaths });
      const firestoreModulePath = requireFromShared.resolve('firebase/compat/firestore', { paths: firebaseResolutionPaths });
      const storageModulePath = requireFromShared.resolve('firebase/compat/storage', { paths: firebaseResolutionPaths });

      const firebaseAppMod = await import(pathToFileURL(appModulePath).href);
      await import(pathToFileURL(firestoreModulePath).href);
      await import(pathToFileURL(storageModulePath).href);
      return firebaseAppMod.default;
    })();
  }
  return firebaseCompatPromise;
}

function normalizeFirebaseConfig(source) {
  const config = source?.firebaseConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length === 0) {
    throw new Error('firebase.firebaseConfig is required');
  }
  return config;
}

export function initializeFirebaseServices(firebaseOptions = {}) {
  const firebaseConfig = normalizeFirebaseConfig(firebaseOptions);
  const appName = typeof firebaseOptions.appName === 'string' && firebaseOptions.appName.trim()
    ? firebaseOptions.appName.trim()
    : `demo-board-firebase-${firebaseConfig.projectId || 'default'}`;

  return loadFirebaseCompat().then((firebase) => {
    const existing = firebase.apps.find((app) => app.name === appName);
    const app = existing || firebase.initializeApp(firebaseConfig, appName);

    return {
      app,
      firestore: app.firestore(),
      storage: app.storage(),
    };
  });
}
