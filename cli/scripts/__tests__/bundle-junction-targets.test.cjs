#!/usr/bin/env node
/**
 * Guard: the packed bundle must contain NO symlinks, and every runtime package must be reachable.
 *
 * Why this exists: `npm pack` silently omits symlinks. A bundle whose node_modules/next is a
 * junction installs with no `next` at all, and the server dies on boot with:
 *
 *     Error: Cannot find module 'next'
 *
 * That is the failure mode this guard prevents. The build materializes every link before
 * packing; this test asserts the result.
 *
 * It additionally verifies that any link still present (a pre-pack tree) points at its OWN store
 * entry — catching the re-hoist bug where react/react-dom/styled-jsx were linked into next's
 * private nested copy, duplicating them in the tarball.
 *
 * Run: node cli/scripts/__tests__/bundle-junction-targets.test.cjs [path/to/cli/app]
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Extract the `.pnpm/<entry>` segment from a junction target. */
function storeEntryOf(target) {
  const m = target.replace(/\\/g, "/").match(/\/\.pnpm\/([^/]+)\//);
  return m ? m[1] : null;
}

/** pnpm store entry names are "<name>@<ver>", with a scoped "/" written as "+". */
function entryMatchesPackage(entry, pkg) {
  const prefixes = [`${pkg}@`];
  if (pkg.startsWith("@")) prefixes.push(`${pkg.replace("/", "+")}@`);
  return prefixes.some((p) => entry.startsWith(p));
}

/** Runtime packages the server cannot start without. */
const REQUIRED = ["next", "react", "react-dom", "open", "sql.js"];

function main() {
  const bundle = process.argv[2] || path.resolve(__dirname, "../../app");
  const nm = path.join(bundle, "node_modules");
  if (!fs.existsSync(nm)) {
    console.log(`⏭️  no bundle node_modules at ${nm} — skipping`);
    return 0;
  }

  // Collect links at ANY depth: npm pack drops them wherever they are.
  const links = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(nm);

  let bad = 0;

  if (links.length > 0) {
    // Pre-pack view: links must at least target their own store entry.
    let checked = 0;
    for (const full of links) {
      // Scoped packages: the link's own name is "env" but the package is "@next/env", so derive
      // it from the path (node_modules/@next/env) rather than basename alone.
      const rel = path.relative(nm, full).replace(/\\/g, "/");
      const segs = rel.split("/");
      const name = segs.length >= 2 && segs[0].startsWith("@") ? `${segs[0]}/${segs[1]}` : segs[0];
      let target;
      try {
        target = fs.realpathSync(full);
      } catch {
        console.log(`  FAIL ${path.relative(bundle, full)}: broken link`);
        bad++;
        continue;
      }
      const storeEntry = storeEntryOf(target);
      const inside = target.replace(/\\/g, "/").startsWith(bundle.replace(/\\/g, "/"));
      if (!storeEntry) {
        if (!inside) {
          console.log(`  FAIL ${path.relative(bundle, full)}: points outside the bundle`);
          bad++;
        }
        continue;
      }
      checked++;
      if (!entryMatchesPackage(storeEntry, name)) {
        console.log(`  FAIL ${name}: links into "${storeEntry}" (should be its own entry)`);
        bad++;
      }
    }
    console.log(`  checked ${checked} junction(s) pointing into .pnpm`);
    console.log(`\n❌ ${links.length} symlink(s) remain — npm pack DROPS these, so the installed`);
    console.log("   package would be missing:");
    for (const l of links.slice(0, 8)) console.log(`     ${path.relative(bundle, l)}`);
    console.log("   The build must materialize links before packing.");
    return 1;
  }

  console.log("  no symlinks in bundle ✅");

  for (const pkg of REQUIRED) {
    const p = path.join(nm, pkg);
    let ok = false;
    try {
      ok = fs.statSync(p).isDirectory() && !fs.lstatSync(p).isSymbolicLink();
    } catch {
      ok = false;
    }
    if (!ok) {
      console.log(`  FAIL ${pkg}: missing or still a link — install would fail with Cannot find module '${pkg}'`);
      bad++;
    }
  }

  if (bad === 0) {
    console.log(`  ${REQUIRED.join(", ")} present as real directories`);
    console.log("\n✅ bundle is pack-safe: no symlinks, all runtime packages resolvable");
    return 0;
  }
  console.log(`\n❌ ${bad} problem(s)`);
  return 1;
}

process.exitCode = main();
