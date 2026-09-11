// Structured logging for ingest, matching the api's pino-based logging so
// Railway's log search and the deploy checks read both services the same
// way. The lanes and the writer keep a plain `(message: string) => void`
// log callback; main.ts wires each one to a pino call carrying the lane
// name and any counts the message reports.

import pino from "pino";

/** The count names a log message may carry, per apps/ingest/AGENTS.md. */
const COUNT_FIELD_NAMES = [
  "messages",
  "rows",
  "dropped",
  "inserted",
  "skipped",
  "new",
  "foreign",
  "unknown_session",
] as const;

const COUNT_FIELD_PATTERN = new RegExp(`\\b(${COUNT_FIELD_NAMES.join("|")})=(\\d+)\\b`, "g");

/**
 * Pulls every `name=<integer>` pair out of a log message for the count
 * field names above, so a log query can filter on them instead of parsing
 * `msg`. Names outside the list, and non-integer values, are ignored.
 */
export function countFields(message: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const match of message.matchAll(COUNT_FIELD_PATTERN)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) fields[name] = Number(value);
  }
  return fields;
}

export interface CreateLoggerOptions {
  /** Defaults to `process.env.LOG_LEVEL`, then `"info"`. */
  level?: string;
  /** Where lines are written; defaults to stdout. Tests pass an in-memory stream. */
  destination?: pino.DestinationStream;
}

/** Builds a pino logger with the base fields every ingest log line carries. */
export function createLogger(opts: CreateLoggerOptions = {}): pino.Logger {
  const options: pino.LoggerOptions = {
    base: { service: "ingest", build: process.env["RAILWAY_GIT_COMMIT_SHA"] ?? "unknown" },
    level: opts.level ?? process.env["LOG_LEVEL"] ?? "info",
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export const logger = createLogger();
