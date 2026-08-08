import type { LogLevel } from './config.js'

/**
 * Structured logging: one JSON object per line, so deployed logs are
 * queryable without a parser. Deliberately dependency-free.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Returns a logger that stamps `fields` onto every line it writes. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  base?: LogFields
  /** Test seam; defaults to writing to stdout / stderr. */
  write?: (line: string, level: LogLevel) => void
  /** Test seam for deterministic timestamps. */
  now?: () => Date
}

const defaultWrite = (line: string, level: LogLevel): void => {
  const stream =
    LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

/**
 * Values that would break a single-line JSON record (an Error, a circular
 * object) are normalized rather than thrown away.
 */
const normalize = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const level = options.level ?? 'info'
  const base = options.base ?? {}
  const write = options.write ?? defaultWrite
  const now = options.now ?? (() => new Date())

  const emit = (lineLevel: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return
    const record: LogFields = {
      time: now().toISOString(),
      level: lineLevel,
      msg: message,
      ...base
    }
    for (const [key, value] of Object.entries(fields ?? {})) {
      record[key] = normalize(value)
    }
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      line = JSON.stringify({
        time: record.time,
        level: lineLevel,
        msg: message,
        logError: 'log fields were not serializable'
      })
    }
    write(line, lineLevel)
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({ ...options, level, base: { ...base, ...fields } })
  }
}
