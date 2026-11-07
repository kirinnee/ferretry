/**
 * "What agents may control" (T, session-spec.html Settings › Agents): whether an agent runtime may
 * use terminals, browsers, the project filesystem or this machine's own configuration files — stored in the account model's
 * `machine.agentControl` (`@ferretry/fleet`'s `MachineSchema`) and read fresh for every call, so a
 * change applies to an agent's very next action with no restart and no cache.
 *
 * This is the port, not the enforcement. Unit M's tools MCP server (a separate PR, on the agent
 * tool-call path) is the port's main caller; it is kept here, beside the setting it reads, so the two
 * units can never drift into naming the rule twice.
 */
import type { AccountModel } from '@ferretry/fleet';
import { parseAccountModel } from '@ferretry/fleet';

/** The five things "What agents may control" switches independently. `settings` is the `config.*`
 *  tools: editing this machine's configuration files (docs/config-files.md), off by default. `scripts`
 *  is `browser.eval`: an agent's own JavaScript in a page it drives, off by default too. */
export type AgentControlKind = 'terminal' | 'browser' | 'files' | 'settings' | 'scripts';

export interface AgentControlPolicy {
  /** Whether an agent runtime may use `kind` on this machine, right now. */
  allows(kind: AgentControlKind): Promise<boolean>;
}

/** This policy's one dependency: this machine's account model, freshly read, or `undefined` for a
 *  machine with no configuration at all — which reads as every toggle on, same as a document that
 *  has the `machine` block but not yet the three fields (the schema's own defaults). */
export type AgentControlDocumentReader = () => Promise<AccountModel | undefined>;

/** The schema's own defaults, for a machine with no configuration to read at all. */
const DEFAULT_AGENT_CONTROL = parseAccountModel({ version: 2 }).machine.agentControl;

/** Which `machine.agentControl` field answers each kind. */
const FIELD: Readonly<Record<AgentControlKind, keyof AccountModel['machine']['agentControl']>> = {
  terminal: 'terminals',
  browser: 'browsers',
  files: 'files',
  settings: 'ferretrySettings',
  scripts: 'pageScripts',
};

/**
 * The real implementation, over this machine's own account model.
 *
 * ONE READER, passed in rather than built here: the composition root already has the single
 * `declaredAccountModel` every other in-process reader of this document shares (`fyd.ts`), and a
 * second reader of the same file would risk disagreeing with it about what this machine declares.
 */
export class AccountModelAgentControlPolicy implements AgentControlPolicy {
  constructor(private readonly read: AgentControlDocumentReader) {}

  async allows(kind: AgentControlKind): Promise<boolean> {
    const model = await this.read();
    const control = model?.machine.agentControl ?? DEFAULT_AGENT_CONTROL;
    return control[FIELD[kind]];
  }
}
