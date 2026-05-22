#!/usr/bin/env node
// test-finbook-report.js — Tests for finbook-core + finbook-report

const path = require('path');
const fs = require('fs');
const os = require('os');

const core = require('../lib/finbook-core.js');
const api = require('../lib/finbook-api.js');
const contract = require('../lib/finbook-contract.js');
const manifestBuilders = require('../lib/finbook-mcp-manifests.js');

function resolveManagedTruthsetsFile(filename) {
  const candidate = path.join(__dirname, '..', filename);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  throw new Error(`Unable to resolve managed-truthsets file: ${filename}`);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function makeDb() {
  return {
    config: {},
    accounts: [{
      account: 'Sarala',
      name: 'Sarala',
      SalaryIncome: [{ EffectiveDate: '2024-06-15', Employer: 'Acme', GrossTaxable: 500000, TDSDeducted: 50000 }],
      ForeignIncome: [],
      PropertyIncome: [],
      CapitalGainsConsolidated: [],
      OtherIncome: [{ IncomeDate: '2024-07-01', IncomeDescription: 'Interest', IncomeAmount: 1200 }],
      StockPurchasesOrTransferIns: [],
      StockSalesOrTransferOuts: [],
      AdvanceTax: [],
      ForeignAccounts: [],
      Properties: []
    }]
  };
}

console.log('\nfinbook report + manifest smoke tests\n');

test('finbook-core income summary returns totals for a valid account context', () => {
  const db = makeDb();
  const ctx = core.createContext(db, 'Sarala');
  const result = core.reports.incomeSummary(ctx, '2024-25');
  assert(result && typeof result === 'object', 'expected income summary object');
  assert(result.totalIncome > 0, 'expected positive income total');
});

test('finbook-api lists known accounts', () => {
  const db = makeDb();
  const accounts = api.listAccounts(db);
  assert(Array.isArray(accounts), 'expected accounts array');
  assert(accounts.some((entry) => entry.account === 'Sarala'), 'expected Sarala account');
});

test('finbook contract includes journal read tools', () => {
  const toolNames = contract.getToolContract().tools.map((tool) => tool.name);
  assert(toolNames.includes('finbook.list_journal_entries'), 'expected finbook.list_journal_entries');
  assert(toolNames.includes('finbook.get_journal_summary'), 'expected finbook.get_journal_summary');
});

test('manifest builders stay aligned with the live contract', () => {
  const semanticManifest = manifestBuilders.buildSemanticManifest();
  const executableManifest = manifestBuilders.buildExecutableManifest();
  const contractToolNames = contract.getToolContract().tools.map((tool) => tool.name).sort();
  const semanticToolNames = Object.values(semanticManifest.tools).flat().map((tool) => tool.name).sort();
  const executableToolNames = executableManifest.tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(semanticToolNames) === JSON.stringify(contractToolNames), 'semantic manifest tool names must match contract');
  assert(JSON.stringify(executableToolNames) === JSON.stringify(contractToolNames), 'executable manifest tool names must match contract');
});

test('manifest generator writes the managed-truthsets files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finbook-manifests-'));
  try {
    const result = manifestBuilders.writeManagedTruthsetsManifests(tmpDir);
    for (const filePath of [result.semanticPath, result.executablePath, result.capabilitiesPath, result.computedViewsPath, result.schemaPath]) {
      assert(fs.existsSync(filePath), `expected generated file: ${path.basename(filePath)}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);