import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleFinbookTool } from '../src/handlers/finbook.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const options = {
    manifest: '../../data-repos-V2/finbook-data/managed-truthsets/mcp-executable-manifest.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') {
      const next = argv[index + 1];
      assert(next, 'Missing value for --manifest');
      options.manifest = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function findTool(manifest, name) {
  const tool = manifest.tools.find((entry) => entry.name === name);
  assert(tool, `Tool not found in manifest: ${name}`);
  return tool;
}

async function invoke(tool, args) {
  const result = await handleFinbookTool(args, tool);
  const envelope = result.structuredContent;
  assert(envelope, `Missing structuredContent for ${tool.name}`);
  assert(envelope.ok === true, `${tool.name} failed: ${JSON.stringify(envelope.error || envelope, null, 2)}`);
  return envelope;
}

function getTableRows(db, accountName, tableName) {
  const account = (db.accounts || []).find((entry) => {
    return entry && (
      entry.account === accountName ||
      entry.name === accountName ||
      entry.AccountName === accountName ||
      entry.AccountCode === accountName
    );
  });
  assert(account, `Account not found in temp DB: ${accountName}`);
  return Array.isArray(account[tableName]) ? account[tableName] : [];
}

function cleanupDir(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function getFinbookToolPrefix(manifest) {
  const listAccountsTool = manifest.tools.find((tool) => tool.name.endsWith('.list_accounts'));
  assert(listAccountsTool, 'Unable to find *.list_accounts tool in manifest');
  return listAccountsTool.name.replace(/list_accounts$/, '');
}

function resolveDbFile(repoPath, toolConfig = {}) {
  if (toolConfig.dbPath) {
    return path.resolve(repoPath, toolConfig.dbPath);
  }

  const defaultPath = path.resolve(repoPath, 'DB', 'data.json');
  if (fs.existsSync(defaultPath)) return defaultPath;

  const dbDir = path.resolve(repoPath, 'DB');
  if (fs.existsSync(dbDir)) {
    const jsonFiles = fs.readdirSync(dbDir).filter((entry) => entry.toLowerCase().endsWith('.json'));
    if (jsonFiles.length === 1) {
      return path.join(dbDir, jsonFiles[0]);
    }
  }

  return defaultPath;
}

function resolveRepoPath(manifestPath, toolConfig = {}) {
  if (toolConfig.repoPath) {
    return path.resolve(path.dirname(manifestPath), toolConfig.repoPath);
  }
  return path.dirname(manifestPath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(options.manifest);
  const manifest = readJson(manifestPath);
  const toolPrefix = getFinbookToolPrefix(manifest);
  const firstToolConfig = manifest.tools[0]?.config || {};
  const repoPath = resolveRepoPath(manifestPath, firstToolConfig);
  const sourceDbPath = resolveDbFile(repoPath, firstToolConfig);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finbook-workflow-probe-'));
  const tempDbPath = path.join(tempDir, 'finbook.json');

  fs.copyFileSync(sourceDbPath, tempDbPath);

  try {
    const listAccountsToolName = `${toolPrefix}list_accounts`;
    const listAccountsTool = {
      ...findTool(manifest, listAccountsToolName),
      manifestPath,
      config: {
        ...findTool(manifest, listAccountsToolName).config,
        dbPath: tempDbPath,
      },
    };

    const accountsEnvelope = await invoke(listAccountsTool, {});
    const accountEntry = accountsEnvelope.data.accounts[0];
    assert(accountEntry, 'No accounts available in temp DB');
    const account = accountEntry.account || accountEntry.name;
    assert(account, 'Unable to derive account identifier from list_accounts response');

    const runId = Date.now();
    const purchaseDate = '2026-01-20';
    const saleDate = '2026-01-25';
    const incomeDate = '2026-01-30';
    const taxDate = '2026-03-15';

    const probes = [
      {
        toolName: `${toolPrefix}record_stock_purchase`,
        tableName: 'StockPurchasesOrTransferIns',
        args: {
          account,
          entry: {
            PurchaseDate: purchaseDate,
            SecurityName: `PROBE-E2E-${runId}`,
            CurrencyCode: 'USD',
            PurchaseQuantity: 7,
            PurchasePricePerUnit: 123.45,
            ExchangeRateToINR: 84.1,
          },
        },
      },
      {
        toolName: `${toolPrefix}record_stock_sale`,
        tableName: 'StockSalesOrTransferOuts',
        args: {
          account,
          entry: {
            SaleDate: saleDate,
            SecurityName: `PROBE-SELL-${runId}`,
            SaleQuantity: 3,
            SaleAmount: 456.78,
            ExchangeRateToINR: 84.2,
          },
        },
      },
      {
        toolName: `${toolPrefix}record_income`,
        tableName: 'OtherIncome',
        args: {
          account,
          incomeType: 'other',
          entry: {
            IncomeDate: incomeDate,
            IncomeDescription: `Workflow probe ${runId}`,
            IncomeAmount: 999,
          },
        },
      },
      {
        toolName: `${toolPrefix}record_capital_gain_outside_stock_transactions`,
        tableName: 'CapitalGainsConsolidated',
        args: {
          account,
          entry: {
            IncomeDate: incomeDate,
            IncomeDescription: `Manual capital gain probe ${runId}`,
            SaleValue: 100000,
            AcquisitionCost: 70000,
            Expenses: 1000,
            GainsType: 'LTCG',
          },
        },
      },
      {
        toolName: `${toolPrefix}record_advance_tax_paid`,
        tableName: 'AdvanceTax',
        args: {
          account,
          entry: {
            EffectiveDate: taxDate,
            TaxAmountPaid: 25000,
            PaymentDescription: `Advance tax probe ${runId}`,
          },
        },
      },
    ];

    const summary = [];

    for (const probe of probes) {
      const manifestTool = findTool(manifest, probe.toolName);
      const tool = {
        ...manifestTool,
        manifestPath,
        config: {
          ...manifestTool.config,
          dbPath: tempDbPath,
        },
      };
      const beforeDb = readJson(tempDbPath);
      const beforeCount = getTableRows(beforeDb, account, probe.tableName).length;
      const envelope = await invoke(tool, probe.args);
      const afterDb = readJson(tempDbPath);
      const afterRows = getTableRows(afterDb, account, probe.tableName);
      const afterCount = afterRows.length;

      assert(afterCount === beforeCount + 1, `${probe.toolName} did not increase ${probe.tableName} row count`);

      summary.push({
        tool: probe.toolName,
        table: probe.tableName,
        beforeCount,
        afterCount,
        created: envelope.data.created === true,
        index: envelope.data.index,
      });
    }

    console.log(JSON.stringify({
      ok: true,
      manifest: manifestPath,
      toolPrefix,
      repoPath,
      tempDbPath,
      account: accountEntry,
      probes: summary,
    }, null, 2));
  } finally {
    cleanupDir(tempDir);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});