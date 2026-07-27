import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const vendorDir = path.join(packageDir, "vendor");
const vendorManifestPath = path.join(vendorDir, "durable-runtime.vendor.json");
const packageJsonPath = path.join(packageDir, "package.json");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script through an npm vendor or verify command.");

function checksum(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verify() {
  const vendorManifest = JSON.parse(readFileSync(vendorManifestPath, "utf8"));
  const tarballPath = path.join(vendorDir, vendorManifest.file);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (vendorManifest.package !== "@gik/durable-runtime") throw new Error("Unexpected vendored package name.");
  if (!existsSync(tarballPath)) throw new Error(`Vendored package is missing: ${tarballPath}`);
  if (checksum(tarballPath) !== vendorManifest.sha256) throw new Error("Vendored package checksum mismatch.");
  if (packageJson.dependencies?.[vendorManifest.package] !== `file:vendor/${vendorManifest.file}`) {
    throw new Error("MCP server dependency does not match the vendored package manifest.");
  }
  console.log(`Verified ${vendorManifest.file} (${vendorManifest.sha256}).`);
}

if (process.argv[2] === "--verify") {
  verify();
  process.exit(0);
}

const invocationDir = process.env.INIT_CWD ?? process.cwd();
const source = process.argv[2] ? path.resolve(invocationDir, process.argv[2]) : undefined;
if (!source || !existsSync(source)) {
  throw new Error("Usage: npm run vendor:durable-runtime -- <path-to-gik-durable-runtime.tgz>");
}
const filename = path.basename(source);
const match = /^gik-durable-runtime-(.+)\.tgz$/.exec(filename);
if (!match) throw new Error("Expected a gik-durable-runtime-<version>.tgz artifact.");

for (const entry of readdirSync(vendorDir)) {
  if (/^gik-durable-runtime-.*\.tgz$/.test(entry) && entry !== filename) rmSync(path.join(vendorDir, entry));
}
copyFileSync(source, path.join(vendorDir, filename));
const sha256 = checksum(path.join(vendorDir, filename));
writeFileSync(vendorManifestPath, `${JSON.stringify({
  package: "@gik/durable-runtime",
  version: match[1],
  file: filename,
  sha256,
}, null, 2)}\n`);

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.dependencies["@gik/durable-runtime"] = `file:vendor/${filename}`;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
rmSync(path.join(packageDir, "node_modules", "@gik", "durable-runtime"), { recursive: true, force: true });
const installed = spawnSync(process.execPath, [npmCli, "install", "--ignore-scripts"], {
  cwd: packageDir,
  stdio: "inherit",
});
if (installed.status !== 0) throw new Error(`npm install failed with exit code ${installed.status}.`);
verify();
