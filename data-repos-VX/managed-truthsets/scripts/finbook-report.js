#!/usr/bin/env node
// finbook-report.js — CLI report tool for agents
//
// Usage:
//   node managed-truthsets/scripts/finbook-report.js managed-truthsets/DB/finbook.json --account <code> --report <type> [--fy <FY>] [--as-on <date>]
//
// Report types:
//   income-summary       Income across all categories for a FY
//   capital-gains         Capital gains detail (stock + manual) for a FY
//   stock-transactions    All buy/sell/transfer activity for a FY
//   holdings              Current stock holdings as on a date
//   stock-purchases       Raw purchase records for a FY
//   stock-sales           Raw sale records for a FY
//   accounts              List all accounts in the DB
//
// Examples:
//   node managed-truthsets/scripts/finbook-report.js managed-truthsets/DB/finbook.json --account Sarala --report income-summary --fy 2024-25
//   node managed-truthsets/scripts/finbook-report.js managed-truthsets/DB/finbook.json --account Sarala --report holdings --as-on 2025-03-31
//   node managed-truthsets/scripts/finbook-report.js managed-truthsets/DB/finbook.json --report accounts
//
// Exit codes: 0 = success, 1 = bad args, 2 = runtime error

const path = require('path');
const fs = require('fs');
const core = require('../lib/finbook-core.js');

function parseArgs(argv) {
  const args = { file: null, account: null, report: null, fy: null, asOn: null };
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--account' && argv[i + 1]) { args.account = argv[++i]; }
    else if (a === '--report' && argv[i + 1]) { args.report = argv[++i]; }
    else if (a === '--fy' && argv[i + 1]) { args.fy = argv[++i]; }
    else if (a === '--as-on' && argv[i + 1]) { args.asOn = argv[++i]; }
    else if (!a.startsWith('--') && !args.file) { args.file = a; }
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
    i++;
  }
  return args;
}

const VALID_REPORTS = ['income-summary', 'capital-gains', 'stock-transactions', 'holdings', 'stock-purchases', 'stock-sales', 'accounts'];

function validate(args) {
  if (!args.file) { console.error('Error: finbook.json path required'); return false; }
  if (!args.report) { console.error('Error: --report <type> required'); return false; }
  if (!VALID_REPORTS.includes(args.report)) { console.error(`Error: Unknown report "${args.report}". Valid: ${VALID_REPORTS.join(', ')}`); return false; }
  if (args.report !== 'accounts' && !args.account) { console.error('Error: --account <code> required for this report'); return false; }
  if (args.report === 'holdings' && !args.asOn) { console.error('Error: --as-on <YYYY-MM-DD> required for holdings report'); return false; }
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  if (!validate(args)) {
    console.error('\nUsage: node finbook-report.js <finbook.json> --account <code> --report <type> [--fy <FY>] [--as-on <date>]');
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(2);
  }

  let db;
  try {
    db = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Error: Failed to parse JSON: ${e.message}`);
    process.exit(2);
  }

  if (args.report === 'accounts') {
    const accounts = (db.accounts || []).map(a => ({
      account: a.account, name: a.name || '',
      tables: Object.keys(a).filter(k => k !== 'account' && k !== 'name')
    }));
    console.log(JSON.stringify({ accounts }, null, 2));
    return;
  }

  let ctx;
  try {
    ctx = core.createContext(db, args.account);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(2);
  }

  let result;
  switch (args.report) {
    case 'income-summary':
      result = core.reports.incomeSummary(ctx, args.fy);
      break;
    case 'capital-gains':
      result = core.reports.capitalGains(ctx, args.fy);
      break;
    case 'stock-transactions':
      result = core.reports.stockTransactions(ctx, args.fy);
      break;
    case 'holdings':
      result = core.reports.holdings(ctx, args.asOn);
      break;
    case 'stock-purchases':
      result = core.reports.stockPurchases(ctx, args.fy);
      break;
    case 'stock-sales':
      result = core.reports.stockSales(ctx, args.fy);
      break;
  }

  console.log(JSON.stringify(result, null, 2));
}

main();