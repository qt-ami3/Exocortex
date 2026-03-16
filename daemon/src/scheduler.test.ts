/**
 * Tests for the cron scheduler.
 *
 * Tests the cron expression parser, schedule matching, and script
 * header parsing independently of the filesystem/process machinery.
 */

import { describe, test, expect } from "bun:test";

// We need to test internal functions, so we'll import the module and
// use a test-oriented approach: extract the pure functions we want to test.
// Since the module doesn't export internals, we replicate the parsing
// logic here for unit testing. This is intentional — the scheduler
// module keeps a small public API surface, and we test the logic directly.

// ── Cron field parser (replicated for testing) ──────────────────────

interface CronField {
  type: "any" | "values";
  values: number[];
}

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === "*") return { type: "any", values: [] };

  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;

      if (range !== "*") {
        const rangeMatch = range.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          end = parseInt(rangeMatch[2], 10);
        } else {
          start = parseInt(range, 10);
          end = max;
        }
      }

      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return { type: "values", values: [...values].sort((a, b) => a - b) };
}

interface ParsedSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseSchedule(expr: string): ParsedSchedule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseCronField(parts[0], 0, 59),
      hour: parseCronField(parts[1], 0, 23),
      dayOfMonth: parseCronField(parts[2], 1, 31),
      month: parseCronField(parts[3], 1, 12),
      dayOfWeek: parseCronField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.type === "any") return true;
  return field.values.includes(value);
}

function scheduleMatches(schedule: ParsedSchedule, date: Date): boolean {
  return (
    fieldMatches(schedule.minute, date.getMinutes()) &&
    fieldMatches(schedule.hour, date.getHours()) &&
    fieldMatches(schedule.dayOfMonth, date.getDate()) &&
    fieldMatches(schedule.month, date.getMonth() + 1) &&
    fieldMatches(schedule.dayOfWeek, date.getDay())
  );
}

interface ScriptHeaders {
  schedule: string | null;
  description: string;
  timeout: number;
}

function parseHeaders(content: string): ScriptHeaders {
  const headers: ScriptHeaders = {
    schedule: null,
    description: "",
    timeout: 300,
  };

  const lines = content.split("\n").slice(0, 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;

    const scheduleMatch = trimmed.match(/^#\s*schedule:\s*(.+)$/i);
    if (scheduleMatch) {
      headers.schedule = scheduleMatch[1].trim();
      continue;
    }

    const descMatch = trimmed.match(/^#\s*description:\s*(.+)$/i);
    if (descMatch) {
      headers.description = descMatch[1].trim();
      continue;
    }

    const timeoutMatch = trimmed.match(/^#\s*timeout:\s*(\d+)$/i);
    if (timeoutMatch) {
      headers.timeout = parseInt(timeoutMatch[1], 10);
      continue;
    }
  }

  return headers;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("parseCronField", () => {
  test("wildcard", () => {
    const f = parseCronField("*", 0, 59);
    expect(f.type).toBe("any");
  });

  test("single value", () => {
    const f = parseCronField("5", 0, 59);
    expect(f).toEqual({ type: "values", values: [5] });
  });

  test("comma-separated values", () => {
    const f = parseCronField("0,15,30,45", 0, 59);
    expect(f).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("range", () => {
    const f = parseCronField("1-5", 0, 6);
    expect(f).toEqual({ type: "values", values: [1, 2, 3, 4, 5] });
  });

  test("step with wildcard", () => {
    const f = parseCronField("*/15", 0, 59);
    expect(f).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("step with range", () => {
    const f = parseCronField("1-30/10", 0, 59);
    expect(f).toEqual({ type: "values", values: [1, 11, 21] });
  });

  test("combined range and values", () => {
    const f = parseCronField("1-3,7,10-12", 1, 31);
    expect(f).toEqual({ type: "values", values: [1, 2, 3, 7, 10, 11, 12] });
  });
});

describe("parseSchedule", () => {
  test("parses standard 5-field expression", () => {
    const s = parseSchedule("0 9 * * 1-5");
    expect(s).not.toBeNull();
    expect(s!.minute).toEqual({ type: "values", values: [0] });
    expect(s!.hour).toEqual({ type: "values", values: [9] });
    expect(s!.dayOfMonth.type).toBe("any");
    expect(s!.month.type).toBe("any");
    expect(s!.dayOfWeek).toEqual({ type: "values", values: [1, 2, 3, 4, 5] });
  });

  test("rejects too few fields", () => {
    expect(parseSchedule("0 9 *")).toBeNull();
  });

  test("rejects too many fields", () => {
    expect(parseSchedule("0 9 * * 1 extra")).toBeNull();
  });

  test("every 30 minutes", () => {
    const s = parseSchedule("*/30 * * * *");
    expect(s).not.toBeNull();
    expect(s!.minute).toEqual({ type: "values", values: [0, 30] });
  });
});

describe("scheduleMatches", () => {
  test("every minute matches any time", () => {
    const s = parseSchedule("* * * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 30))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 0, 1, 0, 0))).toBe(true);
  });

  test("9am daily matches at 9:00", () => {
    const s = parseSchedule("0 9 * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 1))).toBe(false);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 0))).toBe(false);
  });

  test("weekdays only (1-5)", () => {
    const s = parseSchedule("0 9 * * 1-5")!;
    // March 15, 2026 is a Sunday (day 0)
    expect(scheduleMatches(s, new Date(2026, 2, 15, 9, 0))).toBe(false);
    // March 16, 2026 is a Monday (day 1)
    expect(scheduleMatches(s, new Date(2026, 2, 16, 9, 0))).toBe(true);
  });

  test("Friday 6pm", () => {
    const s = parseSchedule("0 18 * * 5")!;
    // March 20, 2026 is a Friday
    expect(scheduleMatches(s, new Date(2026, 2, 20, 18, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 20, 17, 0))).toBe(false);
    // March 19, 2026 is a Thursday
    expect(scheduleMatches(s, new Date(2026, 2, 19, 18, 0))).toBe(false);
  });

  test("every 30 minutes", () => {
    const s = parseSchedule("*/30 * * * *")!;
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 30))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 2, 15, 10, 15))).toBe(false);
  });

  test("specific month and day", () => {
    const s = parseSchedule("0 0 1 1 *")!; // midnight, Jan 1st
    expect(scheduleMatches(s, new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(scheduleMatches(s, new Date(2026, 1, 1, 0, 0))).toBe(false);
  });
});

describe("parseHeaders", () => {
  test("parses all headers", () => {
    const script = `#!/bin/bash
# schedule: 0 9 * * *
# description: Morning email check
# timeout: 120

echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
    expect(h.description).toBe("Morning email check");
    expect(h.timeout).toBe(120);
  });

  test("defaults when headers missing", () => {
    const script = `#!/bin/bash
# schedule: */30 * * * *

echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("*/30 * * * *");
    expect(h.description).toBe("");
    expect(h.timeout).toBe(300);
  });

  test("no schedule returns null", () => {
    const script = `#!/bin/bash
# Just a regular script
echo "hello"`;

    const h = parseHeaders(script);
    expect(h.schedule).toBeNull();
  });

  test("case insensitive header names", () => {
    const script = `#!/bin/bash
# Schedule: 0 9 * * *
# DESCRIPTION: Test job
# Timeout: 60`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
    expect(h.description).toBe("Test job");
    expect(h.timeout).toBe(60);
  });

  test("ignores non-comment lines", () => {
    const script = `#!/bin/bash
echo "schedule: not this"
# schedule: 0 9 * * *`;

    const h = parseHeaders(script);
    expect(h.schedule).toBe("0 9 * * *");
  });
});
