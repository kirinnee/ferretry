/**
 * The parts of the one command-line rule Runtimes shares with a catalog's publish rule (britnee #41): the extra token
 * formats and a token right after `/ ? & #` are cut here too, and a Codex provider's `env_key` (the NAME of a variable,
 * which Runtimes builds itself) is shown as written. Every secret here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CommandWord, ComponentDetail } from '../../../contract/index.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const HIDDEN = '‹hidden›';
const BODY = 'notarealtoken00000000';
const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

/** The words of one MCP server's arguments in its detail (`GET /v1/runtimes/components`). */
function detailWords(args: readonly string[]): readonly CommandWord[] {
  const model = parseAccountModel({
    version: 1,
    components: { mcp: { local: { command: 'run-server', args: [...args] } } },
    profiles: { p: { layers: [] } },
  });
  const found = componentCatalog(model, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === 'mcp/local');
  const detail: ComponentDetail | undefined = found?.detail;
  return detail?.kind === 'mcp' ? (detail.args ?? []) : [];
}

/** What the Resolved view shows for these launch flags, in order. */
function resolvedFlags(flags: readonly string[]): readonly string[] {
  const model = parseAccountModel({
    version: 1,
    components: { settings: { base: { harness: 'claude', flags: [...flags] } } },
    profiles: { p: { layers: ['settings/base'] } },
  });
  const result = resolveProfile({ model, profile: 'p', harness: 'claude' });
  if (!result.ok) throw new Error('expected a resolution');
  return resolvedEntries(result.resolved)
    .filter(entry => entry.field === 'flags')
    .map(entry => entry.value);
}

const shownText = (word: CommandWord): string => (typeof word === 'string' ? word : word.shown);

describe('the parts of the rule a catalog shares (R-0082, britnee #41)', () => {
  it('R-0082 should hide rk_live_ and sk_test_ tokens and a token after / ? & #, in a detail and in the Resolved view', () => {
    const words = [
      `x:rk_live_${BODY}`,
      `--stripe=sk_test_${BODY}`,
      `x/ghp_${BODY}`,
      `x?ghp_${BODY}`,
      `x#ghp_${BODY}`,
      `x&ghp_${BODY}`,
      `https://h.example.invalid/p/ghp_${BODY}`,
    ];
    const expected = [
      HIDDEN,
      `--stripe=${HIDDEN}`,
      `x/${HIDDEN}`,
      `x?${HIDDEN}`,
      `x#${HIDDEN}`,
      `x&${HIDDEN}`,
      `https://h.example.invalid/p/${HIDDEN}`,
    ];
    should(detailWords(words).map(shownText)).deepEqual(expected);
    should(resolvedFlags(words)).deepEqual(expected);
  });

  it('R-0082 should keep showing a path segment that only starts like a token, and the plain package names', () => {
    const words = ['@acme/sk-mcp-server', 'https://h.example.invalid/hf_transfer'];
    should(detailWords(words).map(shownText)).deepEqual(words);
  });

  it('R-0082 should show a Codex provider’s env_key variable name as written', () => {
    const flag = '-c model_providers.openrouter.env_key="OPENROUTER_API_KEY"';
    should(detailWords([flag]).map(shownText)).deepEqual([flag]);
    should(resolvedFlags([flag])).deepEqual([flag]);
  });
});
