import assert from 'node:assert/strict';
import { summarizeDescription } from '../src/automation.mjs';

function run() {
  const max = 420;
  const longInput = `${'x'.repeat(500)}    extra   spacing`;
  const summary = summarizeDescription(longInput, max);

  assert.equal(summary.length, max, 'summary should respect max length');
  assert.equal(summary.endsWith('...'), true, 'summary should end with ellipsis when truncated');

  const shortInput = 'short description';
  const shortSummary = summarizeDescription(shortInput, max);
  assert.equal(shortSummary, shortInput, 'short descriptions should pass through unchanged');

  console.log('automation regression tests passed');
}

run();
