#!/usr/bin/env node
/**
 * Regression guard for the source-map strip.
 *
 * Turbopack always emits production source maps (no opt-out), which a webpack build would not
 * have produced — ~46 MB of `.map` files in this project's server tree. They are dead weight at
 * runtime because Node only reads `.map` under `--enable-source-maps`, which this project never
 * sets.
 *
 * The risk being guarded: over-reach. The stripper must remove only `.map` files inside the
 * build output, and must never touch `app/src/**` (real source) or non-map build artifacts.
 *
 * Run: node cli/scripts/__tests__/sourcemap-strip.test.cjs
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { stripSourceMaps, stripNftManifests } = require("../build-cli.js");
const DIST_DIR_NAME = ".next-cli-build";

function build(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srcmap-strip-"));

  build(root, {
    // Maps inside the build output — must be removed.
    [`${DIST_DIR_NAME}/server/chunks/a.js`]: "console.log(1)\n//# sourceMappingURL=a.js.map",
    [`${DIST_DIR_NAME}/server/chunks/a.js.map`]: "{}",
    [`${DIST_DIR_NAME}/server/middleware.js.map`]: "{}",
    [`${DIST_DIR_NAME}/node_modules/sql.js-x/dist/sql-wasm.js.map`]: "{}",
    [`${DIST_DIR_NAME}/static/chunks/b.js.map`]: "{}",
    // Must SURVIVE: real source, non-map build output, and a file merely named like a map.
    "src/lib/db/paths.js": "// real source\n",
    "src/app/api/v1/route.js.map.txt": "not a source map\n",
    [`${DIST_DIR_NAME}/server/chunks/a.js`]: "console.log(1)",
    [`${DIST_DIR_NAME}/server/app/api/v1/chat/completions/route.js`]: "module.exports={}\n",
    "custom-server.js": "// entry\n",
    "package.json": '{"name":"x"}',
  });

  const removedBefore = countMaps(path.join(root, DIST_DIR_NAME));
  const { removed, bytes } = stripSourceMaps(root);
  const removedAfter = countMaps(path.join(root, DIST_DIR_NAME));

  let failures = 0;
  const check = (ok, label) => {
    if (!ok) failures++;
    console.log((ok ? "  ok  " : "  FAIL").padEnd(8), label);
  };

  console.log(`  maps before=${removedBefore} after=${removedAfter} removed=${removed} (${bytes} bytes)`);

  check(removedAfter === 0, "every .map under the build output is gone");
  check(removed === removedBefore, "reported count matches what existed");

  // The things that must survive.
  check(exists(root, "src/lib/db/paths.js"), "real source under src/ untouched");
  check(exists(root, "src/app/api/v1/route.js.map.txt"), "*.map.txt (not a real map) untouched");
  check(
    exists(root, `${DIST_DIR_NAME}/server/app/api/v1/chat/completions/route.js`),
    "required API route artifact untouched",
  );
  check(exists(root, `${DIST_DIR_NAME}/server/chunks/a.js`), "non-map build chunk untouched");
  check(exists(root, "custom-server.js"), "custom-server.js untouched");
  check(exists(root, "package.json"), "package.json untouched");

  // A second run must be a harmless no-op.
  const second = stripSourceMaps(root);
  check(second.removed === 0, "second run is a no-op (idempotent)");

  // ---- .nft.json manifests (build-time only, never read at runtime) ----
  // Next emits one per route/page (~190 in this project, ~19 MB). They are scope-sensitive:
  // only `*.nft.json` inside the build output may go, and the sibling route.js must survive.
  build(root, {
    [`${DIST_DIR_NAME}/server/app/api/x/route.js`]: "code",
    [`${DIST_DIR_NAME}/server/app/api/x/route.js.nft.json`]: "{}",
    [`${DIST_DIR_NAME}/server/app/api/y/route.js.nft.json`]: "{}",
    [`${DIST_DIR_NAME}/server/page.js.nft.json.bak`]: "{}",
    "src/app/route.js.nft.json": "not build output",
  });

  const nft = stripNftManifests(root);
  check(nft.removed === 2, `removed exactly the 2 build-output manifests (got ${nft.removed})`);
  check(
    !exists(root, `${DIST_DIR_NAME}/server/app/api/x/route.js.nft.json`),
    "route.js.nft.json removed",
  );
  check(exists(root, `${DIST_DIR_NAME}/server/app/api/x/route.js`), "sibling route.js kept");
  check(
    exists(root, `${DIST_DIR_NAME}/server/page.js.nft.json.bak`),
    "*.nft.json.bak (not a manifest) kept",
  );
  check(exists(root, "src/app/route.js.nft.json"), "manifest outside build output kept");
  check(stripNftManifests(root).removed === 0, "nft strip is idempotent");

  fs.rmSync(root, { recursive: true, force: true });

  if (failures === 0) {
    console.log("\n✅ source-map + .nft.json strip verified (removed, everything else intact)");
    return 0;
  }
  console.log(`\n❌ ${failures} strip check(s) FAILED`);
  return 1;
}

function countMaps(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".map")) n++;
    }
  };
  walk(dir);
  return n;
}

process.exitCode = main();
