#!/usr/bin/env node
// test-validate-finbook.js — Tests for the validate-finbook tool

const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const TOOL = path.join(__dirname, 'validate-finbook.js');
let tmpDir;
let passed = 0;
let failed = 0;

function setup() { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-val-')); }
function teardown() { fs.rmSync(tmpDir, { recursive: true, force: true }); }

function writeJson(name, obj) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function run(dbPath) {
  try {
    const out = execFileSync('node', [TOOL, dbPath], { encoding: 'utf-8' });
    return { ok: true, result: JSON.parse(out) };
  } catch (e) {
    try { return { ok: false, result: JSON.parse(e.stdout), code: e.status }; }
    catch (_) { return { ok: false, stderr: e.stderr, code: e.status }; }
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

function makeDb(acctOverrides) {
  return {
    config: {},
    accounts: [{
      account: 'A1', name: 'Test',
      SalaryIncome: [], ForeignIncome: [], PropertyIncome: [],
      CapitalGainsConsolidated: [], OtherIncome: [],
      StockPurchasesOrTransferIns: [], StockSalesOrTransferOuts: [],
      AdvanceTax: [], ForeignAccounts: [], Properties: [],
      ...acctOverrides
    }]
  };
}

console.log('\nvalidate-finbook tool tests\n');
setup();

try {
  test('valid empty DB passes', () => {
    const p = writeJson('db.json', makeDb());
    const r = run(p);
    assert(r.ok, 'should pass');
    assert(r.result.valid === true, 'should be valid');
    assert(r.result.errors === 0, 'should have 0 errors');
  });

  test('valid DB with records passes', () => {
    const p = writeJson('db.json', makeDb({
      SalaryIncome: [{ EffectiveDate: '2024-06-15', Employer: 'Acme', GrossTaxable: 500000 }],
      StockPurchasesOrTransferIns: [{
        PurchaseDate: '2024-05-30', SecurityName: 'MSFT', CurrencyCode: 'USD',
        PurchaseQuantity: 10, PurchasePricePerUnit: 429.17, ExchangeRateToINR: 83.5,
        LotTag: 0, PurchaseLotID: 'MSFT - 429.17 - 30-May-2024'
      }]
    }));
    const r = run(p);
    assert(r.ok, 'should pass');
    assert(r.result.valid === true, 'should be valid');
  });
} finally {
  teardown();
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);