import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UsageData } from "../../messages";

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "exocortex-usage-test-"));
process.env.EXOCORTEX_CONFIG_DIR = TEST_CONFIG_DIR;

const { dataDir, runtimeDir } = await import("@exocortex/shared/paths");
const { clearUsage, handleUsageHeaders } = await import("./usage");

function resetUsageStorage(): void {
  rmSync(runtimeDir(), { recursive: true, force: true });
  rmSync(dataDir(), { recursive: true, force: true });
  mkdirSync(runtimeDir(), { recursive: true });
  mkdirSync(dataDir(), { recursive: true });
}

afterEach(() => {
  clearUsage();
  resetUsageStorage();
});

afterAll(() => {
  delete process.env.EXOCORTEX_CONFIG_DIR;
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

describe("OpenAI usage header parsing", () => {
  test("uses standard codex used-percent headers for the statusline windows", () => {
    resetUsageStorage();

    const headers = new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-secondary-used-percent": "40",
      "x-codex-primary-reset-at": "1704069000",
      "x-codex-secondary-reset-at": "1704074400",
    });

    let usage: UsageData | null = null;
    handleUsageHeaders(headers, (next) => {
      usage = next;
    });

    expect(usage).not.toBeNull();
    if (usage === null) throw new Error("expected usage update");
    const actual: UsageData = usage;

    expect(actual).toEqual({
      fiveHour: {
        utilization: 12.5,
        resetsAt: 1704069000 * 1000,
      },
      sevenDay: {
        utilization: 40,
        resetsAt: 1704074400 * 1000,
      },
    });
  });

  test("reads the active non-default codex limit family and normalizes underscores to dashed header prefixes", () => {
    resetUsageStorage();

    const headers = new Headers({
      "x-codex-active-limit": "codex_other",
      "x-codex-other-primary-used-percent": "77",
      "x-codex-other-secondary-used-percent": "88",
      "x-codex-other-primary-reset-at": "1705000000",
      "x-codex-other-secondary-reset-at": "1706000000",
    });

    let usage: UsageData | null = null;
    handleUsageHeaders(headers, (next) => {
      usage = next;
    });

    expect(usage).not.toBeNull();
    if (usage === null) throw new Error("expected usage update");
    const actual: UsageData = usage;

    expect(actual).toEqual({
      fiveHour: {
        utilization: 77,
        resetsAt: 1705000000 * 1000,
      },
      sevenDay: {
        utilization: 88,
        resetsAt: 1706000000 * 1000,
      },
    });
  });
});
