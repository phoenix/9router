#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = process.env.NINEROUTER_CLI_APP_DIR || path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
];

// Exact directory/file names to drop, matched ONLY at the top level of the tree being copied.
//
// Scope matters: these names also occur deep inside packages — `next/dist/cli` (which
// `dist/server/config-schema.js` requires at runtime), `docs/` inside many packages, etc.
// Matching them at any depth silently deleted next's runtime files and produced a bundle that
// crashed on boot with "Cannot find module '../cli/next-test'". Hence: top level only.
const EXCLUDE_TOP_LEVEL = new Set([
  "tests",
  "gitbook",
  "images",
  "docs",
  "skills",
  "scratch",
  "cli",            // never ship the CLI launcher inside its own bundle
]);

function isEnvFile(name) {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Packed release archives must never be bundled.
 *
 * `npm pack --pack-destination ..` leaves 9router-<version>.tgz in the repo root, which sits
 * inside outputFileTracingRoot. Turbopack's dynamic-filesystem scanning then traces it into
 * standalone (~16.5 MB), it is copied into cli/app, and the NEXT `npm pack` swallows it — so the
 * artifact nests the previous release and roughly doubles in size.
 *
 * Matched by extension at any depth, since the copy can surface at the bundle root or inside a
 * traced directory.
 */
function isArchiveFile(name) {
  return name.endsWith(".tgz") || name.endsWith(".tar.gz") || name.endsWith(".tar");
}

function shouldExclude(name, { topLevel = false } = {}) {
  if (isEnvFile(name) || isArchiveFile(name)) return true;
  if (topLevel && EXCLUDE_TOP_LEVEL.has(name)) return true;
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

/**
 * A pnpm store realpath looks like:
 *   <root>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>[/<subpath>]
 * Return the part after the store's own `node_modules/` — i.e. `<pkg>[/<subpath>]`.
 */
function packagePathWithinStore(realPath) {
  const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
  const idx = realPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const after = realPath.slice(idx + marker.length); // <pkg>@<ver>/node_modules/<pkg>[/sub]
  const segs = after.split(path.sep);
  if (segs.length < 3) return null;
  return segs.slice(2).join(path.sep); // <pkg>[/sub]
}

/**
 * Locate the same package inside the store that was copied into `destNodeModules`.
 *
 * The top-level junction in a pnpm standalone tree points at the ROOT store of the build
 * machine, where the package is the full dev copy (next: 172 MB). The tree being copied keeps
 * its own trace-pruned store (next: 13.8 MB). We must link to the DESTINATION's copy — never
 * the source's — or the shipped bundle would reference a path that only exists on the build
 * machine.
 *
 * Match on the store entry's PACKAGE NAME, not merely on "some entry that happens to contain a
 * directory with this name". pnpm nests a package's own dependencies inside its store entry, so
 * `next@16.3.5.../node_modules/react-dom` exists too. Picking the first hit made
 * `node_modules/react-dom` link into next's private copy, which duplicated react-dom's files
 * inside next's subtree and inflated the packed tarball by ~21 MB.
 *
 * Returns a path in the destination, or null when no equivalent was copied there.
 */
function findDestStoreEquivalent(destNodeModules, externalRealPath) {
  const within = packagePathWithinStore(externalRealPath);
  if (!within) return null;
  const destStore = path.join(destNodeModules, ".pnpm");
  if (!fs.existsSync(destStore)) return null;

  // The package we are resolving, e.g. "react-dom" or "@scope/pkg".
  const wantedName = within.split(path.sep)[0];

  let entries;
  try {
    entries = fs.readdirSync(destStore);
  } catch {
    return null;
  }

  // pnpm store entries are "<name>@<version>[_<peers hash>]"; scoped names keep their slash as
  // a "+" (e.g. "@next+env@16.3.5"). Prefer "name@", and only then the scoped "+" form.
  const wantedPrefixes = [`${wantedName}@`];
  if (wantedName.startsWith("@")) {
    wantedPrefixes.push(`${wantedName.replace("/", "+")}@`);
  }

  for (const entry of entries) {
    if (!wantedPrefixes.some((prefix) => entry.startsWith(prefix))) continue;
    const candidate = path.join(destStore, entry, "node_modules", within);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function copyRecursive(src, dest, isTopLevel = true) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  // Process real directories FIRST. Top-level junctions must be re-targeted at the
  // destination's own .pnpm store, so that store has to exist in `dest` before any
  // junction is handled. readdir happens to return `.pnpm` first, but sorting makes the
  // dependency explicit instead of relying on filesystem ordering.
  entries.sort((a, b) => {
    const rank = (e) => (e.isSymbolicLink() ? 1 : 0);
    return rank(a) - rank(b);
  });
  for (const entry of entries) {
    if (shouldExclude(entry.name, { topLevel: isTopLevel })) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, false);
    } else if (entry.isSymbolicLink()) {
      // Preserve the LINK rather than materializing its target.
      //
      // pnpm's store nests every package's own dependencies:
      //   .pnpm/next@<ver>/node_modules/{react,react-dom,styled-jsx}  <- junctions into .pnpm
      // Materializing those turned them into real directories INSIDE next's entry, so the same
      // files shipped twice (next@ ballooned 13.8 MB -> 22.3 MB) and the tarball doubled.
      //
      // Two cases, both must stay links:
      //   1. The target resolves inside this bundle's own .pnpm store -> recreate the link
      //      relative to the destination, preserving the store layout.
      //   2. The target is outside the bundle (pnpm rewrote top-level entries to point at the
      //      ROOT store on the build machine, where packages are the full un-pruned dev copies)
      //      -> re-target at the destination's equivalent store entry, or materialize only when
      //      the package genuinely does not exist in this bundle.
      try {
        const real = fs.realpathSync(srcPath);
        const stat = fs.statSync(real);
        const destPathResolved = path.resolve(destPath);
        if (fs.existsSync(destPath)) continue;
        if (!stat.isDirectory()) {
          fs.copyFileSync(real, destPath);
          continue;
        }

        const storeAbs = path.resolve(path.join(dest, ".pnpm"));
        const bundleAbs = path.resolve(cliAppDir);

        // Case: the link's real target lives in a store that was copied into this destination.
        const targetInDest = mapStorePath(real, src, dest);
        const linkTarget = targetInDest && fs.existsSync(targetInDest)
          ? targetInDest
          : findDestStoreEquivalent(dest, real);

        if (linkTarget && fs.existsSync(linkTarget)) {
          fs.symlinkSync(path.relative(path.dirname(destPathResolved), linkTarget), destPath, "junction");
        } else if (real.startsWith(bundleAbs + path.sep)) {
          // Inside the bundle but no mapping found: keep a link to the real location.
          fs.symlinkSync(path.relative(path.dirname(destPathResolved), real), destPath, "junction");
        } else {
          copyRecursive(real, destPath, false);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

function resolveStandaloneBuild(appDir, buildDistDir) {
  const legacyStandaloneRoot = path.join(appDir, ".next", "standalone");
  const resolvedStandaloneRoot = path.join(buildDistDir, "standalone");
  let standaloneRoot = fs.existsSync(resolvedStandaloneRoot)
    ? resolvedStandaloneRoot
    : legacyStandaloneRoot;

  // Next.js 16 nests standalone output under the project name when
  // NEXT_TRACING_ROOT_MODE=workspace, e.g. standalone/9router/server.js.
  const pkgName = path.basename(appDir);
  const nestedRoot = path.join(standaloneRoot, pkgName);
  if (fs.existsSync(path.join(nestedRoot, "server.js")) && !fs.existsSync(path.join(standaloneRoot, "server.js"))) {
    console.log(`ℹ️  Detected nested standalone output: ${pkgName}/`);
    standaloneRoot = nestedRoot;
  }

  const standaloneApp = fs.existsSync(path.join(standaloneRoot, "server.js"))
    ? standaloneRoot
    : path.join(standaloneRoot, "app");
  if (!fs.existsSync(standaloneApp)) {
    throw new Error(
      "Next.js standalone build not found under .next/standalone; " +
      "expected either .next/standalone/server.js or .next/standalone/app/",
    );
  }

  return { standaloneApp, standaloneRoot };
}

function copyStandaloneBuild(appDir, buildDistDir, cliAppDir) {
  const { standaloneApp, standaloneRoot } = resolveStandaloneBuild(appDir, buildDistDir);
  copyRecursive(standaloneApp, cliAppDir);

  // Older nested-app layout stores traced node_modules at standalone root.
  const standaloneNodeModules = path.join(standaloneRoot, "node_modules");
  if (standaloneApp !== standaloneRoot && fs.existsSync(standaloneNodeModules)) {
    copyRecursive(standaloneNodeModules, path.join(cliAppDir, "node_modules"));
  }
}

function mergeServerArtifacts(buildDistDir, cliAppDir) {
  const serverSrc = path.join(buildDistDir, "server");
  const serverDest = path.join(cliAppDir, buildDistDirName, "server");
  if (!fs.existsSync(serverSrc)) {
    throw new Error(`Complete Next.js server build not found: ${serverSrc}`);
  }
  copyRecursive(serverSrc, serverDest);
}

function assertRequiredApiArtifacts(cliAppDir) {
  const requiredArtifacts = [
    "app/api/v1/chat/completions/route.js",
    "app/api/v1/messages/route.js",
  ];
  const serverDir = path.join(cliAppDir, buildDistDirName, "server");
  const missingArtifacts = requiredArtifacts
    .map((artifact) => path.join(serverDir, artifact))
    .filter((artifact) => !fs.existsSync(artifact));

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Required CLI API route artifact${missingArtifacts.length === 1 ? " is" : "s are"} missing:\n` +
      missingArtifacts.join("\n"),
    );
  }
}

/**
 * Prune sql.js down to the files Node actually loads — in EVERY copy the bundle contains.
 *
 * sql.js ships its whole browser distribution (~23 MB): asm.js builds, the -debug variants,
 * web workers, and pre-zipped bundles. In Node the package resolves to `dist/sql-wasm.js`,
 * which loads exactly one binary — `dist/sql-wasm.wasm`, located as `__dirname + 'sql-wasm.wasm'`
 * (see the Node branch of sql-wasm.js). Nothing else is ever read, so everything else is dead
 * weight in a server-side bundle.
 *
 * There can be several copies, and all of them matter:
 *   - node_modules/sql.js                          (top level)
 *   - node_modules/.pnpm/sql.js@<ver>/node_modules/sql.js   (pnpm store)
 *   - <distDir>/node_modules/sql.js-<hash>         (Turbopack's content-hashed external shim —
 *                                                    chunks `require("sql.js-<hash>")`, which
 *                                                    Node resolves from the dist dir)
 * Missing the Turbopack copy alone leaves ~23 MB in the artifact, so scan for every package
 * whose name is `sql.js` or starts with `sql.js-`.
 *
 * Returns the number of files removed.
 */
function pruneSqlJsBundle(cliAppDir) {
  // Everything Node may read: the loader, its wasm binary, and the manifest that points at it.
  const KEEP = new Set([
    path.join("dist", "sql-wasm.js"),
    path.join("dist", "sql-wasm.wasm"),
    "package.json",
  ]);

  /** A directory is a sql.js copy if it is named sql.js or sql.js-<hash> and has our entrypoint. */
  const isSqlJsPackage = (dir, name) => {
    if (name !== "sql.js" && !name.startsWith("sql.js-")) return false;
    try {
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.name === "sql.js";
    } catch {
      return false;
    }
  };

  const targets = [];
  const findCopies = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      // Do not descend into a matched package.
      if (isSqlJsPackage(full, entry.name)) {
        targets.push(full);
        continue;
      }
      // .pnpm keeps packages one level deeper: .pnpm/<pkg>@<ver>/node_modules/<pkg>.
      if (entry.name === ".pnpm") {
        let storeEntries;
        try {
          storeEntries = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const se of storeEntries) {
          if (!se.isDirectory()) continue;
          const inner = path.join(full, se.name, "node_modules");
          if (!fs.existsSync(inner)) continue;
          findCopies(inner);
        }
        continue;
      }
      // node_modules trees and the dist dir are the only places copies live.
      if (entry.name === "node_modules" || entry.name === "app") {
        findCopies(full);
      }
    }
  };

  // Search the roots that can hold a copy, without walking the whole artifact.
  for (const root of [
    path.join(cliAppDir, "node_modules"),
    path.join(cliAppDir, buildDistDirName, "node_modules"),
  ]) {
    if (fs.existsSync(root)) findCopies(root);
  }

  if (targets.length === 0) return 0;

  let removed = 0;
  for (const sqlJsDir of targets) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          // Drop the directory once it is empty (e.g. leftover .devcontainer).
          try {
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
          } catch {}
          continue;
        }
        const rel = path.relative(sqlJsDir, full);
        if (KEEP.has(rel)) continue;
        try {
          fs.rmSync(full, { force: true });
          removed++;
        } catch {}
      }
    };
    walk(sqlJsDir);

    // A pruned sql.js must still be loadable; if the expected entrypoints vanished, say so
    // loudly rather than shipping a broken fallback driver.
    const missing = [...KEEP].filter((rel) => !fs.existsSync(path.join(sqlJsDir, rel)));
    if (missing.length > 0) {
      console.warn(
        `⚠️  sql.js prune removed required files in ${path.relative(cliAppDir, sqlJsDir)}: ${missing.join(", ")}`,
      );
    } else {
      console.log(`✅ Pruned sql.js at ${path.relative(cliAppDir, sqlJsDir)}`);
    }
  }
  console.log(`✅ Pruned ${targets.length} sql.js copy/copies (removed ${removed} files)`);
  return removed;
}

/**
 * Remove JavaScript source maps from the built artifact.
 *
 * Turbopack's own build log states: "Turbopack currently always builds production sourcemaps
 * for the browser. This will include project sourcecode if deployed to production." Unlike
 * webpack, there is no opt-out, so a Turbopack build drags ~46 MB of `.map` files into the
 * server tree that a webpack build would not have produced.
 *
 * They are pure dead weight at runtime: Node only consults `.map` when started with
 * `--enable-source-maps`, and this project never enables it (custom-server.js does not pass the
 * flag, nor does anything set NODE_OPTIONS). The trailing `//# sourceMappingURL=...` comment
 * inside each chunk is inert when the map file is absent — Node does not fetch it, and a
 * missing map simply yields non-mapped stack traces.
 *
 * Only files inside the copied build output are touched; `src/**` is left alone.
 * Returns the number of files removed and the bytes reclaimed.
 */
function stripSourceMaps(cliAppDir) {
  const roots = [
    path.join(cliAppDir, buildDistDirName), // server/, static/, node_modules/ (turbopack shims)
  ].filter((p) => fs.existsSync(p));

  let removed = 0;
  let bytes = 0;
  for (const root of roots) {
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".map")) continue;
        try {
          const size = fs.statSync(full).size;
          fs.rmSync(full, { force: true });
          removed++;
          bytes += size;
        } catch {}
      }
    };
    walk(root);
  }

  if (removed > 0) {
    console.log(`✅ Stripped ${removed} source map(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  } else {
    console.log("⏭️  No source maps found");
  }
  return { removed, bytes };
}

/**
 * Remove Next.js output-file-trace manifests (`*.nft.json`) from the built artifact.
 *
 * Next emits one alongside every route and page to record which files that entry depends on.
 * It exists purely so a LATER build can decide what to copy into a standalone output — nothing
 * at runtime reads it. Verified in this bundle: no server file references `.nft.json`, and the
 * shipped artifact never runs a build.
 *
 * There are ~190 of them (~19 MB), which is a meaningful share of the packed tarball.
 * Returns the number of files removed and the bytes reclaimed.
 */
function stripNftManifests(cliAppDir) {
  const root = path.join(cliAppDir, buildDistDirName);
  if (!fs.existsSync(root)) return { removed: 0, bytes: 0 };

  let removed = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".nft.json")) continue;
      try {
        const size = fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        removed++;
        bytes += size;
      } catch {}
    }
  };
  walk(root);

  if (removed > 0) {
    console.log(`✅ Stripped ${removed} .nft.json manifest(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  return { removed, bytes };
}

/**
 * Replace every symlink/junction under `root` with a real copy of its target.
 *
 * Required because `npm pack` silently omits symlinks. A bundle that relies on them installs
 * broken: `require('next')` cannot resolve because node_modules/next is simply absent.
 *
 * Two-pass per directory, and the ordering matters:
 *   1. Materialize every link in this directory FIRST, recursing into each fresh copy. A link
 *      may point at a store entry that itself contains links, and those nested links must be
 *      expanded *through the copy* — not via the store, which may already have been rewritten.
 *   2. Then descend into the real sub-directories.
 *
 * `visited` tracks realpaths to avoid cycles. It is checked only for links, never to skip a
 * directory outright: pnpm points several links at one store entry, and each of those copies
 * must still be expanded independently.
 *
 * Returns the number of links materialized.
 */
function materializeLinks(root, visited = new Set()) {
  if (!fs.existsSync(root)) return 0;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;

  // Pass 1: links in this directory.
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);

    let target;
    try {
      target = fs.realpathSync(full);
    } catch {
      continue; // broken link
    }
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      try {
        fs.copyFileSync(target, full);
        count++;
      } catch {}
      continue;
    }
    copyRecursive(target, full, false);
    count++;
    // Expand links nested inside the fresh copy.
    count += materializeLinks(full, visited);
  }

  // Pass 2: descend into real directories.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    count += materializeLinks(full, visited);
  }
  return count;
}

function buildCliPackage() {
  console.log("📦 Building 9Router CLI package with Next.js...\n");

  fs.mkdirSync(buildHomeDir, { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

  // Step 0: Sync version from app/cli/package.json to app/package.json
  console.log("0️⃣  Syncing version to app/package.json...");
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const appPkgPath = path.join(appDir, "package.json");
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
  if (appPkg.version !== cliPkg.version) {
    appPkg.version = cliPkg.version;
    fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");
    console.log(`✅ Version synced: ${cliPkg.version}\n`);
  } else {
    console.log(`✅ Version already synced: ${cliPkg.version}\n`);
  }

  // Step 0.5: Remove the recursive-nested bundle from a previous run, BEFORE building.
  //
  // The CLI build writes its Next output to .next-cli-build, which sits INSIDE the tracing
  // root. The previous build's copied bundle therefore lands at
  //   .next-cli-build/standalone/<pkg>/cli/app/...
  // and gets traced into the next build, nesting a copy of the bundle inside itself
  // (~8 MB per run, growing over successive builds).
  //
  // Only that nested `cli` directory is removed. Wiping the whole standalone tree (as an
  // earlier version did) also threw away work that the tracing step had already produced, so
  // every build paid a full re-copy — the Turbopack compile cache was warm, but the server
  // tree still had to be re-traced and re-copied from scratch.
  console.log("0️⃣ b Cleaning nested bundle from previous build...");
  const staleStandalone = path.join(buildDistDir, "standalone");
  let nestedCleaned = 0;
  if (fs.existsSync(staleStandalone)) {
    // standalone may be nested under the package name (standalone/<pkg>) or flat.
    const candidates = [staleStandalone];
    for (const entry of fs.readdirSync(staleStandalone, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(staleStandalone, entry.name));
    }
    for (const root of candidates) {
      const nested = path.join(root, "cli");
      if (!fs.existsSync(nested)) continue;
      try {
        fs.rmSync(nested, { recursive: true, force: true });
        console.log(`✅ Removed nested copy ${path.relative(appDir, nested)}`);
        nestedCleaned++;
      } catch (e) {
        console.warn(`⚠️  Could not remove ${nested}: ${e.message}`);
      }
    }
  }
  console.log(nestedCleaned > 0 ? "✅ Nested bundle cleaned\n" : "✅ Nothing to clean\n");

  // Step 1: Build app with Next.js (workspace tracing root → traced node_modules in standalone).
  console.log("1️⃣  Building Next.js app...");
  try {
    execSync("npm run build", {
      stdio: "inherit",
      cwd: appDir,
      env: {
        ...process.env,
        HOME: buildHomeDir,
        USERPROFILE: buildHomeDir,
        APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
        NEXT_DIST_DIR: buildDistDirName,
        NEXT_TRACING_ROOT_MODE: "workspace",
      }
    });
    console.log("✅ Next.js build completed\n");
  } catch (error) {
    console.error("❌ Next.js build failed");
    process.exit(1);
  }

  // Step 2: Clean old app/cli/app if exists.
  // Windows: rmSync can leave leftovers behind when files are still locked (AV scan,
  // explorer, EBUSY). A partial clean silently poisons npm pack — the next tarball
  // ships stale dirs like app/cli, app/tests, app/gitbook (300+ MB bloat). So: remove,
  // then verify it's really gone, retrying with backoff before giving up.
  console.log("2️⃣  Cleaning old app/cli/app...");
  if (fs.existsSync(cliAppDir)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { fs.rmSync(cliAppDir, { recursive: true, force: true }); } catch {}
      if (!fs.existsSync(cliAppDir)) break;
      console.warn(`⚠️  cli/app still present after rm attempt ${attempt}, retrying...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
    if (fs.existsSync(cliAppDir)) {
      throw new Error(
        "cli/app could not be fully removed (files locked?). Delete it manually and rerun — " +
        "a partial clean bloats the tarball with stale directories."
      );
    }
  }
  console.log("✅ Cleaned\n");

  // Step 3: Copy Next.js standalone build to app/cli/app.
  // Newer Next.js standalone output writes server.js/package.json plus .next/, src/, and
  // node_modules/ directly under .next/standalone. Older builds may still use a nested app/.
  console.log("3️⃣  Copying Next.js standalone build to app/cli/app...");
  try {
    copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
  } catch (error) {
    console.error("❌ Next.js standalone build not found under .next/standalone");
    console.error("Expected either .next/standalone/server.js or .next/standalone/app/");
    process.exit(1);
  }
  console.log("✅ Copied standalone build\n");

  // Step 3a: Copy custom server (injects real socket IP, strips spoofable XFF).
  const customServerSrc = path.join(appDir, "custom-server.js");
  if (fs.existsSync(customServerSrc)) {
    fs.copyFileSync(customServerSrc, path.join(cliAppDir, "custom-server.js"));
    console.log("✅ Copied custom-server.js\n");
  } else {
    console.error("❌ custom-server.js not found — without it no request can be proven local,");
    console.error("   so the packaged CLI would demand an API key for its own dashboard and /v1.");
    process.exit(1);
  }

  // Step 3b: Ensure sql.js (pure JS fallback) bundled in app/cli/app/node_modules.
  // Strip better-sqlite3 (native) — it lives in ~/.9router/runtime to avoid
  // Windows EBUSY during global CLI updates. node:sqlite (Node ≥22.5) is also
  // available as a no-install middle tier.
  console.log("3️⃣ b Configuring SQLite drivers...");
  function ensureModuleInBundle(pkg) {
    const dest = path.join(cliAppDir, "node_modules", pkg);
    if (fs.existsSync(dest)) {
      console.log(`✅ ${pkg} already bundled`);
      return;
    }
    const candidates = [
      path.join(appDir, "node_modules", pkg),
      path.join(rootDir, "node_modules", pkg),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursive(src, dest);
    console.log(`✅ Bundled ${pkg}`);
  }
  ensureModuleInBundle("sql.js");
  pruneSqlJsBundle(cliAppDir);
  // `open` is external (see serverExternalPackages in next.config.mjs), so it must exist in
  // the bundle's node_modules or every importer throws MODULE_NOT_FOUND at runtime. Output
  // tracing normally copies it; this is the same belt-and-braces guard used for sql.js.
  ensureModuleInBundle("open");
  // better-sqlite3 must not ship: native module, per-platform copy lives in
  // ~/.9router/runtime. Strip every layout variant: flat `better-sqlite3`,
  // pnpm store `better-sqlite3@x.y.z`, and Turbopack's content-hashed
  // `better-sqlite3-<hash>` under the dist dir's nested node_modules.
  const bundleNodeModules = path.join(cliAppDir, "node_modules");
  const pnpmStoreDir = path.join(bundleNodeModules, ".pnpm");
  const stripNativeSqlite = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("better-sqlite3")) {
        const target = path.join(dir, name);
        // Unlink junctions explicitly: rmSync on a junction is safe on Windows (it removes the
        // link, not the target), but doing it this way keeps the intent obvious and guarantees
        // the shared .pnpm target is never traversed.
        try {
          const lst = fs.lstatSync(target);
          if (lst.isSymbolicLink()) {
            fs.unlinkSync(target);
          } else {
            fs.rmSync(target, { recursive: true, force: true });
          }
        } catch {}
        console.log(`✅ Stripped ${name} from ${path.relative(cliAppDir, dir)}`);
      }
    }
  };
  for (const nmDir of [bundleNodeModules, path.join(cliAppDir, buildDistDirName, "node_modules")]) {
    stripNativeSqlite(nmDir);
    stripNativeSqlite(path.join(nmDir, ".pnpm"));
  }
  // pnpm keeps transitive deps under node_modules/.pnpm/<pkg>@<ver>/node_modules/<dep>.
  // copyRecursive now preserves those links instead of materializing them, so the .pnpm store
  // is the single copy and top-level entries link into it. What still needs doing is hoisting
  // any transitive dep that has NO top-level link yet, since Node's walk-up from a flattened
  // real directory (server.js, src/) cannot see into .pnpm.
  // Hoisted entries are created as LINKS into .pnpm, not copies — a copy here would undo the
  // dedup and re-inflate the bundle by tens of MB.
  if (fs.existsSync(pnpmStoreDir)) {
    const HOIST_DENYLIST = new Set(["better-sqlite3", "bindings", "file-uri-to-path"]);
    let hoisted = 0;
    const storeAbs = path.resolve(pnpmStoreDir);
    const linkIntoStore = (targetAbs, destPath) => {
      if (fs.existsSync(destPath)) return false;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(destPath), targetAbs), destPath, "junction");
      return true;
    };

    /**
     * Find a dependency's OWN store entry: .pnpm/<name>@<ver>[_peers]/node_modules/<name>.
     *
     * Iterating store entries and taking the first that contains the dependency name picks up
     * pnpm's nested copies of another package's private deps — `next@.../node_modules/react-dom`
     * etc. Linking to those strands files inside next's subtree, duplicating them in the packed
     * tarball. Always prefer the dependency's own top-level entry.
     */
    const findOwnStoreEntry = (depName) => {
      const prefixes = [`${depName}@`];
      if (depName.startsWith("@")) prefixes.push(`${depName.replace("/", "+")}@`);
      let entries;
      try {
        entries = fs.readdirSync(pnpmStoreDir);
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (!prefixes.some((p) => entry.startsWith(p))) continue;
        const candidate = path.join(pnpmStoreDir, entry, "node_modules", depName);
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    };

    for (const pkgEntry of fs.readdirSync(pnpmStoreDir, { withFileTypes: true })) {
      if (!pkgEntry.isDirectory()) continue;
      const innerDir = path.join(pnpmStoreDir, pkgEntry.name, "node_modules");
      if (!fs.existsSync(innerDir)) continue;
      for (const dep of fs.readdirSync(innerDir, { withFileTypes: true })) {
        if (dep.name === ".bin" || HOIST_DENYLIST.has(dep.name) || shouldExclude(dep.name, { topLevel: true })) continue;
        const depPath = path.join(innerDir, dep.name);
        let real;
        try {
          real = fs.realpathSync(depPath);
          if (!fs.statSync(real).isDirectory()) continue;
        } catch { continue; }
        // Only link to targets genuinely inside this bundle's store.
        if (!real.startsWith(storeAbs + path.sep) && real !== storeAbs) continue;
        // Prefer the dependency's own entry over another package's nested copy of it.
        const own = findOwnStoreEntry(dep.name);
        if (own) real = own;
        try {
          if (dep.name.startsWith("@")) {
            for (const child of fs.readdirSync(real)) {
              const childReal = path.join(real, child);
              if (linkIntoStore(childReal, path.join(bundleNodeModules, dep.name, child))) hoisted++;
            }
          } else if (linkIntoStore(real, path.join(bundleNodeModules, dep.name))) {
            hoisted++;
          }
        } catch {}
      }
    }
    console.log(`✅ Re-hoisted ${hoisted} pnpm deps to bundle top level`);
  }

  // Step 3c: Replace top-level junctions with real directories.
  //
  // `npm pack` does NOT archive symlinks — it silently drops them. A bundle whose
  // node_modules/next is a junction therefore installs without any `next` at all, and the
  // server dies on boot with "Cannot find module 'next'". The packed tarball contained 0
  // entries under node_modules/next while .pnpm/next@ held all 985 files.
  //
  // So every link must become a real directory before packing. This stays cheap because the
  // copy source is the bundle's OWN trace-pruned store entry (next: ~13.8 MB), not the build
  // machine's full dev copy (~172 MB).
  //
  // Links are walked depth-first and materialised from the link's target, so nested links
  // inside a package (pnpm nests a package's own deps) are handled too.
  console.log("3️⃣ c Materializing node_modules links (npm pack drops symlinks)...");
  materializeLinks(bundleNodeModules);
  console.log("");

  // Step 4: Copy static files
  console.log("4️⃣  Copying static files...");
  const staticSrc = path.join(appDir, ".next", "static");
  const staticSrcResolved = path.join(buildDistDir, "static");
  const staticDest = path.join(cliAppDir, buildDistDirName, "static");
  if (fs.existsSync(staticSrcResolved) || fs.existsSync(staticSrc)) {
    copyRecursive(fs.existsSync(staticSrcResolved) ? staticSrcResolved : staticSrc, staticDest);
    console.log("✅ Copied static files\n");
  } else {
    console.log("⏭️  No static files found\n");
  }

  // Step 5: Copy public folder if exists
  console.log("5️⃣  Copying public folder...");
  const publicSrc = path.join(appDir, "public");
  const publicDest = path.join(cliAppDir, "public");
  if (fs.existsSync(publicSrc)) {
    copyRecursive(publicSrc, publicDest);
    console.log("✅ Copied public folder\n");
  } else {
    console.log("⏭️  No public folder found\n");
  }

  // Step 6: Copy vendor-chunks (required for production)
  console.log("6️⃣  Copying vendor-chunks...");
  const vendorChunksSrc = path.join(appDir, ".next", "server", "vendor-chunks");
  const vendorChunksSrcResolved = path.join(buildDistDir, "server", "vendor-chunks");
  const vendorChunksDest = path.join(cliAppDir, buildDistDirName, "server", "vendor-chunks");
  if (fs.existsSync(vendorChunksSrcResolved) || fs.existsSync(vendorChunksSrc)) {
    copyRecursive(fs.existsSync(vendorChunksSrcResolved) ? vendorChunksSrcResolved : vendorChunksSrc, vendorChunksDest);
    console.log("✅ Copied vendor-chunks\n");
  } else {
    console.log("⏭️  No vendor-chunks found\n");
  }

  // Step 6b: Merge the complete generated server tree. Next.js standalone output
  // is trace-pruned and can omit route modules or chunks loaded dynamically.
  console.log("6️⃣ b Copying complete server artifacts...");
  mergeServerArtifacts(buildDistDir, cliAppDir);
  assertRequiredApiArtifacts(cliAppDir);
  console.log("✅ Copied complete server artifacts\n");

  // Step 7: Copy MITM server files (not bundled by Next.js standalone)
  console.log("7️⃣  Copying MITM server files...");
  const mitmSrc = path.join(appDir, "src", "mitm");
  const mitmDest = path.join(cliAppDir, "src", "mitm");
  if (fs.existsSync(mitmSrc)) {
    copyRecursive(mitmSrc, mitmDest);
    console.log("✅ Copied MITM files\n");
  } else {
    console.log("⏭️  No MITM files found\n");
  }

  // Step 7b: Copy standalone updater (headless Node process for install progress)
  console.log("7️⃣ b Copying updater files...");
  const updaterSrc = path.join(appDir, "src", "lib", "updater");
  const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
  if (fs.existsSync(updaterSrc)) {
    copyRecursive(updaterSrc, updaterDest);
    console.log("✅ Copied updater files\n");
  } else {
    console.log("⏭️  No updater files found\n");
  }

  // Step 7c: Drop source maps and build-time trace manifests. Runs after every copy step so
  // nothing re-introduces them, and before the MITM bundle so that step's own output is not
  // revisited.
  console.log("7️⃣ c Stripping source maps...");
  stripSourceMaps(cliAppDir);
  stripNftManifests(cliAppDir);
  console.log("");

  // Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
  console.log("8️⃣  Building MITM server...");
  try {
    execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
    console.log("✅ MITM server build completed\n");
  } catch (error) {
    console.error("❌ MITM build failed");
    process.exit(1);
  }

  // Step 8b: Final sweep — the MITM bundler may emit its own maps or manifests.
  console.log("8️⃣ b Final source-map sweep...");
  stripSourceMaps(cliAppDir);
  stripNftManifests(cliAppDir);
  console.log("");

  console.log("✨ CLI package build completed!");
  console.log(`📁 Output: ${cliAppDir}`);

  try {
    const { execSync: exec } = require("child_process");
    const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
    console.log(`📊 Package size: ${size.split("\t")[0]}`);
  } catch (e) {
    // Silent fail on size check
  }
}

module.exports = {
  assertRequiredApiArtifacts,
  copyStandaloneBuild,
  mergeServerArtifacts,
  pruneSqlJsBundle,
  stripSourceMaps,
  stripNftManifests,
  materializeLinks,
};

if (require.main === module) {
  buildCliPackage();
}
