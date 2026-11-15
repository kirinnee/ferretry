import { describe, expect, it } from 'bun:test';
import type { LoginEnvironment } from '../../../contract/index.ts';
import { type EditRow, editRows, envChange, rowsChanged } from '../../../app/lib/environment-edit.ts';

const ENVIRONMENT: LoginEnvironment = {
  variables: [
    { name: 'BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
    { name: 'AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
    { name: 'ODD_TOKEN', kind: 'hidden' },
  ],
  quotaSource: 'zai-coding-plan',
  missingSecrets: [],
  test: { available: false, reason: 'No preset.' },
};

const rows = (): EditRow[] => [...editRows(ENVIRONMENT)];
const withRow = (index: number, change: Partial<EditRow>): EditRow[] =>
  rows().map((row, at) => (at === index ? { ...row, ...change } : row));
const newRow = (name: string, value: string): EditRow => ({
  key: `new:${name}`,
  name,
  kind: 'new',
  value,
  removed: false,
});
/** A key-shaped string, assembled so no source line holds one. */
const KEY = ['sk', 'ant', 'a'.repeat(24)].join('-');
/** Names that are keys as well (POSIX-valid ones, and one that is not), assembled at runtime from fake bodies. */
const KEY_NAMES = [
  ['ghp', 'a1b2c3d4e5f6a1b2c3d4e5f6'].join('_'),
  ['github', 'pat', 'a1b2c3d4e5f6a1b2c3d4e5f6'].join('_'),
  ['sk', 'live', 'a1b2c3d4e5f6a1b2c3d4e5f6'].join('_'),
  KEY,
];

describe('editRows', () => {
  it('starts from every variable, a plain one with its value and a secret or hidden one empty', () => {
    expect(rows()).toEqual([
      {
        key: 'variable:BASE_URL',
        name: 'BASE_URL',
        kind: 'plain',
        value: 'https://api.z.ai/api/anthropic',
        removed: false,
      },
      { key: 'variable:AUTH_TOKEN', name: 'AUTH_TOKEN', kind: 'secret', value: '', removed: false },
      { key: 'variable:ODD_TOKEN', name: 'ODD_TOKEN', kind: 'hidden', value: '', removed: false },
    ]);
  });
});

describe('rowsChanged', () => {
  it('is false for the rows it started with', () => {
    expect(rowsChanged(rows(), rows())).toBe(false);
  });

  it('is true for an edited value, a removal, an added row and a typed replacement', () => {
    expect(rowsChanged(rows(), withRow(0, { value: 'https://other.test' }))).toBe(true);
    expect(rowsChanged(rows(), withRow(0, { removed: true }))).toBe(true);
    expect(rowsChanged(rows(), [...rows(), newRow('', '')])).toBe(true);
    expect(rowsChanged(rows(), withRow(1, { value: `\${secret:OTHER_KEY}` }))).toBe(true);
  });

  it('is true for a row that is not one the editor started with', () => {
    expect(rowsChanged(rows(), withRow(0, { name: 'RENAMED' }))).toBe(true);
  });
});

describe('envChange', () => {
  it('keeps a secret or hidden variable as it is, and sends a plain one as it stands', () => {
    expect(envChange('zai', rows())).toEqual({
      kind: 'change',
      change: {
        kind: 'login.env',
        id: 'zai',
        env: {
          BASE_URL: 'https://api.z.ai/api/anthropic',
          AUTH_TOKEN: { keep: true },
          ODD_TOKEN: { keep: true },
        },
      },
    });
  });

  it('accepts a secret reference typed over a secret or a hidden variable', () => {
    const edit = envChange('zai', withRow(1, { value: `\${secret:WORK_KEY}` }));
    expect(edit).toMatchObject({ kind: 'change', change: { env: { AUTH_TOKEN: `\${secret:WORK_KEY}` } } });
    const hidden = envChange('zai', withRow(2, { value: `\${secret:HIDDEN_KEY}` }));
    expect(hidden).toMatchObject({ kind: 'change', change: { env: { ODD_TOKEN: `\${secret:HIDDEN_KEY}` } } });
  });

  it('adds a new variable, and leaves out a removed one and a blank new row', () => {
    const edit = envChange('zai', [...withRow(0, { removed: true }), newRow(' REGION ', 'us-east-1'), newRow('', '')]);
    expect(edit).toMatchObject({
      kind: 'change',
      change: { env: { AUTH_TOKEN: { keep: true }, ODD_TOKEN: { keep: true }, REGION: 'us-east-1' } },
    });
    expect(edit.kind === 'change' && Object.keys(edit.change.env)).toEqual(['AUTH_TOKEN', 'ODD_TOKEN', 'REGION']);
  });

  it('refuses a raw key typed into a plain value, a secret replacement or a new variable, without repeating it', () => {
    for (const edit of [
      envChange('zai', withRow(0, { value: KEY })),
      envChange('zai', withRow(1, { value: KEY })),
      envChange('zai', [...rows(), newRow('GATEWAY_TOKEN', KEY)]),
    ]) {
      expect(edit.kind).toBe('refused');
      expect(JSON.stringify(edit)).not.toContain(KEY);
      expect(edit).toMatchObject({ sentence: expect.stringContaining(`\${secret:NAME}`) });
    }
  });

  it('refuses an address that carries a password or a key, naming the variable only', () => {
    const userinfo = envChange('zai', withRow(0, { value: 'https://user:hunter2hunter2@gw.test/v1' }));
    expect(userinfo).toEqual({
      kind: 'refused',
      sentence: 'BASE_URL is an address holding a password. Write it without that and keep it in Settings › Secrets.',
    });
    const query = envChange('zai', withRow(0, { value: 'https://gw.test/v1?api_key=abcdef1234567890' }));
    expect(query).toMatchObject({ kind: 'refused', sentence: expect.stringContaining('key in its query string') });
    expect(JSON.stringify([userinfo, query])).not.toContain('hunter2');
    expect(JSON.stringify([userinfo, query])).not.toContain('abcdef1234567890');
  });

  it('refuses a new variable with no name, a bad name, a reserved name, a repeated name or no value', () => {
    expect(envChange('zai', [newRow('', 'x')])).toEqual({
      kind: 'refused',
      sentence: 'A new variable needs a name.',
    });
    expect(envChange('zai', [newRow('9LIVES', 'x')])).toEqual({
      kind: 'refused',
      sentence:
        "The new variable's name is not a variable name: letters, digits and underscores, not starting with a digit.",
    });
    expect(envChange('zai', [newRow('CODEX_HOME', '/tmp')])).toEqual({
      kind: 'refused',
      sentence: 'CODEX_HOME is reserved: Ferretry sets it for the runtime itself.',
    });
    expect(envChange('zai', [...rows(), newRow('BASE_URL', 'x')])).toEqual({
      kind: 'refused',
      sentence: 'BASE_URL is listed twice.',
    });
    expect(envChange('zai', [newRow('REGION', '  ')])).toEqual({
      kind: 'refused',
      sentence: 'REGION needs a value.',
    });
  });

  it('refuses a name that is a key, and never repeats it', () => {
    for (const name of KEY_NAMES) {
      const edit = envChange('zai', [...rows(), newRow(name, 'https://gw.test')]);
      expect(edit.kind).toBe('refused');
      expect(JSON.stringify(edit)).not.toContain(name);
      expect(JSON.stringify(edit)).not.toContain('a1b2c3d4e5f6');
    }
    // A POSIX-valid key says it is a key; one that is not a name at all says so, and neither is echoed.
    expect(envChange('zai', [newRow(KEY_NAMES[0] as string, 'x')])).toMatchObject({
      sentence: expect.stringContaining('looks like a key'),
    });
    expect(envChange('zai', [newRow(KEY, 'x')])).toMatchObject({
      sentence: expect.stringContaining('is not a variable name'),
    });
  });

  it('accepts variables called __proto__ or constructor, and still refuses one listed twice', () => {
    const edit = envChange('zai', [newRow('__proto__', 'x'), newRow('constructor', 'y')]);
    expect(edit.kind).toBe('change');
    expect(edit.kind === 'change' && Object.keys(edit.change.env)).toEqual(['__proto__', 'constructor']);
    expect(envChange('zai', [newRow('constructor', 'x'), newRow('constructor', 'y')])).toEqual({
      kind: 'refused',
      sentence: 'constructor is listed twice.',
    });
  });

  it('lets a new variable take the name of one that is being removed', () => {
    const edit = envChange('zai', [...withRow(0, { removed: true }), newRow('BASE_URL', 'https://other.test')]);
    expect(edit).toMatchObject({ kind: 'change', change: { env: { BASE_URL: 'https://other.test' } } });
  });
});
