import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function resolveAzureCliCommand() {
  const override = typeof process.env.AZURE_CLI_COMMAND === 'string' ? process.env.AZURE_CLI_COMMAND.trim() : '';
  if (override) {
    return override;
  }

  if (process.platform !== 'win32') {
    return 'az';
  }

  const candidates = [
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd')
      : '',
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd')
      : '',
    process.env.LocalAppData
      ? path.join(process.env.LocalAppData, 'Programs', 'Azure CLI', 'wbin', 'az.cmd')
      : '',
    'az.cmd',
  ].filter(Boolean);

  return candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate)) || candidates[0];
}

export function runAzureCli(commandArgs, { inherit = false } = {}) {
  const command = resolveAzureCliCommand();

  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...commandArgs], {
      encoding: 'utf-8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: !inherit,
    });
  }

  return execFileSync(command, commandArgs, {
    encoding: 'utf-8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: !inherit,
  });
}