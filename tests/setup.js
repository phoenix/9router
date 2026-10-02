import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Tests must never fall through to the developer's real 9router data directory.
// A unique directory per test file also prevents workers from sharing SQLite state.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-vitest-"));
process.env.DATA_DIR = dataDir;

afterAll(async () => {
  try {
    const { getAdapterSync } = await import("../src/lib/db/driver.js");
    getAdapterSync().close();
  } catch {
    // The file never initialized the database adapter.
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
