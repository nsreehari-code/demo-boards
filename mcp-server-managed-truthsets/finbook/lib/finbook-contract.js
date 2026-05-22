'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = 'finbook.mcp.v2';

const READ_TOOLS = [
  {
    name: 'finbook.get_contract',
    description: 'Return the current Finbook MCP contract so agents can discover the supported tool surface, optionally including the semantic manifest and the public executable manifest.',
    apiMethod: 'getToolContract',
    httpRoute: '/api/domain/contract',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {
        includeSemanticManifest: {
          type: 'boolean',
          description: 'When true, include the semantic Finbook MCP manifest in the response. Defaults to true for HTTP discovery.'
        },
        includeExecutableManifest: {
          type: 'boolean',
          description: 'When true, include the public executable Finbook MCP manifest in the response. Defaults to true for HTTP discovery.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'finbook.describe_semantic_structure',
    description: 'Describe the semantic structure of the Finbook database: account model, transactional tables, reference data, computed views, and preferred mutation patterns.',
    apiMethod: 'getSemanticStructure',
    httpRoute: '/api/domain/semantic-structure',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_schema',
    description: 'Return Finbook schema metadata for all supported tables and computed fields.',
    apiMethod: 'getSchema',
    httpRoute: '/api/domain/schema',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_committed_state',
    description: 'Return the full committed Finbook state snapshot as a fallback read tool for broad reasoning.',
    apiMethod: 'getState',
    httpRoute: '/api/domain/state?state=committed',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_working_state',
    description: 'Return the full working Finbook state snapshot, including pending server-journal changes, as a fallback read tool for broad reasoning.',
    apiMethod: 'getState',
    httpRoute: '/api/domain/state?state=working',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.validate_working_state',
    description: 'Validate the current Finbook working state and return deterministic structural errors and warnings without requiring file access.',
    apiMethod: 'validateWorkingState',
    httpRoute: '/api/domain/validate-working-state',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.list_journal_entries',
    description: 'Return the effective uncommitted journal entries that contribute to the current working state since the last commit. Discarded entries are filtered out.',
    apiMethod: 'listJournalEntries',
    httpRoute: '/api/domain/journal',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_journal_summary',
    description: 'Return a user-oriented semantic summary of the effective uncommitted journal entries that contribute to the current working state since the last commit. The summary is computed only from cleaned active entries and is shaped for cards or brief UI summaries.',
    apiMethod: 'getJournalSummary',
    httpRoute: '/api/domain/journal-summary',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.list_accounts',
    description: 'List available Finbook accounts in the connected data repo.',
    apiMethod: 'listAccounts',
    httpRoute: '/api/domain/accounts',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_repo_config',
    description: 'Return repo-level Finbook configuration and append-only reference tables.',
    apiMethod: 'getRepoConfig',
    httpRoute: '/api/domain/repo-config',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_account_profile',
    description: 'Return append-only account profile/reference data for one Finbook account.',
    apiMethod: 'getAccountProfile',
    httpRoute: '/api/domain/account-profile',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' }
      },
      required: ['account'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.list_table_rows',
    description: 'Return computed rows for a Finbook table, optionally filtered by financial year.',
    apiMethod: 'listTableRows',
    httpRoute: '/api/domain/table',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        table: { type: 'string', description: 'Exact Finbook table name.' },
        fy: { type: 'string', description: 'Optional FY filter such as 2024-25.' }
      },
      required: ['account', 'table'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.get_computed_view',
    description: 'Return one named computed Finbook view for an account. Preferred over export_account for agent and application access to computed results.',
    apiMethod: 'runReport',
    httpRoute: '/api/domain/computed-view',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        view: {
          type: 'string',
          enum: ['income-summary', 'capital-gains', 'stock-transactions', 'holdings', 'stock-purchases', 'stock-sales'],
          description: 'Named computed Finbook view.'
        },
        fy: { type: 'string', description: 'Optional FY filter such as 2024-25.' },
        asOn: { type: 'string', description: 'Optional as-on date in YYYY-MM-DD format for holdings.' }
      },
      required: ['account', 'view'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.run_report',
    description: 'Run a shared Finbook computed report for an account. Compatibility alias for finbook.get_computed_view.',
    apiMethod: 'runReport',
    httpRoute: '/api/domain/report',
    httpMethod: 'GET',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        report: {
          type: 'string',
          enum: ['income-summary', 'capital-gains', 'stock-transactions', 'holdings', 'stock-purchases', 'stock-sales'],
          description: 'Shared Finbook report name.'
        },
        fy: { type: 'string', description: 'Optional FY filter such as 2024-25.' },
        asOn: { type: 'string', description: 'Optional as-on date in YYYY-MM-DD format for holdings.' }
      },
      required: ['account', 'report'],
      additionalProperties: false
    }
  }
];

