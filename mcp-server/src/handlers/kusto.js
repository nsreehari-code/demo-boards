import { runAzureCli } from './azure-cli.js';

function asPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function toMcpResult(envelope) {
  return {
    content: [{ type: 'text', text: asPrettyJson(envelope) }],
    structuredContent: envelope,
  };
}

function success(operation, params, data) {
  return { ok: true, operation, params: params || {}, data };
}

function failure(operation, params, message, code = 'kusto_error') {
  return { ok: false, operation, params: params || {}, error: { code, message } };
}

function getConfig(tool) {
  return tool?.config && typeof tool.config === 'object' ? tool.config : {};
}

function resolveFromConfig(tool, { envVarKey, defaultKey }) {
  const config = getConfig(tool);
  const envVar = typeof config[envVarKey] === 'string' ? config[envVarKey] : '';
  const fromEnv = envVar ? (process.env[envVar] || '').trim() : '';
  const fromDefault = typeof config[defaultKey] === 'string' ? config[defaultKey].trim() : '';
  return fromEnv || fromDefault;
}

function resolveClusterUri(tool) {
  const cluster = resolveFromConfig(tool, { envVarKey: 'clusterEnvVar', defaultKey: 'clusterDefault' });
  if (!cluster) {
    throw new Error('kusto tool is missing a cluster URI (set config.clusterDefault or the configured env var)');
  }
  return cluster.replace(/\/+$/, '');
}

function resolveDatabase(args, tool) {
  const requested = typeof args?.database === 'string' ? args.database.trim() : '';
  if (requested) return requested;
  const database = resolveFromConfig(tool, { envVarKey: 'databaseEnvVar', defaultKey: 'databaseDefault' });
  if (!database) {
    throw new Error('kusto tool is missing a database (pass args.database or set config.databaseDefault)');
  }
  return database;
}

function resolveTenant(tool) {
  const config = getConfig(tool);
  const envVar = typeof config.tenantEnvVar === 'string' ? config.tenantEnvVar : '';
  const fromEnv = envVar ? (process.env[envVar] || '').trim() : '';
  const fromConfig = typeof config.tenant === 'string' ? config.tenant.trim() : '';
  return fromEnv || fromConfig;
}

function getAccessToken(clusterUri, tenant) {
  const args = ['account', 'get-access-token', '--resource', clusterUri, '--query', 'accessToken', '-o', 'tsv'];
  if (tenant) {
    args.push('--tenant', tenant);
  }
  return runAzureCli(args).trim();
}

async function kustoRequest(clusterUri, endpoint, db, csl, token) {
  const response = await fetch(`${clusterUri}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
    },
    body: JSON.stringify({ db, csl }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Kusto request failed (${response.status}): ${text.slice(0, 800)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Kusto returned non-JSON response: ${text.slice(0, 800)}`);
  }
}

// Parse a v1 REST response ({ Tables: [...] }) into the primary result table
// as an array of plain row objects keyed by column name.
function parsePrimaryTable(payload, maxRows) {
  const tables = Array.isArray(payload?.Tables) ? payload.Tables : [];
  if (tables.length === 0) {
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }
  const primary = tables.find((table) => table?.TableName === 'Table_0') || tables[0];
  const columns = Array.isArray(primary?.Columns)
    ? primary.Columns.map((column) => column?.ColumnName || '')
    : [];
  const rawRows = Array.isArray(primary?.Rows) ? primary.Rows : [];
  const limit = typeof maxRows === 'number' && maxRows > 0 ? maxRows : rawRows.length;
  const limited = rawRows.slice(0, limit);
  const rows = limited.map((row) =>
    Object.fromEntries(columns.map((name, index) => [name, Array.isArray(row) ? row[index] : null])),
  );
  return {
    columns,
    rows,
    rowCount: rawRows.length,
    truncated: rawRows.length > limited.length,
  };
}

const DEFAULT_MAX_ROWS = 500;

export async function handleKustoTool(args, tool) {
  const operation = tool.name;
  let clusterUri = '';
  let database = '';

  try {
    clusterUri = resolveClusterUri(tool);
    const tenant = resolveTenant(tool);
    const token = getAccessToken(clusterUri, tenant);

    switch (tool.name) {
      case 'kusto.query': {
        database = resolveDatabase(args, tool);
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (!query) {
          throw new Error('kusto.query requires a non-empty query string');
        }
        const maxRows = typeof args?.maxRows === 'number' && args.maxRows > 0 ? args.maxRows : DEFAULT_MAX_ROWS;
        const payload = await kustoRequest(clusterUri, '/v1/rest/query', database, query, token);
        const table = parsePrimaryTable(payload, maxRows);
        return toMcpResult(success(operation, { cluster: clusterUri, database, query }, table));
      }
      case 'kusto.list_tables': {
        database = resolveDatabase(args, tool);
        const payload = await kustoRequest(clusterUri, '/v1/rest/mgmt', database, '.show tables', token);
        const table = parsePrimaryTable(payload);
        const tableNames = table.rows
          .map((row) => row.TableName)
          .filter((name) => typeof name === 'string' && name.length > 0);
        return toMcpResult(success(operation, { cluster: clusterUri, database }, {
          tableCount: tableNames.length,
          tables: tableNames,
        }));
      }
      case 'kusto.get_schema': {
        database = resolveDatabase(args, tool);
        const tableName = typeof args?.table === 'string' ? args.table.trim() : '';
        if (!tableName) {
          throw new Error('kusto.get_schema requires a table name');
        }
        const csl = `.show table ${tableName} cslschema`;
        const payload = await kustoRequest(clusterUri, '/v1/rest/mgmt', database, csl, token);
        const parsed = parsePrimaryTable(payload);
        const schemaRow = parsed.rows[0] || {};
        return toMcpResult(success(operation, { cluster: clusterUri, database, table: tableName }, {
          table: tableName,
          schema: schemaRow.Schema || schemaRow.CslSchema || '',
          raw: schemaRow,
        }));
      }
      default:
        throw new Error(`Unknown kusto tool: ${tool.name}`);
    }
  } catch (error) {
    return toMcpResult(failure(operation, { cluster: clusterUri, database }, String(error?.message || error)));
  }
}
