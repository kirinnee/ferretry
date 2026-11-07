/**
 * `@ferretry/core-vault/contract/testing` (§7.8): Vault's fakes and conformance suites. The real Vault port passes
 * `inputHoldsConformance`, `outputGuardConformance`, `redactionConformance` and `vaultConformance`; Terminals and
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
  type TargetRef,
} from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import type { InputRaise, InputRequestId, InputRequestState } from '../inputs.ts';
import type { ChildEnvironment, VaultApi } from '../port.ts';
import {
  allowedDestination,
  type AuthorizedOutcome,
  type CredentialPlacement,
  type OutboundHttpRequest,
  type SecretName,
  type SecretSummary,
  type SecretUseCommand,
  type SecretUseRefusal,
  type SecretUseResult,
  secretMask,
  secretReferencesIn,
} from '../secrets.ts';
import type { InputTargetAdapter, InputTargetFacts } from '../targets.ts';
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

/** §4.7's rule table and worked cases, run against an `InputHolds` (the tool conformance suite adds the tool side). */
export function inputHoldsConformance(name: string, make: () => HoldsSubject): void {
  const pane = targetRef('terminal', '%1');
  const page = targetRef('page', 'p1');
  describe(`input holds conformance: ${name}`, () => {
    test('a target with no hold allows every op for the ferret', () => {
      const subject = make();
      for (const op of Object.keys(OP_EFFECTS) as Op[]) expect(subject.holds.decide(page, op, 'ferret')).toBe('allow');
    });
    test('an op not in OP_EFFECTS is refused', () => {
      expect(make().holds.decide(page, 'teleport' as Op, 'ferret')).toEqual({ refused: 'unknown_op' });
    });
    test('a pending card with a non-code field refuses every ferret write, allows reads (I52)', () => {
      const subject = make();
      subject.pendingCard(page, { codeOnly: false });
      for (const op of ['keys', 'type', 'press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
        expect(refused(subject.holds.decide(page, op, 'ferret'))).toBe(true);
      expect(subject.holds.decide(page, 'read', 'ferret')).toBe('allow');
      expect(subject.holds.decide(page, 'type', 'owner-input')).toBe('allow');
    });
    test('a code-only card lets terminal_send and browser_type through, and only those (I32)', () => {
      const subject = make();
      subject.pendingCard(page, { codeOnly: true });
      expect(subject.holds.decide(page, 'type', 'ferret')).toBe('allow');
      expect(subject.holds.decide(page, 'keys', 'ferret')).toBe('allow');
      for (const op of ['press', 'fill', 'script', 'navigate', 'open', 'close'] as const)
        expect(refused(subject.holds.decide(page, op, 'ferret'))).toBe(true);
    });
    test('a quarantined terminal refuses reads for the ferret and owner-tools, still takes keys (I72)', () => {
      const subject = make();
      subject.quarantine(pane);
      expect(subject.holds.decide(pane, 'read', 'ferret')).toEqual({ refused: 'quarantined' });
      expect(subject.holds.decide(pane, 'wait', 'owner-tools')).toEqual({ refused: 'quarantined' });
      expect(subject.holds.decide(pane, 'keys', 'ferret')).toBe('allow');
    });
    test('the viewer stream of a quarantined terminal needs an audited reveal (I77)', () => {
      const subject = make();
      subject.quarantine(pane);
      expect(refused(subject.holds.decide(pane, 'stream', 'owner-viewer'))).toBe(true);
      expect(subject.holds.decide(pane, 'stream', 'owner-viewer', subject.reveal(pane))).toBe('allow');
    });
    test('a page hold on the held document refuses reads, script and pictures; writes are allowed (I117)', () => {
      const subject = make();
      subject.pageHold(page, { onHeldDocument: true });
      for (const op of ['read', 'wait', 'script', 'picture', 'stream'] as const)
        expect(refused(subject.holds.decide(page, op, 'ferret'))).toBe(true);
      expect(refused(subject.holds.decide(page, 'read', 'owner-tools'))).toBe(true);
      for (const op of ['type', 'press', 'fill', 'navigate', 'open', 'close'] as const)
        expect(subject.holds.decide(page, op, 'ferret')).toBe('allow');
    });
    test('after a new document reads are masked, pictures still refused (except until-moved-on) (I116)', () => {
      const subject = make();
      subject.pageHold(page, { onHeldDocument: false });
      expect(subject.holds.decide(page, 'read', 'ferret')).toBe('allow-masked');
      expect(subject.holds.decide(page, 'script', 'ferret')).toBe('allow-masked');
      expect(refused(subject.holds.decide(page, 'picture', 'ferret'))).toBe(true);
      const moved = make();
      moved.pageHold(page, { onHeldDocument: false, untilMovedOn: true });
      expect(moved.holds.decide(page, 'picture', 'ferret')).toBe('allow');
    });
    test('worked cases: rows that match together answer the most restrictive', () => {
      const a = make();
      a.pendingCard(page, { codeOnly: true });
      a.pageHold(page, { onHeldDocument: true });
      expect(a.holds.decide(page, 'type', 'ferret')).toBe('allow'); // rows 2 and 4: type has no reads
      expect(refused(a.holds.decide(page, 'read', 'ferret'))).toBe(true); // rows 2 and 4
      const b = make();
      b.pendingCard(pane, { codeOnly: true });
      b.quarantine(pane);
      expect(b.holds.decide(pane, 'keys', 'ferret')).toBe('allow'); // rows 2 and 3
      expect(refused(b.holds.decide(pane, 'read', 'ferret'))).toBe(true);
      const c = make();
      c.pendingCard(page, { codeOnly: false });
      expect(refused(c.holds.decide(page, 'type', 'ferret'))).toBe(true); // rows 1 and 5
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
    test('a stamp is showable until a hold begins on its target', () => {
      const subject = make();
      const stamp = subject.guard.stamp([page]);
      expect(subject.guard.stillShowable(stamp)).toBe(true);
      subject.beginHold(page);
      expect(subject.guard.stillShowable(stamp)).toBe(false);
    });
    test('a hold on another target leaves a targeted stamp showable', () => {
      const subject = make();
      const stamp = subject.guard.stamp([page]);
      subject.beginHold(other);
      expect(subject.guard.stillShowable(stamp)).toBe(true);
    });
    test('stillShowable is synchronous', () => {
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
          const out = [...line].map((ch, i) => (masked[at + i] === true ? '*' : ch)).join('');
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
  readonly #inputs = new Map<InputRequestId, InputRequestState>();
  #nextInput = 0;

  constructor(
    private readonly child: FakeChild = command => ({ stdout: command.command.join(' '), stderr: '' }),
    private readonly transport: FakeTransport = () => ({ kind: 'completion', payload: {} }),
  ) {}

  async names(): Promise<readonly SecretSummary[]> {
    return [...this.#values].map(
      ([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }) as SecretSummary,
    );
  }
  async put(name: SecretName, value: string): Promise<void> {
    const at = '2026-11-07T12:00:00.000Z';
    this.#values.set(name, { value, createdAt: this.#values.get(name)?.createdAt ?? at, updatedAt: at });
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
  #resolve(env: Readonly<Record<string, string>>): Result<Record<string, string>, readonly SecretName[]> {
    const unknown: SecretName[] = [];
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(env)) {
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
    const resolved = this.#resolve(env);
    if (!resolved.ok) return err({ unknown: resolved.error });
    const handle = Object.freeze({
      names: Object.keys(env),
      toJSON: () => ({ names: Object.keys(env) }),
    }) as unknown as ChildEnvironment;
    childValues.set(handle, Object.freeze(resolved.value));
    return ok(handle);
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