const WRITE_TOOLS = [
  {
    name: 'finbook.append_repo_config_entry',
    description: 'Append one repo-config reference entry. This is the preferred append-only tool for repo-level Finbook master data.',
    apiMethod: 'appendRepoConfigEntry',
    httpRoute: '/api/domain/append-repo-config-entry',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Repo config category name.' },
        key: { type: 'string', description: 'Unique append-only key within the category.' },
        value: {
          description: 'Optional value payload for the appended entry.'
        }
      },
      required: ['category', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.append_account_profile_entry',
    description: 'Append one account-profile reference entry. This is the preferred append-only tool for account master data.',
    apiMethod: 'appendAccountProfileEntry',
    httpRoute: '/api/domain/append-account-profile-entry',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        category: { type: 'string', description: 'Account profile category name.' },
        key: { type: 'string', description: 'Unique append-only key within the category.' },
        value: {
          description: 'Optional value payload for the appended entry.'
        }
      },
      required: ['account', 'category', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.upsert_row',
    description: 'Create or update one Finbook row in a table as a generic fallback when no more semantic write tool applies.',
    apiMethod: 'upsertRow',
    httpRoute: '/api/domain/upsert-row',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        table: { type: 'string', description: 'Exact Finbook table name.' },
        row: { type: 'object', description: 'Row payload to create or merge.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'table', 'row'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.delete_row',
    description: 'Delete one Finbook row from a table by index or row reference as a generic correction tool.',
    apiMethod: 'deleteRow',
    httpRoute: '/api/domain/delete-row',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        table: { type: 'string', description: 'Exact Finbook table name.' },
        row: { type: 'object', description: 'Optional row reference when deleting by dedup keys.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to delete.' }
      },
      required: ['account', 'table'],
      anyOf: [
        { required: ['index'] },
        { required: ['row'] }
      ],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.record_stock_purchase',
    description: 'Record a stock purchase or transfer-in entry in Finbook. Preferred over the generic row tool for stock-purchase writes.',
    apiMethod: 'recordStockPurchase',
    httpRoute: '/api/domain/record-stock-purchase',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        entry: { type: 'object', description: 'Stock purchase entry payload for StockPurchasesOrTransferIns.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.record_stock_sale',
    description: 'Record a stock sale or transfer-out entry in Finbook. Preferred over the generic row tool for stock-sale writes.',
    apiMethod: 'recordStockSale',
    httpRoute: '/api/domain/record-stock-sale',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        entry: { type: 'object', description: 'Stock sale entry payload for StockSalesOrTransferOuts.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.record_income',
    description: 'Record a non-stock income entry using one of the known Finbook income types: salary, foreign, property, or other. Preferred over the generic row tool for income writes.',
    apiMethod: 'recordIncome',
    httpRoute: '/api/domain/record-income',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        incomeType: { type: 'string', enum: ['salary', 'foreign', 'property', 'other'], description: 'Known Finbook income type.' },
        entry: { type: 'object', description: 'Income entry payload for the selected income type table.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'incomeType', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.record_capital_gain_outside_stock_transactions',
    description: 'Record a manual or consolidated capital gain entry that cannot be derived from recorded stock purchase and sale transactions. Preferred over the generic row tool for manual capital gains.',
    apiMethod: 'recordCapitalGainOutsideStockTransactions',
    httpRoute: '/api/domain/record-capital-gain-outside-stock-transactions',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        entry: { type: 'object', description: 'CapitalGainsConsolidated entry payload.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'finbook.record_advance_tax_paid',
    description: 'Record an advance-tax payment entry in Finbook. Preferred over the generic row tool for advance-tax writes.',
    apiMethod: 'recordAdvanceTaxPaid',
    httpRoute: '/api/domain/record-advance-tax-paid',
    httpMethod: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code or display name.' },
        entry: { type: 'object', description: 'AdvanceTax entry payload.' },
        index: { type: 'integer', minimum: 0, description: 'Optional explicit row index to update.' }
      },
      required: ['account', 'entry'],
      additionalProperties: false
    }
  }
];

const MCP_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function success(operation, params, data, meta = {}) {
  return {
    ok: true,
    contractVersion: CONTRACT_VERSION,
    operation,
    params: params || {},
    data,
    meta
  };
}

function failure(operation, params, message, meta = {}, code = 'finbook_error') {
  return {
    ok: false,
    contractVersion: CONTRACT_VERSION,
    operation,
    params: params || {},
    error: {
      code,
      message,
      meta
    }
  };
}

function getFinbookManifest(filename, legacyFilename) {
  const candidates = [
    path.join(__dirname, '..', 'managed-truthsets', filename),
    path.join(__dirname, '..', filename)
  ];
  if (legacyFilename) {
    candidates.push(path.join(__dirname, '..', legacyFilename));
  }
  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) continue;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }
  return null;
}

