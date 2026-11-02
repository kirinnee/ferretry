import { describe, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { redactText } from '../../../src/lib/fleet/catalog.ts';
import { referenceRedactText } from '../../support/redact-reference.ts';

// The context-free token rule cuts a token wherever it stands, so it must not cut a word that only ends the way a
// token starts (`task-plan-ended` holds `sk-plan-ended`). The repo's own prose and scripts are the corpus of real
// phrases: a line the new rule hides and main did not may only be one that holds a private-key header.

const ROOT = join(import.meta.dir, '../../../../..');
const TEXT_FILE = /\.(?:md|sh|ts|tsx|json|ya?ml|txt)$/u;
const MAX_LINE = 2000;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const PHRASES = [
  'the task-plan-ended event',
  'a risk-assessment-notes file',
  'vosk-model-small-en-us-0',
  'ask-the-owner before it runs',
  'the disk-usage-report-2024 job',
];

describe('redactText: no false hits on real phrases', () => {
  it.each(PHRASES)('should leave %s as it is', phrase => {
    should(redactText(phrase)).deepEqual({ text: phrase, redacted: false });
  });

  it('should hide on a line of docs, scripts and skills only what main hid, or a private-key header', () => {
    const extra: string[] = [];
    for (const root of ['docs', 'scripts', '.claude']) {
      for (const file of walk(join(ROOT, root)).filter(path => TEXT_FILE.test(path))) {
        for (const line of readFileSync(file, 'utf8').split(/\r\n|\r|\n/u)) {
          if (line.length > MAX_LINE || line.includes('-----BEGIN')) continue;
          if (redactText(line).redacted && !referenceRedactText(line).redacted) extra.push(`${file}: ${line}`);
        }
      }
    }
    should(extra).deepEqual([]);
  });
});
