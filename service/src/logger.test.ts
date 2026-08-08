import { describe, expect, test } from 'vitest'
import { createLogger } from './logger.js'

const collector = () => {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
}

const fixedNow = () => new Date('2026-08-08T12:00:00.000Z')

describe('createLogger', () => {
  test('writes one JSON object per line', () => {
    const sink = collector()
    createLogger({ write: sink.write, now: fixedNow }).info('list created', {
      listId: 'abc'
    })
    expect(sink.lines).toEqual([
      {
        time: '2026-08-08T12:00:00.000Z',
        level: 'info',
        msg: 'list created',
        listId: 'abc'
      }
    ])
  })

  test('drops records below the configured level', () => {
    const sink = collector()
    const logger = createLogger({ level: 'warn', write: sink.write })
    logger.debug('quiet')
    logger.info('quiet')
    logger.warn('loud')
    expect(sink.lines.map((line) => line.msg)).toEqual(['loud'])
  })

  test('child loggers stamp their fields onto every line', () => {
    const sink = collector()
    const logger = createLogger({ write: sink.write }).child({
      requestId: 'r-1'
    })
    logger.info('one')
    logger.info('two', { listId: 'abc' })
    expect(sink.lines.map((line) => line.requestId)).toEqual(['r-1', 'r-1'])
    expect(sink.lines[1]?.listId).toBe('abc')
  })

  test('serializes errors instead of emitting an empty object', () => {
    const sink = collector()
    createLogger({ write: sink.write }).error('signing failed', {
      err: new Error('boom')
    })
    expect(sink.lines[0]?.err).toMatchObject({
      name: 'Error',
      message: 'boom'
    })
  })

  test('still emits a line when fields are not serializable', () => {
    const sink = collector()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    createLogger({ write: sink.write }).info('cycle', { circular })
    expect(sink.lines[0]?.logError).toBe('log fields were not serializable')
    expect(sink.lines[0]?.msg).toBe('cycle')
  })

  test('routes warn and error to stderr, everything else to stdout', () => {
    const streams: string[] = []
    const logger = createLogger({
      level: 'debug',
      write: (_line, level) =>
        streams.push(
          level === 'warn' || level === 'error' ? 'stderr' : 'stdout'
        )
    })
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')
    expect(streams).toEqual(['stdout', 'stdout', 'stderr', 'stderr'])
  })
})
