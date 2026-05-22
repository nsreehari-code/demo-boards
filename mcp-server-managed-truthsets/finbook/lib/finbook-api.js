'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./finbook-core');

const DISCARD_JOURNAL_OPERATION = 'finbook.discard_journal_entries';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDb(filePath) {
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
}

function saveDb(filePath, db) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(db, null, 2), 'utf-8');
  return resolved;
}

function getJournalFilePath(dbFilePath) {
  const resolved = path.resolve(dbFilePath);
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.journal.jsonl`);
}

function getSampleDbFilePath(dbFilePath) {
  const resolved = path.resolve(dbFilePath);
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.sample${parsed.ext || '.json'}`);
}

function getSampleJournalFilePath(dbFilePath) {
  const resolved = path.resolve(dbFilePath);
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.sample.journal.jsonl`);
}

function ensureRuntimeFilesFromSamples(dbFilePath, options = {}) {
  const resolvedDbPath = path.resolve(dbFilePath);
  const resolvedJournalPath = getJournalFilePath(resolvedDbPath);
  const sampleDbPath = path.resolve(options.sampleDbPath || getSampleDbFilePath(resolvedDbPath));
  const sampleJournalPath = path.resolve(options.sampleJournalPath || getSampleJournalFilePath(resolvedDbPath));

  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

  const result = {
    dbPath: resolvedDbPath,
    journalPath: resolvedJournalPath,
    sampleDbPath,
    sampleJournalPath,
    dbCreated: false,
    journalCreated: false
  };

  if (!fs.existsSync(resolvedDbPath) && fs.existsSync(sampleDbPath)) {
    fs.copyFileSync(sampleDbPath, resolvedDbPath);
    result.dbCreated = true;
  }

  if (!fs.existsSync(resolvedJournalPath) && fs.existsSync(sampleJournalPath)) {
    fs.copyFileSync(sampleJournalPath, resolvedJournalPath);
    result.journalCreated = true;
  }

  return result;
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Journal entry must be an object.');
  }
  if (!entry.operation || typeof entry.operation !== 'string') {
    throw new Error('Journal entry operation is required.');
  }
  if (entry.payload != null && (typeof entry.payload !== 'object' || Array.isArray(entry.payload))) {
    throw new Error('Journal entry payload must be an object.');
  }
  const normalized = {
    entryId: typeof entry.entryId === 'string' && entry.entryId ? entry.entryId : crypto.randomUUID(),
    version: Number.isInteger(entry.version) ? entry.version : 1,
    operation: entry.operation,
    payload: clone(entry.payload || {}),
    createdAt: typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : new Date().toISOString()
  };
  if (entry.meta && typeof entry.meta === 'object' && !Array.isArray(entry.meta)) {
    normalized.meta = clone(entry.meta);
  }
  return normalized;
}

function createJournalEntry(operation, payload, meta) {
  return normalizeJournalEntry({ operation, payload, meta });
}

function createDiscardJournalEntry(entryIds, meta) {
  const normalizedEntryIds = [...new Set((entryIds || []).filter((entryId) => typeof entryId === 'string' && entryId))];
  if (normalizedEntryIds.length === 0) {
    throw new Error('discard entryIds are required.');
  }
  return createJournalEntry(DISCARD_JOURNAL_OPERATION, { entryIds: normalizedEntryIds }, meta);
}

function getLastProcessedEntryId(db) {
  return db && db._system && db._system.journal && typeof db._system.journal.lastProcessedEntryId === 'string'
    ? db._system.journal.lastProcessedEntryId
    : null;
}

function setLastProcessedEntryId(db, entryId) {
  if (!db._system || typeof db._system !== 'object' || Array.isArray(db._system)) {
    db._system = {};
  }
  if (!db._system.journal || typeof db._system.journal !== 'object' || Array.isArray(db._system.journal)) {
    db._system.journal = {};
  }
  if (entryId) {
    db._system.journal.lastProcessedEntryId = entryId;
  } else {
    delete db._system.journal.lastProcessedEntryId;
    if (Object.keys(db._system.journal).length === 0) delete db._system.journal;
    if (Object.keys(db._system).length === 0) delete db._system;
  }
  return getLastProcessedEntryId(db);
}

function ensureUniqueJournalEntryIds(entries) {
  const seen = new Set();
  entries.forEach((entry) => {
    if (seen.has(entry.entryId)) {
      throw new Error(`Duplicate journal entryId: ${entry.entryId}`);
    }
    seen.add(entry.entryId);
  });
}

function getPendingJournalEntries(db, entries, opts = {}) {
  const normalizedEntries = (entries || []).map((entry) => normalizeJournalEntry(entry));
  ensureUniqueJournalEntryIds(normalizedEntries);
  const lastProcessedEntryId = Object.prototype.hasOwnProperty.call(opts, 'lastProcessedEntryId')
    ? opts.lastProcessedEntryId
    : getLastProcessedEntryId(db);
  if (!lastProcessedEntryId) {
    return normalizedEntries;
  }
  for (let index = normalizedEntries.length - 1; index >= 0; index -= 1) {
    if (normalizedEntries[index].entryId === lastProcessedEntryId) {
      return normalizedEntries.slice(index + 1);
    }
  }
  throw new Error(`lastProcessedEntryId "${lastProcessedEntryId}" not found in journal.`);
}

function getDiscardedJournalEntryIds(entries) {
  const discardedEntryIds = new Set();
  (entries || []).forEach((entry) => {
    if (entry.operation !== DISCARD_JOURNAL_OPERATION) return;
    const entryIds = Array.isArray(entry.payload && entry.payload.entryIds) ? entry.payload.entryIds : [];
    entryIds.forEach((entryId) => {
      if (typeof entryId === 'string' && entryId) {
        discardedEntryIds.add(entryId);
      }
    });
  });
  return discardedEntryIds;
}

function getActiveJournalEntries(entries) {
  const normalizedEntries = (entries || []).map((entry) => normalizeJournalEntry(entry));
  ensureUniqueJournalEntryIds(normalizedEntries);
  const discardedEntryIds = getDiscardedJournalEntryIds(normalizedEntries);
  return normalizedEntries.filter((entry) => (
    entry.operation !== DISCARD_JOURNAL_OPERATION && !discardedEntryIds.has(entry.entryId)
  ));
}

function loadJournal(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  if (!content.trim()) {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeJournalEntry(JSON.parse(line)));
}

function saveJournal(filePath, entries) {
  const resolved = path.resolve(filePath);
  const normalized = (entries || []).map((entry) => normalizeJournalEntry(entry));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const text = normalized.length > 0
    ? `${normalized.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    : '';
  fs.writeFileSync(resolved, text, 'utf-8');
  return resolved;
}

function appendJournalEntries(filePath, entries) {
  const resolved = path.resolve(filePath);
  const normalized = (entries || []).map((entry) => normalizeJournalEntry(entry));
  if (normalized.length === 0) {
    return [];
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(
    resolved,
    `${normalized.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8'
  );
  return normalized;
}

function listAccounts(db) {
  return (db.accounts || []).map(a => ({ account: a.account, name: a.name || '', enabled: a.enabled !== false }));
}

function getAccount(db, accountCode) {
  if (!db.accounts || !Array.isArray(db.accounts)) return null;
  return db.accounts.find(a =>
    a.account.toLowerCase() === accountCode.toLowerCase() ||
    (a.name && a.name.toLowerCase() === accountCode.toLowerCase())
  ) || null;
}

function ensureAccount(db, account) {
  if (!db.accounts) db.accounts = [];
  const existing = getAccount(db, account.account);
  if (existing) return existing;
  const next = { account: account.account, name: account.name || account.account, enabled: account.enabled !== false };
  core.TABLE_NAMES.forEach(tableName => {
    next[tableName] = [];
  });
  db.accounts.push(next);
  return next;
}

function createAccount(db, accountCode, name, opts = {}) {
  if (!accountCode || !name) {
    throw new Error('accountCode and name are required.');
  }
  const existing = getAccount(db, accountCode);
  if (existing) {
    throw new Error(`Account "${accountCode}" already exists.`);
  }
  return ensureAccount(db, {
    account: accountCode,
    name,
    enabled: opts.enabled !== false
  });
}

function setAccountEnabled(db, accountCode, enabled) {
  const account = getAccount(db, accountCode);
  if (!account) {
    throw new Error(`Account "${accountCode}" not found.`);
  }
  account.enabled = enabled !== false;
  return {
    account: account.account,
    enabled: account.enabled
  };
}

const ACCOUNT_PROFILE_BASE_CATEGORIES = ['Properties', 'ForeignAccounts'];
const ACCOUNT_PROFILE_KEY_FIELDS = {
  Properties: 'PropertyID',
  ForeignAccounts: 'ForeignAccount'
};
const REPO_CONFIG_KEY_FIELDS = {
  CapitalGainsQuarters: 'quarter',
  FYQuarters: 'quarter'
};

function listAccountProfileCategories(account) {
  const dynamic = Object.keys(account || {}).filter((key) => {
    if (['account', 'name', 'enabled'].includes(key)) return false;
    return Array.isArray(account[key]) && !core.TABLE_NAMES.includes(key);
  });
  return [...new Set([...ACCOUNT_PROFILE_BASE_CATEGORIES, ...dynamic])];
}

function buildAccountProfileEntry(category, key, value) {
  if (!category) {
    throw new Error('category is required.');
  }
  if (!key) {
    throw new Error('key is required.');
  }
  const keyField = ACCOUNT_PROFILE_KEY_FIELDS[category] || 'Key';
  const normalizedValue = normalizeAccountProfileValue(category, value);
  if (value == null) {
    return { [keyField]: key };
  }
  if (typeof normalizedValue === 'object' && !Array.isArray(normalizedValue)) {
    return { ...normalizedValue, [keyField]: key };
  }
  return { [keyField]: key, Value: normalizedValue };
}

function getAccountProfileEntryKey(category, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const keyField = ACCOUNT_PROFILE_KEY_FIELDS[category] || 'Key';
  return entry[keyField];
}

function getAccountProfile(db, accountCode) {
  const account = getAccount(db, accountCode);
  if (!account) {
    throw new Error(`Account "${accountCode}" not found.`);
  }
  const categories = {};
  listAccountProfileCategories(account).forEach((category) => {
    categories[category] = clone(Array.isArray(account[category]) ? account[category] : []);
  });
  return {
    account: account.account,
    name: account.name || account.account,
    enabled: account.enabled !== false,
    categories,
    Properties: clone(categories.Properties || []),
    ForeignAccounts: clone(categories.ForeignAccounts || [])
  };
}

function appendAccountProfileEntry(db, accountCode, category, key, value) {
  if (!category || typeof category !== 'string') {
    throw new Error('category is required.');
  }
  if (!key || typeof key !== 'string') {
    throw new Error('key is required.');
  }
  const rows = getRawTable(db, accountCode, category);
  if (rows.some((row) => getAccountProfileEntryKey(category, row) === key)) {
    throw new Error(`Category "${category}" already contains key "${key}".`);
  }
  const next = buildAccountProfileEntry(category, key, value);
  rows.push(next);
  return {
    category,
    key,
    entry: clone(next),
    index: rows.length - 1,
    created: true
  };
}

function getRepoConfig(db) {
  return {
    config: clone(db.config || {}),
    accounts: listAccounts(db),
    configTables: {
      CapitalGainsQuarters: clone((db.config && db.config.CapitalGainsQuarters) || []),
      FYQuarters: clone((db.config && db.config.FYQuarters) || [])
    }
  };
}

function buildRepoConfigEntry(category, key, value) {
  const keyField = REPO_CONFIG_KEY_FIELDS[category] || 'Key';
  if (REPO_CONFIG_KEY_FIELDS[category]) {
    const next = (value && typeof value === 'object' && !Array.isArray(value)) ? { ...value } : {};
    next[keyField] = key;
    return next;
  }
  if (value == null || value === '' || value === key) {
    return key;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, [keyField]: key };
  }
  return { [keyField]: key, Value: value };
}

function getRepoConfigEntryKey(category, entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const keyField = REPO_CONFIG_KEY_FIELDS[category] || 'Key';
  return entry[keyField];
}

function appendRepoConfigEntry(db, category, key, value) {
  if (!category || typeof category !== 'string') {
    throw new Error('category is required.');
  }
  if (!key || typeof key !== 'string') {
    throw new Error('key is required.');
  }
  if (!db.config || typeof db.config !== 'object' || Array.isArray(db.config)) {
    db.config = {};
  }
  if (!Array.isArray(db.config[category])) {
    db.config[category] = [];
  }
  const rows = db.config[category];
  if (rows.some((entry) => getRepoConfigEntryKey(category, entry) === key)) {
    throw new Error(`Repo config category "${category}" already contains key "${key}".`);
  }
  const next = buildRepoConfigEntry(category, key, value);
  rows.push(next);
  return {
    category,
    key,
    entry: clone(next),
    index: rows.length - 1,
    created: true
  };
}

function getSchema() {
  return {
    tableNames: [...core.TABLE_NAMES],
    dateFields: clone(core.DATE_FIELDS),
    computedFields: clone(core.COMPUTED_FIELDS),
    requiredFields: clone(core.REQUIRED_FIELDS),
    numberFields: clone(core.NUMBER_FIELDS),
    allowedFields: clone(core.ALLOWED_FIELDS),
    uiOnlyFields: [...(core.UI_ONLY_FIELDS || [])],
    dedupKeys: clone(core.DEDUP_KEYS)
  };
}

function getSemanticStructure() {
  return {
    overview: {
      model: 'Finbook stores append-only financial records per account plus repo-level reference data and computed projections.',
      preferredReadPattern: 'Use targeted account/table/report tools first. Use full committed or working state only as a fallback for broader reasoning.',
      preferredWritePattern: 'Use semantic record_* and append_* tools first. Use generic row tools only when no semantic tool applies.'
    },
    preferredToolOrder: [
      {
        step: 1,
        guidance: 'Start by calling finbook.describe_semantic_structure to understand the model, preferred mutation patterns, and table semantics.'
      },
      {
        step: 2,
        guidance: 'Read targeted state first: accounts, repo config, account profile, table rows, and reports.'
      },
      {
        step: 3,
        guidance: 'Use semantic write tools first: record_* for transactional data and append_* for append-only reference data.'
      },
      {
        step: 4,
        guidance: 'Use generic row tools only when no semantic tool applies.'
      },
      {
        step: 5,
        guidance: 'Run finbook.validate_working_state after writes to confirm the working state is structurally valid.'
      },
      {
        step: 6,
        guidance: 'Use full committed or working state snapshots only as fallback reads when targeted tools are insufficient.'
      }
    ],
    topLevel: [
      {
        key: 'config',
        kind: 'repo-config',
        semantics: 'Repo-wide settings and append-only reference tables shared across accounts.',
        preferredWrites: ['append_repo_config_entry']
      },
      {
        key: 'accounts',
        kind: 'account-collection',
        semantics: 'Each account contains transactional tables plus append-only profile/reference data.',
        preferredReads: ['list_accounts', 'get_account_profile', 'list_table_rows', 'run_report']
      }
    ],
    accountModel: {
      identity: 'Accounts are addressed by account code or display name.',
      lifecycle: 'Account creation, enable/disable, and row lock controls are governance actions and are not agent-safe MCP tools.',
      appendOnlyReferenceData: ['Properties', 'ForeignAccounts']
    },
    transactionalTables: core.TABLE_NAMES.map((tableName) => ({
      table: tableName,
      semantics: {
        StockPurchasesOrTransferIns: 'Stock purchase lots and transfer-ins. PurchaseLotID identifies sale-referenceable lots.',
        StockSalesOrTransferOuts: 'Stock sale lots and transfer-outs. PurchaseLots references prior purchase lots.',
        SalaryIncome: 'Salary and payroll-derived income entries.',
        ForeignIncome: 'Foreign-source income such as dividends or interest.',
        PropertyIncome: 'Property income and expense records.',
        CapitalGainsConsolidated: 'Manual capital gains not derived from stock purchase/sale lots.',
        OtherIncome: 'Other taxable income records.',
        AdvanceTax: 'Advance tax payment records.'
      }[tableName] || 'Finbook transactional table.',
      dedupKeys: clone(core.DEDUP_KEYS[tableName] || []),
      computedFields: clone(core.COMPUTED_FIELDS[tableName] || []),
      preferredWriteTool: {
        StockPurchasesOrTransferIns: 'finbook.record_stock_purchase',
        StockSalesOrTransferOuts: 'finbook.record_stock_sale',
        SalaryIncome: 'finbook.record_income',
        ForeignIncome: 'finbook.record_income',
        PropertyIncome: 'finbook.record_income',
        OtherIncome: 'finbook.record_income',
        CapitalGainsConsolidated: 'finbook.record_capital_gain_outside_stock_transactions',
        AdvanceTax: 'finbook.record_advance_tax_paid'
      }[tableName] || 'finbook.upsert_row'
    })),
    computedViews: [
      'income-summary',
      'capital-gains',
      'stock-transactions',
      'holdings',
      'stock-purchases',
      'stock-sales'
    ],
    policy: {
      journaling: 'Journal materialization and discard are internal admin/runtime operations and are intentionally not part of the agent-safe MCP contract.',
      rawStateFallback: 'Committed and working state snapshots are available as fallback read tools, not as the primary way to query Finbook data.',
      validatorFirst: 'After applying tool-based writes, agents should call finbook.validate_working_state before concluding or asking for follow-up action.'
    }
  };
}

function getTableSchema(tableName) {
  return {
    tableName,
    dateField: core.DATE_FIELDS[tableName] || null,
    computedFields: [...(core.COMPUTED_FIELDS[tableName] || [])],
    requiredFields: [...(core.REQUIRED_FIELDS[tableName] || [])],
    numberFields: [...(core.NUMBER_FIELDS[tableName] || [])],
    allowedFields: [...(core.ALLOWED_FIELDS[tableName] || [])],
    dedupKeys: [...(core.DEDUP_KEYS[tableName] || [])],
    uiOnlyFields: [...(core.UI_ONLY_FIELDS || [])]
  };
}

function isValidDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(new Date(value).getTime());
}

function validateWorkingRecord(accountCode, tableName, record, index) {
  const errors = [];
  const warnings = [];
  const prefix = `${accountCode}.${tableName}[${index}]`;
  const requiredFields = core.REQUIRED_FIELDS[tableName] || [];
  requiredFields.forEach((field) => {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      errors.push(`${prefix}: missing required field '${field}'`);
    }
  });

  const dateFields = Array.isArray(core.DATE_FIELDS[tableName]) ? core.DATE_FIELDS[tableName] : [core.DATE_FIELDS[tableName]].filter(Boolean);
  dateFields.forEach((field) => {
    const value = record[field];
    if (value !== undefined && value !== null && !isValidDateString(value)) {
      errors.push(`${prefix}: invalid date '${field}' = '${value}' (expected YYYY-MM-DD)`);
    }
  });

  (core.NUMBER_FIELDS[tableName] || []).forEach((field) => {
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== 'number') {
      errors.push(`${prefix}: '${field}' must be a number, got ${typeof value} ('${value}')`);
    }
  });

  const allowedFields = core.ALLOWED_FIELDS[tableName] || [];
  Object.keys(record).forEach((field) => {
    if (!allowedFields.includes(field)) {
      errors.push(`${prefix}: unknown field '${field}' — not in ${tableName} schema`);
    }
  });

  (core.COMPUTED_FIELDS[tableName] || []).forEach((field) => {
    if (record[field] !== undefined) {
      warnings.push(`${prefix}: computed field '${field}' should not be persisted — will be ignored on load`);
    }
  });

  if (tableName === 'StockPurchasesOrTransferIns' && !record.PurchaseLotID && record.PurchaseDate && record.SecurityName) {
    warnings.push(`${prefix}: missing PurchaseLotID — sales cannot reference this lot`);
  }

  if (tableName === 'StockSalesOrTransferOuts' && record.PurchaseLots !== undefined) {
    if (!Array.isArray(record.PurchaseLots)) {
      errors.push(`${prefix}: PurchaseLots must be an array`);
    } else {
      record.PurchaseLots.forEach((lot, lotIndex) => {
        if (!lot.PurchaseLotID) {
          errors.push(`${prefix}.PurchaseLots[${lotIndex}]: missing PurchaseLotID`);
        }
        if (typeof lot.SaleQuantity !== 'number' || lot.SaleQuantity <= 0) {
          errors.push(`${prefix}.PurchaseLots[${lotIndex}]: SaleQuantity must be a positive number`);
        }
      });
    }
  }

  return { errors, warnings };
}

function validateWorkingState(db) {
  const errors = [];
  const warnings = [];
  const accounts = {};

  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    return {
      valid: false,
      errors: 1,
      warnings: 0,
      accounts,
      errorDetails: ['Top-level: DB must be an object']
    };
  }

  if (!Array.isArray(db.accounts)) {
    return {
      valid: false,
      errors: 1,
      warnings: 0,
      accounts,
      errorDetails: ['Top-level: missing or invalid "accounts" array']
    };
  }

  db.accounts.forEach((account) => {
    const code = account && account.account;
    if (!code) {
      errors.push('Account missing "account" code');
      return;
    }
    accounts[code] = {};

    Object.keys(account).forEach((key) => {
      if (['account', 'name', 'enabled', 'CrossVerifications'].includes(key)) return;
      if (Array.isArray(account[key]) && !core.TABLE_NAMES.includes(key)) return;
      if (!core.TABLE_NAMES.includes(key) && !['account', 'name', 'enabled', 'CrossVerifications'].includes(key)) {
        warnings.push(`${code}: unknown table key '${key}'`);
      }
    });

    core.TABLE_NAMES.forEach((tableName) => {
      const rows = account[tableName];
      if (rows == null) return;
      if (!Array.isArray(rows)) {
        errors.push(`${code}.${tableName}: expected array, got ${typeof rows}`);
        return;
      }
      accounts[code][tableName] = rows.length;
      rows.forEach((record, index) => {
        const result = validateWorkingRecord(code, tableName, record, index);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      });
    });
  });

  const result = {
    valid: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    accounts
  };
  if (errors.length > 0) result.errorDetails = errors;
  if (warnings.length > 0) result.warningDetails = warnings;
  return result;
}

function getRawTable(db, accountCode, tableName) {
  const account = getAccount(db, accountCode);
  if (!account) {
    throw new Error(`Account "${accountCode}" not found.`);
  }
  if (!Array.isArray(account[tableName])) {
    account[tableName] = [];
  }
  return account[tableName];
}

function listTableRows(db, accountCode, tableName, opts = {}) {
  const ctx = core.createContext(db, accountCode);
  let rows = ctx.getTable(tableName).map(row => ({ ...row }));
  if (opts.fy) {
    rows = ctx.filterByFY(rows, opts.fy, tableName);
  }
  return rows;
}

function deriveComputedRow(tableName, row, index) {
  const next = { ...row };
  const compute = core.COMPUTATIONS[tableName];
  if (compute) compute(next, index == null ? 0 : index);
  return next;
}

function deriveAllComputed(db, accountCode, tableName, opts = {}) {
  const rows = listTableRows(db, accountCode, tableName, opts);
  return rows.map((row, index) => deriveComputedRow(tableName, row, index));
}

function rowMatches(tableName, current, candidate) {
  const dedupKeys = core.DEDUP_KEYS[tableName] || [];
  if (dedupKeys.length === 0) return false;
  return dedupKeys.every(key => current[key] === candidate[key]);
}

function findRowIndex(rows, tableName, rowRef, opts = {}) {
  let index = Number.isInteger(opts.index) ? opts.index : -1;
  if (index < 0 && opts.match && typeof opts.match === 'function') {
    index = rows.findIndex(existing => opts.match(existing, rowRef));
  }
  if (index < 0) {
    index = rows.findIndex(existing => rowMatches(tableName, existing, rowRef || {}));
  }
  return index;
}

function getExistingRow(rows, index, tableName) {
  if (index < 0 || index >= rows.length) return null;
  const row = rows[index];
  if (!row) return null;
  return row;
}

function assertRowUnlocked(row, tableName, operation) {
  if (row && row.IsLocked) {
    throw new Error(`${operation} is not allowed for locked ${tableName} rows. Unlock the row first.`);
  }
}

function upsertRow(db, accountCode, tableName, row, opts = {}) {
  const rows = getRawTable(db, accountCode, tableName);
  const index = findRowIndex(rows, tableName, row, opts);
  if (index >= 0) {
    assertRowUnlocked(getExistingRow(rows, index, tableName), tableName, 'Update');
    rows[index] = { ...rows[index], ...row };
    return { row: rows[index], index, created: false };
  }
  rows.push({ ...row });
  return { row: rows[rows.length - 1], index: rows.length - 1, created: true };
}

function deleteRow(db, accountCode, tableName, rowRef, opts = {}) {
  const rows = getRawTable(db, accountCode, tableName);
  const index = findRowIndex(rows, tableName, rowRef, opts);
  if (index < 0) return { deleted: false, index: -1 };
  assertRowUnlocked(getExistingRow(rows, index, tableName), tableName, 'Delete');
  const [deleted] = rows.splice(index, 1);
  return { deleted: true, index, row: deleted };
}

function lockRow(db, accountCode, tableName, rowRef, opts = {}) {
  const rows = getRawTable(db, accountCode, tableName);
  const index = findRowIndex(rows, tableName, rowRef, opts);
  if (index < 0) return { locked: false, index: -1 };
  rows[index] = { ...rows[index], IsLocked: true };
  return { locked: true, index, row: rows[index] };
}

function unlockRow(db, accountCode, tableName, rowRef, opts = {}) {
  const rows = getRawTable(db, accountCode, tableName);
  const index = findRowIndex(rows, tableName, rowRef, opts);
  if (index < 0) return { unlocked: false, index: -1 };
  rows[index] = { ...rows[index], IsLocked: false };
  return { unlocked: true, index, row: rows[index] };
}

const INCOME_TABLE_BY_TYPE = {
  salary: 'SalaryIncome',
  foreign: 'ForeignIncome',
  property: 'PropertyIncome',
  other: 'OtherIncome'
};

function ensurePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function moveAliasField(target, canonicalKey, aliasKeys) {
  if (hasOwn(target, canonicalKey) && target[canonicalKey] != null) {
    return;
  }
  for (const aliasKey of aliasKeys) {
    if (hasOwn(target, aliasKey) && target[aliasKey] != null) {
      target[canonicalKey] = target[aliasKey];
      return;
    }
  }
}

function getNormalizedCurrencyCode(entry) {
  const raw = typeof entry.CurrencyCode === 'string'
    ? entry.CurrencyCode
    : typeof entry.Currency === 'string'
      ? entry.Currency
      : '';
  return raw.trim().toUpperCase();
}

function normalizeStockPurchaseEntry(entry) {
  const next = { ...entry };
  moveAliasField(next, 'CurrencyCode', ['Currency']);
  if (!hasOwn(next, 'ExchangeRateToINR') && getNormalizedCurrencyCode(next) === 'INR') {
    next.ExchangeRateToINR = 1;
  }
  delete next.Currency;
  return next;
}

function normalizeStockSaleEntry(entry) {
  const next = { ...entry };
  if (!hasOwn(next, 'ExchangeRateToINR') && getNormalizedCurrencyCode(next) === 'INR') {
    next.ExchangeRateToINR = 1;
  }
  delete next.Currency;
  delete next.CurrencyCode;
  return next;
}

function normalizeIncomeEntry(incomeType, entry) {
  const next = { ...entry };
  const normalizedType = typeof incomeType === 'string' ? incomeType.trim().toLowerCase() : '';

  if (normalizedType === 'salary') {
    moveAliasField(next, 'EffectiveDate', ['IncomeDate']);
    moveAliasField(next, 'GrossTaxable', ['IncomeAmount']);
    moveAliasField(next, 'TDSDeducted', ['TDSAmount']);
    delete next.IncomeDate;
    delete next.IncomeAmount;
    delete next.TDSAmount;
    return next;
  }

  if (normalizedType === 'foreign') {
    moveAliasField(next, 'Currency', ['CurrencyCode']);
    moveAliasField(next, 'TaxesWithheld', ['TDSAmount']);
    if (!hasOwn(next, 'ExchangeRateToINR') && getNormalizedCurrencyCode(next) === 'INR') {
      next.ExchangeRateToINR = 1;
    }
    delete next.CurrencyCode;
    delete next.TDSAmount;
    return next;
  }

  if (normalizedType === 'other' || normalizedType === 'property') {
    moveAliasField(next, 'TDSDeducted', ['TDSAmount']);
    delete next.TDSAmount;
  }

  return next;
}

function normalizeAccountProfileValue(category, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const next = { ...value };
  if (category === 'ForeignAccounts') {
    moveAliasField(next, 'Entity', ['Institution']);
    moveAliasField(next, 'AccountNumber', ['AccountMask']);
    delete next.Institution;
    delete next.Country;
    delete next.AccountMask;
  }
  return next;
}

function mergeConfigPatch(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value === null) {
      delete target[key];
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {};
      target[key] = current;
      mergeConfigPatch(current, value);
      if (Object.keys(target[key]).length === 0) {
        delete target[key];
      }
      return;
    }
    target[key] = value;
  });
}

function patchConfig(db, patch) {
  ensurePlainObject(patch, 'patch');
  if (!db.config || typeof db.config !== 'object' || Array.isArray(db.config)) {
    db.config = {};
  }
  mergeConfigPatch(db.config, patch);
  return { config: clone(db.config) };
}

function recordStockPurchase(db, accountCode, entry, opts = {}) {
  ensurePlainObject(entry, 'entry');
  return upsertRow(db, accountCode, 'StockPurchasesOrTransferIns', normalizeStockPurchaseEntry(entry), opts);
}

function recordStockSale(db, accountCode, entry, opts = {}) {
  ensurePlainObject(entry, 'entry');
  return upsertRow(db, accountCode, 'StockSalesOrTransferOuts', normalizeStockSaleEntry(entry), opts);
}

function recordIncome(db, accountCode, incomeType, entry, opts = {}) {
  const normalizedType = typeof incomeType === 'string' ? incomeType.trim().toLowerCase() : '';
  const tableName = INCOME_TABLE_BY_TYPE[normalizedType];
  if (!tableName) {
    throw new Error(`Unknown income type: ${incomeType}`);
  }
  ensurePlainObject(entry, 'entry');
  return upsertRow(db, accountCode, tableName, normalizeIncomeEntry(normalizedType, entry), opts);
}

function recordCapitalGainOutsideStockTransactions(db, accountCode, entry, opts = {}) {
  ensurePlainObject(entry, 'entry');
  return upsertRow(db, accountCode, 'CapitalGainsConsolidated', entry, opts);
}

function recordAdvanceTaxPaid(db, accountCode, entry, opts = {}) {
  ensurePlainObject(entry, 'entry');
  return upsertRow(db, accountCode, 'AdvanceTax', entry, opts);
}

function applyOperation(db, operation, payload = {}) {
  switch (operation) {
    case DISCARD_JOURNAL_OPERATION:
      return { discardedEntryIds: Array.isArray(payload.entryIds) ? [...payload.entryIds] : [] };
    case 'finbook.create_account':
      return createAccount(db, payload.accountCode, payload.name, { enabled: payload.enabled });
    case 'finbook.set_account_enabled':
      return setAccountEnabled(db, payload.account, payload.enabled);
    case 'finbook.patch_config':
      return patchConfig(db, payload.patch);
    case 'finbook.append_repo_config_entry':
      return appendRepoConfigEntry(
        db,
        payload.category,
        payload.key,
        Object.prototype.hasOwnProperty.call(payload, 'value') ? payload.value : undefined
      );
    case 'finbook.append_account_profile_entry':
      return appendAccountProfileEntry(
        db,
        payload.account,
        payload.category,
        payload.key,
        Object.prototype.hasOwnProperty.call(payload, 'value') ? payload.value : undefined
      );
    case 'finbook.upsert_row':
      return upsertRow(db, payload.account, payload.table, payload.row, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.delete_row':
      return deleteRow(db, payload.account, payload.table, payload.row || {}, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.lock_row':
      return lockRow(db, payload.account, payload.table, payload.row || {}, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.unlock_row':
      return unlockRow(db, payload.account, payload.table, payload.row || {}, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.record_stock_purchase':
      return recordStockPurchase(db, payload.account, payload.entry, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.record_stock_sale':
      return recordStockSale(db, payload.account, payload.entry, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.record_income':
      return recordIncome(db, payload.account, payload.incomeType, payload.entry, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.record_capital_gain_outside_stock_transactions':
      return recordCapitalGainOutsideStockTransactions(db, payload.account, payload.entry, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    case 'finbook.record_advance_tax_paid':
      return recordAdvanceTaxPaid(db, payload.account, payload.entry, {
        index: Number.isInteger(payload.index) ? payload.index : undefined
      });
    default:
      throw new Error(`Unknown journal operation: ${operation}`);
  }
}

function applyJournal(db, entries, opts = {}) {
  const target = opts.mutate ? db : clone(db);
  const normalizedEntries = (entries || []).map((entry) => normalizeJournalEntry(entry));
  ensureUniqueJournalEntryIds(normalizedEntries);
  const replayEntries = opts.filterDiscarded === false ? normalizedEntries : getActiveJournalEntries(normalizedEntries);
  const results = [];
  replayEntries.forEach((entry) => {
    results.push(applyOperation(target, entry.operation, entry.payload));
  });
  return {
    db: target,
    results,
    entries: replayEntries
  };
}

function commitJournal(db, entries, opts = {}) {
  const target = opts.mutate ? db : clone(db);
  const pendingEntries = getPendingJournalEntries(target, entries, opts);
  if (pendingEntries.length === 0) {
    return {
      db: target,
      results: [],
      pendingEntries: [],
      lastProcessedEntryId: getLastProcessedEntryId(target),
      committed: false
    };
  }
  const applied = applyJournal(target, pendingEntries, { mutate: true });
  const lastProcessedEntryId = pendingEntries[pendingEntries.length - 1].entryId;
  setLastProcessedEntryId(target, lastProcessedEntryId);
  return {
    db: target,
    results: applied.results,
    pendingEntries,
    lastProcessedEntryId,
    committed: true
  };
}

function runReport(db, accountCode, reportName, opts = {}) {
  const ctx = core.createContext(db, accountCode);
  switch (reportName) {
    case 'income-summary':
      return core.reports.incomeSummary(ctx, opts.fy);
    case 'capital-gains':
      return core.reports.capitalGains(ctx, opts.fy);
    case 'stock-transactions':
      return core.reports.stockTransactions(ctx, opts.fy);
    case 'holdings':
      return core.reports.holdings(ctx, opts.asOnDate || opts.asOn);
    case 'stock-purchases':
      return core.reports.stockPurchases(ctx, opts.fy);
    case 'stock-sales':
      return core.reports.stockSales(ctx, opts.fy);
    default:
      throw new Error(`Unknown report: ${reportName}`);
  }
}

function exportAccount(db, accountCode, fy, opts = {}) {
  const ctx = core.createContext(db, accountCode);
  const today = new Date().toISOString().slice(0, 10);
  const selectedFY = fy || 'All';
  const asOnDate = opts.asOnDate || (() => {
    if (!fy || fy === 'All') return today;
    const endYear = parseInt(fy.split('-')[0], 10) + 1;
    const fyEnd = `${endYear}-03-31`;
    return fyEnd < today ? fyEnd : today;
  })();

  const incomeSummary = core.reports.incomeSummary(ctx, selectedFY);
  const capitalGains = core.reports.capitalGains(ctx, selectedFY);
  const stockBook = core.reports.holdings(ctx, asOnDate);
  const computedRecords = {};

  core.TABLE_NAMES.forEach(tableName => {
    const rows = ctx.filterByFY(ctx.getTable(tableName), selectedFY, tableName);
    computedRecords[tableName] = rows.map(row => ({ ...row }));
  });

  return {
    exportDate: today,
    account: ctx.acct.name || ctx.acct.account,
    financialYear: selectedFY,
    incomeSummary: {
      byCategory: incomeSummary.byCategory,
      totalTaxableIncome: incomeSummary.totalIncome,
      totalRelief: incomeSummary.totalRelief,
      totalTDS: incomeSummary.totalTDS
    },
    capitalGains: {
      transactions: capitalGains.rows,
      totalGainLoss: capitalGains.totalGainLoss,
      ltcgTotal: capitalGains.ltcg,
      stcgTotal: capitalGains.stcg
    },
    stockBook: {
      asOnDate: stockBook.asOnDate,
      holdings: stockBook.holdings,
      totalPortfolioValue: stockBook.totalPortfolioValue
    },
    allIncomeRows: incomeSummary.rows,
    computedRecords
  };
}

module.exports = {
  core,
  loadDb,
  saveDb,
  getJournalFilePath,
  getSampleDbFilePath,
  getSampleJournalFilePath,
  ensureRuntimeFilesFromSamples,
  loadJournal,
  saveJournal,
  appendJournalEntries,
  createJournalEntry,
  createDiscardJournalEntry,
  getLastProcessedEntryId,
  setLastProcessedEntryId,
  getPendingJournalEntries,
  getDiscardedJournalEntryIds,
  getActiveJournalEntries,
  applyOperation,
  applyJournal,
  commitJournal,
  DISCARD_JOURNAL_OPERATION,
  listAccounts,
  getAccount,
  getAccountProfile,
  getRepoConfig,
  appendRepoConfigEntry,
  ensureAccount,
  createAccount,
  setAccountEnabled,
  appendAccountProfileEntry,
  patchConfig,
  listTableRows,
  upsertRow,
  deleteRow,
  lockRow,
  unlockRow,
  recordStockPurchase,
  recordStockSale,
  recordIncome,
  recordCapitalGainOutsideStockTransactions,
  recordAdvanceTaxPaid,
  runReport,
  exportAccount,
  getSchema,
  getSemanticStructure,
  validateWorkingState,
  getTableSchema,
  deriveComputedRow,
  deriveAllComputed
};