#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toCopilotAgentMarkdown } from '../../../generative-interaction-kernel/packages/agent-lifecycle-exp/dist/index.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultTargetDir = path.resolve(scriptDirectory, '..', '.copilot-workspace');

function parseArgs(argv) {
  const opts = {
    targetDir: defaultTargetDir,
    repoName: 'demo-boards-copilot-workspace',
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i += 1];

    switch (arg) {
      case '--target-dir':
        opts.targetDir = path.resolve(process.cwd(), next());
        break;
      case '--repo-name':
        opts.repoName = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/provision-copilot-agents.mjs [options]

Creates a local GitHub Copilot workspace scaffold for MCP-backed agent execution.

Options:
  --target-dir <path>   Target directory (default: mcp-server/.copilot-workspace)
  --repo-name <name>    Repository name metadata written into the generated files
  --dry-run             Print the planned files without writing them
  --force               Overwrite existing generated files
  --help                Show this help
`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeIfChanged(filePath, content) {
  ensureDir(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === content) return false;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function createCopilotInstructions(repoName) {
  return `# ${repoName} — Copilot Workspace Instructions

This repository is configured to run a local Copilot-backed agent using the MCP service layer.

## Operating model

- The model proposes tool calls.
- The host runtime owns validation and execution.
- MCP transports are the bridge between the model and the runtime host, not the execution authority.
- Keep tool calls narrow, explicit, and grounded in the repo state.

## Local workspace rules

- Prefer reading the current repo state before making assumptions.
- Favor small, reviewable edits over broad rewrites.
- Use the repo's existing tool contracts and source manifests instead of inventing new ones.
- Keep generated artifacts in the repo and explain any agent-specific behaviors in this file.

## Simple local chat agent

The local Copilot agent should behave like a lightweight chat surface backed by the MCP tool chain.
It must:

- answer using the local repo state and the current request only
- avoid making up facts, tool names, or schema fields
- use available MCP tools for execution and validation
- return a concise structured response with clear uncertainty when needed

## Tooling conventions

- Use repo-local skills from .github/skills before inventing new workflow patterns.
- Use .github/hooks for session and tool logging when the agent lifecycle needs observability.
- Keep hooks non-invasive and safe for local execution.
`;
}

function createSimpleAgentTemplate(repoName) {
  const tool = (name, description) => ({
    type: 'function',
    name,
    description,
    parameters: { type: 'object', additionalProperties: true },
    strict: true,
  });
  return {
    id: `${repoName}-simple-chat`,
    description: `Local chat agent for the ${repoName} workspace using the MCP-backed toolchain.`,
    executionAuthority: 'host',
    instructions: [
      `You are a local repository assistant for ${repoName}.`,
      'Your job is to help with grounded repository work, not to invent undocumented behavior.',
      [
        'Always:',
        '- read the relevant repo files before making changes',
        '- prefer the smallest safe action',
        '- keep changes consistent with the existing architecture',
        '- distinguish between model-proposed tool calls and host-owned execution',
      ].join('\n'),
      [
        'When you need to act:',
        '- inspect the relevant files or tool manifests first',
        '- validate the change with the narrowest possible command',
        '- report only what was verified',
      ].join('\n'),
    ],
    tools: [
      tool('read_file', 'Read a repository file.'),
      tool('search', 'Search the repository.'),
      tool('list_dir', 'List a repository directory.'),
      tool('run_in_terminal', 'Run a host-approved terminal command.'),
      tool('edit_file', 'Apply a host-approved file edit.'),
    ],
  };
}

function createSessionHook() {
  return `{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "mkdir -p logs && printf '%s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> logs/copilot-session-start.log",
        "powershell": "New-Item -ItemType Directory -Force -Path logs | Out-Null; Add-Content -Path logs/copilot-session-start.log -Value (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
        "cwd": ".",
        "timeoutSec": 10
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "printf '%s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> logs/copilot-session-end.log",
        "powershell": "Add-Content -Path logs/copilot-session-end.log -Value (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
        "cwd": ".",
        "timeoutSec": 10
      }
    ]
  }
}
`;
}

function createToolHook() {
  return `{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "echo \"tool-use-start\" >> logs/copilot-tool-events.log",
        "powershell": "Add-Content -Path logs/copilot-tool-events.log -Value 'tool-use-start'",
        "cwd": ".",
        "timeoutSec": 10
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "bash": "echo \"tool-use-end\" >> logs/copilot-tool-events.log",
        "powershell": "Add-Content -Path logs/copilot-tool-events.log -Value 'tool-use-end'",
        "cwd": ".",
        "timeoutSec": 10
      }
    ]
  }
}
`;
}

function createSkillFile() {
  return `# Live Board Cards Soul

This skill captures the core operating model for live board and card work.

## Principles

- Treat cards as the first-class system object.
- Read live board state before making a claim about the current situation.
- Prefer repo-local and currently available state over assumptions.
- Keep work scoped to the user's actual intent.
- Separate observed facts from interpretation.

## Execution guidance

- Read the relevant card or board state before editing.
- Validate changes with the smallest available proof.
- Record assumptions clearly when the repo state is incomplete.
- Use MCP-backed tools for operational execution, not ad hoc shell work when a repo tool exists.
`;
}

function buildWorkspaceFiles(targetDir, repoName) {
  return [
    {
      path: path.join(targetDir, '.github', 'copilot-instructions.md'),
      content: createCopilotInstructions(repoName),
    },
    {
      path: path.join(targetDir, '.github', 'agents', 'simple-chat.agent.md'),
      content: toCopilotAgentMarkdown(createSimpleAgentTemplate(repoName), { model: 'gpt-5.4' }),
    },
    {
      path: path.join(targetDir, '.github', 'hooks', 'session-logging.json'),
      content: createSessionHook(),
    },
    {
      path: path.join(targetDir, '.github', 'hooks', 'tool-logging.json'),
      content: createToolHook(),
    },
    {
      path: path.join(targetDir, '.github', 'skills', 'live-board-cards-soul', 'SKILL.md'),
      content: createSkillFile(),
    },
    {
      path: path.join(targetDir, 'README.md'),
      content: `# ${repoName}\n\nThis workspace is prepared for local Copilot CLI execution and repo-grounded chat tasks.\n\nGenerated by scripts/provision-copilot-agents.mjs.\n`,
    },
  ];
}

function initGitRepo(targetDir) {
  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    try {
      execFileSync('git', ['init'], { cwd: targetDir, stdio: 'inherit' });
    } catch (error) {
      console.warn(`git init failed for ${targetDir}: ${error.message}`);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targetDir = opts.targetDir;

  if (!opts.dryRun) {
    ensureDir(targetDir);
    initGitRepo(targetDir);
  }

  const files = buildWorkspaceFiles(targetDir, opts.repoName);

  if (opts.dryRun) {
    console.log(`Dry run: would create ${files.length} files under ${targetDir}`);
    for (const file of files) {
      console.log(file.path);
    }
    return;
  }

  for (const file of files) {
    const existing = fs.existsSync(file.path);
    if (existing && !opts.force) {
      const current = fs.readFileSync(file.path, 'utf8');
      if (current === file.content) {
        continue;
      }
      console.log(`Preserving existing file (use --force to overwrite): ${file.path}`);
      continue;
    }
    writeIfChanged(file.path, file.content);
    console.log(`Created/updated: ${file.path}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
