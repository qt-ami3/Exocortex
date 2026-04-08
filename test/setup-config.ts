import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

if (!process.env.EXOCORTEX_TEST_CONFIG_READY) {
  process.env.EXOCORTEX_TEST_CONFIG_READY = "1";
  process.env.EXOCORTEX_TEST = "1";

  const configured = process.env.EXOCORTEX_CONFIG_DIR?.trim();
  const configDir = configured
    ? resolve(configured)
    : mkdtempSync(join(tmpdir(), "exocortex-test-config-"));

  process.env.EXOCORTEX_CONFIG_DIR = configDir;
  mkdirSync(configDir, { recursive: true });

  if (!configured) {
    process.on("exit", () => {
      rmSync(configDir, { recursive: true, force: true });
    });
  }
}
