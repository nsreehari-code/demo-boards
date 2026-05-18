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
  const repoApiPath = path.join(repoDir, 'lib', 'finbook-api.js');
  const repoContractPath = path.join(repoDir, 'lib', 'finbook-contract.js');
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

function getToolAction(toolName) {
  return String(toolName || '').replace(/^finbook(?:\.[^.]+)?\./, '');
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

      case 'list_accounts': {
        const db = api.loadDb(dbFile);
        return toMcpResult(contract.success(operation, {}, { accounts: api.listAccounts(db) }, meta));
      }

      case 'get_repo_config': {
        const db = api.loadDb(dbFile);
        return toMcpResult(contract.success(operation, {}, api.getRepoConfig(db), meta));
      }

      case 'get_account_profile': {
        const params = {
          account: args?.account || null,
        };
        const db = api.loadDb(dbFile);
        return toMcpResult(contract.success(operation, params, api.getAccountProfile(db, args.account), meta));
      }

      case 'list_table_rows': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          fy: args?.fy || null,
        };
        const db = api.loadDb(dbFile);
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
        const db = api.loadDb(dbFile);
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
        const db = api.loadDb(dbFile);
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
        const db = api.loadDb(dbFile);
        const result = api.exportAccount(db, args.account, args.fy || 'All', { asOnDate: args.asOn || undefined });
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'append_repo_config_entry': {
        const params = {
          category: args?.category || null,
          key: args?.key || null,
        };
        const db = api.loadDb(dbFile);
        const result = api.appendRepoConfigEntry(db, args.category, args.key, args.value);
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'append_account_profile_entry': {
        const params = {
          account: args?.account || null,
          category: args?.category || null,
          key: args?.key || null,
        };
        const db = api.loadDb(dbFile);
        const result = api.appendAccountProfileEntry(db, args.account, args.category, args.key, args.value);
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'upsert_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.upsertRow(db, args.account, args.table, args.row, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'delete_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.deleteRow(db, args.account, args.table, args.row || {}, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        if (!result.deleted) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'lock_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.lockRow(db, args.account, args.table, args.row || {}, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        if (!result.locked) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'unlock_row': {
        const params = {
          account: args?.account || null,
          table: args?.table || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.unlockRow(db, args.account, args.table, args.row || {}, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        if (!result.unlocked) {
          return toMcpResult(contract.failure(operation, params, 'Row not found', meta, 'not_found'));
        }
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_stock_purchase': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.recordStockPurchase(db, args.account, args.entry, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_stock_sale': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.recordStockSale(db, args.account, args.entry, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_income': {
        const params = {
          account: args?.account || null,
          incomeType: args?.incomeType || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.recordIncome(db, args.account, args.incomeType, args.entry, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_capital_gain_outside_stock_transactions': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.recordCapitalGainOutsideStockTransactions(db, args.account, args.entry, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'record_advance_tax_paid': {
        const params = {
          account: args?.account || null,
          index: Number.isInteger(args?.index) ? args.index : null,
        };
        const db = api.loadDb(dbFile);
        const result = api.recordAdvanceTaxPaid(db, args.account, args.entry, {
          index: Number.isInteger(args?.index) ? args.index : undefined,
        });
        api.saveDb(dbFile, db);
        return toMcpResult(contract.success(operation, params, result, meta));
      }

      case 'lore': {
        const cmd = args?.cmd;
        const key = args?.key || null;
        const value = Object.prototype.hasOwnProperty.call(args || {}, 'value') ? args.value : undefined;
        const includeDeprecated = args?.includeDeprecated === true;
        const params = { cmd: cmd || null, key };
        const loreFile = api.getLoreFilePath(dbFile);
        const loreDb = api.loadLoreDb(loreFile);
        if (cmd === 'get') {
          return toMcpResult(contract.success(operation, params, { entry: api.loreGet(loreDb, key) }, meta));
        }
        if (cmd === 'get_all') {
          const entries = api.loreGetAll(loreDb, { includeDeprecated });
          return toMcpResult(contract.success(operation, params, { count: entries.length, entries }, meta));
        }
        if (cmd === 'set') {
          const result = api.loreSet(loreDb, key, value);
          api.saveLoreDb(loreFile, loreDb);
          return toMcpResult(contract.success(operation, params, result, meta));
        }
        if (cmd === 'append') {
          const result = api.loreAppend(loreDb, key, value);
          api.saveLoreDb(loreFile, loreDb);
          return toMcpResult(contract.success(operation, params, result, meta));
        }
        if (cmd === 'deprecate') {
          const result = api.loreDeprecate(loreDb, key);
          api.saveLoreDb(loreFile, loreDb);
          return toMcpResult(contract.success(operation, params, result, meta));
        }
        throw new Error(`Unknown lore cmd: ${cmd}`);
      }

      default:
        throw new Error(`Unsupported Finbook MCP tool: ${tool.name}`);
    }
  } catch (error) {
    return toMcpResult(contract.failure(operation, args || {}, error.message, meta, 'invalid_request'));
  }
}