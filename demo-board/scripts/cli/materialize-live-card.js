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
      '  cat payload.json | node materialize-live-card.js',
      '',
      'Payload shape matches eval-card-compute:',
      '  { "card-content": <card>, "mock-requires": {...}, "mock-fetched-sources": {...} }',
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

function getAtPath(objectValue, ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return undefined;
  }
  let target = objectValue;
  let pathRef = ref;
  if (pathRef.startsWith('fetched_sources.')) {
    target = objectValue._sourcesData || {};
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
  const provides = Array.isArray(card.provides) ? card.provides : [];
  for (const entry of provides) {
    if (!entry || typeof entry.bindTo !== 'string' || typeof entry.ref !== 'string') {
      continue;
    }
    outputs[entry.bindTo] = getAtPath(runtimeNode, entry.ref);
  }
  return outputs;
}

function materializeView(card, runtimeNode) {
  const view = card.view && typeof card.view === 'object' ? card.view : {};
  const elements = Array.isArray(view.elements) ? view.elements : [];
  return {
    layout: view.layout,
    features: view.features,
    elements: elements.map((element, index) => {
      const visible = typeof element.visible === 'string'
        ? Boolean(getAtPath(runtimeNode, element.visible))
        : true;
      const bind = typeof element?.data?.bind === 'string' ? element.data.bind : null;
      const resolved = bind ? getAtPath(runtimeNode, bind) : undefined;
      const model = {
        id: element.id || `element-${index}`,
        kind: element.kind,
        label: element.label,
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
      if (Array.isArray(resolved)) {
        model.resolved = typeof model.maxRows === 'number' ? resolved.slice(0, model.maxRows) : resolved;
      } else {
        model.resolved = resolved;
      }
      return model;
    }),
  };
}

function buildPayload(args) {
  if (args.payload || args.card || args.requires || args['fetched-sources']) {
    usage();
    throw new Error('materialize-live-card.js accepts input only from stdin');
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

  if (!Object.prototype.hasOwnProperty.call(stdinPayload, 'mock-fetched-sources')) {
    usage();
    throw new Error('payload must include mock-fetched-sources');
  }

  if (stdinPayload['mock-fetched-sources'] == null || typeof stdinPayload['mock-fetched-sources'] !== 'object' || Array.isArray(stdinPayload['mock-fetched-sources'])) {
    usage();
    throw new Error('payload mock-fetched-sources must be a JSON object');
  }

  return stdinPayload;
}

function runEvalCardCompute(payload) {
  const result = spawnSync(process.execPath, [cliPath, 'eval-card-compute'], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `eval-card-compute failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = buildPayload(args);
  const card = payload['card-content'] || payload;
  const evalResult = runEvalCardCompute(payload);
  if (evalResult.status !== 'success') {
    console.log(JSON.stringify(evalResult, null, 2));
    process.exit(0);
  }

  const runtimeNode = {
    ...card,
    card_data: card.card_data || {},
    requires: payload['mock-requires'],
    computed_values: evalResult.data?.computed_values || {},
    _sourcesData: payload['mock-fetched-sources'],
  };

  const output = {
    status: 'success',
    data: {
      ...evalResult.data,
      provided_outputs: materializeProvides(card, runtimeNode),
      view_model: materializeView(card, runtimeNode),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main();