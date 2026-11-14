/**
 * `@ferretry/core-vault/contract/testing` (§7.8): Vault's fakes and conformance suites. The real Vault port passes
 * `inputHoldsConformance`, `outputGuardConformance`, `redactionConformance`, `vaultConformance` and
 * `sealedDocumentsConformance`; Terminals and
 * Browsers run their `input.targets` adapters through `inputTargetConformance`. The fakes pass the same suites.
 */
import { describe, expect, test } from 'bun:test';
import {
  type Actor,
  type CellGrid,
  type FerretId,
  type GuardStamp,
  type HoldDecision,
  type InputHolds,
  OP_EFFECTS,
  type Op,
  type OutputGuard,
  type Redaction,
  type RedactionScope,
  type RevealGrant,
  type StatePort,
  type TargetRef,
} from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import type { InputRaise, InputRequestId, InputRequestState } from '../inputs.ts';
import type { ActedPage, ChildEnvironment, PageActNote, VaultApi } from '../port.ts';
import {
  PHONE_APPROVAL_UNAVAILABLE,
  type PhoneApprovalAgentView,
  type PhoneApprovalAsk,
  type PhoneApprovalProvider,
} from '../phone.ts';
import {
  type SealedDocumentDef,
  type SealedDocumentHandle,
  type SealedDocumentsApi,
  type SealedName,
  SealedNameSchema,
} from '../sealed.ts';
import {
  allowedDestination,
  type AuthorizedOutcome,
  type CredentialPlacement,
  optionalSecretReference,
  optionalSecretReferenceOf,
  MINTED_ECHO_MASK,
  MINTED_REPLY_HEADERS,
  type MintedExchangeOutcome,
  type MintedExchangeRequest,
  type OutboundHttpRequest,
  type SecretName,
  type SecretSummary,
  type SecretUseCommand,
  type SecretUseRefusal,
  type SecretUseResult,
  secretMask,
  secretReferencesIn,
} from '../secrets.ts';
import type { InputTargetAdapter, InputTargetFacts, ObserveResult, PushNumberRead } from '../targets.ts';
import { targetRef } from '../targets.ts';

const keyOf = (target: TargetRef): string => `${String(target.kind)}:${target.key}`;

// ─── input holds (§4.7) ───────────────────────────────────────────────────────────────────────────────────────────

/** The state a holds implementation under test can be put in, per target. */
export interface HoldsSubject {
  readonly holds: InputHolds;
  /** A terminal in quarantine after a secret was typed into it. */
  quarantine(target: TargetRef): void;
  /** A page hold; `onHeldDocument` false once the page loaded a new document inside the window. */
  pageHold(target: TargetRef, options: { readonly onHeldDocument: boolean; readonly untilMovedOn?: boolean }): void;
  /** A pending input card; `codeOnly` when every field is a `code`. */
  pendingCard(target: TargetRef, options: { readonly codeOnly: boolean }): void;
  /** An audited "Show anyway" for one target (minted by Vault only). */
  reveal(target: TargetRef): RevealGrant;
}

interface TargetHolds {
  quarantined?: true;
  page?: { readonly onHeldDocument: boolean; readonly untilMovedOn: boolean };
  pending?: { readonly codeOnly: boolean };
}

const RANK = { allow: 0, 'allow-masked': 1, refused: 2 } as const;
const rankOf = (decision: HoldDecision): number => (typeof decision === 'string' ? RANK[decision] : RANK.refused);

/**
 * An in-memory `InputHolds` implementing §4.7's rules in effect terms: holds refuse by effect, never by a list of
 * tools, and when several rows match the most restrictive answer wins (refused over allow-masked over allow).
 */
export class FakeInputHolds implements InputHolds, HoldsSubject {
  readonly holds: InputHolds = this;
  readonly #targets = new Map<string, TargetHolds>();
  readonly #reveals = new Set<RevealGrant>();

  #at(target: TargetRef): TargetHolds {
    const key = keyOf(target);
    let holds = this.#targets.get(key);
    if (holds === undefined) {
      holds = {};
      this.#targets.set(key, holds);
    }
    return holds;
  }
  quarantine(target: TargetRef): void {
    this.#at(target).quarantined = true;
  }
  pageHold(target: TargetRef, options: { readonly onHeldDocument: boolean; readonly untilMovedOn?: boolean }): void {
    this.#at(target).page = { onHeldDocument: options.onHeldDocument, untilMovedOn: options.untilMovedOn === true };
  }
  pendingCard(target: TargetRef, options: { readonly codeOnly: boolean }): void {
    this.#at(target).pending = { codeOnly: options.codeOnly };
  }
  clear(target: TargetRef): void {
    this.#targets.delete(keyOf(target));
  }
  reveal(target: TargetRef): RevealGrant {
    const grant = { target, until: '2999-01-01T00:00:00.000Z' } as unknown as RevealGrant;
    this.#reveals.add(grant);
    return grant;
  }

  decide(target: TargetRef, op: Op, actor: Actor, reveal?: RevealGrant): HoldDecision {
    if (!Object.hasOwn(OP_EFFECTS, op)) return { refused: 'unknown_op' };
    if (actor === 'owner-input') return 'allow';
    const effects: readonly string[] = OP_EFFECTS[op];
    const reads = effects.includes('reads');
    const writes = effects.includes('writes');
    const pictures = effects.includes('pictures');
    const state = this.#targets.get(keyOf(target)) ?? {};
    const answers: HoldDecision[] = ['allow'];

    // rows 1, 2 and 5: a pending card refuses writes; a code-only card lets `keys` and `type` through (I32).
    if (state.pending !== undefined && writes) {
      const codeTypes = state.pending.codeOnly && (op === 'keys' || op === 'type');
      if (!codeTypes) answers.push({ refused: 'input_pending' });
    }
    // row 3: a quarantined terminal refuses every read for the ferret and owner-tools; a viewer needs a reveal.
    if (state.quarantined === true && (reads || pictures)) {
      const revealed =
        actor === 'owner-viewer' &&
        reveal !== undefined &&
        this.#reveals.has(reveal) &&
        keyOf((reveal as unknown as { target: TargetRef }).target) === keyOf(target);
      if (!revealed) answers.push({ refused: 'quarantined' });
    }
    // row 4: a page hold refuses pictures for the window and reads while the held document shows; masks after.
    if (state.page !== undefined) {
      if (pictures && !(state.page.untilMovedOn && !state.page.onHeldDocument)) answers.push({ refused: 'held' });
      if (reads) answers.push(state.page.onHeldDocument ? { refused: 'held' } : 'allow-masked');
    }
    return answers.reduce((worst, next) => (rankOf(next) > rankOf(worst) ? next : worst));
  }
}

