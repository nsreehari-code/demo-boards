#!/usr/bin/env node
// Smoke check for Sentinel tenant auth via Azure CLI.
//
// Verifies that:
//   1) SENTINEL_TENANT_ID (or --tenant) is configured
//   2) Azure CLI has an active account context
//   3) a Sentinel token can be minted for the target tenant/resource
//
// Usage:
//   npm run smoke:sentinel:tenant
//   npm run smoke:sentinel:tenant -- --tenant <tenant-guid>
//   npm run smoke:sentinel:tenant -- --login

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAzureCli } from '../src/handlers/azure-cli.js';

const DEFAULT_RESOURCE = '4500ebfb-89b6-4b14-a480-7f749797bfcd';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpServerRoot = path.resolve(__dirname, '..');

// Load mcp-server/.env so SENTINEL_* resolves exactly like src/index.js.
const envPath = path.join(mcpServerRoot, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore malformed .env; explicit environment variables still take effect.
  }
}

function parseArgs(argv) {
  const parsed = {
    tenant: '',
    resource: '',
    login: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--tenant' && argv[i + 1]) {
      parsed.tenant = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--resource' && argv[i + 1]) {
      parsed.resource = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--login') {
      parsed.login = true;
      continue;
    }
  }

  return parsed;
}

function getAccountSummary() {
  const raw = runAzureCli([
    'account',
    'show',
    '--query',
    '{tenantId:tenantId,subscriptionId:id,subscriptionName:name,user:user.name}',
    '-o',
    'json',
  ]).trim();
  return JSON.parse(raw);
}

function tryMintSentinelToken(resource, tenant) {
  const args = [
    'account',
    'get-access-token',
    '--resource',
    resource,
    '--query',
    '{tenant:tenant,expiresOn:expiresOn,tokenType:tokenType}',
    '-o',
    'json',
  ];
  if (tenant) {
    args.push('--tenant', tenant);
  }
  const raw = runAzureCli(args).trim();
  return JSON.parse(raw);
}

function runTenantLogin(resource, tenant) {
  const args = [
    'login',
    '--scope',
    `${resource}/.default`,
    '--allow-no-subscriptions',
  ];
  if (tenant) {
    args.push('--tenant', tenant);
  }
  runAzureCli(args, { inherit: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenant = (args.tenant || process.env.SENTINEL_TENANT_ID || '').trim();
  const resource = (args.resource || process.env.SENTINEL_RESOURCE || DEFAULT_RESOURCE).trim();

  if (!tenant) {
    console.error('[sentinel:tenant-check] Missing tenant. Set SENTINEL_TENANT_ID in mcp-server/.env or pass --tenant <guid>.');
    process.exit(1);
    return;
  }

  console.log('[sentinel:tenant-check] target:', { tenant, resource });

  let account;
  try {
    account = getAccountSummary();
    console.log('[sentinel:tenant-check] az account:', account);
  } catch (error) {
    console.error(`[sentinel:tenant-check] Unable to read az account context: ${String(error?.message || error)}`);
    process.exit(1);
    return;
  }

  const mintWithOptionalLogin = () => {
    try {
      return tryMintSentinelToken(resource, tenant);
    } catch (error) {
      if (!args.login) {
        throw error;
      }
      console.log('[sentinel:tenant-check] Token mint failed; launching interactive az login...');
      runTenantLogin(resource, tenant);
      return tryMintSentinelToken(resource, tenant);
    }
  };

  try {
    const tokenInfo = mintWithOptionalLogin();
    console.log('[sentinel:tenant-check] token:', tokenInfo);
    console.log('[sentinel:tenant-check] PASS');
    process.exit(0);
  } catch (error) {
    console.error(`[sentinel:tenant-check] FAIL: ${String(error?.message || error)}`);
    console.error('[sentinel:tenant-check] Tip: run with --login to trigger browser sign-in for this tenant.');
    process.exit(1);
  }
}

main();
