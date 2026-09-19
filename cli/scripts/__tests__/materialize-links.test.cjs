#!/usr/bin/env node
/**
 * Regression guard for materializeLinks.
 *
 * `npm pack` silently omits symlinks, so the packager converts every link in the bundle to a
 * real directory before packing. This test covers the three ways that can go wrong:
 *   - a link is left behind (npm pack would drop it, breaking the install)
 *   - content is not actually loadable after the copy
 *   - nested links are missed, because pnpm keeps a package's own deps as SIBLINGS of the
 *     package inside its store entry: .pnpm/next@<ver>/node_modules/{next,react,…}
 *
 * Run: node cli/scripts/__tests__/materialize-links.test.cjs
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { materializeLinks } = require("../build-cli.js");

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log((ok ? "  ok  " : "  FAIL").padEnd(8), label);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "matlink-"));
const nm = path.join(root, "node_modules");
const store = path.join(nm, ".pnpm");

// Store entries with real content.
fs.mkdirSync(path.join(store, "next@16.0.0", "node_modules", "next"), { recursive: true });
fs.writeFileSync(path.join(store, "next@16.0.0", "node_modules", "next", "index.js"), "module.exports='next';\n");
fs.writeFileSync(path.join(store, "next@16.0.0", "node_modules", "next", "package.json"), '{"name":"next","main":"index.js"}');

fs.mkdirSync(path.join(store, "react@19.0.0", "node_modules", "react"), { recursive: true });
fs.writeFileSync(path.join(store, "react@19.0.0", "node_modules", "react", "index.js"), "module.exports='react';\n");
fs.writeFileSync(path.join(store, "react@19.0.0", "node_modules", "react", "package.json"), '{"name":"react","main":"index.js"}');

// Top-level junctions -> store entries.
fs.symlinkSync(path.relative(nm, path.join(store, "next@16.0.0", "node_modules", "next")), path.join(nm, "next"), "junction");
fs.symlinkSync(path.relative(nm, path.join(store, "react@19.0.0", "node_modules", "react")), path.join(nm, "react"), "junction");

// A nested junction inside next's own entry (pnpm nests private deps).
fs.symlinkSync(
  path.relative(path.join(store, "next@16.0.0", "node_modules"), path.join(store, "react@19.0.0", "node_modules", "react")),
  path.join(store, "next@16.0.0", "node_modules", "react"),
  "junction",
);

const before = fs.lstatSync(path.join(nm, "next")).isSymbolicLink();
check(before, "precondition: node_modules/next is a link");

const count = materializeLinks(nm);
console.log(`  materialized ${count} link(s)`);

// Every link must be gone — npm pack would drop them.
const leftovers = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isSymbolicLink()) leftovers.push(path.relative(root, full));
    else if (e.isDirectory()) walk(full);
  }
};
walk(nm);
check(leftovers.length === 0, `no links remain (found ${JSON.stringify(leftovers)})`);

// Content must be real and loadable.
check(fs.existsSync(path.join(nm, "next", "index.js")), "next/index.js is a real file");
check(fs.existsSync(path.join(nm, "react", "index.js")), "react/index.js is a real file");
check(!fs.lstatSync(path.join(nm, "next")).isSymbolicLink(), "node_modules/next is a real directory");

// pnpm nests a package's deps as SIBLINGS of the package inside its store entry
// (.pnpm/next@1/node_modules/{next,react}), so a materialized node_modules/next legitimately
// has no node_modules of its own. What must hold is that the store entry's sibling link was
// expanded where that entry is still consulted: nm/.pnpm.
check(
  fs.existsSync(path.join(nm, ".pnpm", "next@16.0.0", "node_modules", "react", "index.js")),
  "nested store link (next@'s sibling react) materialized",
);

let loadable = false;
try {
  loadable = require(path.join(nm, "next", "index.js")) === "next";
} catch {}
check(loadable, "materialized module actually requires successfully");

// Idempotent: a second pass finds nothing to do.
check(materializeLinks(nm) === 0, "second run is a no-op");

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\n✅ materializeLinks verified" : `\n❌ ${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
