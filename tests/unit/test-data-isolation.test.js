import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "@/lib/dataDir.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { createProviderConnection, getProviderConnections } from "@/models/index.js";

describe("test data isolation", () => {
  it("persists provider test data only inside an isolated temporary DATA_DIR", async () => {
    const tempRoot = path.resolve(os.tmpdir());
    const configuredDir = path.resolve(DATA_DIR);

    expect(configuredDir.startsWith(`${tempRoot}${path.sep}`)).toBe(true);
    expect(path.basename(configuredDir)).toMatch(/^9router-vitest-/);

    const connection = await createProviderConnection({
      provider: "test-data-isolation",
      authType: "apikey",
      name: "isolated-fixture",
      apiKey: "not-a-real-secret",
    });

    expect(fs.existsSync(DATA_FILE)).toBe(true);
    expect(path.resolve(DATA_FILE).startsWith(`${configuredDir}${path.sep}`)).toBe(true);

    const stored = await getProviderConnections({ provider: "test-data-isolation" });
    expect(stored.map(({ id }) => id)).toContain(connection.id);
  });
});
