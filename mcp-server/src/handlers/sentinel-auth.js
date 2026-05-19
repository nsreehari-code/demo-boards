import { runAzureCli } from './azure-cli.js';

function resolveTenant(args, tool) {
  const config = tool?.config && typeof tool.config === 'object' ? tool.config : {};
  const tenantFromEnv = typeof config.tenantEnvVar === 'string' && config.tenantEnvVar
    ? process.env[config.tenantEnvVar]
    : '';
  const requestedTenant = typeof args?.tenant === 'string' ? args.tenant.trim() : '';
  const configuredTenant = typeof config.tenant === 'string' ? config.tenant.trim() : '';
  return requestedTenant || configuredTenant || (tenantFromEnv || '').trim();
}

function getRequiredResource(tool) {
  const config = tool?.config && typeof tool.config === 'object' ? tool.config : {};
  const resource = typeof config.resource === 'string' ? config.resource.trim() : '';
  if (!resource) {
    throw new Error('sentinel.login is missing configured auth resource');
  }
  return resource;
}

function runAzureLogin(tenant) {
  const args = ['login'];
  if (tenant) {
    args.push('--tenant', tenant);
  }
  runAzureCli(args, { inherit: true });
}

function tryGetToken(resource, tenant) {
  const args = ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv'];
  if (tenant) {
    args.push('--tenant', tenant);
  }
  return runAzureCli(args).trim();
}

function getAccountSummary() {
  const raw = runAzureCli(['account', 'show', '-o', 'json']);
  const parsed = JSON.parse(raw);
  return {
    environmentName: parsed.environmentName || '',
    homeTenantId: parsed.homeTenantId || '',
    id: parsed.id || '',
    isDefault: parsed.isDefault === true,
    name: parsed.name || '',
    tenantId: parsed.tenantId || '',
    user: parsed.user || null,
  };
}

export async function handleSentinelLogin(args, tool) {
  const tenant = resolveTenant(args, tool);
  const resource = getRequiredResource(tool);
  const forceLogin = args?.forceLogin === true;

  let promptedLogin = false;
  if (forceLogin) {
    runAzureLogin(tenant);
    promptedLogin = true;
  }

  let token = '';
  try {
    token = tryGetToken(resource, tenant);
  } catch {
    runAzureLogin(tenant);
    promptedLogin = true;
    token = tryGetToken(resource, tenant);
  }

  if (!token) {
    throw new Error('Azure CLI did not return a Sentinel access token after login');
  }

  const account = getAccountSummary();
  const result = {
    account,
    promptedLogin,
    tenant: tenant || account.tenantId || '',
    tokenAcquired: true,
  };

  return {
    content: [
      {
        type: 'text',
        text: `Sentinel login ready for ${account.user?.name || account.name || 'current account'}`,
      },
    ],
    structuredContent: {
      result,
    },
  };
}