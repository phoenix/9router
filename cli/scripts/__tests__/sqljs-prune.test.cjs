#!/usr/bin/env node
/**
 * Regression guard for the sql.js bundle prune.
 *
 * sql.js ships ~23 MB of browser distribution (asm.js, -debug variants, workers, pre-zipped
 * bundles). In Node only `dist/sql-wasm.js` + `dist/sql-wasm.wasm` are ever read. This test
 * proves the prune keeps every copy WORKING — a smaller bundle that fails at runtime is worse
 * than a large one.
 *
 * It covers BOTH layouts the artifact contains, because missing either one silently leaves
 * ~23 MB behind:
 *   - node_modules/sql.js                        (top level)
 *   - <distDir>/node_modules/sql.js-<hash>       (Turbopack's content-hashed external shim;
 *                                                 server chunks do require("sql.js-<hash>"))
 *
 * Run: node cli/scripts/__tests__/sqljs-prune.test.cjs
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pruneSqlJsBundle } = require("../build-cli.js");
const DIST_DIR_NAME = ".next-cli-build";

/** Total bytes under `dir`. Kept in bytes so recursion does not re-scale at each level. */
function dirBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? dirBytes(full) : fs.statSync(full).size;
  }
  return total;
}

const toMB = (bytes) => bytes / (1024 * 1024);

/** Every file under `dir`, relative and slash-normalised. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

const KEEP = ["dist/sql-wasm.js", "dist/sql-wasm.wasm", "package.json"].sort();

async function main() {
  // __tests__ -> scripts -> cli -> repo root. node_modules/sql.js there is a pnpm symlink;
  // resolve it so cpSync copies real files rather than trying to recreate a symlink (blocked
  // in sandboxed environments).
  const sourceSqlJs = fs.realpathSync(path.resolve(__dirname, "../../../node_modules/sql.js"));
  if (!fs.existsSync(sourceSqlJs)) {
    console.log("⏭️  sql.js not installed — skipping");
    return 0;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sqljs-prune-"));

  // Two copies, mirroring the real artifact layout.
  const topLevel = path.join(tmpRoot, "node_modules", "sql.js");
  const hashed = path.join(tmpRoot, DIST_DIR_NAME, "node_modules", "sql.js-4dec5ed134bce993");
  fs.mkdirSync(path.dirname(topLevel), { recursive: true });
  fs.mkdirSync(path.dirname(hashed), { recursive: true });
  fs.cpSync(sourceSqlJs, topLevel, { recursive: true, dereference: true });
  fs.cpSync(sourceSqlJs, hashed, { recursive: true, dereference: true });

  // A decoy that must NOT be touched: a normal package under .pnpm.
  const decoy = path.join(tmpRoot, "node_modules", ".pnpm", "left-pad@1.0.0", "node_modules", "left-pad");
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
  fs.writeFileSync(path.join(decoy, "index.js"), "module.exports = 1;\n");

  const before = dirBytes(topLevel) + dirBytes(hashed);
  console.log(`  before: ${toMB(before).toFixed(2)} MB across 2 sql.js copies`);

  // Sanity: the un-pruned copies must work.
  for (const dir of [topLevel, hashed]) {
    const init = require(dir);
    const SQL = await init();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (a INT); INSERT INTO t VALUES (1);");
    if (db.exec("SELECT a FROM t")[0].values[0][0] !== 1) {
      console.error(`❌ baseline sql.js failed before prune (${dir}) — aborting`);
      return 1;
    }
    db.close();
  }

  const removed = pruneSqlJsBundle(tmpRoot);
  const after = dirBytes(topLevel) + dirBytes(hashed);

  let failures = 0;

  // Both copies: only the three required files remain.
  for (const [label, dir] of [["top-level", topLevel], ["turbopack-hash", hashed]]) {
    const files = listFiles(dir);
    const same = JSON.stringify(files) === JSON.stringify(KEEP);
    if (!same) failures++;
    console.log((same ? "  ok  " : "  FAIL").padEnd(8), `${label}: only required files remain ${JSON.stringify(files)}`);
  }

  // Both copies must still WORK — this is the assertion that matters.
  for (const [label, dir] of [["top-level", topLevel], ["turbopack-hash", hashed]]) {
    let ok = false;
    let detail = "";
    try {
      for (const k of Object.keys(require.cache)) {
        if (k.startsWith(dir)) delete require.cache[k];
      }
      const init = require(dir);
      const SQL = await init();
      const db = new SQL.Database();
      db.run("CREATE TABLE t (a INT); INSERT INTO t VALUES (7);");
      const got = db.exec("SELECT a FROM t")[0].values[0][0];
      db.close();
      ok = got === 7;
      detail = `query returned ${got}`;
    } catch (e) {
      detail = e.message;
    }
    if (!ok) failures++;
    console.log((ok ? "  ok  " : "  FAIL").padEnd(8), `${label}: still queries (${detail})`);
  }

  // The decoy package must be untouched.
  const decoyIntact = fs.existsSync(path.join(decoy, "index.js"));
  if (!decoyIntact) failures++;
  console.log((decoyIntact ? "  ok  " : "  FAIL").padEnd(8), "unrelated .pnpm package untouched");

  console.log(
    `\n  size: ${toMB(before).toFixed(2)} MB -> ${toMB(after).toFixed(2)} MB ` +
      `(removed ${removed} files, saved ${toMB(before - after).toFixed(2)} MB)`,
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (failures === 0) {
    console.log("\n✅ sql.js prune verified (both copies pruned, both still work)");
    return 0;
  }
  console.log(`\n❌ ${failures} sql.js prune check(s) FAILED`);
  return 1;
}

main().then((c) => {
  // Do not call process.exit: sql.js wasm handles may still be open, and forcing exit trips a
  // libuv teardown assertion ("handle->flags & UV_HANDLE_CLOSING") that looks like a failure.
  process.exitCode = c;
});
