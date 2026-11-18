/**
 * Test-title marker scanner (S-01b2 P1). RED STUB: the contract's exports exist; every input is refused. The implementation follows.
 */
export const KIND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
export const RUNNER_MODULES = Object.freeze(['node:test', 'vitest', '@jest/globals', 'bun:test', '@playwright/test']);
export const LIMITS = Object.freeze({ maxBytes: 1048576, stepsPerByte: 8, maxTemplateDepth: 16 });
export const GRAMMAR = Object.freeze(['X1', 'X2', 'X3', 'X4', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13', 'L14',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'F1a', 'F1b', 'F2', 'F3', 'M1', 'M2']);
export function scanTitles() { return { status: 'unscannable', reason: 'scanner_error', line: null, calls: [], counts: null, steps: 0 }; }
