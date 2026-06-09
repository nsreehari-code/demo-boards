import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'sample-card-templates');
const DEFAULT_SAMPLE_TEMPLATE_INDEX_FILE = path.resolve(DEFAULT_SAMPLE_TEMPLATE_DIR, '_index.json');

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveSampleTemplateCatalogPaths(hostConfig) {
  const configuredDir = normalizeOptionalString(hostConfig?.sampleTemplateCatalog?.dir);
  const configuredIndexFile = normalizeOptionalString(hostConfig?.sampleTemplateCatalog?.indexFile);
  const boardRoot = normalizeOptionalString(hostConfig?.boardRoot);
  const sampleTemplateDir = configuredDir
    ? path.resolve(configuredDir)
    : boardRoot
      ? path.resolve(boardRoot, 'server', 'hosted-board-runtime', 'sample-card-templates')
      : DEFAULT_SAMPLE_TEMPLATE_DIR;
  const manifestPath = configuredIndexFile
    ? path.resolve(configuredIndexFile)
    : DEFAULT_SAMPLE_TEMPLATE_INDEX_FILE;
  return {
    sampleTemplateDir,
    manifestPath,
    manifestFileName: path.basename(manifestPath),
  };
}

function createStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeManifestEntry(entry) {
  const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
  const fileName = typeof entry?.fileName === 'string' ? entry.fileName.trim() : '';
  const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
  if (!key || !fileName || !label) {
    return null;
  }
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(key)) {
    throw createStatusError(`Sample template manifest contains an invalid key '${key}'`, 500);
  }
  const baseName = path.basename(fileName);
  if (baseName !== fileName) {
    throw createStatusError(`Sample template manifest contains an invalid fileName '${fileName}'`, 500);
  }
  return {
    key,
    fileName,
    label,
    description: typeof entry?.description === 'string' ? entry.description.trim() : '',
  };
}

function loadSampleTemplateManifest(hostConfig) {
  const { sampleTemplateDir, manifestPath, manifestFileName } = resolveSampleTemplateCatalogPaths(hostConfig);
  const manifest = readJsonFile(manifestPath);
  const sourceEntries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const manifestEntries = sourceEntries.map(normalizeManifestEntry).filter(Boolean);
  const seenKeys = new Set();

  for (const entry of manifestEntries) {
    if (seenKeys.has(entry.key)) {
      throw createStatusError(`Sample template manifest contains a duplicate key '${entry.key}'`, 500);
    }
    seenKeys.add(entry.key);
    const templatePath = path.join(sampleTemplateDir, entry.fileName);
    if (!fs.existsSync(templatePath)) {
      throw createStatusError(`Sample template '${entry.fileName}' declared in ${manifestFileName} is missing`, 500);
    }
  }

  return {
    sampleTemplateDir,
    entries: manifestEntries,
  };
}

function resolveSampleTemplateFilePath(sampleTemplateDir, fileName) {
  const normalizedFileName = typeof fileName === 'string' ? fileName.trim() : '';
  if (!normalizedFileName) {
    throw createStatusError('file_name is required', 400);
  }
  const baseName = path.basename(normalizedFileName);
  if (baseName !== normalizedFileName) {
    throw createStatusError(`Invalid template file name '${normalizedFileName}'`, 400);
  }
  const absolutePath = path.resolve(sampleTemplateDir, normalizedFileName);
  const allowedPrefix = `${path.resolve(sampleTemplateDir)}${path.sep}`;
  if (!absolutePath.startsWith(allowedPrefix) && absolutePath !== path.resolve(sampleTemplateDir, normalizedFileName)) {
    throw createStatusError(`Invalid template file name '${normalizedFileName}'`, 400);
  }
  return absolutePath;
}

export function listSampleTemplateEntries(hostConfig) {
  const { entries } = loadSampleTemplateManifest(hostConfig);
  return {
    entries: entries.map(({ key, label, description }) => ({ key, label, description })),
  };
}

export function getSampleTemplateEnvelope(hostConfig, key) {
  const { sampleTemplateDir, entries } = loadSampleTemplateManifest(hostConfig);
  const normalizedKey = typeof key === 'string' ? key.trim() : '';
  if (!normalizedKey) {
    throw createStatusError('key is required', 400);
  }
  const entry = entries.find((candidate) => candidate.key === normalizedKey);
  if (!entry) {
    throw createStatusError(`Sample template '${normalizedKey}' not found`, 404);
  }
  const templatePath = resolveSampleTemplateFilePath(sampleTemplateDir, entry.fileName);
  if (!fs.existsSync(templatePath)) {
    throw createStatusError(`Sample template '${normalizedKey}' is missing`, 404);
  }
  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    payload: readJsonFile(templatePath),
  };
}