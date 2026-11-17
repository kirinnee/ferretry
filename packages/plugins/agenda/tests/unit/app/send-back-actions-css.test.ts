import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../../app/features/agenda/agenda-inbox.css'), 'utf8');
const rule = (selector: RegExp): string => css.match(selector)?.[0] ?? '';

describe('the send-back box’s action row', () => {
  const row = rule(/\n\.fy-send-back__actions \{[^}]*\}/u);

  it('is a row with the shared gap token between its buttons, so Attach, Cancel and Send back never touch', () => {
    expect(row).toContain('display: flex;');
    expect(row).toContain('gap: var(--gap-sm);');
  });

  it('wraps on a phone and keeps the buttons at the end, as the other action rows do', () => {
    expect(row).toContain('flex-wrap: wrap;');
    expect(row).toContain('justify-content: flex-end;');
  });

  it('invents no spacing value of its own', () => {
    expect(row).not.toMatch(/\d+px/u);
  });
});
