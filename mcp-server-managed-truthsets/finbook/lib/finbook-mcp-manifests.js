'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('./finbook-contract');
const api = require('./finbook-api');

const SEMANTIC_MANIFEST_FILENAME = 'mcp-manifest.json';
const EXECUTABLE_MANIFEST_FILENAME = 'mcp-executable-manifest.json';
const CAPABILITIES_FILENAME = 'capabilities.json';
const COMPUTED_VIEWS_FILENAME = 'computed-views.json';
const SCHEMA_FILENAME = 'schema.json';

const TOOL_GROUPS = {
  orientation: ['finbook.get_contract', 'finbook.describe_semantic_structure', 'finbook.get_schema'],
  targetedReads: [
    'finbook.list_accounts',
    'finbook.get_repo_config',
    'finbook.get_account_profile',
    'finbook.list_table_rows',
    'finbook.get_computed_view',
    'finbook.run_report'
  ],
  fallbackReads: ['finbook.get_committed_state', 'finbook.get_working_state'],
  journalReads: ['finbook.list_journal_entries', 'finbook.get_journal_summary'],
  appendOnlyWrites: ['finbook.append_repo_config_entry', 'finbook.append_account_profile_entry'],
  semanticTransactionalWrites: [
    'finbook.record_stock_purchase',
    'finbook.record_stock_sale',
    'finbook.record_income',
    'finbook.record_capital_gain_outside_stock_transactions',
    'finbook.record_advance_tax_paid'
  ],
  genericCorrections: ['finbook.upsert_row', 'finbook.delete_row'],
  validation: ['finbook.validate_working_state']
};

