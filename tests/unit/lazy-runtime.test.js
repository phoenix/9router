import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The loader resolves from DATA_DIR/runtime, so point it at a throwaway tree
// before the module (and writableDataDir's cache) is imported.
const originalDataDir = process.env.DATA_DIR;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9r-lazy-runtime-"));
process.env.DATA_DIR = tempRoot;

const runtimeDir = path.join(tempRoot, "runtime");
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(
  path.join(runtimeDir, "package.json"),
  JSON.stringify({ name: "9router-runtime", version: "1.0.0", private: true })
);

function writePackage(name, dir, code) {
  const pkgDir = path.join(dir, "node_modules", name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js" })
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), code);
}

// Only reachable through the runtime dir, never from the app install.
writePackage("9r-runtime-only-dep", runtimeDir, "module.exports = { where: 'runtime' };");
// Installed but broken: must surface the real error, not be reclassified as missing.
writePackage("9r-broken-dep", runtimeDir, "throw new Error('native binding exploded');");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("lazyRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Regression: Turbopack rewrote the old computed import() into a stub that
  // always threw "Cannot find module as expression is too dynamic", so an
  // already-installed dependency was reported missing and the caller got a bogus
  // "wreq-js unavailable" 502. Requiring must now resolve the real package.
  it("resolves a dependency already installed in the app", async () => {
    let installed = true;
    try {
      createRequire(import.meta.url).resolve("wreq-js");
    } catch {
      installed = false;
    }
    if (!installed) return; // devDependency absent in this checkout

    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const mod = await loadRuntimeDep("wreq-js");
    expect(typeof mod.createSession).toBe("function");
  });

  it("falls back to the DATA_DIR/runtime install", async () => {
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const mod = await loadRuntimeDep("9r-runtime-only-dep");
    expect(mod.where).toBe("runtime");
  });

  it("propagates a broken installed module instead of treating it as missing", async () => {
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await expect(loadRuntimeDep("9r-broken-dep")).rejects.toThrow(/native binding exploded/);
  });

  it("dedupes concurrent loads into one resolution", async () => {
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const [a, b] = await Promise.all([
      loadRuntimeDep("9r-runtime-only-dep"),
      loadRuntimeDep("9r-runtime-only-dep"),
    ]);
    expect(a).toBe(b);
  });
});
