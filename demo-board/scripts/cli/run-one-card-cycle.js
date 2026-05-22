#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, 'board-live-cards-cli.js');

function usage() {
  console.error(
    [
      'Usage:',
      '  cat payload.json | node run-one-card-cycle.js --base-ref <board-ref>',
      '',
      'Required payload shape:',
      '  { "card-content": <card>, "mock-requires": {...} }',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function readStdinJson() {
  if (process.stdin.isTTY) {
    return null;
  }
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : null;
}

function buildPayload(args) {
  if (typeof args['base-ref'] !== 'string' || args['base-ref'].trim().length === 0) {
    usage();
    throw new Error('--base-ref is required');
  }

  if (args.payload || args.card || args.requires) {
    usage();
    throw new Error('run-one-card-cycle.js accepts input only from stdin');
  }

  const stdinPayload = readStdinJson();
  if (!stdinPayload) {
    usage();
    throw new Error('stdin payload is required');
  }

  if (typeof stdinPayload !== 'object' || Array.isArray(stdinPayload)) {
    usage();
    throw new Error('payload must be a JSON object');
  }

  if (!Object.prototype.hasOwnProperty.call(stdinPayload, 'card-content')) {
    usage();
    throw new Error('payload must include card-content');
  }

  if (stdinPayload['card-content'] == null || typeof stdinPayload['card-content'] !== 'object' || Array.isArray(stdinPayload['card-content'])) {
    usage();
    throw new Error('payload card-content must be a JSON object');
  }

  if (!Object.prototype.hasOwnProperty.call(stdinPayload, 'mock-requires')) {
    usage();
    throw new Error('payload must include mock-requires');
  }

  if (stdinPayload['mock-requires'] == null || typeof stdinPayload['mock-requires'] !== 'object' || Array.isArray(stdinPayload['mock-requires'])) {
    usage();
    throw new Error('payload mock-requires must be a JSON object');
  }

  return stdinPayload;
}

function getAtPath(objectValue, ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return undefined;
  }

  let target = objectValue;
  let pathRef = ref;
  if (pathRef.startsWith('fetched_sources.')) {
    target = objectValue.fetched_sources;
    pathRef = pathRef.slice('fetched_sources.'.length);
  }

  for (const segment of pathRef.split('.')) {
    if (target == null) {
      return undefined;
    }
    target = target[segment];
  }

  return target;
}

function materializeProvides(card, runtimeNode) {
  const outputs = {};
  for (const entry of Array.isArray(card?.provides) ? card.provides : []) {
    if (!entry || typeof entry.bindTo !== 'string' || typeof entry.ref !== 'string') {
      continue;
    }
    outputs[entry.bindTo] = getAtPath(runtimeNode, entry.ref);
  }
  return outputs;
}

function materializeView(card, runtimeNode) {
  const view = card?.view;
  const elements = Array.isArray(view?.elements) ? view.elements : [];

  return {
    layout: view?.layout,
    features: view?.features,
    elements: elements.map((element, index) => {
      const visible = typeof element?.visible === 'string'
        ? Boolean(getAtPath(runtimeNode, element.visible))
        : true;
      const bind = typeof element?.data?.bind === 'string' ? element.data.bind : undefined;
      const resolved = bind ? getAtPath(runtimeNode, bind) : undefined;
      const model = {
        id: element?.id || `element-${index}`,
        kind: element?.kind,
        label: element?.label,
        visible,
      };

      if (bind) {
        model.bind = bind;
      }
      if (Array.isArray(element?.data?.columns)) {
        model.columns = element.data.columns;
      }
      if (typeof element?.data?.maxRows === 'number') {
        model.maxRows = element.data.maxRows;
      }
      if (resolved !== undefined) {
        model.resolved = Array.isArray(resolved) && typeof model.maxRows === 'number'
          ? resolved.slice(0, model.maxRows)
          : resolved;
      }

      return model;
    }),
  };
}

function runSimulateCardCycle(payload, args) {
  const cliArgs = [cliPath, 'simulate-card-cycle'];
  cliArgs.push('--base-ref', args['base-ref'].trim());

  const result = spawnSync(process.execPath, cliArgs, {
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `simulate-card-cycle failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = buildPayload(args);
  const card = payload?.['card-content'] ?? payload;
  const simulateResult = runSimulateCardCycle(payload, args);

  if (simulateResult.status !== 'success') {
    console.log(JSON.stringify(simulateResult, null, 2));
    process.exit(0);
  }

  const runtimeNode = {
    card_data: card?.card_data,
    requires: payload?.['mock-requires'],
    fetched_sources: undefined,
    computed_values: simulateResult.data?.computed_values,
  };

  const output = {
    status: 'success',
    data: {
      ...simulateResult.data,
      fetched_sources: simulateResult.data?.source_probes,
      provided_outputs: materializeProvides(card, runtimeNode),
      view_model: materializeView(card, runtimeNode),
    },
  };

  delete output.data.source_probes;

  console.log(JSON.stringify(output, null, 2));
}

main();