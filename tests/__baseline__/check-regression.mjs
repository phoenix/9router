// Local regression gate (Windows-safe).
// Mirrors verify-no-regression.mjs but derives the test id without relying on a
// "/app/" segment in the absolute path (upstream's script assumes a POSIX layout).
// Usage: node tests/__baseline__/check-regression.mjs <results.json>
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

// Normalize: strip drive letter, make separators '/', keep the "tests/..." tail.
const testId = (name) => {
  const n = name.replace(/\\/g, "/");
  const i = n.indexOf("tests/");
  return (i === -1 ? n : n.slice(i)) + "";
};

const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => testId(f.name) + " :: " + a.fullName)
);

const regressions = nowFails.filter(f => !knownFails.has(f));
const nowPasses = [...knownFails].filter(k => !nowFails.includes(k));

if (regressions.length) {
  console.error(`\nREGRESSION: ${regressions.length} test(s) now failing but not in baseline:\n`);
  regressions.forEach(f => console.error("  - " + f));
}
console.log(`\nnow fails = ${nowFails.length}`);
console.log(`baseline known = ${knownFails.size}`);
console.log(`still failing (known) = ${knownFails.size - nowPasses.length}`);
console.log(`now passing that were known-fail = ${nowPasses.length}`);
nowPasses.forEach(f => console.log("  + " + f));

process.exit(regressions.length ? 1 : 0);
