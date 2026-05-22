#!/usr/bin/env node
// validate-finbook.js — Deterministic structural validator for finbook.json
//
// Usage:
//   node mcp-server-managed-truthsets/finbook/scripts/validate-finbook.js mcp-server-managed-truthsets/finbook/DB/finbook.json [--base <ref>]

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const core = require('../lib/finbook-core.js');

const { TABLE_NAMES, COMPUTED_FIELDS, REQUIRED_FIELDS, NUMBER_FIELDS, ALLOWED_FIELDS } = core;
const UI_ONLY = core.UI_ONLY_FIELDS || [];

const DATE_FIELDS = {
  SalaryIncome: ['EffectiveDate'],
  ForeignIncome: ['IncomeDate'],
  PropertyIncome: ['IncomeDate'],
  CapitalGainsConsolidated: ['IncomeDate'],
  OtherIncome: ['IncomeDate'],
  StockPurchasesOrTransferIns: ['PurchaseDate'],
  StockSalesOrTransferOuts: ['SaleDate'],
  AdvanceTax: ['PaymentDate', 'EffectiveDate']
};

function isValidDate(str) {
  if (!str) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(str) && !isNaN(new Date(str).getTime());
}

function validateRecord(acctCode, table, record, index) {
  const errors = [];
  const warnings = [];
  const prefix = `${acctCode}.${table}[${index}]`;

  const required = REQUIRED_FIELDS[table];
  if (required) {
    for (const field of required) {
      if (record[field] === undefined || record[field] === null || record[field] === '') {
        errors.push(`${prefix}: missing required field '${field}'`);
      }
    }
  }

  const dateFlds = DATE_FIELDS[table] || [];
  for (const field of dateFlds) {
    const val = record[field];
    if (val !== undefined && val !== null && !isValidDate(val)) {
      errors.push(`${prefix}: invalid date '${field}' = '${val}' (expected YYYY-MM-DD)`);
    }
  }

  const numFlds = NUMBER_FIELDS[table] || [];
  for (const field of numFlds) {
    const val = record[field];
    if (val !== undefined && val !== null && typeof val !== 'number') {
      errors.push(`${prefix}: '${field}' must be a number, got ${typeof val} ('${val}')`);
    }
  }

  const allowed = ALLOWED_FIELDS[table];
  if (allowed) {
    for (const field of Object.keys(record)) {
      if (!allowed.includes(field)) {
        errors.push(`${prefix}: unknown field '${field}' — not in ${table} schema`);
      }
    }
  }

  const computed = COMPUTED_FIELDS[table] || [];
  for (const field of computed) {
    if (record[field] !== undefined) {
      warnings.push(`${prefix}: computed field '${field}' should not be persisted — will be ignored on load`);
    }
  }

  if (table === 'StockPurchasesOrTransferIns') {
    if (!record.PurchaseLotID && record.PurchaseDate && record.SecurityName) {
      warnings.push(`${prefix}: missing PurchaseLotID — sales cannot reference this lot`);
    }
  }

  if (table === 'StockSalesOrTransferOuts' && record.PurchaseLots) {
    if (!Array.isArray(record.PurchaseLots)) {
      errors.push(`${prefix}: PurchaseLots must be an array`);
    } else {
      record.PurchaseLots.forEach((lot, li) => {
        if (!lot.PurchaseLotID) {
          errors.push(`${prefix}.PurchaseLots[${li}]: missing PurchaseLotID`);
        }
        if (typeof lot.SaleQuantity !== 'number') {
          errors.push(`${prefix}.PurchaseLots[${li}]: SaleQuantity must be a number`);
        }
      });
    }
  }

  return { errors, warnings };
}

function validateDb(db) {
  const errors = [];
  const warnings = [];

  if (!db || typeof db !== 'object') {
    return { valid: false, errors: 1, warnings: 0, errorDetails: ['Top-level DB must be an object'], warningDetails: [] };
  }
  if (!Array.isArray(db.accounts)) {
    errors.push('Top-level `accounts` must be an array');
  }
  if (db.config !== undefined && typeof db.config !== 'object') {
    errors.push('Top-level `config` must be an object when present');
  }

  for (const acct of db.accounts || []) {
    const acctCode = acct.account || acct.name || '<unknown-account>';
    for (const [key, val] of Object.entries(acct)) {
      if (key === 'account' || key === 'name' || key === 'enabled') continue;
      if (!TABLE_NAMES.includes(key)) {
        if (!UI_ONLY.includes(key)) {
          warnings.push(`${acctCode}: unknown top-level account key '${key}'`);
        }
        continue;
      }
      if (!Array.isArray(val)) {
        errors.push(`${acctCode}.${key}: expected array`);
        continue;
      }
      val.forEach((record, index) => {
        const result = validateRecord(acctCode, key, record, index);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    errorDetails: errors,
    warningDetails: warnings
  };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getBaseJson(baseRef, cwd) {
  const content = execSync(`git show ${baseRef}`, { cwd, encoding: 'utf-8' });
  return JSON.parse(content);
}

function compareUiOnlyFields(currentDb, baseDb) {
  const warnings = [];
  const accountMap = new Map((baseDb.accounts || []).map((acct) => [acct.account || acct.name, acct]));

  for (const acct of currentDb.accounts || []) {
    const acctKey = acct.account || acct.name;
    const baseAcct = accountMap.get(acctKey);
    if (!baseAcct) continue;

    for (const tableName of TABLE_NAMES) {
      const currentRows = Array.isArray(acct[tableName]) ? acct[tableName] : [];
      const baseRows = Array.isArray(baseAcct[tableName]) ? baseAcct[tableName] : [];
      const max = Math.max(currentRows.length, baseRows.length);
      for (let i = 0; i < max; i++) {
        const currentRow = currentRows[i] || {};
        const baseRow = baseRows[i] || {};
        for (const field of UI_ONLY) {
          if (currentRow[field] !== baseRow[field]) {
            warnings.push(`${acctKey}.${tableName}[${i}]: UI-only field '${field}' differs from base ref`);
          }
        }
      }
    }
  }

  return warnings;
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => !arg.startsWith('--'));
  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx !== -1 ? args[baseIdx + 1] : null;

  if (!fileArg) {
    console.error(JSON.stringify({ valid: false, errors: 1, warnings: 0, errorDetails: ['Usage: validate-finbook.js <finbook.json> [--base <ref>]'], warningDetails: [] }, null, 2));
    process.exit(1);
  }

  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(JSON.stringify({ valid: false, errors: 1, warnings: 0, errorDetails: [`File not found: ${filePath}`], warningDetails: [] }, null, 2));
    process.exit(1);
  }

  let db;
  try {
    db = loadJson(filePath);
  } catch (err) {
    console.error(JSON.stringify({ valid: false, errors: 1, warnings: 0, errorDetails: [`Failed to parse JSON: ${err.message}`], warningDetails: [] }, null, 2));
    process.exit(1);
  }

  const result = validateDb(db);

  if (baseRef) {
    try {
      const baseDb = getBaseJson(baseRef, path.dirname(filePath));
      result.warningDetails.push(...compareUiOnlyFields(db, baseDb));
      result.warnings = result.warningDetails.length;
    } catch (err) {
      result.warningDetails.push(`Unable to compare UI-only fields against base ref: ${err.message}`);
      result.warnings = result.warningDetails.length;
    }
  }

  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (result.valid) {
    process.stdout.write(output);
    process.exit(0);
  }
  process.stdout.write(output);
  process.exit(2);
}

main();