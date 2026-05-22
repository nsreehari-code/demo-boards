import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function asPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function toMcpResult(envelope) {
  return {
    content: [
      {
        type: 'text',
        text: asPrettyJson(envelope),
      },
    ],
    structuredContent: envelope,
  };
}

function resolveRepoDir(tool) {
  const repoPath = tool?.config?.repoPath;
  const manifestDir = path.dirname(tool.manifestPath);
  const repoDir = repoPath && typeof repoPath === 'string'
    ? path.resolve(manifestDir, repoPath)
    : manifestDir;
  if (!fs.existsSync(repoDir)) {
    throw new Error(`Configured repoPath does not exist: ${repoDir}`);
  }
  return repoDir;
}

function resolveDbFile(repoDir, tool) {
  if (tool?.config?.dbPath) {
    return path.resolve(repoDir, tool.config.dbPath);
  }

  const defaultPath = path.resolve(repoDir, 'DB', 'data.json');
  if (fs.existsSync(defaultPath)) return defaultPath;

  const dbDir = path.resolve(repoDir, 'DB');
  if (fs.existsSync(dbDir)) {
    const jsonFiles = fs.readdirSync(dbDir).filter((entry) => entry.toLowerCase().endsWith('.json'));
    if (jsonFiles.length === 1) {
      return path.join(dbDir, jsonFiles[0]);
    }
  }

  return defaultPath;
}

function loadModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function loadFinbookModules(repoDir) {
  const managedTruthsetsBase = path.join(repoDir, 'managed-truthsets', 'lib');
  const repoApiPath = path.join(managedTruthsetsBase, 'finbook-api.js');
  const repoContractPath = path.join(managedTruthsetsBase, 'finbook-contract.js');
  const overlayBase = path.resolve(repoDir, '..', '..', 'finbook-domain', 'finbook-data-overlay', 'lib');
  const overlayApiPath = path.join(overlayBase, 'finbook-api.js');
  const overlayContractPath = path.join(overlayBase, 'finbook-contract.js');

  const apiPath = fs.existsSync(repoApiPath) ? repoApiPath : overlayApiPath;
  const contractPath = fs.existsSync(repoContractPath) ? repoContractPath : overlayContractPath;

  return {
    api: loadModule(apiPath),
    contract: loadModule(contractPath),
  };
}

function getOperation(toolName) {
  return toolName;
}

function loadStateSnapshot(api, dbFile, state = 'working') {
  const committedDb = api.loadDb(dbFile);
  const journalFile = api.getJournalFilePath(dbFile);
  const serverJournal = api.loadJournal(journalFile);
  const pendingServerJournal = api.getPendingJournalEntries(committedDb, serverJournal);
  const appliedWorkingDb = api.applyJournal(committedDb, pendingServerJournal).db;
  return {
    state,
    committedDb,
    serverJournal,
    pendingServerJournal,
    workingDb: state === 'committed' ? committedDb : appliedWorkingDb,
  };
}

function buildStatePayload(snapshot) {
  return {
    state: snapshot.state,
    committedDb: snapshot.committedDb,
    serverJournal: snapshot.serverJournal,
    pendingServerJournal: snapshot.pendingServerJournal,
    workingDb: snapshot.workingDb,
  };
}

function getWorkingDb(api, dbFile) {
  return loadStateSnapshot(api, dbFile, 'working').workingDb;
}

function getOptionalIndex(args) {
  return Number.isInteger(args?.index) ? args.index : undefined;
}

function appendJournalOperation(api, dbFile, operation, payload, meta) {
  const workingDb = getWorkingDb(api, dbFile);
  const journalEntry = api.createJournalEntry(operation, payload, meta);
  const preview = api.applyJournal(workingDb, [journalEntry]);
  const journalFile = api.getJournalFilePath(dbFile);
  api.appendJournalEntries(journalFile, [journalEntry]);
  return {
    journalEntry,
    result: preview.results[0],
    workingDb: preview.db,
  };
}

function getToolAction(toolName) {
  return String(toolName || '').replace(/^finbook(?:\.[^.]+)?\./, '');
}

function mapIncomeTypeToTable(incomeType) {
  const normalized = typeof incomeType === 'string' ? incomeType.trim().toLowerCase() : '';
  return {
    salary: 'SalaryIncome',
    foreign: 'ForeignIncome',
    property: 'PropertyIncome',
    other: 'OtherIncome',
  }[normalized] || null;
}

