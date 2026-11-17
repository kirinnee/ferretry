// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every case is the literal text of a shell-style reference.
/**
 * A default in an environment reference (`${NAME:-<literal>}`) carries a literal, and a literal can carry a credential:
 * the rule judges it like any value instead of letting the whole reference through as a pointer. Fixtures are
 * assembled at run time so no file holds a real-looking key.
 */
import { describe, expect, test } from 'bun:test';
import { mcpServerRefusal } from '../../contract/index.ts';
import { looksLikeRawSecret } from '../../contract/raw-secret.ts';

const filler = (length: number): string => 'A1b2C3d4E5f6'.repeat(Math.ceil(length / 12)).slice(0, length);
const RANDOM = 'q7Zk2PxV9mLw4TnR8sBd3FgH';
const command = (env: Record<string, string>) => ({ transport: 'command' as const, command: 'npx', args: [], env });

describe('MCP env rule: a default literal is judged like any value', () => {
  test.each([
    ['a known shape (sk-ant-)', 'API_KEY', `\${API_KEY:-sk-ant-${filler(20)}}`],
    ['a known shape (ghp_)', 'TOKEN', `\${TOKEN:-ghp_${filler(24)}}`],
    ['a known shape (AKIA)', 'AWS_ID', `\${AWS_ID:-AKIA${filler(16).toUpperCase()}}`],
    ['a long random literal under a credential name', 'API_KEY', `\${API_KEY:-${RANDOM}}`],
    ['a known shape under a name that is no credential name', 'HOST', `\${HOST:-sk-live-${filler(20)}}`],
  ])('should refuse %s in a default, in a project file and in a login', (_label, name, value) => {
    // Act
    const project = mcpServerRefusal('project', command({ [name]: value }));
    const login = mcpServerRefusal('login', command({ [name]: value }));

    // Assert
    expect(project).not.toBeNull();
    expect(login).not.toBeNull();
  });

  test.each([
    ['a bare pointer', '${API_KEY}'],
    ['an empty default', '${API_KEY:-}'],
    ['a short harmless default', '${PORT:-8080}'],
    ['a URL default', '${API_URL:-https://api.example.com/v1}'],
    ['a short word under a credential name', '${API_KEY:-changeme}'],
  ])('should keep %s', (_label, value) => {
    // Act
    const actual = mcpServerRefusal('project', command({ API_KEY: value }));

    // Assert
    expect(actual).toBeNull();
  });

  test('should still refuse a raw key that is no reference', () => {
    expect(mcpServerRefusal('login', command({ API_KEY: `sk-live-${filler(20)}` }))).not.toBeNull();
  });
});

describe('MCP wire raw-secret test: only a bare NAME is a pointer', () => {
  test.each([
    ['a default literal', `\${API_KEY:-${RANDOM}}`],
    ['a secret pointer with a default', `\${secret:API_KEY:-${RANDOM}}`],
    ['an assigning default', `\${API_KEY:=${RANDOM}}`],
    ['an alternative value', `\${API_KEY:+${RANDOM}}`],
  ])('should flag %s under a credential name', (_label, value) => {
    expect(looksLikeRawSecret('API_KEY', value)).toBe(true);
  });

  test.each(['${API_KEY}', '${secret:ANTHROPIC_API_KEY}', '${secret?:ANTHROPIC_API_KEY}', '$ANTHROPIC_API_KEY_VALUE'])(
    'should not flag the pointer %s',
    value => {
      expect(looksLikeRawSecret('API_KEY', value)).toBe(false);
    },
  );
});
