#!/usr/bin/env node
'use strict';

const path = require('path');
const { writeManagedTruthsetsManifests } = require('../lib/finbook-mcp-manifests.js');

const outputDir = path.resolve(__dirname, '..');
const result = writeManagedTruthsetsManifests(outputDir);
const files = [
  result.semanticPath,
  result.executablePath,
  result.capabilitiesPath,
  result.computedViewsPath,
  result.schemaPath,
].map((filePath) => path.basename(filePath));

process.stdout.write(`Generated ${files.join(', ')} in ${outputDir}\n`);