/**
 * The four places Runtimes SHOWS a command line, driven with the real functions (no mock), for the tests that hold the
 * fail-closed net (CFG-LEAK): the Resolved view (`POST /v1/runtimes/profiles/preview`: an MCP server's line and a settings
 * component's flags), a component's detail (`GET /v1/runtimes/components`: MCP args and settings flags) and the runtime
 * list's overridden flags (`GET /v1/runtimes`).
 *
 * Each answers the TEXT it shows and whether the whole thing was withheld, so one assertion reads every view alike.
 */
import { WITHHELD_WORDS_TEXT } from '../../../contract/index.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, componentCatalog, runtimeCatalog } from '../../../daemon/lib/service/catalog.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

/** What one view shows of a line: its text, and whether the view withheld it (said so in words, showed no part). */
export interface ViewText {
  readonly text: string;
  readonly withheld: boolean;
}

/** The names of the views, in the order `viewsOf` answers them. */
export const VIEW_NAMES = [
  'resolved MCP line',
  'resolved flags',
  'detail MCP args',
  'detail flags',
  'runtime list overridden flags',
] as const;

const modelWith = (components: Record<string, unknown>, profiles: Record<string, unknown>, extra = {}) =>
  parseAccountModel({ version: 1, components, profiles, ...extra });

function resolvedOf(model: ReturnType<typeof modelWith>) {
  const result = resolveProfile({ model, profile: 'p', harness: 'claude', settingsBodies: { base: {} } });
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return resolvedEntries(result.resolved);
}

const textOf = (shown: readonly string[]): ViewText => ({
  text: shown.join('\n'),
  withheld: shown.some(text => text.includes(WITHHELD_WORDS_TEXT)),
});

/** What every Runtimes view shows of `line` (a list of command-line words), in `VIEW_NAMES` order. */
export function viewsOf(line: readonly string[]): readonly ViewText[] {
  // The Resolved view: an MCP server's command line, and a settings component's flags.
  const mcpModel = modelWith({ mcp: { srv: { command: 'srv', args: [...line] } } }, { p: { layers: ['mcp/srv'] } });
  const flagModel = modelWith(
    { settings: { base: { harness: 'claude', file: 'base.json', flags: [...line] } } },
    { p: { layers: ['settings/base'] } },
  );
  const mcpLine = resolvedOf(mcpModel)
    .filter(entry => entry.field === 'mcp')
    .map(entry => entry.value);
  const flagValues = resolvedOf(flagModel)
    .filter(entry => entry.field === 'flags')
    .map(entry => entry.value);

  // A component's detail.
  const detailOf = (model: ReturnType<typeof modelWith>, reference: string) => {
    const found = componentCatalog(model, FACTS)
      .kinds.flatMap(group => group.components)
      .find(component => component.reference === reference);
    if (found === undefined) throw new Error(`no ${reference}`);
    return found.detail;
  };
  const mcpDetail = detailOf(mcpModel, 'mcp/srv');
  const flagDetail = detailOf(flagModel, 'settings/base');
  const wordsOf = (words: readonly (string | { readonly shown: string })[] | undefined): readonly string[] =>
    (words ?? []).map(word => (typeof word === 'string' ? word : word.shown));
  const argsView: ViewText =
    mcpDetail.kind === 'mcp' && mcpDetail.argsWithheld === true
      ? { text: WITHHELD_WORDS_TEXT, withheld: true }
      : { text: wordsOf(mcpDetail.kind === 'mcp' ? mcpDetail.args : undefined).join('\n'), withheld: false };
  const flagsView: ViewText =
    flagDetail.kind === 'settings' && flagDetail.flagsWithheld === true
      ? { text: WITHHELD_WORDS_TEXT, withheld: true }
      : { text: wordsOf(flagDetail.kind === 'settings' ? flagDetail.flags : undefined).join('\n'), withheld: false };

  // The runtime list: a flag the fixed layer overrides names its words (`--permission-mode` is one it always sets).
  const overriddenModel = parseAccountModel({
    version: 1,
    credentials: { 'claude-a': { harness: 'claude', store: 'ferretry' } },
    components: {
      settings: {
        'cl-settings': {
          harness: 'claude',
          file: 'components/settings/cl-settings.json',
          flags: ['--permission-mode', ...line],
        },
      },
    },
    profiles: { tuned: { layers: ['settings/cl-settings'] } },
    runtimes: { 'claude-default': { credential: 'claude-a', profile: 'tuned', agent: true } },
  });
  const overridden =
    runtimeCatalog(overriddenModel, FACTS).runtimes.find(entry => entry.name === 'claude-default')?.fixedLayer
      ?.overridden ?? [];

  return [
    textOf(mcpLine),
    textOf(flagValues),
    argsView,
    flagsView,
    textOf(overridden.flatMap(entry => [entry.key, entry.value])),
  ];
}
