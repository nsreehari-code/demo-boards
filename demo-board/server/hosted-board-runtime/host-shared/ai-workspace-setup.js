import { spawn } from 'node:child_process';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function boardNeedsAiWorkspaceSetup(boardConfig) {
  const ai = normalizeText(boardConfig?.ai).toLowerCase();
  if (ai === 'copilot' || ai === 'foundry') {
    return true;
  }

  return Boolean(
    normalizeText(boardConfig?.aiWorkspaceTemplate)
    || normalizeText(boardConfig?.aiWorkspaceRoot),
  );
}

export function runSetupSingleAiWorkspaceScript(setupScriptPath, boardId, configPath) {
  return new Promise((resolve, reject) => {
    const args = [setupScriptPath, boardId];
    if (configPath) {
      args.push('--config', configPath);
    }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(`setup-single-ai-workspace.js exited with code ${code}: ${stderr || stdout}`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}