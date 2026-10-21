import { isAbsolute, join, resolve } from 'node:path';
import type { AccountModel } from '@ferretry/fleet';
import { hostCodexHome, parseAccountModel } from '@ferretry/fleet';
import type { ConversationListPolicy, ConversationRoot } from './conversations.ts';

/**
 * The owner's own CLI homes on this computer — the ones "On this computer" conversations are read from.
 *
 * Each follows the CLI's own rule, the same one {@link hostCodexHome} and the host-harness scan apply:
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when the daemon inherited one, else `~/.claude` / `~/.codex`. The
 * home is the same on macOS and Linux; only `userHome` differs. A RELATIVE variable is read against
 * a directory the daemon cannot know, so it is never guessed at: Claude falls back to `~/.claude`
 * (what the host scan does) and Codex, which has no such fallback, lists nothing from the computer.
 */
export interface ComputerHomeEnvironment {
  readonly claudeConfigDir: string | undefined;
  readonly codexHome: string | undefined;
  readonly userHome: string;
}

export function computerConversationRoots(environment: ComputerHomeEnvironment): readonly ConversationRoot[] {
  const named = environment.claudeConfigDir?.trim() ?? '';
  const claude = named !== '' && isAbsolute(named) ? resolve(named) : join(environment.userHome, '.claude');
  const codex = hostCodexHome(environment.codexHome, environment.userHome);
  return [
    { harness: 'claude', home: claude, source: 'computer' },
    ...(codex === undefined ? [] : [{ harness: 'codex' as const, home: codex, source: 'computer' as const }]),
  ];
}

/** The schema's own defaults, for a machine with no configuration to read at all. */
const DEFAULT_CONVERSATIONS = parseAccountModel({ version: 2 }).machine.conversations;

/** The machine's account model, freshly read, or `undefined` for a machine with none. */
export type ConversationSettingsReader = () => Promise<AccountModel | undefined>;

/** "Keep in sync", read fresh from `machine.conversations.listComputer` for every listing. */
export class AccountModelConversationListPolicy implements ConversationListPolicy {
  constructor(private readonly read: ConversationSettingsReader) {}

  async listsComputer(): Promise<boolean> {
    return ((await this.read())?.machine.conversations ?? DEFAULT_CONVERSATIONS).listComputer;
  }
}
