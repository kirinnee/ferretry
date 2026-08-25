/**
 * The fleet a host gets without anybody asking for one.
 *
 * Until this module, a machine with Claude Code installed and a daemon running could do nothing: the
 * daemon resolved `claude` on the `PATH`, said so at boot, and then refused to launch it, because it
 * launches the wrappers the fleet manifest publishes and the manifest published none. Every word of
 * that refusal was accurate and its effect was that setup was a tax somebody paid before anything
 * worked at all. This module is the answer to it — the accounts a detected harness earns on its own,
 * declared as values so that one owner names them and every surface reads the same four names.
 *
 * FOUR RULES, and each one is here rather than at a call site because a call site is where they get
 * quietly re-derived:
 *
 *  1. **Only a harness that was actually found gets accounts.** Detection is
 *     `locateHarnessCommand`'s job and this module does not repeat it: it takes the kinds somebody
 *     else resolved. A second detector would be a second opinion about what "installed" means, and
 *     the two would disagree the first time an operator wrote down a path.
 *  2. **One name rule, for the default fleet and for anything a person adds later.** The wrapper an
 *     account gets is {@link derivedWrapperName}, whether the account came from this module or from a
 *     browser form, so `claude-default` and `claude-auto-default` are the same kind of name as
 *     `claude-work` and `claude-auto-work` rather than a special case somebody has to know about.
 *  3. **The home is the wrapper name.** Two strings that must always agree are one string. A default
 *     account whose home drifted from its wrapper would publish credentials under a directory no
 *     surface names.
 *  4. **The instructions document is part of the account, not a file that happens to exist.**
 *     {@link DEFAULT_INSTRUCTIONS} is read by the thing that WRITES those documents and by the thing
 *     that POINTS accounts at them, so "configured by default" is a single fact instead of two
 *     hopeful ones. An unattended agent is given different guidance from an attended one because it
 *     is a different situation, which is why the lane is part of the key.
 *
 * Pure and value-only: nothing here reads a filesystem, mints an identifier, or renders YAML.
 * Rendering a configuration is {@link module:scaffold}'s job and deciding to write one is the
 * daemon's; this module only says what a default fleet IS.
 */

import type { AccountMode, HarnessKind } from './manifest.ts';

/**
 * The provider-account name every default account shares.
 *
 * ONE agent per harness, two lanes on it — not two agents. The lanes are two homes for one provider
 * login, which is exactly the shape `identity` was built for: signing in once makes both usable.
 * Two agents would be two logins for one account and would ask a person to do the sign-in twice.
 */
export const DEFAULT_ACCOUNT_NAME = 'default';

/**
 * The lanes a default account occupies, and the only two this module has an opinion about.
 *
 * These are VARIANT names — composition slots the starter configuration declares — and they are
 * spelled here because the wrapper names derive from them. A fleet an operator has since re-laned
 * keeps its own lanes: nothing below rewrites a configuration that already has accounts.
 */
export const FLEET_DEFAULT_LANES = ['default', 'auto'] as const;
export type FleetDefaultLane = (typeof FLEET_DEFAULT_LANES)[number];

/**
 * The mode each default lane publishes.
 *
 * Annotated over the lanes rather than spelled loosely, so a third default lane would be a compile
 * error here instead of a lane whose accounts silently publish the wrong mode — and `mode` is the
 * field consumers read to decide whether an account may be driven unattended, so a wrong one is not
 * a cosmetic defect.
 */
export const DEFAULT_LANE_MODES: Readonly<Record<FleetDefaultLane, AccountMode>> = {
  default: 'interactive',
  auto: 'auto',
};

/**
 * The model a first account starts with, per harness.
 *
 * EXPORTED because three consumers need the same value: the starter configuration writes it, the
 * account form offers it when a harness declares no model of its own and says out loud that it is
 * Ferretry's starter rather than something the host declared, and the default accounts below serve
 * it. Two copies of a model identifier would drift the first time either moved, and the drift would
 * be invisible in the worst way — a form offering a model no scaffold ever wrote, on an account that
 * then claims to serve it.
 */
export const FLEET_STARTER_MODELS: Readonly<Record<HarnessKind, string>> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.6',
};

/**
 * The wrapper name an account gets.
 *
 * The default lane keeps the bare `<harness>-<name>` a person would type; any other lane is spelled
 * out, so two lanes of one account never collide. It lives in this package rather than beside the
 * mutation that used to own it because the default fleet needs the same rule: a second spelling here
 * would produce a `claude-auto-default` from one path and a `claude-default-auto` from the other, and
 * the disagreement would only surface as a wrapper somebody could not find.
 */
export function derivedWrapperName(harness: string, name: string, variant: string): string {
  return variant === 'default' ? `${harness}-${name}` : `${harness}-${variant}-${name}`;
}