function getSemanticManifest() {
  const manifest = getFinbookManifest('mcp-manifest.json');
  if (manifest) return manifest;
  throw new Error('Finbook semantic manifest not found');
}

function getExecutableManifest() {
  const manifest = getFinbookManifest('mcp-executable-manifest.json');
  if (manifest) return manifest;
  throw new Error('Finbook executable manifest not found');
}

function getExecutableDiscoveryManifest() {
  return getExecutableManifest();
}

function getToolContract(options = {}) {
  const {
    includeSemanticManifest = false,
    includeExecutableManifest = false
  } = options;
  const contract = {
    contractVersion: CONTRACT_VERSION,
    recommendedWorkflow: [
      'Call finbook.describe_semantic_structure first when you need to understand the model or choose the right mutation path.',
      'Prefer targeted reads such as accounts, account profile, repo config, table rows, and reports before full-state reads.',
      'Prefer semantic write tools (record_* and append_*) before generic row tools.',
      'Prefer finbook.get_computed_view for named computed views and use finbook.run_report only as a compatibility alias.',
      'Call finbook.validate_working_state after tool-based writes.',
      'Use committed or working state snapshots only as fallback reads.'
    ],
    preferredReadToolsByTask: {
      record_extraction: [
        'finbook.list_accounts',
        'finbook.get_account_profile',
        'finbook.get_repo_config',
        'finbook.list_table_rows',
        'finbook.get_computed_view'
      ],
      claim_recording: [
        'finbook.list_accounts',
        'finbook.get_account_profile',
        'finbook.list_table_rows',
        'finbook.get_computed_view'
      ],
      claim_verification: [
        'finbook.get_computed_view',
        'finbook.list_table_rows',
        'finbook.get_account_profile'
      ],
      fallback_broad_reasoning: [
        'finbook.get_working_state',
        'finbook.get_committed_state'
      ]
    },
    readTools: clone(READ_TOOLS),
    writeTools: clone(WRITE_TOOLS),
    tools: clone(MCP_TOOLS)
  };
  if (includeSemanticManifest) {
    contract.semanticManifest = getSemanticManifest();
  }
  if (includeExecutableManifest) {
    contract.executableManifest = getExecutableDiscoveryManifest();
  }
  return contract;
}

module.exports = {
  CONTRACT_VERSION,
  READ_TOOLS,
  WRITE_TOOLS,
  MCP_TOOLS,
  success,
  failure,
  getToolContract,
  getSemanticManifest,
  getExecutableManifest,
  getExecutableDiscoveryManifest
};
