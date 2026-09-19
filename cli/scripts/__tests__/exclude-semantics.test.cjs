#!/usr/bin/env node
/**
 * Regression guard for the CLI packager's exclusion rules.
 *
 * Two hazards these tests pin down:
 *
 * 1. Scope. Repo-only directory names (`tests`, `cli`, `docs`, …) must be excluded ONLY at the
 *    top level of the copied tree. They also occur deep inside packages — `next/dist/cli` is
 *    required at boot by `dist/server/config-schema.js` — so matching them at any depth
 *    deletes runtime files and the server dies with:
 *        Cannot find module '../cli/next-test'
 *    `.env*` and release archives are the opposite case: excluded at every depth.
 *
 * 2. Archives. `npm pack --pack-destination ..` writes the release tarball into the repo root,
 *    which is the tracing root. The tracer picks it up, it is copied into the bundle, and the
 *    next pack embeds it — each release nesting the previous one and roughly doubling in size.
 *    Matching by extension prevents that loop.
 *
 * The logic below is a verbatim mirror of cli/scripts/build-cli.js. It is duplicated rather
 * than imported because build-cli.js is a side-effecting script (it runs a build on require
 * when invoked as main), and a drift here should fail loudly — if you change the real
 * matchers, change these too.
 *
 * Run: node cli/scripts/__tests__/exclude-semantics.test.cjs
 */

"use strict";

const EXCLUDE_PATTERNS = ["@img", "sharp", "detect-libc", "*.log", "tmp", ".DS_Store"];

const EXCLUDE_TOP_LEVEL = new Set([
  "tests",
  "gitbook",
  "images",
  "docs",
  "skills",
  "scratch",
  "cli",
]);

function isEnvFile(name) {
  return name === ".env" || name.startsWith(".env.");
}

function isArchiveFile(name) {
  return name.endsWith(".tgz") || name.endsWith(".tar.gz") || name.endsWith(".tar");
}

function shouldExclude(name, { topLevel = false } = {}) {
  if (isEnvFile(name) || isArchiveFile(name)) return true;
  if (topLevel && EXCLUDE_TOP_LEVEL.has(name)) return true;
  return EXCLUDE_PATTERNS.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

/** [name, topLevel, wantExcluded, rationale] */
const CASES = [
  ["tests", true, true, "repo tests dir is dropped"],
  ["tests", false, false, "a nested 'tests' inside a package must survive"],
  ["cli", true, true, "repo cli launcher is dropped from its own bundle"],
  ["cli", false, false, "next/dist/cli is REQUIRED at runtime — dropping it breaks boot"],
  ["docs", true, true, "repo docs are dropped"],
  ["docs", false, false, "package-level docs must survive"],
  ["images", true, true, "repo images are dropped"],
  ["images", false, false, "nested package image assets must survive"],
  ["skills", true, true, "repo skills are dropped"],
  ["skills", false, false, "nested 'skills' dir must survive"],
  ["gitbook", true, true, "repo gitbook is dropped"],
  ["gitbook", false, false, "nested 'gitbook' dir must survive"],
  ["scratch", true, true, "repo scratch is dropped"],
  ["scratch", false, false, "nested 'scratch' dir must survive"],
  [".env", true, true, "env file excluded"],
  [".env", false, true, "env file excluded at any depth"],
  [".env.example", true, true, "env variant excluded (the original leak)"],
  [".env.local", false, true, "env variant excluded at any depth"],
  [".env.production", false, true, "env variant excluded at any depth"],
  ["sharp", true, true, "sharp excluded at top level"],
  ["sharp", false, true, "sharp excluded anywhere (pre-existing behaviour)"],
  ["@img", false, true, "@img (sharp binaries) excluded anywhere"],
  ["detect-libc", false, true, "detect-libc excluded anywhere"],
  ["foo.log", false, true, "log files excluded anywhere"],
  ["next", true, false, "next must never be excluded"],
  ["dist", false, false, "dist must never be excluded"],
  ["server", false, false, "server must never be excluded"],
  ["src", true, false, "src is runtime code and is kept"],
  ["open-sse", true, false, "the routing engine is runtime code and is kept"],
  ["public", true, false, "public assets are kept"],
  ["sql.js", true, false, "sql.js must not match any exclusion"],
  // Release archives: `npm pack --pack-destination ..` leaves 9router-<ver>.tgz in the repo
  // root, which is outputFileTracingRoot. Turbopack traces it into standalone, it is copied
  // into cli/app, and the next npm pack embeds it — each release nesting the previous one and
  // roughly doubling the tarball. Match by extension, at any depth.
  ["9router-0.5.81.tgz", true, true, "release tarball at bundle root"],
  ["9router-0.5.81.tgz", false, true, "release tarball at any depth"],
  ["foo.tar.gz", false, true, "gzipped tar"],
  ["bar.tar", false, true, "plain tar"],
  ["server.js", true, false, "entrypoint must survive (not archive-matched)"],
];

function main() {
  let failures = 0;
  for (const [name, topLevel, want, why] of CASES) {
    const got = shouldExclude(name, { topLevel });
    const ok = got === want;
    if (!ok) failures++;
    console.log(
      (ok ? "  ok  " : "  FAIL").padEnd(8),
      `excl=${String(got).padEnd(5)}`,
      `name=${name.padEnd(16)}`,
      `top=${String(topLevel).padEnd(5)}`,
      why,
    );
  }
  console.log(
    failures === 0
      ? `\n✅ all ${CASES.length} exclusion cases correct`
      : `\n❌ ${failures}/${CASES.length} exclusion cases FAILED`,
  );
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { shouldExclude, isEnvFile, EXCLUDE_TOP_LEVEL, EXCLUDE_PATTERNS };
