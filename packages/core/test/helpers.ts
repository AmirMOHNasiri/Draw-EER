import { expect } from 'vitest';
import { parse } from '../src';
import type { Statement } from '../src';

/** Parses source that must be free of syntax errors. */
export function parseOk(source: string): Statement[] {
  const { file, errors } = parse(source);
  expect(errors).toEqual([]);
  return file.statements;
}

/** Parses source that must contain errors and returns their messages. */
export function errorMessages(source: string): string[] {
  const { errors } = parse(source);
  expect(errors.length).toBeGreaterThan(0);
  return errors.map((e) => e.message);
}

/**
 * Makes AST nodes easy to compare: drops ranges and turns each name into its
 * plain text, so tests can focus on structure.
 */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' && typeof record.quoted === 'boolean') return record.text;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key !== 'range') result[key] = plain(item);
    }
    return result;
  }
  return value;
}
