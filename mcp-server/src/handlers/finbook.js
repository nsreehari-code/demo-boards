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
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error(`Tool ${tool?.name || '(unknown)'} is missing config.repoPath`);
  }

  const manifestDir = path.dirname(tool.manifestPath);
  const repoDir = path.resolve(manifestDir, repoPath);
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
    repoDir,
    dbFile,
  };

  try {
    switch (action) {
      case 'get_schema':
        return toMcpResult(contract.success(operation, {}, api.getSchema(), meta));

      case 'list_accounts': {
        const db = api.loadDb(dbFile);
        return toMcpResult(contract.success(operation, {}, { accounts: api.listAccounts(db) }, meta));
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

      default:
        throw new Error(`Unsupported Finbook MCP tool: ${tool.name}`);
    }
  } catch (error) {
    return toMcpResult(contract.failure(operation, args || {}, error.message, meta, 'invalid_request'));
  }
}