const SEMANTIC_PURPOSES = {
  'finbook.get_contract': 'Return the live machine-readable contract for the Finbook MCP/tool surface.',
  'finbook.describe_semantic_structure': 'Explain the meaning of the Finbook model, tables, computed views, and preferred write paths.',
  'finbook.get_schema': 'Return schema metadata for supported tables and computed fields.',
  'finbook.list_accounts': 'List the known Finbook accounts in the connected repository.',
  'finbook.get_repo_config': 'Read repo-wide configuration and append-only reference tables.',
  'finbook.get_account_profile': 'Read append-only account profile and reference data for a single account.',
  'finbook.list_table_rows': 'Read computed rows for one table, optionally scoped by financial year.',
  'finbook.get_computed_view': 'Return one named computed view such as holdings, capital gains, or income summary for an account.',
  'finbook.run_report': 'Compatibility alias for finbook.get_computed_view.',
  'finbook.get_committed_state': 'Return the fully committed state snapshot for broad reasoning when targeted reads are insufficient.',
  'finbook.get_working_state': 'Return the current working state snapshot, including pending runtime changes, as a fallback broad read.',
  'finbook.list_journal_entries': 'Return the effective uncommitted journal entries contributing to the current working state since the last commit.',
  'finbook.get_journal_summary': 'Return a user-oriented summary of the effective uncommitted journal entries contributing to the current working state.',
  'finbook.append_repo_config_entry': 'Append one repo-level master-data or reference entry without rewriting the whole category.',
  'finbook.append_account_profile_entry': 'Append one account-level master-data or reference entry without rewriting the whole category.',
  'finbook.record_stock_purchase': 'Record a stock purchase or transfer-in entry.',
  'finbook.record_stock_sale': 'Record a stock sale or transfer-out entry.',
  'finbook.record_income': 'Record salary, foreign, property, or other income using the named income family.',
  'finbook.record_capital_gain_outside_stock_transactions': 'Record manual or externally computed capital gains that do not come from tracked lot sales.',
  'finbook.record_advance_tax_paid': 'Record an advance-tax payment entry.',
  'finbook.upsert_row': 'Create or update a row when no more specific semantic write tool applies.',
  'finbook.delete_row': 'Delete a row by reference as a generic correction tool.',
  'finbook.validate_working_state': 'Validate structural integrity of the current working state after writes.'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getContractToolMap() {
  return new Map(contract.getToolContract().tools.map((tool) => [tool.name, clone(tool)]));
}

function titleizeToolName(toolName) {
  const action = String(toolName || '').replace(/^finbook\./, '').replace(/[._-]+/g, ' ');
  const title = action.replace(/\b\w/g, (match) => match.toUpperCase());
  return `Finbook ${title}`;
}

function buildSemanticManifest() {
  const semanticStructure = api.getSemanticStructure();
  const toolMap = getContractToolMap();

  return {
    manifestVersion: 'finbook.mcp.manifest.v1',
    service: 'finbook',
    contractVersion: contract.CONTRACT_VERSION,
    summary: 'Agent-facing semantic manifest for the Finbook MCP/tool surface. Describes what the system means, which tools exist, and how to use them safely without exposing transport or storage internals.',
    systemSemantics: {
      purpose: 'Finbook manages personal tax truth for one repository as account-centered financial records plus append-only reference data and computed tax reports.',
      topLevelModel: semanticStructure.topLevel.map((entry) => ({
        key: entry.key,
        kind: entry.kind,
        meaning: entry.semantics
      })),
      accountModel: {
        identity: semanticStructure.accountModel.identity,
        appendOnlyReferenceData: clone(semanticStructure.accountModel.appendOnlyReferenceData || []),
        governanceBoundary: 'Account creation, enable or disable state, row locking, journal materialization, commit, and discard are governance or runtime actions and are not agent-safe MCP tools.'
      },
      transactionalTables: semanticStructure.transactionalTables.map((entry) => ({
        table: entry.table,
        meaning: entry.semantics,
        preferredWriteTool: String(entry.preferredWriteTool || '').startsWith('finbook.')
          ? entry.preferredWriteTool
          : `finbook.${entry.preferredWriteTool}`
      })),
      computedViews: clone(semanticStructure.computedViews || [])
    },
    toolPriorities: {
      orientation: [
        'Start with finbook.describe_semantic_structure when the model, table meaning, or preferred mutation path is unclear.',
        'Use finbook.get_contract when you need the machine-readable contract for the live tool surface.'
      ],
      readOrder: [
        'Prefer targeted reads first: finbook.list_accounts, finbook.get_repo_config, finbook.get_account_profile, finbook.list_table_rows, and finbook.get_computed_view.',
        'Use finbook.list_journal_entries or finbook.get_journal_summary when the question is specifically about pending uncommitted changes.',
        'Use finbook.get_working_state or finbook.get_committed_state only as fallback reads for broad reasoning.',
        'Prefer finbook.get_computed_view for named computed views and use finbook.run_report only as a compatibility alias.'
      ],
      writeOrder: [
        'Prefer append-only tools for master data: finbook.append_repo_config_entry and finbook.append_account_profile_entry.',
        'Prefer semantic transactional write tools before generic row tools.',
        'Use finbook.upsert_row and finbook.delete_row only when no more specific semantic tool applies.'
      ],
      validation: [
        'Call finbook.validate_working_state after tool-based writes before concluding work or asking for follow-up action.'
      ]
    },
    tools: Object.fromEntries(
      Object.entries(TOOL_GROUPS).map(([groupName, toolNames]) => [
        groupName,
        toolNames.map((toolName) => {
          const tool = toolMap.get(toolName);
          if (!tool) throw new Error(`Missing tool definition for semantic manifest: ${toolName}`);
          return {
            name: toolName,
            purpose: SEMANTIC_PURPOSES[toolName] || tool.description
          };
        })
      ])
    ),
    agentGuidance: {
      recordExtraction: [
        'Prefer finbook.list_accounts, finbook.get_account_profile, finbook.get_repo_config, finbook.list_table_rows, and finbook.get_computed_view for targeted context.',
        'Use finbook.describe_semantic_structure when table meaning or write-path choice is unclear.'
      ],
      claimRecording: [
        'Prefer finbook.list_accounts, finbook.get_account_profile, finbook.list_table_rows, and finbook.get_computed_view before broad state reads.'
      ],
      claimVerification: [
        'Prefer finbook.get_computed_view, finbook.list_table_rows, and finbook.get_account_profile for verification reasoning.'
      ]
    },
    guardrails: [
      'Use the Finbook MCP/tool surface instead of editing raw state files directly.',
      'Do not treat committed or working state snapshots as the default query surface; use them only as fallback reads.',
      'Do not treat admin export dumps as part of the agent-safe MCP surface; use targeted computed-view tools instead.',
      'Do not assume governance or runtime actions such as commit, discard, journal replay, row locking, or account lifecycle controls are available as agent-safe tools.'
    ]
  };
}

function buildExecutableManifest(options = {}) {
  const {
    handler = 'finbook',
    server = {
      name: 'finbook-mcp',
      version: '0.1.0',
      description: 'Executable MCP manifest for the Finbook tool surface'
    },
    connection = {
      transport: 'streamable-http',
      urlEnvVar: 'FINBOOK_MCP_SERVER_URL',
      urlDefault: 'http://127.0.0.1:7801/mcp'
    }
  } = options;

  return {
    manifestVersion: 'finbook.mcp.executable.v1',
    service: 'finbook',
    server: clone(server),
    connection: clone(connection),
    tools: contract.getToolContract().tools.map((tool) => ({
      name: tool.name,
      title: titleizeToolName(tool.name),
      description: tool.description,
      handler,
      inputSchema: clone(tool.inputSchema)
    }))
  };
}

// ---- Table / view / schema metadata (SOT for generated JSON files) ----

const TABLE_DESCRIPTIONS = {
  AdvanceTax: 'Advance tax payment records by quarter.',
  CapitalGainsConsolidated: 'Manual capital gains entries (STCG/LTCG) from non-stock-lot sources.',
  ForeignAccounts: 'Foreign brokerage/bank accounts held by this person (append-only reference).',
  ForeignIncome: 'Foreign-source income — dividends, interest, consulting from non-Indian sources.',
  OtherIncome: 'Miscellaneous income — bank interest, gifts, etc.',
  Properties: 'Properties owned, used as lookup for PropertyIncome (append-only reference).',
  PropertyIncome: 'Rental and property-related income records.',
  SalaryIncome: 'Salary and payroll-derived income entries.',
  StockPurchasesOrTransferIns: 'Stock purchase lots and transfer-ins with cost basis for portfolio tracking.',
  StockSalesOrTransferOuts: 'Stock sale lots and transfer-outs referencing prior purchase lots.'
};

const COMPUTED_VIEW_META = {
  'income-summary': {
    title: 'Income Summary',
    description: 'Income breakdown by category with totals for taxable income, relief under Chapter VI-A, and TDS.',
    fields: ['byCategory', 'totalTaxableIncome', 'totalRelief', 'totalTDS']
  },
  'capital-gains': {
    title: 'Capital Gains',
    description: 'Buy-sell matched transactions with gain/loss, holding period classification (LTCG/STCG), and aggregate totals.',
    fields: ['transactions', 'totalGainLoss', 'ltcgTotal', 'stcgTotal']
  },
  'stock-transactions': {
    title: 'Stock Transactions',
    description: 'All stock buy and sell entries with matching, transfer type, and FY/quarter classification.',
    fields: ['rows']
  },
  'holdings': {
    title: 'Stock Holdings',
    description: 'Current holdings with quantity, average cost, and total portfolio value as of a specified date.',
    fields: ['asOnDate', 'holdings', 'totalPortfolioValue']
  },
  'stock-purchases': {
    title: 'Stock Purchases',
    description: 'Raw stock purchase and transfer-in records.',
    fields: ['rows']
  },
  'stock-sales': {
    title: 'Stock Sales',
    description: 'Raw stock sale and transfer-out records.',
    fields: ['rows']
  }
};

const SCHEMA_FIELD_DESCS = {
  IncomeDate: 'Income effective date.', EffectiveDate: 'Record effective date.',
  PaymentDate: 'Payment date.', PurchaseDate: 'Purchase or transfer-in date.', SaleDate: 'Sale or transfer-out date.',
  IncomeSource: 'Source tag from config.', IncomeType: 'Type tag from config.',
  ForeignAccount: 'References ForeignAccounts.ForeignAccount.',
  Currency: 'Currency code from config.', CurrencyCode: 'Currency code of the transaction.',
  IncomeAmount: 'Amount in foreign currency.', TaxesWithheld: 'Tax withheld in foreign currency.',
  ExchangeRateToINR: 'Exchange rate used for INR conversion.',
  NonTaxable: 'True if exempt from Indian tax.', IsLocked: 'True if this row is locked.',
  IsTransferIn: 'True if this is an in-kind transfer-in, not a purchase.',
  IsTransferOut: 'True if this is an in-kind transfer-out, not a sale.',
  IsSTTPaid: 'True if STT was paid on this purchase.', Deleted: 'Soft-delete flag.',
  Remarks: 'Free-form notes.', Details: 'Additional detail text.',
  PropertyID: 'References Properties.PropertyID.',
  GrossIncome: 'Gross income in ₹.', TotalExpenses: 'Deductible expenses in ₹.',
  TDSDeducted: 'TDS deducted in ₹.', TDSDeductor: 'Name of the TDS deductor.',
  GainsType: 'STCG or LTCG.', IncomeDescription: 'Description of the income or gain.',
  SaleValue: 'Sale proceeds in ₹.', AcquisitionCost: 'Purchase cost in ₹.', Expenses: 'Transaction expenses in ₹.',
  Employer: 'Employer name.', GrossTaxable: 'Gross taxable income.',
  TaxablePerquisites: 'Taxable value of perquisites.', Exemptions: 'Total exemptions.', Deductions: 'Deductions under Chapter VI-A.',
  BrokerageName: 'Brokerage or custodian name.', SecurityName: 'Security name or ticker.',
  PurchaseQuantity: 'Units purchased.', PurchasePricePerUnit: 'Price per unit in purchase currency.',
  PurchaseExpenses: 'Transaction expenses.', LotTag: 'Optional lot tag.',
  PurchaseLotID: 'Auto-assigned lot identifier.', PurchaseLots: 'Purchase lot references for this sale.',
  SaleQuantity: 'Units sold.', SaleAmount: 'Sale proceeds (total).',
  SaleExpenses: 'Transaction expenses in sale currency.', DomesticExpensesINR: 'Domestic expenses in ₹.',
  TaxAmountPaid: 'Advance tax paid in ₹.', PaymentDescription: 'Payment description.',
  Entity: 'Institution name.', AccountNumber: 'Account number.',
  PropertyAddress: 'Property address.', OwnershipSharePercent: 'Ownership share percentage (0–100).', PropertyType: 'Property type.'
};

const SCHEMA_CONFIG_SECTION = {
  type: 'object',
  description: 'Repo-wide settings and append-only reference tables shared across all accounts.',
  properties: {
    ForeignStockTickers: { type: 'array', items: { type: 'string' }, description: 'Foreign stock ticker symbols (e.g. AAPL, GOOG).' },
    ForeignCurrencies: { type: 'array', items: { type: 'string' }, description: 'Foreign currency codes (e.g. USD, EUR).' },
    CurrencyRates: { type: 'object', description: 'Exchange rates to INR keyed by currency code.', additionalProperties: { type: 'number' } },
    CurrencySymbols: { type: 'object', description: 'Display symbols keyed by currency code.', additionalProperties: { type: 'string' } },
    ForeignIncomeSource: { type: 'array', items: { type: 'string' }, description: 'Tag list of income sources (e.g. Stocks, Consulting).' },
    ForeignIncomeType: { type: 'array', items: { type: 'string' }, description: 'Tag list of income types (e.g. Dividends, Interest).' },
    CapitalGainsTypes: { type: 'array', items: { type: 'string' }, description: 'Capital gains types (e.g. STCG, LTCG).' },
    CapitalGainsQuarters: {
      type: 'array', description: 'Advance tax quarter definitions for capital gains (CgQ).',
      items: { type: 'object', required: ['quarter', 'from', 'to'], properties: { quarter: { type: 'string' }, from: { type: 'string', description: 'Start date in DD-MMM format.' }, to: { type: 'string', description: 'End date in DD-MMM format.' } } }
    },
    FYQuarters: {
      type: 'array', description: 'Financial year quarter definitions (QFY: Q1–Q4, Apr–Mar).',
      items: { type: 'object', required: ['quarter', 'from', 'to'], properties: { quarter: { type: 'string' }, from: { type: 'string', description: 'Start date in DD-MMM format.' }, to: { type: 'string', description: 'End date in DD-MMM format.' } } }
    },
    ShowRupeeSymbol: { type: 'boolean', description: 'Whether to show ₹ symbol in the UI.' }
  },
  additionalProperties: true
};

function buildSchemaFieldDef(tableName, fieldName) {
  const core = api.core;
  const dateField = core.DATE_FIELDS[tableName];
  const numberFields = core.NUMBER_FIELDS[tableName] || [];
  const desc = SCHEMA_FIELD_DESCS[fieldName] || fieldName;
  if (fieldName === 'PurchaseLots') {
    return {
      type: 'array', description: 'Purchase lot references consumed by this sale.',
      items: { type: 'object', required: ['PurchaseLotID', 'SaleQuantity'], properties: { PurchaseLotID: { type: 'string' }, SaleQuantity: { type: 'number' } } }
    };
  }
  if (fieldName === 'Deleted') return { type: 'boolean', description: desc };
  if (fieldName.startsWith('Is') || fieldName === 'NonTaxable') return { type: 'boolean', default: false, description: desc };
  if (fieldName === dateField || fieldName.endsWith('Date')) return { type: 'string', format: 'date-time', description: desc };
  if (numberFields.includes(fieldName)) return { type: 'number', description: desc };
  if (fieldName === 'OwnershipSharePercent') return { type: 'number', minimum: 0, maximum: 100, description: desc };
  if (fieldName === 'Remarks' || fieldName === 'Details' || fieldName === 'TDSDeductor') return { type: ['string', 'null'], description: desc };
  return { type: 'string', description: desc };
}

function buildCapabilitiesManifest() {
  const core = api.core;
  const tables = core.TABLE_NAMES.map((name) => {
    const all = core.ALLOWED_FIELDS[name] || [];
    const computed = core.COMPUTED_FIELDS[name] || [];
    return {
      name,
      description: TABLE_DESCRIPTIONS[name] || name,
      fields: all.filter((f) => !computed.includes(f))
    };
  });
  return {
    description: 'Tax toolkit data layer — income records, capital gains, stock transactions, cross-verification across multiple brokerage accounts.',
    tables,
    features: ['multi-account', 'cross-verification', 'tax-computation']
  };
}

function buildComputedViewsManifest() {
  const viewKeys = api.getSemanticStructure().computedViews;
  const views = viewKeys.map((key) => {
    const meta = COMPUTED_VIEW_META[key] || { title: key, description: key };
    return { key, ...meta };
  });
  return {
    description: 'Computed financial views from Finbook data. Requires account name and view key.',
    parameters: {
      account: 'Account name (required). Call without account to list available accounts.',
      fy: "Financial year like '2025-26', or omit for all years. Not all views use this parameter."
    },
    views
  };
}

function buildSchemaManifest() {
  const core = api.core;
  const accountProperties = {
    account: { type: 'string', description: 'Unique account code.' },
    name: { type: 'string', description: 'Display name of the account holder.' },
    enabled: { type: 'boolean', default: true, description: 'Whether this account is active.' }
  };
  for (const refTable of ['ForeignAccounts', 'Properties']) {
    const fields = core.ALLOWED_FIELDS[refTable] || [];
    const required = core.REQUIRED_FIELDS[refTable] || [];
    const properties = {};
    for (const f of fields) properties[f] = buildSchemaFieldDef(refTable, f);
    accountProperties[refTable] = {
      type: 'array',
      description: TABLE_DESCRIPTIONS[refTable] || refTable,
      items: { type: 'object', required, properties }
    };
  }
  for (const tableName of core.TABLE_NAMES) {
    if (tableName === 'ForeignAccounts' || tableName === 'Properties') continue;
    const fields = core.ALLOWED_FIELDS[tableName] || [];
    const required = core.REQUIRED_FIELDS[tableName] || [];
    const properties = {};
    for (const f of fields) properties[f] = buildSchemaFieldDef(tableName, f);
    properties.Deleted = { type: 'boolean', description: 'Soft-delete flag.' };
    accountProperties[tableName] = {
      type: 'array',
      description: TABLE_DESCRIPTIONS[tableName] || tableName,
      items: { type: 'object', required, properties }
    };
  }
  return {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    title: 'Finbook Database',
    description: 'Schema for the Finbook database — tracks income, capital gains, stock transactions, and advance tax across multiple brokerage accounts.',
    type: 'object',
    required: ['accounts'],
    properties: {
      config: SCHEMA_CONFIG_SECTION,
      accounts: {
        type: 'array',
        description: 'List of account holders, each with transactional tables and reference data.',
        items: { type: 'object', required: ['account', 'name'], properties: accountProperties }
      }
    }
  };
}

function writeManagedTruthsetsManifests(outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const semanticManifest = buildSemanticManifest();
  const executableManifest = buildExecutableManifest(options.executable || {});
  const capabilities = buildCapabilitiesManifest();
  const computedViews = buildComputedViewsManifest();
  const schema = buildSchemaManifest();

  const semanticPath = path.join(outputDir, SEMANTIC_MANIFEST_FILENAME);
  const executablePath = path.join(outputDir, EXECUTABLE_MANIFEST_FILENAME);
  const capabilitiesPath = path.join(outputDir, CAPABILITIES_FILENAME);
  const computedViewsPath = path.join(outputDir, COMPUTED_VIEWS_FILENAME);
  const schemaPath = path.join(outputDir, SCHEMA_FILENAME);

  fs.writeFileSync(semanticPath, `${JSON.stringify(semanticManifest, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(executablePath, `${JSON.stringify(executableManifest, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(computedViewsPath, `${JSON.stringify(computedViews, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8');

  return { semanticPath, executablePath, capabilitiesPath, computedViewsPath, schemaPath };
}

module.exports = {
  SEMANTIC_MANIFEST_FILENAME,
  EXECUTABLE_MANIFEST_FILENAME,
  CAPABILITIES_FILENAME,
  COMPUTED_VIEWS_FILENAME,
  SCHEMA_FILENAME,
  buildSemanticManifest,
  buildExecutableManifest,
  buildCapabilitiesManifest,
  buildComputedViewsManifest,
  buildSchemaManifest,
  writeManagedTruthsetsManifests
};