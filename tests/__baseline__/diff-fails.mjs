// 差集回归比对（AGENTS-SOP 铁律）：new-fails = after - before，按「测试文件 basename + 用例全名」归一化。
// 用法: node tests/__baseline__/diff-fails.mjs <before.json> <after.json>
import { readFileSync } from "fs";
import { basename } from "path";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("Usage: node diff-fails.mjs <before.json> <after.json>");
  process.exit(2);
}

const id = (file, fullName) =>
  basename(String(file).replace(/\\/g, "/")) + " :: " + fullName;

function failedSet(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const set = new Map();
  for (const file of report.testResults || []) {
    for (const a of file.assertionResults || []) {
      if (a.status === "failed") set.set(id(file.name, a.fullName), a.title);
    }
  }
  return set;
}

const before = failedSet(beforePath);
const after = failedSet(afterPath);

const newFails = [...after.keys()].filter((k) => !before.has(k));
const fixed = [...before.keys()].filter((k) => !after.has(k));

console.log(`before failed = ${before.size}`);
console.log(`after  failed = ${after.size}`);
console.log(`new failures  = ${newFails.length}`);
newFails.forEach((k) => console.log("  + " + k));
console.log(`newly passing = ${fixed.length}`);
fixed.forEach((k) => console.log("  - " + k));

process.exit(newFails.length ? 1 : 0);