function inferJournalTable(entry) {
  const payload = entry?.payload || {};
  if (typeof payload.table === 'string' && payload.table) {
    return payload.table;
  }
  switch (entry?.operation) {
    case 'finbook.record_stock_purchase':
      return 'StockPurchasesOrTransferIns';
    case 'finbook.record_stock_sale':
      return 'StockSalesOrTransferOuts';
    case 'finbook.record_income':
      return mapIncomeTypeToTable(payload.incomeType);
    case 'finbook.record_capital_gain_outside_stock_transactions':
      return 'CapitalGainsConsolidated';
    case 'finbook.record_advance_tax_paid':
      return 'AdvanceTax';
    default:
      return null;
  }
}

function incrementCounter(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function toCountList(counter) {
  return Array.from(counter.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function getSemanticKindMeta(entry) {
  switch (entry?.operation) {
    case 'finbook.patch_config':
      return { kind: 'config_update', label: 'config update' };
    case 'finbook.append_repo_config_entry':
      return { kind: 'repo_reference_append', label: 'repo reference append' };
    case 'finbook.append_account_profile_entry':
      return { kind: 'account_profile_update', label: 'account profile update' };
    case 'finbook.upsert_row':
      return { kind: 'row_upsert', label: 'data update' };
    case 'finbook.delete_row':
      return { kind: 'row_delete', label: 'row deletion' };
    case 'finbook.lock_row':
      return { kind: 'row_lock', label: 'row lock' };
    case 'finbook.unlock_row':
      return { kind: 'row_unlock', label: 'row unlock' };
    case 'finbook.record_stock_purchase':
      return { kind: 'stock_purchase_recorded', label: 'stock purchase' };
    case 'finbook.record_stock_sale':
      return { kind: 'stock_sale_recorded', label: 'stock sale' };
    case 'finbook.record_income':
      return { kind: 'income_recorded', label: 'income record' };
    case 'finbook.record_capital_gain_outside_stock_transactions':
      return { kind: 'capital_gain_recorded', label: 'capital gain record' };
    case 'finbook.record_advance_tax_paid':
      return { kind: 'advance_tax_recorded', label: 'advance tax record' };
    default:
      return { kind: 'other_change', label: 'change' };
  }
}

function incrementSemanticCounter(counter, meta) {
  if (!meta?.kind) return;
  const current = counter.get(meta.kind);
  if (current) {
    current.count += 1;
    return;
  }
  counter.set(meta.kind, {
    kind: meta.kind,
    label: meta.label,
    count: 1,
  });
}

function toSemanticCountList(counter) {
  return Array.from(counter.values())
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

function buildCardTitle(totalEntries, accountSummaries, changeKinds) {
  if (totalEntries === 0) {
    return 'No pending changes';
  }

  const topKind = changeKinds[0];
  const subject = topKind
    ? `${topKind.count} ${pluralize(topKind.count, topKind.label)}`
    : `${totalEntries} pending ${pluralize(totalEntries, 'change')}`;

  if (accountSummaries.length === 1) {
    return `${subject} for ${accountSummaries[0].account}`;
  }

  if (accountSummaries.length > 1) {
    return `${totalEntries} pending changes across ${accountSummaries.length} accounts`;
  }

  return `${totalEntries} pending ${pluralize(totalEntries, 'change')}`;
}

function buildCardSubtitle(totalEntries, tableCounts, timeRange, accountSummaries) {
  if (totalEntries === 0) {
    return 'Working state matches committed state';
  }

  const parts = [];
  if (accountSummaries.length > 0) {
    const topAccounts = accountSummaries.slice(0, 2).map((entry) => entry.account).join(', ');
    parts.push(`Accounts: ${topAccounts}`);
  }
  if (tableCounts.length > 0) {
    const topTables = tableCounts.slice(0, 2).map((entry) => entry.name).join(', ');
    parts.push(`Affects ${topTables}`);
  }
  if (timeRange?.lastCreatedAt) {
    parts.push(`Latest change ${timeRange.lastCreatedAt}`);
  }
  return parts.join(' | ') || 'Pending changes are waiting to be committed';
}

function buildShortSummary(totalEntries, changeKinds, accountSummaries) {
  if (totalEntries === 0) {
    return 'There are no pending journal changes.';
  }

  const changeText = changeKinds.length > 0
    ? changeKinds.map((entry) => `${entry.count} ${pluralize(entry.count, entry.label)}`).join(', ')
    : `${totalEntries} pending ${pluralize(totalEntries, 'change')}`;

  if (accountSummaries.length === 1) {
    return `Pending changes for ${accountSummaries[0].account}: ${changeText}.`;
  }

  if (accountSummaries.length > 1) {
    return `Pending changes across ${accountSummaries.length} accounts: ${changeText}.`;
  }

  return `Pending changes: ${changeText}.`;
}

function getAccountKey(entry) {
  return typeof entry?.payload?.account === 'string' && entry.payload.account
    ? entry.payload.account
    : 'repo';
}

function buildAccountGroups(entries) {
  const groups = new Map();

  entries.forEach((entry) => {
    const account = getAccountKey(entry);
    const table = inferJournalTable(entry);
    const semanticMeta = getSemanticKindMeta(entry);
    let group = groups.get(account);
    if (!group) {
      group = {
        account,
        totalEntries: 0,
        entries: [],
        changeKindCounter: new Map(),
        tableCounter: new Map(),
        firstCreatedAt: null,
        lastCreatedAt: null,
      };
      groups.set(account, group);
    }

    group.totalEntries += 1;
    group.entries.push(entry);
    incrementSemanticCounter(group.changeKindCounter, semanticMeta);
    incrementCounter(group.tableCounter, table);

    if (typeof entry.createdAt === 'string' && entry.createdAt) {
      if (!group.firstCreatedAt || entry.createdAt < group.firstCreatedAt) group.firstCreatedAt = entry.createdAt;
      if (!group.lastCreatedAt || entry.createdAt > group.lastCreatedAt) group.lastCreatedAt = entry.createdAt;
    }
  });

  return Array.from(groups.values())
    .map((group) => ({
      account: group.account,
      totalEntries: group.totalEntries,
      shortSummary: buildShortSummary(group.totalEntries, toSemanticCountList(group.changeKindCounter), [{ account: group.account }]),
      changeKinds: toSemanticCountList(group.changeKindCounter),
      affectedTables: toCountList(group.tableCounter),
      timeRange: group.firstCreatedAt && group.lastCreatedAt
        ? {
            firstCreatedAt: group.firstCreatedAt,
            lastCreatedAt: group.lastCreatedAt,
          }
        : null,
      entries: group.entries,
    }))
    .sort((left, right) => right.totalEntries - left.totalEntries || left.account.localeCompare(right.account));
}

function summarizeJournalEntries(entries) {
  const semanticKindCounter = new Map();
  const accountCounter = new Map();
  const tableCounter = new Map();
  let firstCreatedAt = null;
  let lastCreatedAt = null;

  entries.forEach((entry) => {
    incrementSemanticCounter(semanticKindCounter, getSemanticKindMeta(entry));

    const account = getAccountKey(entry);
    const table = inferJournalTable(entry);

    incrementCounter(accountCounter, account);
    incrementCounter(tableCounter, table);

    if (typeof entry.createdAt === 'string' && entry.createdAt) {
      if (!firstCreatedAt || entry.createdAt < firstCreatedAt) firstCreatedAt = entry.createdAt;
      if (!lastCreatedAt || entry.createdAt > lastCreatedAt) lastCreatedAt = entry.createdAt;
    }
  });

  const changeKinds = toSemanticCountList(semanticKindCounter);
  const accountCounts = toCountList(accountCounter);
  const tableCounts = toCountList(tableCounter);
  const accountSummaries = buildAccountGroups(entries);
  const timeRange = firstCreatedAt && lastCreatedAt
    ? {
        firstCreatedAt,
        lastCreatedAt,
      }
    : null;

  return {
    status: entries.length === 0 ? 'no_pending_changes' : 'pending_changes',
    totalEntries: entries.length,
    cardTitle: buildCardTitle(entries.length, accountSummaries, changeKinds),
    cardSubtitle: buildCardSubtitle(entries.length, tableCounts, timeRange, accountSummaries),
    shortSummary: buildShortSummary(entries.length, changeKinds, accountSummaries),
    changeKinds,
    affectedAccounts: accountCounts,
    accountGroups: accountSummaries,
    affectedTables: tableCounts,
    timeRange,
  };
}

export async function handleFinbookTool(args, tool) {
  const repoDir = resolveRepoDir(tool);
  const dbFile = resolveDbFile(repoDir, tool);
  const { api, contract } = loadFinbookModules(repoDir);
  const operation = getOperation(tool.name);
  const action = getToolAction(tool.name);
  const meta = {
    surface: 'mcp',
  };

  try {
    switch (action) {
      case 'get_contract': {
        const params = {
          includeSemanticManifest: args?.includeSemanticManifest === true,
        };
        const result = contract.getToolContract({
          includeSemanticManifest: args?.includeSemanticManifest === true,
        });
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'describe_semantic_structure':
        return toMcpResult(contract.success(operation, {}, api.getSemanticStructure(), meta));

      case 'get_schema':
        return toMcpResult(contract.success(operation, {}, api.getSchema(), meta));

      case 'get_committed_state': {
        const snapshot = loadStateSnapshot(api, dbFile, 'committed');
        return toMcpResult(contract.success(operation, { state: 'committed' }, buildStatePayload(snapshot), meta));
      }

      case 'get_working_state': {
        const snapshot = loadStateSnapshot(api, dbFile, 'working');
        return toMcpResult(contract.success(operation, { state: 'working' }, buildStatePayload(snapshot), meta));
      }

      case 'validate_working_state': {
        const snapshot = loadStateSnapshot(api, dbFile, 'working');
        return toMcpResult(contract.success(operation, {}, api.validateWorkingState(snapshot.workingDb), meta));
      }

      case 'list_journal_entries': {
        const journalFile = api.getJournalFilePath(dbFile);
        const allEntries = api.loadJournal(journalFile);
        const activeEntries = api.getActiveJournalEntries(allEntries);
        const params = {};
        return toMcpResult(contract.success(operation, params, {
          totalEntries: activeEntries.length,
          entries: activeEntries,
        }, meta));
      }

      case 'get_journal_summary': {
        const journalFile = api.getJournalFilePath(dbFile);
        const allEntries = api.loadJournal(journalFile);
        const activeEntries = api.getActiveJournalEntries(allEntries);
        return toMcpResult(contract.success(operation, {}, {
          summary: summarizeJournalEntries(activeEntries),
          entries: activeEntries,
        }, meta));
      }

      case 'list_accounts': {
        const db = getWorkingDb(api, dbFile);
        return toMcpResult(contract.success(operation, {}, { accounts: api.listAccounts(db) }, meta));
      }

      case 'get_repo_config': {
        const db = getWorkingDb(api, dbFile);
        return toMcpResult(contract.success(operation, {}, api.getRepoConfig(db), meta));
      }

      case 'get_account_profile': {
        const params = {
          account: args?.account || null,
        };
        const db = getWorkingDb(api, dbFile);
        return toMcpResult(contract.success(operation, params, api.getAccountProfile(db, args.account), meta));
      }

      case 'list_table_rows': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          fy: args?.fy || null,
        };
        const db = getWorkingDb(api, dbFile);
        const rows = api.listTableRows(db, args.account, args.table, { fy: args.fy || undefined });
        return toMcpResult(contract.success(operation, params, { count: rows.length, rows }, meta));
      }

      case 'run_report': {
        const params = {
          account: args?.account || null,
          report: args?.report || null,
          fy: args?.fy || null,
          asOn: args?.asOn || null,
        };
        const db = getWorkingDb(api, dbFile);
        const result = api.runReport(db, args.account, args.report, {
          fy: args.fy || undefined,
          asOn: args.asOn || undefined,
          asOnDate: args.asOn || undefined,
        });
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'get_computed_view': {
        const params = {
          account: args?.account || null,
          view: args?.view || null,
          fy: args?.fy || null,
          asOn: args?.asOn || null,
        };
        const db = getWorkingDb(api, dbFile);
        const result = api.runReport(db, args.account, args.view, {
          fy: args.fy || undefined,
          asOn: args.asOn || undefined,
          asOnDate: args.asOn || undefined,
        });
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'export_account': {
        const params = {
          account: args?.account || null,
          fy: args?.fy || null,
          asOn: args?.asOn || null,
        };
        const db = getWorkingDb(api, dbFile);
        const result = api.exportAccount(db, args.account, args.fy || 'All', { asOnDate: args.asOn || undefined });
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'append_repo_config_entry': {
        const params = {
          category: args?.category || null,
          key: args?.key || null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          category: args?.category,
          key: args?.key,
          value: args?.value,
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'append_account_profile_entry': {
        const params = {
          account: args?.account || null,
          category: args?.category || null,
          key: args?.key || null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          category: args?.category,
          key: args?.key,
          value: args?.value,
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'upsert_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          table: args?.table,
          row: args?.row,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'delete_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          table: args?.table,
          row: args?.row || {},
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        if (!result.deleted) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'lock_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          table: args?.table,
          row: args?.row || {},
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        if (!result.locked) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'unlock_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          table: args?.table,
          row: args?.row || {},
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        if (!result.unlocked) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_stock_purchase': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          entry: args?.entry,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_stock_sale': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          entry: args?.entry,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_income': {
        const params = {
          account: args?.account || null,
          incomeType: args?.incomeType || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          incomeType: args?.incomeType,
          entry: args?.entry,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_capital_gain_outside_stock_transactions': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          entry: args?.entry,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_advance_tax_paid': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const { journalEntry, result } = appendJournalOperation(api, dbFile, operation, {
          account: args?.account,
          entry: args?.entry,
          ...(Number.isInteger(args?.index) ? { index: args.index } : {}),
        }, meta);
        result.journalEntryId = journalEntry.entryId;
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      default:
        throw new Error(`Unsupported Finbook MCP tool: ${tool.name}`);
    }
  } catch (error) {
    return toMcpResult(contract.failure(operation, args || {}, error.message, meta, 'invalid_request'));
  }
}