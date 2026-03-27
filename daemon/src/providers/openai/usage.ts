import { join } from "path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import type { UsageData, UsageWindow } from "../../messages";

const USAGE_FILE = join(runtimeDir(), "usage-openai.json");

function loadFromDisk(): UsageData | null {
  try {
    if (!existsSync(USAGE_FILE)) return null;
    return JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as UsageData;
  } catch {
    return null;
  }
}

function saveToDisk(usage: UsageData): void {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // best-effort
  }
}

let lastUsage: UsageData | null = loadFromDisk();
let resetTimer: ReturnType<typeof setTimeout> | null = null;

export function getLastUsage(): UsageData | null {
  return lastUsage;
}

export function clearUsage(): void {
  lastUsage = null;
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  try {
    if (existsSync(USAGE_FILE)) unlinkSync(USAGE_FILE);
  } catch {
    // best-effort
  }
}

function commitUsage(usage: UsageData, onUpdate: (usage: UsageData) => void): void {
  lastUsage = usage;
  saveToDisk(usage);
  onUpdate(usage);
  scheduleResetRefresh(onUpdate);
}

function scheduleResetRefresh(onUpdate: (usage: UsageData) => void): void {
  if (resetTimer) clearTimeout(resetTimer);

  const now = Date.now();
  const candidates = [lastUsage?.fiveHour?.resetsAt, lastUsage?.sevenDay?.resetsAt]
    .filter((timestamp): timestamp is number => timestamp != null && timestamp > now);

  if (candidates.length === 0) return;

  const earliest = Math.min(...candidates);
  const delay = earliest - now + 5_000;
  resetTimer = setTimeout(() => {
    resetTimer = null;
    if (!lastUsage) return;
    const nextUsage = {
      fiveHour: normalizeExpiredWindow(lastUsage.fiveHour, Date.now()),
      sevenDay: normalizeExpiredWindow(lastUsage.sevenDay, Date.now()),
    };
    if (JSON.stringify(nextUsage) === JSON.stringify(lastUsage)) {
      scheduleResetRefresh(onUpdate);
      return;
    }
    log("info", "openai usage: reset boundary reached, zeroing expired windows");
    commitUsage(nextUsage, onUpdate);
  }, delay);
}

function normalizeExpiredWindow(window: UsageWindow | null, now: number): UsageWindow | null {
  if (!window) return null;
  if (window.resetsAt != null && window.resetsAt <= now) {
    return {
      utilization: 0,
      resetsAt: null,
    };
  }
  return window;
}

export function refreshUsage(_onUpdate: (usage: UsageData) => void): void {
  return;
}

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const usage = parseHeaders(headers);
  if (!usage) return;
  commitUsage(usage, onUpdate);
}

function parseHeaders(headers: Headers): UsageData | null {
  const prefix = resolveLimitPrefix(headers);

  const fiveHour = parseWindow(
    firstHeader(headers, [
      `${prefix}-primary-used-percent`,
      `${prefix}-primary-over-secondary-limit-percent`,
      "x-codex-primary-used-percent",
      "x-codex-primary-over-secondary-limit-percent",
    ]),
    firstHeader(headers, [
      `${prefix}-primary-reset-at`,
      "x-codex-primary-reset-at",
    ]),
    lastUsage?.fiveHour,
  );
  const sevenDay = parseWindow(
    firstHeader(headers, [
      `${prefix}-secondary-used-percent`,
      `${prefix}-secondary-over-primary-limit-percent`,
      "x-codex-secondary-used-percent",
      "x-codex-secondary-over-primary-limit-percent",
    ]),
    firstHeader(headers, [
      `${prefix}-secondary-reset-at`,
      "x-codex-secondary-reset-at",
    ]),
    lastUsage?.sevenDay,
  );

  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function resolveLimitPrefix(headers: Headers): string {
  const activeLimit = headers.get("x-codex-active-limit")?.trim();
  if (!activeLimit || activeLimit === "codex") return "x-codex";
  return `x-${activeLimit.toLowerCase().replaceAll("_", "-")}`;
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value != null) return value;
  }
  return null;
}

function parseWindow(percentValue: string | null, resetAtValue: string | null, previous?: UsageWindow | null): UsageWindow | null {
  if (!percentValue && !resetAtValue) return previous ?? null;
  const utilization = parsePercent(percentValue);
  if (utilization === null) return previous ?? null;
  return {
    utilization,
    resetsAt: parseResetValue(resetAtValue) ?? previous?.resetsAt ?? null,
  };
}

function parsePercent(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function parseResetValue(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate.getTime();
}
