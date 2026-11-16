import { describe, expect, test } from 'bun:test';
import { MCP_CONFIG, McpItemSchema, type McpItem } from '../../contract/index.ts';
import { mcpParts } from '../../daemon/lib/launch-parts.ts';

// Synthetic fixtures only. Match each shape today's config-file raw-secret detector refuses.
const shaped = [
  `sk-ant-${'a'.repeat(8)}`,
  `sk-or-${'a'.repeat(8)}`,
  `sk-${'a'.repeat(16)}`,
  `sk-proj-${'a'.repeat(16)}`,
  `AKIA${'A'.repeat(16)}`,
  `ASIA${'A'.repeat(16)}`,
  `ghp_${'a'.repeat(20)}`,
  `github_pat_${'a'.repeat(20)}`,
  `xoxb-${'a'.repeat(10)}`,
  `gsk_${'a'.repeat(20)}`,
  `csk-${'a'.repeat(20)}`,
  `AIza${'a'.repeat(30)}`,
  `glpat-${'a'.repeat(16)}`,
];

describe('configured MCP launch parts', () => {
  test('G180 configured items refuse literal provider-shaped credentials under any env name', () => {
    for (const value of shaped) {
      const parsed = MCP_CONFIG.schema.safeParse({ command: 'tool', env: { DESCRIPTION: `Bearer ${value}` } });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toEqual(['env', 'DESCRIPTION']);
        const messages = parsed.error.issues.map(issue => issue.message).join('\n');
        expect(messages.includes(value)).toBe(false);
        expect(messages).toContain('fy secret set NAME');
      }
    }
  });

  test('G180 configured items refuse high-entropy credentials but allow references and ordinary literals', () => {
    const random = 'aB3dE5gH7jK9mN2p';
    for (const name of ['TOKEN', 'api_key', 'CLIENT_SECRET', 'password', 'CREDENTIALS'])
      expect(McpItemSchema.safeParse({ command: 'tool', env: { [name]: random } }).success).toBe(false);
    const env = {
      TOKEN: `\${secret:TOOL_TOKEN}`,
      API_KEY: `\${API_KEY}`,
      PASSWORD: '$PASSWORD',
      LANG: 'en_US.UTF-8',
      TOKEN_FILE: '/keys/token',
      KEY: 'https://example.com/keys',
      SECRET: 'a'.repeat(32),
      NOTE: random,
    };
    const item = McpItemSchema.parse({ command: 'tool', env });
    expect(mcpParts(new Map([['tool', item]]), 'claude-code')).toEqual([
      { kind: 'mcp', name: 'tool', config: { command: 'tool', env } },
    ]);
  });

  test('G180 launch rechecks unchecked items before producing parts, without quoting the credential', () => {
    for (const value of [...shaped, 'aB3dE5gH7jK9mN2p', `\${secret:lower}`]) {
      const item: McpItem = { command: 'tool', env: { TOKEN: value } };
      let failure: unknown;
      try {
        mcpParts(new Map([['tool', item]]), 'claude-code');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.includes(value)).toBe(false);
    }
  });
});