const refused = (decision: HoldDecision): boolean => typeof decision === 'object';

/**
 * The question the act runner asks of the holds: `prepare` when they have one (a fresh read of what a page shows), then
 * `decide` with nothing between them. A conformance case asks it the same way for every implementation.
 */
async function ask(
  holds: InputHolds & { prepare?(target: TargetRef, op: Op, actor: Actor): Promise<void> },
  target: TargetRef,
  op: Op,
  actor: Actor,
  reveal?: RevealGrant,
): Promise<HoldDecision> {
  await holds.prepare?.(target, op, actor);
  return holds.decide(target, op, actor, reveal);
}

/** §4.7's rule table and worked cases, run against an `InputHolds` (the tool conformance suite adds the tool side). */
export function inputHoldsConformance(name: string, make: () => HoldsSubject): void {
  const pane = targetRef('terminal', '%1');
  const page = targetRef('page', 'p1');
  describe(`input holds conformance: ${name}`, () => {
    test('a target with no hold allows every op for the ferret', async () => {
      const subject = make();
      for (const op of Object.keys(OP_EFFECTS) as Op[])
        expect(await ask(subject.holds, page, op, 'ferret')).toBe('allow');
    });
    test('an op not in OP_EFFECTS is refused', async () => {
      expect(await ask(make().holds, page, 'teleport' as Op, 'ferret')).toEqual({ refused: 'unknown_op' });
    });
    test('a pending card with a non-code field refuses every ferret write, allows reads (I52)', async () => {
      const subject = make();
      subject.pendingCard(page, { codeOnly: false });
      for (const op of ['keys', 'type', 'press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
        expect(refused(await ask(subject.holds, page, op, 'ferret'))).toBe(true);
      expect(await ask(subject.holds, page, 'read', 'ferret')).toBe('allow');
      expect(await ask(subject.holds, page, 'type', 'owner-input')).toBe('allow');
    });
    test('a pending card with a non-code field refuses the owner’s tools, the warden and the viewer too — only the owner’s own input passes (I119)', async () => {
      const subject = make();
      subject.pendingCard(page, { codeOnly: false });
      for (const actor of ['owner-tools', 'warden', 'owner-viewer'] as const)
        for (const op of ['keys', 'type', 'press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
          expect(await ask(subject.holds, page, op, actor)).toEqual({ refused: 'input_pending' });
      for (const actor of ['owner-tools', 'warden'] as const)
        expect(await ask(subject.holds, page, 'read', actor)).toBe('allow');
      for (const op of ['keys', 'type', 'press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
        expect(await ask(subject.holds, page, op, 'owner-input')).toBe('allow');
    });
    test('a code-only card lets terminal_send and browser_type through, and only those (I32)', async () => {
      const subject = make();
      subject.pendingCard(page, { codeOnly: true });
      expect(await ask(subject.holds, page, 'type', 'ferret')).toBe('allow');
      expect(await ask(subject.holds, page, 'keys', 'ferret')).toBe('allow');
      for (const op of ['press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
        expect(refused(await ask(subject.holds, page, op, 'ferret'))).toBe(true);
    });
    test('a quarantined terminal refuses reads for the ferret and owner-tools, still takes keys (I72)', async () => {
      const subject = make();
      subject.quarantine(pane);
      expect(await ask(subject.holds, pane, 'read', 'ferret')).toEqual({ refused: 'quarantined' });
      expect(await ask(subject.holds, pane, 'wait', 'owner-tools')).toEqual({ refused: 'quarantined' });
      expect(await ask(subject.holds, pane, 'keys', 'ferret')).toBe('allow');
    });
    test('the viewer stream of a quarantined terminal needs an audited reveal (I77)', async () => {
      const subject = make();
      subject.quarantine(pane);
      expect(refused(await ask(subject.holds, pane, 'stream', 'owner-viewer'))).toBe(true);
      expect(await ask(subject.holds, pane, 'stream', 'owner-viewer', subject.reveal(pane))).toBe('allow');
    });
    test('a page hold on the held document refuses reads, script and pictures; writes are allowed (I117)', async () => {
      const subject = make();
      subject.pageHold(page, { onHeldDocument: true });
      for (const op of ['read', 'wait', 'script', 'picture', 'stream'] as const)
        expect(refused(await ask(subject.holds, page, op, 'ferret'))).toBe(true);
      expect(refused(await ask(subject.holds, page, 'read', 'owner-tools'))).toBe(true);
      for (const op of ['type', 'press', 'fill', 'navigate', 'open', 'close'] as const)
        expect(await ask(subject.holds, page, op, 'ferret')).toBe('allow');
    });
    test('after a new document reads are masked, pictures still refused (except until-moved-on) (I116)', async () => {
      const subject = make();
      subject.pageHold(page, { onHeldDocument: false });
      expect(await ask(subject.holds, page, 'read', 'ferret')).toBe('allow-masked');
      expect(await ask(subject.holds, page, 'script', 'ferret')).toBe('allow-masked');
      expect(refused(await ask(subject.holds, page, 'picture', 'ferret'))).toBe(true);
      const moved = make();
      moved.pageHold(page, { onHeldDocument: false, untilMovedOn: true });
      expect(await ask(moved.holds, page, 'picture', 'ferret')).toBe('allow');
    });
    test('worked cases: rows that match together answer the most restrictive', async () => {
      const a = make();
      a.pendingCard(page, { codeOnly: true });
      a.pageHold(page, { onHeldDocument: true });
      expect(await ask(a.holds, page, 'type', 'ferret')).toBe('allow'); // rows 2 and 4: type has no reads
      expect(refused(await ask(a.holds, page, 'read', 'ferret'))).toBe(true); // rows 2 and 4
      const b = make();
      b.pendingCard(pane, { codeOnly: true });
      b.quarantine(pane);
      expect(await ask(b.holds, pane, 'keys', 'ferret')).toBe('allow'); // rows 2 and 3
      expect(refused(await ask(b.holds, pane, 'read', 'ferret'))).toBe(true);
      const c = make();
      c.pendingCard(page, { codeOnly: false });
      expect(refused(await ask(c.holds, page, 'type', 'ferret'))).toBe(true); // rows 1 and 5
    });
  });
}

// ─── output guard ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface OutputGuardSubject {
  readonly guard: OutputGuard;
  beginHold(target: TargetRef): void;
}

/** A guard with one generation per target; a stamp with no targets moves with any hold. Holds no secret. */
export class FakeOutputGuard implements OutputGuard, OutputGuardSubject {
  readonly guard: OutputGuard = this;
  #generation = 0;
  readonly #changed = new Map<string, number>();
  beginHold(target: TargetRef): void {
    this.#generation += 1;
    this.#changed.set(keyOf(target), this.#generation);
  }
  stamp(targets: readonly TargetRef[] = []): GuardStamp {
    return { generation: this.#generation, targets };
  }
  stillShowable(stamp: GuardStamp): boolean {
    if (stamp.targets.length === 0) return stamp.generation === this.#generation;
    return stamp.targets.every(target => (this.#changed.get(keyOf(target)) ?? 0) <= stamp.generation);
  }
}

export function outputGuardConformance(name: string, make: () => OutputGuardSubject): void {
  const page = targetRef('page', 'p1');
  const other = targetRef('page', 'p2');
  describe(`output guard conformance: ${name}`, () => {
    test('a stamp is showable until a hold begins on its target', async () => {
      const subject = make();
      const stamp = subject.guard.stamp([page]);
      expect(subject.guard.stillShowable(stamp)).toBe(true);
      subject.beginHold(page);
      expect(subject.guard.stillShowable(stamp)).toBe(false);
    });
    test('a hold on another target leaves a targeted stamp showable', async () => {
      const subject = make();
      const stamp = subject.guard.stamp([page]);
      subject.beginHold(other);
      expect(subject.guard.stillShowable(stamp)).toBe(true);
    });
    test('stillShowable is synchronous', async () => {
      const subject = make();
      expect(typeof subject.guard.stillShowable(subject.guard.stamp())).toBe('boolean');
    });
  });
}

// ─── redaction ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Read-scoped masking over a fixed set of values; counts how often the values were opened. */
export class FakeRedaction implements Redaction {
  opens = 0;
  constructor(private readonly values: ReadonlyMap<SecretName, string>) {}

  async read<T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T> {
    this.opens += 1;
    const values = [...this.values].sort((a, b) => b[1].length - a[1].length);
    const ranges = (text: string): boolean[] => {
      const masked = new Array<boolean>(text.length).fill(false);
      for (const [, value] of values)
        for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1))
          for (let i = at; i < at + value.length; i += 1) masked[i] = true;
      return masked;
    };
    const scope: RedactionScope = {
      text: s => values.reduce((out, [secret, value]) => out.split(value).join(secretMask(secret)), s),
      cells: (grid: CellGrid): CellGrid => {
        const rows = grid.rows.map(row => {
          const masked = ranges(row.join(''));
          let at = 0;
          return row.map(cell => {
            const hide = [...cell].some((_, i) => masked[at + i] === true);
            at += cell.length;
            return hide ? '*'.repeat(cell.length) : cell;
          });
        });
        return { columns: grid.columns, rows };
      },
      lines: lines => {
        const masked = ranges(lines.join(''));
        let at = 0;
        return lines.map(line => {
          // UTF-16 units, as Vault's own starring walks them.
          let out = '';
          for (let i = 0; i < line.length; i++) out += masked[at + i] === true ? '*' : line.charAt(i);
          at += line.length;
          return out;
        });
      },
    };
    return await fn(scope);
  }
}

export interface RedactionSubject {
  readonly redaction: Redaction;
  /** A value the subject holds under `name`. */
  readonly value: string;
  readonly name: SecretName;
}

export function redactionConformance(name: string, make: () => RedactionSubject | Promise<RedactionSubject>): void {
  describe(`redaction conformance: ${name}`, () => {
    test('text loses the value', async () => {
      const subject = await make();
      const out = await subject.redaction.read(scope => scope.text(`token=${subject.value}.`));
      expect(out.includes(subject.value)).toBe(false);
    });
    test('cells are masked same-width, exactly the matched cells (I105)', async () => {
      const subject = await make();
      const cells = ['a', ...subject.value.split(''), 'z'];
      const grid = await subject.redaction.read(scope => scope.cells({ columns: cells.length, rows: [cells] }));
      const row = grid.rows[0] ?? [];
      expect(row).toHaveLength(cells.length);
      expect(row[0]).toBe('a');
      expect(row[row.length - 1]).toBe('z');
      expect(row.slice(1, -1).every(cell => /^\*+$/u.test(cell))).toBe(true);
    });
    test('a value wrapped across rows is masked in each row (I106)', async () => {
      const subject = await make();
      const half = Math.floor(subject.value.length / 2);
      const lines = await subject.redaction.read(scope =>
        scope.lines([`x${subject.value.slice(0, half)}`, `${subject.value.slice(half)}y`]),
      );
      expect(lines.join('').includes(subject.value)).toBe(false);
      expect(lines[0]?.startsWith('x')).toBe(true);
      expect(lines[1]?.endsWith('y')).toBe(true);
    });
    test('read answers what fn returns', async () => {
      const subject = await make();
      expect(await subject.redaction.read(() => 42)).toBe(42);
    });
  });
}

// ─── the vault port ───────────────────────────────────────────────────────────────────────────────────────────────

const childValues = new WeakMap<ChildEnvironment, Readonly<Record<string, string>>>();

/** TEST ONLY: what a fake runner would put in its child's environment. The real Vault offers nothing like it. */
export function fakeChildEnvironmentValues(env: ChildEnvironment): Readonly<Record<string, string>> | undefined {
  return childValues.get(env);
}

/** What a fake `run` child prints, given its resolved environment. */
export type FakeChild = (
  command: SecretUseCommand,
  env: Readonly<Record<string, string>>,
) => { stdout: string; stderr: string };

/** A fake transport: what came back from a request, given the headers it was sent with. */
export type FakeTransport = (request: OutboundHttpRequest) => AuthorizedOutcome;

/** An in-memory Vault port: values held privately, names out, masked output, the same refusals as today. */
export class FakeVault implements VaultApi {
  readonly #values = new Map<SecretName, { value: string; createdAt: string; updatedAt: string }>();
  /** Every page act Browsers told (`pageActed`), and the page it was placed on once the call ended (`null`: none). */
  readonly pageActs: { ferret: FerretId; script: boolean; placed?: ActedPage | null }[] = [];
  /** Every takeover Browsers told (`pageTakenOver`): the ferret and the keys (name and id) of the page. */
  readonly pageTakeovers: { ferret: FerretId; keys: readonly string[] }[] = [];
  /** Every host a page script was told to have run on (`undefined`: one that could not be read). */
  readonly scriptedHosts: (string | undefined)[] = [];
  /** Page scripts running now (`scriptRunning` not yet ended). */
  scriptsRunning = 0;
  readonly #inputs = new Map<InputRequestId, InputRequestState>();
  #nextInput = 0;
  /** The names a PLUGIN wrote with `put` (what the real Vault's mint ledger records); `plant` writes one that is not. */
  readonly #minted = new Set<SecretName>();
  /** What a minted exchange reaches: the server's reply to a request that carries the credential. Unset: unreachable. */
  mintedServer: ((request: MintedExchangeRequest) => Response | Promise<Response>) | undefined;
  /** Every request a minted exchange sent, headers as the server saw them (the credential is in them: a fake's own view). */
  readonly mintedSent: MintedExchangeRequest[] = [];

  constructor(
    private readonly child: FakeChild = command => ({ stdout: command.command.join(' '), stderr: '' }),
    private readonly transport: FakeTransport = () => ({ kind: 'completion', payload: {} }),
  ) {}

  async pageTakenOver(ferret: FerretId, keys: readonly string[]): Promise<void> {
    this.pageTakeovers.push({ ferret, keys });
  }
  pageActed(ferret: FerretId, script: boolean): PageActNote {
    const act: { ferret: FerretId; script: boolean; placed?: ActedPage | null } = { ferret, script };
    this.pageActs.push(act);
    return {
      placed: page => {
        act.placed = page ?? null;
      },
    };
  }
  scriptRunning(): () => void {
    this.scriptsRunning += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.scriptsRunning -= 1;
    };
  }
  scriptedOn(host: string | undefined): void {
    this.scriptedHosts.push(host);
  }
  /**
   * APPROVE ON YOUR PHONE (the twin of the real Vault's members): what the fake's page and terminal show, what it
   * says was steered, and the service it hands a raise to. All unset by default, and an unset provider refuses the
   * way the real Vault does while nothing provides `input.phone-approval`.
   */
  pushNumberRead: { readonly pageId: string; readonly read: PushNumberRead } | undefined;
  terminalObserved: ObserveResult = { ok: false, reason: 'unsupported' };
  steered = false;
  phoneApprovals: PhoneApprovalProvider | undefined;
  /** Every `tainted` question asked, for a test that checks which surface and instant were named. */
  readonly taintedAsked: { ferret: FerretId; kind: 'browser' | 'terminal'; since: number }[] = [];
  async pushNumber(
    _ferret: FerretId,
    _key: string,
  ): Promise<{ readonly pageId: string; readonly read: PushNumberRead } | undefined> {
    return this.pushNumberRead;
  }
  async observeTerminal(_ferret: FerretId, _key: string): Promise<ObserveResult> {
    return this.terminalObserved;
  }
  tainted(ferret: FerretId, kind: 'browser' | 'terminal', since: number): boolean {
    this.taintedAsked.push({ ferret, kind, since });
    return this.steered;
  }
  async raisePhoneApproval(ferret: FerretId, ask: PhoneApprovalAsk): Promise<Result<PhoneApprovalAgentView, string>> {
    return this.phoneApprovals === undefined
      ? err(PHONE_APPROVAL_UNAVAILABLE)
      : await this.phoneApprovals.raise(ferret, ask);
  }
  async names(): Promise<readonly SecretSummary[]> {
    return [...this.#values].map(
      ([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }) as SecretSummary,
    );
  }
  async put(name: SecretName, value: string): Promise<void> {
    const at = '2026-11-07T12:00:00.000Z';
    this.#values.set(name, { value, createdAt: this.#values.get(name)?.createdAt ?? at, updatedAt: at });
    this.#minted.add(name);
  }
  /** A value somebody OTHER than the plugin put (the owner's): held, usable by name, but never the plugin's mint. */
  plant(name: SecretName, value: string): void {
    const at = '2026-11-07T12:00:00.000Z';
    this.#values.set(name, { value, createdAt: at, updatedAt: at });
    this.#minted.delete(name);
  }
  /** The real Vault's minted exchange in a fake: refused unless the plugin put the value; the reply has the value masked. */
  async fetchMinted(
    name: SecretName,
    request: MintedExchangeRequest,
    placement: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' },
  ): Promise<MintedExchangeOutcome> {
    if (!this.#minted.has(name) || this.mintedServer === undefined) return { kind: 'refused' };
    if (Object.keys(request.headers).some(header => header.toLowerCase() === placement.header.toLowerCase()))
      return { kind: 'refused' };
    const value = this.#values.get(name)?.value;
    if (value === undefined) return { kind: 'secret_missing' };
    const credential = placement.scheme === undefined ? value : `${placement.scheme} ${value}`;
    const sent = { ...request, headers: { ...request.headers, [placement.header]: credential } };
    this.mintedSent.push(sent);
    const reply = await this.mintedServer(sent);
    const mask = (raw: string): string => raw.split(value).join(MINTED_ECHO_MASK);
    const headers: Record<string, string> = {};
    for (const name of MINTED_REPLY_HEADERS) {
      const held = reply.headers.get(name);
      if (held !== null) headers[name] = mask(held);
    }
    // The twin keeps the real shape (status, allowlisted headers, a text body or complete events) with a literal mask: the
    // real Vault's every-spelling masking is proved in the Vault's own tests.
    const raw = mask(await reply.text());
    const events = (reply.headers.get('content-type') ?? '').startsWith('text/event-stream');
    return {
      kind: 'response',
      status: reply.status,
      statusText: mask(reply.statusText),
      headers,
      body: events
        ? {
            kind: 'events',
            events: new ReadableStream<string>({
              start(controller) {
                for (const block of raw.split(/\n\n/u).filter(part => part.trim() !== ''))
                  controller.enqueue(`${block}\n\n`);
                controller.close();
              },
            }),
          }
        : { kind: 'text', text: raw },
    };
  }
  async has(name: SecretName): Promise<boolean> {
    return this.#values.has(name);
  }
  async remove(name: SecretName): Promise<boolean> {
    return this.#values.delete(name);
  }
  #mask(text: string): string {
    let out = text;
    for (const [name, entry] of [...this.#values].sort((a, b) => b[1].value.length - a[1].value.length))
      out = out.split(entry.value).join(secretMask(name));
    return out;
  }
  /** `optional`: a ferret child's environment, where a whole-value `${secret?:NAME}` not held is left out. */
  #resolve(
    env: Readonly<Record<string, string>>,
    optional = false,
  ): Result<Record<string, string>, readonly SecretName[]> {
    const unknown: SecretName[] = [];
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(env)) {
      const named = optional ? optionalSecretReferenceOf(raw) : undefined;
      if (named !== undefined) {
        const held = this.#values.get(named)?.value;
        if (held !== undefined) out[key] = held;
        continue;
      }
      for (const name of secretReferencesIn(raw)) if (!this.#values.has(name)) unknown.push(name);
      out[key] = raw.replace(
        /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/gu,
        (_, name: string) => this.#values.get(name)?.value ?? '',
      );
    }
    return unknown.length > 0 ? err(unknown) : ok(out);
  }
  async run(command: SecretUseCommand): Promise<Result<SecretUseResult, SecretUseRefusal>> {
    if (!command.cwd.startsWith('/')) return err('invalid_cwd');
    if (command.secrets.some(name => !this.#values.has(name))) return err('unknown_secret');
    const env: Record<string, string> = {};
    for (const name of command.secrets) env[name] = this.#values.get(name)?.value ?? '';
    const resolved = this.#resolve(command.env);
    if (!resolved.ok) return err('unknown_secret');
    const printed = this.child(command, { ...env, ...resolved.value });
    return ok({
      outcome: 'exited',
      exitCode: 0,
      stdout: this.#mask(printed.stdout),
      stderr: this.#mask(printed.stderr),
      truncated: false,
      used: command.secrets,
    });
  }
  async authorizeFetch(
    name: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' },
  ): Promise<AuthorizedOutcome> {
    if (!allowedDestination(request.url, hostAllowlist)) return { kind: 'refused' };
    if (Object.keys(request.headers).some(header => header.toLowerCase() === placement.header.toLowerCase()))
      return { kind: 'refused' };
    const value = this.#values.get(name)?.value;
    if (value === undefined) return { kind: 'secret_missing' };
    const credential = placement.scheme === undefined ? value : `${placement.scheme} ${value}`;
    const outcome = this.transport({ ...request, headers: { ...request.headers, [placement.header]: credential } });
    if (outcome.kind === 'completion' && JSON.stringify(outcome.payload).includes(value)) return { kind: 'unreadable' };
    return outcome;
  }
  async childEnvironment(
    _ferret: FerretId,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> {
    const resolved = this.#resolve(env, true);
    if (!resolved.ok) return err({ unknown: resolved.error });
    const names = Object.keys(resolved.value);
    const handle = Object.freeze({
      names,
      toJSON: () => ({ names }),
    }) as unknown as ChildEnvironment;
    childValues.set(handle, Object.freeze(resolved.value));
    return ok(handle);
  }
  /** The fake narrows nothing (the real Vault's reach is tested against the real Vault): a runtime's check is a plain environment. */
  async childEnvironmentForRuntime(
    _runtime: string,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> {
    return await this.childEnvironment('runtime-check' as FerretId, env);
  }
  async raiseInput(_ferret: FerretId, _raise: InputRaise): Promise<Result<InputRequestId, string>> {
    this.#nextInput += 1;
    const id = this.#nextInput.toString(16).padStart(32, '0') as InputRequestId;
    this.#inputs.set(id, 'pending');
    return ok(id);
  }
  async cancelInput(_ferret: FerretId, id: InputRequestId): Promise<void> {
    if (this.#inputs.get(id) === 'pending') this.#inputs.set(id, 'cancelled');
  }
  async inputState(id: InputRequestId): Promise<InputRequestState | undefined> {
    return this.#inputs.get(id);
  }
}

export interface VaultSubject {
  readonly vault: VaultApi;
}

const GETTER_NAMES = /^(get|value|values|read|reveal|open|secret|plaintext)/iu;

/** The "use, never read" suite: no getter, masked output, the outbound refusals, and a launch env that refuses unknowns. */
export function vaultConformance(name: string, make: () => VaultSubject | Promise<VaultSubject>): void {
  const VALUE = 'sk-test-0123456789abcdef';
  const NAME = 'API_KEY' as SecretName;
  const request: OutboundHttpRequest = {
    method: 'GET',
    url: 'https://api.example.test/v1/me',
    headers: {},
    timeoutMs: 1_000,
    maxResponseBytes: 1_000,
  };
  describe(`vault conformance: ${name}`, () => {
    test('the port has no getter', async () => {
      const { vault } = await make();
      const methods = new Set<string>();
      for (let o: object | null = vault; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o))
        for (const key of Object.getOwnPropertyNames(o)) methods.add(key);
      for (const method of methods) if (method !== 'constructor') expect(GETTER_NAMES.test(method)).toBe(false);
    });
    test('names list never carries a value', async () => {
      const { vault } = await make();
      await vault.put(NAME, VALUE);
      expect(JSON.stringify(await vault.names()).includes(VALUE)).toBe(false);
    });
    test('a run that prints the value returns it masked (S14)', async () => {
      const { vault } = await make();
      await vault.put(NAME, VALUE);
      const result = await vault.run({
        command: ['sh', '-c', 'echo $API_KEY'],
        cwd: '/tmp',
        secrets: [NAME],
        env: {},
        timeoutMs: 1_000,
      });
      expect(result.ok && result.value.stdout.includes(VALUE)).toBe(false);
      expect(result.ok && result.value.used).toEqual([NAME]);
    });
    test('a relative cwd and an unknown secret are refused', async () => {
      const { vault } = await make();
      expect(await vault.run({ command: ['true'], cwd: 'rel', secrets: [], env: {}, timeoutMs: 1_000 })).toEqual(
        err('invalid_cwd'),
      );
      expect(
        await vault.run({ command: ['true'], cwd: '/tmp', secrets: ['NOPE' as SecretName], env: {}, timeoutMs: 1_000 }),
      ).toEqual(err('unknown_secret'));
    });
    test('authorizeFetch sends only to an allowlisted https host and never over a caller credential', async () => {
      const { vault } = await make();
      await vault.put(NAME, VALUE);
      expect(await vault.authorizeFetch(NAME, ['other.example.test'], request)).toEqual({ kind: 'refused' });
      expect(
        await vault.authorizeFetch(NAME, ['api.example.test'], { ...request, url: 'http://api.example.test/' }),
      ).toEqual({
        kind: 'refused',
      });
      expect(
        await vault.authorizeFetch(NAME, ['api.example.test'], {
          ...request,
          headers: { Authorization: 'Bearer mine' },
        }),
      ).toEqual({ kind: 'refused' });
      expect(await vault.authorizeFetch('MISSING' as SecretName, ['api.example.test'], request)).toEqual({
        kind: 'secret_missing',
      });
    });
    test('a child environment refuses an unknown secret and serialises as names only', async () => {
      const { vault } = await make();
      await vault.put(NAME, VALUE);
      const missing = await vault.childEnvironment('f1' as FerretId, { X: '${secret:NOPE}' });
      expect(missing.ok).toBe(false);
      const env = await vault.childEnvironment('f1' as FerretId, { TOKEN: 'Bearer ${secret:API_KEY}' });
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.value.names).toEqual(['TOKEN']);
        expect(JSON.stringify(env.value).includes(VALUE)).toBe(false);
      }
    });
    test('an optional reference is set when held and left unset when not; a plain reference still refuses', async () => {
      const { vault } = await make();
      await vault.put(NAME, VALUE);
      const env = await vault.childEnvironment('f1' as FerretId, {
        HELD: optionalSecretReference(NAME),
        GONE: optionalSecretReference('SIGNED_OUT' as SecretName),
      });
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect([...env.value.names].sort()).toEqual(['HELD']);
        expect(JSON.stringify(env.value).includes(VALUE)).toBe(false);
      }
      const plain = await vault.childEnvironment('f1' as FerretId, {
        GONE: optionalSecretReference('SIGNED_OUT' as SecretName),
        X: '${secret:NOPE}',
      });
      expect(plain.ok).toBe(false);
      if (!plain.ok) expect(plain.error.unknown).toEqual(['NOPE']);
    });
  });
}

// ─── input targets ────────────────────────────────────────────────────────────────────────────────────────────────

/** A target adapter over nothing: every target is gone. A starting point for a tool's own fake. */
export const goneTargetAdapter: InputTargetAdapter = {
  masking: 'text',
  observe: async () => ({ ok: false, reason: 'target_gone' }),
  type: async () => 'target_gone',
};

/** What a write is bound to (today's `InputTargetPort.type`, input-requests/ports.ts:143): any change types nothing. */
export const TERMINAL_BINDINGS = ['pane', 'foreground', 'echo', 'prompt'] as const;
export const PAGE_BINDINGS = ['document', 'element'] as const;
export type InputTargetBinding = (typeof TERMINAL_BINDINGS)[number] | (typeof PAGE_BINDINGS)[number];

/** A target the adapter can see and type into now, with a recorder of the writes that reached it. */
export interface LiveInputTarget {
  /** Its key; it has one field, `value`. */
  readonly key: string;
  /** Changes one binding of the live target, as the world would between the card and the write. */
  change(binding: InputTargetBinding): void | Promise<void>;
  /** Writes that reached the live target since the subject was made. */
  writes(): number;
}

export interface InputTargetSubject {
  readonly adapter: InputTargetAdapter;
  /** A target key the adapter has never seen. */
  readonly unknownKey: string;
  readonly kind: 'terminal' | 'page';
  readonly live: LiveInputTarget;
}

/** One live-target case: the card's target unchanged, one binding changed, or a grant fill told not to go ahead. */
export type LiveTargetCase = 'unchanged' | InputTargetBinding | 'proceed-refused';

export const liveTargetCases = (kind: 'terminal' | 'page'): readonly LiveTargetCase[] => [
  'unchanged',
  ...(kind === 'terminal' ? TERMINAL_BINDINGS : PAGE_BINDINGS),
  'proceed-refused',
];

/**
 * Runs one live-target case and says what went wrong, or `undefined` when the adapter behaved: an unchanged target is
 * typed into exactly once; a changed binding or a refused `proceed` types nothing and answers neither `typed` nor
 * `uncertain`.
 */
export async function liveTargetFailure(
  subject: InputTargetSubject,
  which: LiveTargetCase,
): Promise<string | undefined> {
  const { adapter, kind, live } = subject;
  const target = { kind, key: live.key } as const;
  const observed = await adapter.observe('f1' as FerretId, target, [{ id: 'value' }]);
  if (!observed.ok) return `the live ${kind} could not be observed (${observed.reason})`;
  if (which !== 'unchanged' && which !== 'proceed-refused') await live.change(which);
  const typed = await adapter.type(
    'f1' as FerretId,
    target,
    [{ field: 'value', text: 'synthetic-value' }],
    false,
    observed.facts,
    which === 'proceed-refused' ? { proceed: () => false } : undefined,
  );
  const writes = live.writes();
  if (which === 'unchanged')
    return typed === 'typed' && writes === 1
      ? undefined
      : `an unchanged ${kind} answered ${typed} and was written ${writes} times`;
  return typed !== 'typed' && typed !== 'uncertain' && writes === 0
    ? undefined
    : `a ${kind} with ${which} answered ${typed} and was written ${writes} times`;
}

/** A terminal or page with one live target: observes it, checks every binding before a write, records each write. */
export class FakeInputTarget implements InputTargetAdapter {
  readonly masking = 'text' as const;
  #facts: InputTargetFacts;
  #writes = 0;

  constructor(
    readonly kind: 'terminal' | 'page',
    readonly key = 'live',
  ) {
    this.#facts =
      kind === 'terminal'
        ? {
            kind: 'terminal',
            paneProof: { paneId: '%1', pid: 100 },
            foreground: { pid: 200, pgid: 200, comm: 'sudo', argv: 'sudo true' },
            echo: 'off',
            cursorRow: 3,
            promptLine: 'Password:',
            promptLineDigest: 'a'.repeat(64),
            recognisedConsumer: true,
          }
        : {
            kind: 'page',
            pageId: key,
            origin: 'https://example.test',
            secure: true,
            navigationId: 'n1',
            fields: [
              {
                fieldId: 'value',
                frameOrigin: 'https://example.test',
                frameId: 'frame-1',
                backendNodeId: 10,
                field: { tag: 'input', type: 'password' },
                box: { x: 0, y: 0, w: 100, h: 20 },
                visible: true,
              },
            ],
          };
  }

  /** The `live` fixture for this adapter. */
  get live(): LiveInputTarget {
    return { key: this.key, change: binding => this.change(binding), writes: () => this.#writes };
  }

  change(binding: InputTargetBinding): void {
    const facts = this.#facts;
    if (facts.kind === 'terminal') {
      if (binding === 'pane') this.#facts = { ...facts, paneProof: { paneId: '%2', pid: 101 } };
      if (binding === 'foreground')
        this.#facts = { ...facts, foreground: { pid: 300, pgid: 300, comm: 'bash', argv: 'bash' } };
      if (binding === 'echo') this.#facts = { ...facts, echo: 'on' };
      if (binding === 'prompt') this.#facts = { ...facts, promptLine: '$', promptLineDigest: 'b'.repeat(64) };
    } else if (facts.kind === 'page') {
      if (binding === 'document') this.#facts = { ...facts, navigationId: 'n2' };
      if (binding === 'element')
        this.#facts = {
          ...facts,
          fields: facts.fields.map(field => ({ ...field, backendNodeId: field.backendNodeId + 1 })),
        };
    }
  }

  async observe(_ferret: FerretId, target: { readonly kind: string; readonly key: string }) {
    return target.kind === this.kind && target.key === this.key
      ? { ok: true as const, facts: this.#facts }
      : { ok: false as const, reason: 'target_gone' as const };
  }

  async type(
    _ferret: FerretId,
    target: { readonly kind: string; readonly key: string },
    _values: readonly { readonly field: string; readonly text: string }[],
    _submit: boolean,
    expected: InputTargetFacts,
    options?: { readonly proceed?: () => boolean },
  ) {
    if (target.kind !== this.kind || target.key !== this.key) return 'target_gone' as const;
    if (!sameBindings(this.#facts, expected)) return 'target_changed' as const;
    if (options?.proceed !== undefined && !options.proceed()) return 'target_changed' as const;
    this.#writes += 1;
    return 'typed' as const;
  }
}

/** Whether every binding of `now` matches what the card showed: pane, foreground, echo, prompt; document, element. */
function sameBindings(now: InputTargetFacts, expected: InputTargetFacts): boolean {
  if (now.kind === 'terminal' && expected.kind === 'terminal')
    return (
      JSON.stringify(now.paneProof) === JSON.stringify(expected.paneProof) &&
      JSON.stringify(now.foreground) === JSON.stringify(expected.foreground) &&
      now.echo === expected.echo &&
      now.cursorRow === expected.cursorRow &&
      now.promptLineDigest === expected.promptLineDigest
    );
  if (now.kind === 'page' && expected.kind === 'page')
    return (
      now.pageId === expected.pageId &&
      now.origin === expected.origin &&
      now.navigationId === expected.navigationId &&
      now.fields.length === expected.fields.length &&
      now.fields.every((field, at) => {
        const was = expected.fields[at];
        return (
          was !== undefined &&
          field.fieldId === was.fieldId &&
          field.frameId === was.frameId &&
          field.backendNodeId === was.backendNodeId
        );
      })
    );
  return false;
}

/**
 * What every `input.targets` adapter must do with a target that is not there, and with a live one: typed into once
 * while every binding holds, never once a binding changed (pane, foreground, echo, prompt; document, element) or a
 * grant fill's `proceed` says no. Tools add their own cases.
 */
export function inputTargetConformance(
  name: string,
  make: () => InputTargetSubject | Promise<InputTargetSubject>,
): void {
  describe(`input target conformance: ${name}`, () => {
    test('it declares its masking ability', async () => {
      const { adapter } = await make();
      expect(['text', 'cells', 'pixels']).toContain(adapter.masking);
    });
    test('observing a target that is not there answers target_gone, never facts', async () => {
      const { adapter, unknownKey, kind } = await make();
      const observed = await adapter.observe('f1' as FerretId, { kind, key: unknownKey }, [{ id: 'value' }]);
      expect(observed.ok).toBe(false);
    });
    test('typing into a target that is not there types nothing', async () => {
      const { adapter, unknownKey, kind } = await make();
      const facts: InputTargetFacts =
        kind === 'terminal'
          ? {
              kind: 'terminal',
              paneProof: { paneId: '%999', pid: 1 },
              foreground: { pid: 1, pgid: 1, comm: 'sudo', argv: 'sudo' },
              echo: 'off',
              cursorRow: 0,
              promptLine: 'Password:',
              promptLineDigest: '0'.repeat(64),
              recognisedConsumer: true,
            }
          : {
              kind: 'page',
              pageId: unknownKey,
              origin: 'https://example.test',
              secure: true,
              navigationId: 'n1',
              fields: [
                {
                  fieldId: 'value',
                  frameOrigin: 'https://example.test',
                  frameId: 'f',
                  backendNodeId: 1,
                  field: { tag: 'input' },
                  box: { x: 0, y: 0, w: 1, h: 1 },
                  visible: true,
                },
              ],
            };
      const typed = await adapter.type(
        'f1' as FerretId,
        { kind, key: unknownKey },
        [{ field: 'value', text: 'x' }],
        false,
        facts,
      );
      expect(typed === 'target_gone' || typed === 'target_changed').toBe(true);
    });
    test('a live target is typed into once while its bindings hold, and never once one changes', async () => {
      const { kind } = await make();
      for (const which of liveTargetCases(kind)) expect(await liveTargetFailure(await make(), which)).toBeUndefined();
    });
  });
}

// ─── sealed documents (contract change C) ─────────────────────────────────────────────────────────────────────────

/**
 * Sealed documents in memory, scoped exactly as the real port is: by the caller's own state port (the kernel's
 * knowledge of the caller), then the document. Nothing is sealed; a test that needs today's bytes uses the real one.
 */
export class FakeSealedDocuments implements SealedDocumentsApi {
  readonly #folders = new WeakMap<StatePort, Map<string, Map<string, Uint8Array>>>();

  open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    const entries = (): Map<string, Uint8Array> => {
      let folder = this.#folders.get(own);
      if (folder === undefined) {
        folder = new Map();
        this.#folders.set(own, folder);
      }
      let held = folder.get(document.state.path);
      if (held === undefined) {
        held = new Map();
        folder.set(document.state.path, held);
      }
      return held;
    };
    const named = (name: SealedName): SealedName => {
      if (!SealedNameSchema.safeParse(name).success) throw new TypeError(`${document.state.path}: not a sealed name`);
      return name;
    };
    return {
      names: async () => [...entries().keys()],
      put: async (name, value) => {
        entries().set(named(name), typeof value === 'string' ? new TextEncoder().encode(value) : value.slice());
      },
      get: async name => {
        const bytes = entries().get(named(name));
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      },
      getBytes: async name => entries().get(named(name))?.slice(),
      delete: async name => entries().delete(named(name)),
    };
  }
}

export interface SealedDocumentsSubject {
  readonly port: SealedDocumentsApi;
  /** The calling plugin's own state port, declaring `document`. */
  readonly mine: StatePort;
  /** Another plugin's state port, declaring a document of the same name and path. */
  readonly theirs: StatePort;
  readonly document: SealedDocumentDef;
}

/** Own round trip, and another plugin's documents unreachable even under the same document and entry names. */
export function sealedDocumentsConformance(
  name: string,
  make: () => SealedDocumentsSubject | Promise<SealedDocumentsSubject>,
): void {
  const VALUE = 'rt-test-0123456789abcdef';
  const ENTRY = 'MCP_DOCS_REFRESH' as SealedName;
  describe(`sealed documents conformance: ${name}`, () => {
    test('names lists exactly this document’s stored names, never values or another plugin’s names', async () => {
      const { port, mine, theirs, document } = await make();
      const own = port.open(mine, document);
      const other = port.open(theirs, document);
      const bytesName = 'lnk_bytes-1' as SealedName;
      const otherName = 'OTHER_PLUGIN_ONLY' as SealedName;
      expect(await own.names()).toEqual([]);
      await other.put(otherName, 'other-plugin-value');
      await own.put(ENTRY, VALUE);
      await own.put(bytesName, new Uint8Array([0, 1, 254, 255]));
      await own.put(ENTRY, `${VALUE}-rotated`);

      const names = await port.open(mine, document).names();
      expect([...names].sort()).toEqual([ENTRY, bytesName].sort());
      expect(names.every(entry => typeof entry === 'string')).toBe(true);
      expect(JSON.stringify(names).includes(VALUE)).toBe(false);
      expect(await other.names()).toEqual([otherName]);

      await own.delete(ENTRY);
      expect(await own.names()).toEqual([bytesName]);
      await own.delete(bytesName);
      expect(await own.names()).toEqual([]);
    });
    test('a plugin puts, gets and deletes its own sealed values', async () => {
      const { port, mine, document } = await make();
      const own = port.open(mine, document);
      await own.put(ENTRY, VALUE);
      await own.put('lnk_bytes-1' as SealedName, new Uint8Array([0, 1, 254, 255]));
      expect(await own.get(ENTRY)).toBe(VALUE);
      expect([...((await own.getBytes('lnk_bytes-1' as SealedName)) ?? [])]).toEqual([0, 1, 254, 255]);
      await own.put(ENTRY, `${VALUE}-rotated`);
      expect(await own.get(ENTRY)).toBe(`${VALUE}-rotated`);
      expect(await own.delete(ENTRY)).toBe(true);
      expect(await own.delete(ENTRY)).toBe(false);
      expect(await own.get(ENTRY)).toBeUndefined();
    });
    test("another plugin's documents cannot be read or deleted, even under the same names", async () => {
      const { port, mine, theirs, document } = await make();
      await port.open(theirs, document).put(ENTRY, VALUE);
      const own = port.open(mine, document);
      expect(await own.get(ENTRY)).toBeUndefined();
      expect(await own.delete(ENTRY)).toBe(false);
      expect(await port.open(theirs, document).get(ENTRY)).toBe(VALUE);
    });
    test('a name outside the grammar is refused', async () => {
      const { port, mine, document } = await make();
      await expect(port.open(mine, document).put('../escape' as SealedName, VALUE)).rejects.toThrow();
    });
  });
}
