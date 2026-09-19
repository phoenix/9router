// 验证 getDataDir() 的跨平台行为（模拟服务器场景）
// 用法: node scripts/verify-datadir-fix.js
const path = require("path");
const os = require("os");
const { getDataDir } = require("../cli/hooks/sqliteRuntime");

console.log("=== 本机环境 ===");
console.log("  process.platform :", process.platform);
console.log("  APPDATA          :", process.env.APPDATA || "(未设置)");
console.log("  homedir          :", os.homedir());
console.log();

console.log("=== getDataDir() 在无 DATA_DIR 时 ===");
delete process.env.DATA_DIR;
const d1 = getDataDir();
console.log("  结果:", d1);
const expected = process.platform === "win32"
  ? path.join(process.env.APPDATA || os.homedir(), "9router")
  : path.join(os.homedir(), ".9router");
console.log("  期望:", expected);
console.log("  匹配:", d1 === expected ? "✅" : "❌");
console.log();

console.log("=== 模拟 Linux 服务器（关键场景）===");
// 模拟：platform=linux, APPDATA 不存在, homedir=/home/ai
const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const origHome = os.homedir;
const origAppData = process.env.APPDATA;
try {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  os.homedir = () => "/home/ai";
  delete process.env.APPDATA;
  const d2 = getDataDir();
  // path.join uses the HOST separator (Windows here), so compare the semantic
  // suffix rather than a POSIX literal.
  const endsWithDot9router = /[\\/]\.9router$/.test(d2);
  const usesHome = d2.includes("ai");
  const noAppData = !/AppData/i.test(d2);
  console.log("  结果:", d2);
  console.log("  期望语义: <homedir>/.9router   （不含 AppData）");
  console.log("  以 .9router 结尾:", endsWithDot9router ? "✅" : "❌");
  console.log("  基于 homedir    :", usesHome ? "✅" : "❌");
  console.log("  不含 AppData    :", noAppData ? "✅ 正确（读老库）" : "❌ 错误（会读空库）");
  console.log("  总判定:", endsWithDot9router && usesHome && noAppData ? "✅ 通过" : "❌ 失败");
} finally {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  os.homedir = origHome;
  if (origAppData !== undefined) process.env.APPDATA = origAppData;
}
console.log();

console.log("=== DATA_DIR 优先级（最高）===");
process.env.DATA_DIR = "/custom/path";
console.log("  设置 DATA_DIR=/custom/path →", getDataDir());
console.log("  匹配:", getDataDir() === "/custom/path" ? "✅" : "❌");
delete process.env.DATA_DIR;
