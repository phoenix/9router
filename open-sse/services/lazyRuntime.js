// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and loaded from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.
//
// Loads through `createRequire`, never `import(expr)`: the app is bundled by
// Turbopack, which cannot resolve a computed specifier and replaces it with a
// stub that always throws "Cannot find module as expression is too dynamic".
// That stub used to swallow every real lookup, so the on-demand install ran even
// when the package was already present and the caller got a bogus error. A
// require() on a fixed base path is resolved by Node at runtime instead, so the
// bundler never rewrites it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

// Base filenames createRequire() resolves modules from, in order of preference.
// import.meta.url points at this module inside the traced standalone app;
// process.cwd() covers a plain `node open-sse/...` run from the repo root.
function requireBases() {
  const bases = [];
  try {
    bases.push(fileURLToPath(import.meta.url));
  } catch {
    // Bundler did not expose import.meta.url — fall through to cwd.
  }
  bases.push(path.join(process.cwd(), "index.js"));
  return bases;
}

function requireFrom(baseFile, pkg) {
  return createRequire(baseFile)(pkg);
}

// Try every base and return the first successful require. Rethrows the last
// non-missing error (a broken native binding must not be masked as "missing").
function tryRequire(pkg) {
  let lastMissing = null;
  for (const base of requireBases()) {
    try {
      return requireFrom(base, pkg);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
      lastMissing = error;
    }
  }
  throw lastMissing || Object.assign(new Error(`Cannot find module '${pkg}'`), { code: "MODULE_NOT_FOUND" });
}

function tryRequireFromDir(dir, pkg) {
  return requireFrom(path.join(dir, "index.js"), pkg);
}

// Run npm's CLI through the same Node binary as the app. Spawning "npm.cmd"
// needs cmd.exe (absent on hardened Windows hosts, and its `shell: true` path
// mangles the argument list); `node npm-cli.js` works on every platform.
function resolveNpmInvocation() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const cli of candidates) {
    if (fs.existsSync(cli)) return { command: process.execPath, prefixArgs: [cli], shell: false };
  }
  // Last resort: the npm binary on PATH. Windows needs a shell for the .cmd shim.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return { command: npm, prefixArgs: [], shell: process.platform === "win32" };
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const { command, prefixArgs, shell } = resolveNpmInvocation();
  const args = [...prefixArgs, "install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

const inflight = new Map();

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return tryRequire(pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  try {
    return tryRequireFromDir(getRuntimeDir(), pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then load from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
  return tryRequireFromDir(dir, pkg);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