/**
 * Where the default instructions documents sit in the fleet's asset tree, per harness and lane.
 *
 * FOUR DOCUMENTS, and the count is the point. One shared document for everything was what shipped
 * before, and it forced two compromises: Codex read a file whose own first paragraph told it that it
 * was Claude's, and an unattended agent read guidance written for one that can ask a question. So
 * each harness gets the document its own harness names — `CLAUDE.md`, `AGENTS.md` — and each lane
 * gets its own copy of it, because "never stop and ask" is correct advice in exactly one of the two
 * lanes and dangerous in the other.
 *
 * The paths are RELATIVE, in the `./name` spelling a configuration uses, because that is what an
 * asset reference in `config.yaml` looks like and this table is what both the writer and the
 * referencer read. Canonicalise before comparing two of them — `./CLAUDE.md` and `CLAUDE.md` are one
 * document — which `canonicalAssetReference` is for.
 */
export const DEFAULT_INSTRUCTIONS: Readonly<Record<HarnessKind, Readonly<Record<FleetDefaultLane, string>>>> = {
  claude: { default: './CLAUDE.md', auto: './CLAUDE-auto.md' },
  codex: { default: './AGENTS.md', auto: './AGENTS-auto.md' },
};

/**
 * The name a default instructions document is registered under in `config.shared`.
 *
 * A shared document needs a NAME as well as a path: the registry is what lets a surface offer it,
 * count who uses it, and switch one account between the shared copy and its own. Derived from the
 * harness and the lane rather than tabled separately, so a name can never name a path the table
 * above does not hold.
 */
export function defaultInstructionsName(kind: HarnessKind, lane: FleetDefaultLane): string {
  return lane === 'default' ? kind : `${kind}-${lane}`;
}

/** One account a detected harness earns, complete enough to declare without a further decision. */
export interface FleetDefaultAccount {
  readonly kind: HarnessKind;
  readonly lane: FleetDefaultLane;
  readonly mode: AccountMode;
  /** The generated executable's name. Also the home, because the two must never disagree. */
  readonly wrapper: string;
  readonly home: string;
  readonly displayName: string;
  readonly defaultModel: string;
  /** The asset reference this account's instructions come from, as `config.yaml` spells it. */
  readonly instructions: string;
}

/**
 * What a harness is called where a person reads it, rather than where a schema does.
 *
 * EXPORTED because three surfaces put it in front of somebody — a default account's display name, the
 * starter instructions document's own first paragraph, and the boot line that says whose login was
 * copied into which home. Three private copies of one label is how "Claude" and "Claude Code" end up
 * on one screen describing the same thing.
 */
export const HARNESS_LABEL: Readonly<Record<HarnessKind, string>> = { claude: 'Claude', codex: 'Codex' };

/**
 * Every default account for the harnesses this host was found to have, in a stable order.
 *
 * ORDERED BY HARNESS, THEN LANE — the interactive one first — because the order reaches a person: it
 * is the order the boot trail names them in and the order a configuration declares them in, and a
 * set that reordered itself between two runs would make a diff of a scaffolded file unreadable.
 *
 * An EMPTY input yields an empty result rather than a guess. A host with no harness gets no accounts,
 * which is what makes the whole thing safe to run unconditionally at every start: the decision
 * "should anything be created" is answered by what was detected, not by a flag somebody has to set.
 */
export function defaultAccountsFor(kinds: readonly HarnessKind[]): readonly FleetDefaultAccount[] {
  const ordered = (['claude', 'codex'] as const).filter(kind => kinds.includes(kind));
  return ordered.flatMap(kind =>
    FLEET_DEFAULT_LANES.map((lane): FleetDefaultAccount => {
      const wrapper = derivedWrapperName(kind, DEFAULT_ACCOUNT_NAME, lane);
      return {
        kind,
        lane,
        mode: DEFAULT_LANE_MODES[lane],
        wrapper,
        home: wrapper,
        displayName:
          lane === 'default'
            ? `${HARNESS_LABEL[kind]} (default)`
            : `${HARNESS_LABEL[kind]} (default, ${DEFAULT_LANE_MODES[lane]})`,
        defaultModel: FLEET_STARTER_MODELS[kind],
        instructions: DEFAULT_INSTRUCTIONS[kind][lane],
      };
    }),
  );
}

/**
 * The four wrapper names a fully-equipped host publishes, as one sentence for a boot line.
 *
 * Said rather than counted. "2 accounts created" tells a person nothing they can act on; the names
 * are what they type, what `fy fleet ls` prints, and what they search for when they want the files
 * gone.
 */
export function defaultAccountSummary(accounts: readonly FleetDefaultAccount[]): string {
  return accounts.map(account => account.wrapper).join(', ');
}
