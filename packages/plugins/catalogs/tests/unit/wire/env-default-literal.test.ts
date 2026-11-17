// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every case is the literal text of a shell-style reference.
/**
 * Catalogs' copy of the MCP env rule: a default in an environment reference (`${NAME:-<literal>}`) is judged like any
 * value. Fixtures are assembled at run time so no file holds a real-looking key.
 */
import { describe, expect, test } from 'bun:test';
import { mcpServerRefusal } from '../../../contract/wire/foreign.ts';

const filler = (length: number): string => 'A1b2C3d4E5f6'.repeat(Math.ceil(length / 12)).slice(0, length);
const command = (env: Record<string, string>) => ({ transport: 'command' as const, args: [], env });

describe('catalog MCP env rule: a default literal is judged like any value', () => {
  test.each([
    ['a known shape (sk-ant-)', 'API_KEY', `\${API_KEY:-sk-ant-${filler(20)}}`],
    ['a known shape (ghp_)', 'TOKEN', `\${TOKEN:-ghp_${filler(24)}}`],
    ['a long random literal under a credential name', 'API_KEY', '${API_KEY:-q7Zk2PxV9mLw4TnR8sBd3FgH}'],
  ])('should refuse %s in a default', (_label, name, value) => {
    expect(mcpServerRefusal('login', command({ [name]: value }))).not.toBeNull();
    expect(mcpServerRefusal('project', command({ [name]: value }))).not.toBeNull();
  });

  test.each(['${API_KEY}', '${API_KEY:-}', '${PORT:-8080}'])('should keep %s', value => {
    expect(mcpServerRefusal('project', command({ API_KEY: value }))).toBeNull();
  });
});
