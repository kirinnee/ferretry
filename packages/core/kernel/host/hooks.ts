import type { Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type {
  ContributeHook,
  Contribution,
  DecideHook,
  HookDecision,
  HookDef,
  ObserveHook,
  ProvideHook,
  TransformHook,
} from '../contract/define.ts';
import { CORE_IDS } from '../contract/ids.ts';
import type { Log } from '../contract/ports.ts';
import type { HookInvoker } from '../manifest/implement.ts';
import type { HookOffer, HookTake, Manifest } from '../manifest/types.ts';

/** Why the hook graph refused a build (§3.5). Each names everyone involved. */
export interface HookRefusal {
  readonly hook: string;
  readonly plugins: readonly string[];
  readonly sentence: string;
}

/** A taker's state: a skeleton or failed taker is a no-op (decide: allow; provide: unavailable). */
export type TakerState = 'live' | 'skeleton' | 'failed';

interface Taker {
  readonly plugin: string;
  readonly take: HookTake;
  /** Position in start order, for the tie-break. */
  readonly rank: number;
  readonly priority: number;
  handler?: unknown;
  state: TakerState;
}

const isCore = (id: string): boolean => (CORE_IDS as readonly string[]).includes(id);

const takeKey = (take: HookTake): string =>
  take.hook.mode === 'provide' && take.key !== undefined ? `${take.hook.name}:${take.key}` : take.hook.name;

/** A deadline the engine waits for; the clock is the kernel's, so the test host drives it. */
export type Deadline = (ms: number) => { readonly promise: Promise<'timeout'>; cancel(): void };

/**
 * The hooks engine (§3.5). Built once from the enabled manifests in start order; halves attach their handlers as they
 * are built. Rules kept from the design:
 *
 * - observe: unordered, after the offerer's write; a failing taker is logged.
 * - decide: priority high first, then start order, then id; the first no wins with its reason; a throw or a timeout is
 *   a no. Only core offers or takes a `securityPath` decide hook.
 * - transform: same order; each sees the previous output; a failing taker refuses the whole operation.
 * - provide: one taker per key; two takers of one key refuse the build naming both; a security-path provide hook
 *   names its allowed takers and the build refuses any other.
 * - contribute: by the item's order, then id; duplicate ids are left out and named; a failing taker's items are left out.
 */
export class HookEngine {
  private readonly offers = new Map<string, { readonly plugin: string; readonly offer: HookOffer }>();
  private readonly takers = new Map<string, Taker[]>();
  private readonly byPluginKey = new Map<string, Taker>();
  /** Plain sentences for `fy doctor`: contribute items left out, takers that failed. */
  readonly notes: string[] = [];

  private constructor(
    private readonly log: Log,
    private readonly deadline: Deadline,
  ) {}

  /** Checks the graph. Refusals name every plugin involved; the caller drops the refused takes' plugins. */
  static plan(
    manifests: readonly Manifest[],
    log: Log,
    deadline: Deadline,
  ): { readonly engine: HookEngine; readonly refusals: readonly HookRefusal[] } {
    const engine = new HookEngine(log, deadline);
    const refusals: HookRefusal[] = [];
    for (const manifest of manifests)
      for (const offer of manifest.hooks?.offers ?? []) {
        const hook = offer.hook;
        if (hook.mode === 'decide' && hook.securityPath && !isCore(manifest.id)) {
          refusals.push({
            hook: hook.name,
            plugins: [manifest.id],
            sentence: `${manifest.id} offers the security-path hook ${hook.name}, which only core may offer.`,
          });
          continue;
        }
        const existing = engine.offers.get(hook.name);
        if (existing !== undefined) {
          refusals.push({
            hook: hook.name,
            plugins: [existing.plugin, manifest.id],
            sentence: `${existing.plugin} and ${manifest.id} both offer the hook ${hook.name}.`,
          });
          continue;
        }
        engine.offers.set(hook.name, { plugin: manifest.id, offer });
      }
    const providedKeys = new Map<string, string>();
    manifests.forEach((manifest, rank) => {
      for (const take of manifest.hooks?.takes ?? []) {
        const hook = take.hook;
        const refuse = (sentence: string, plugins: readonly string[] = [manifest.id]): void => {
          refusals.push({ hook: hook.name, plugins, sentence });
        };
        if (hook.mode === 'decide' && hook.securityPath && !isCore(manifest.id)) {
          refuse(`${manifest.id} takes the security-path hook ${hook.name}, which only core may take.`);
          continue;
        }
        if (hook.mode === 'provide') {
          if (take.key === undefined) {
            refuse(`${manifest.id} takes the provide hook ${hook.name} without a key.`);
            continue;
          }
          const keyCheck = hook.key.safeParse(take.key);
          if (!keyCheck.success) {
            refuse(`${manifest.id} takes ${hook.name} with the key "${take.key}", which the hook does not define.`);
            continue;
          }
          if (hook.takers !== undefined && !hook.takers.includes(manifest.id)) {
            refuse(`${manifest.id} may not take the security-path hook ${hook.name}; only ${hook.takers.join(', ')} may.`);
            continue;
          }
          const key = `${hook.name}:${take.key}`;
          const other = providedKeys.get(key);
          if (other !== undefined) {
            refuse(`${other} and ${manifest.id} both provide ${hook.name} for "${take.key}".`, [other, manifest.id]);
            continue;
          }
          providedKeys.set(key, manifest.id);
        }
        const taker: Taker = {
          plugin: manifest.id,
          take,
          rank,
          priority: take.priority ?? manifest.priority ?? 50,
          state: 'skeleton',
        };
        const list = engine.takers.get(hook.name) ?? [];
        list.push(taker);
        engine.takers.set(hook.name, list);
        engine.byPluginKey.set(`${manifest.id}\u0000${takeKey(take)}`, taker);
      }
    });
    return { engine, refusals };
  }

  /** The offerer of a hook, if any plugin offers it. A take of a hook nobody offers is an edge to nothing. */
  offererOf(hook: HookDef): string | undefined {
    return this.offers.get(hook.name)?.plugin;
  }

  /** Attaches a built half's hook implementations (keyed `name` or `name:key`). */
  attach(plugin: string, impls: Readonly<Record<string, unknown>> | undefined, state: TakerState): void {
    for (const [key, taker] of this.byPluginKey) {
      if (!key.startsWith(`${plugin}\u0000`)) continue;
      taker.state = state;
      if (state === 'live') taker.handler = impls?.[takeKey(taker.take)];
      if (state === 'live' && taker.handler === undefined) taker.state = 'skeleton';
    }
  }

  /** A plugin failed (or its dependency did) after attaching: its takes become no-ops / unavailable. */
  markFailed(plugin: string): void {
    for (const [key, taker] of this.byPluginKey) if (key.startsWith(`${plugin}\u0000`)) taker.state = 'failed';
  }

  /** The invoker a plugin's `build` receives: only for hooks it offered (§6). */
  invokerFor(plugin: string): HookInvoker {
    const offered = (hook: HookDef): void => {
      if (this.offers.get(hook.name)?.plugin !== plugin)
        throw new TypeError(`${plugin} invoked the hook ${hook.name}, which it did not declare in hooks.offers`);
    };
    return {
      observe: (hook, payload) => {
        offered(hook);
        this.observe(hook, payload);
      },
      decide: async (hook, input) => {
        offered(hook);
        return await this.decide(hook, input);
      },
      transform: async (hook, value) => {
        offered(hook);
        return await this.transform(hook, value);
      },
      provider: (hook, key) => {
        offered(hook);
        return this.provider(hook, key);
      },
      providers: hook => {
        offered(hook);
        return this.providers(hook);
      },
      contributions: hook => {
        offered(hook);
        return this.contributions(hook);
      },
    };
  }

  private ordered(hook: HookDef): readonly Taker[] {
    return [...(this.takers.get(hook.name) ?? [])].sort(
      (a, b) => b.priority - a.priority || a.rank - b.rank || a.plugin.localeCompare(b.plugin),
    );
  }

  private timeoutOf(hook: DecideHook | TransformHook): number {
    return this.offers.get(hook.name)?.offer.timeoutMs ?? hook.timeoutMs;
  }

  observe<P>(hook: ObserveHook<string, P>, payload: P): void {
    for (const taker of this.takers.get(hook.name) ?? []) {
      if (taker.state !== 'live') continue;
      const handler = taker.handler as (payload: P) => void | Promise<void>;
      queueMicrotask(() => {
        try {
          void Promise.resolve(handler(payload)).catch(error => this.observeFailed(hook, taker, error));
        } catch (error) {
          this.observeFailed(hook, taker, error);
        }
      });
    }
  }

  private observeFailed(hook: HookDef, taker: Taker, error: unknown): void {
    this.log.warn('a hook taker failed', {
      hook: hook.name,
      plugin: taker.plugin,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  private async bounded<T>(work: () => T | Promise<T>, ms: number): Promise<{ value: T } | 'timeout' | 'threw'> {
    const deadline = this.deadline(ms);
    try {
      const answer = await Promise.race([Promise.resolve().then(work).then(value => ({ value })), deadline.promise]);
      return answer;
    } catch {
      return 'threw';
    } finally {
      deadline.cancel();
    }
  }

  async decide<I>(hook: DecideHook<string, I>, input: I): Promise<HookDecision> {
    for (const taker of this.ordered(hook)) {
      // A failed taker of a decide hook says no (§3.4 failed); a skeleton one is a no-op the suite marks skeleton.
      if (taker.state === 'failed')
        return { allow: false, reason: `${taker.plugin} is not running, so it cannot agree to this.` };
      if (taker.state !== 'live') continue;
      const handler = taker.handler as (input: I) => HookDecision | Promise<HookDecision>;
      const answer = await this.bounded(() => handler(input), this.timeoutOf(hook));
      if (answer === 'timeout') return { allow: false, reason: `${taker.plugin} did not answer in time.` };
      if (answer === 'threw') return { allow: false, reason: `${taker.plugin} failed while deciding.` };
      const decision = answer.value;
      if (decision === null || typeof decision !== 'object' || decision.allow !== true) {
        const reason =
          decision !== null && typeof decision === 'object' && decision.allow === false && typeof decision.reason === 'string'
            ? decision.reason
            : `${taker.plugin} refused.`;
        return { allow: false, reason };
      }
    }
    return { allow: true };
  }

  async transform<V>(hook: TransformHook<string, V>, value: V): Promise<Result<V, string>> {
    let current = value;
    for (const taker of this.ordered(hook)) {
      if (taker.state === 'failed') return err(`${taker.plugin} is not running, so this was refused.`);
      if (taker.state !== 'live') continue;
      const handler = taker.handler as (value: V) => V | Promise<V>;
      const before = current;
      const answer = await this.bounded(() => handler(before), this.timeoutOf(hook));
      if (answer === 'timeout') return err(`${taker.plugin} did not answer in time.`);
      if (answer === 'threw') return err(`${taker.plugin} failed while changing this.`);
      if (hook.value !== undefined) {
        const parsed = hook.value.safeParse(answer.value);
        if (!parsed.success) return err(`${taker.plugin} answered something ${hook.name} does not accept.`);
        current = parsed.data;
      } else current = answer.value;
    }
    return ok(current);
  }

  provider<K extends string, V>(hook: ProvideHook<string, K, V>, key: K): V | 'unavailable' {
    const taker = (this.takers.get(hook.name) ?? []).find(candidate => candidate.take.key === key);
    if (taker === undefined || taker.state !== 'live') return 'unavailable';
    return taker.handler as V;
  }

  providers<K extends string, V>(hook: ProvideHook<string, K, V>): ReadonlyMap<K, V> {
    const map = new Map<K, V>();
    for (const taker of this.takers.get(hook.name) ?? [])
      if (taker.state === 'live' && taker.take.key !== undefined) map.set(taker.take.key as K, taker.handler as V);
    return map;
  }

  /** Who takes a provide key, live or not (the `fy plugin show` and doctor view). */
  providerPlugin(hook: ProvideHook, key: string): string | undefined {
    return (this.takers.get(hook.name) ?? []).find(candidate => candidate.take.key === key)?.plugin;
  }

  contributions<I>(hook: ContributeHook<string, I>): readonly Contribution<I>[] {
    const items: Contribution<I>[] = [];
    const seen = new Map<string, string>();
    for (const taker of this.ordered(hook)) {
      if (taker.state !== 'live') continue;
      let contributed: readonly Contribution<I>[];
      try {
        contributed = (taker.handler as () => readonly Contribution<I>[])();
      } catch {
        this.note(`${taker.plugin}'s items for ${hook.name} were left out because it failed.`);
        continue;
      }
      for (const item of contributed) {
        const owner = seen.get(item.id);
        if (owner !== undefined) {
          this.note(`${hook.name} item "${item.id}" from ${taker.plugin} was left out: ${owner} already uses that id.`);
          continue;
        }
        if (hook.item !== undefined && !hook.item.safeParse(item.item).success) {
          this.note(`${hook.name} item "${item.id}" from ${taker.plugin} was left out: it does not fit the hook.`);
          continue;
        }
        seen.set(item.id, taker.plugin);
        items.push(item);
      }
    }
    return items.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
  }

  private note(sentence: string): void {
    if (!this.notes.includes(sentence)) this.notes.push(sentence);
  }

  /** The resolved order of every taken hook, for `generated/hooks.md` and `fy plugin show`. */
  order(): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, readonly string[]>();
    for (const [name] of this.takers) {
      const offer = this.offers.get(name);
      const hook = offer?.offer.hook ?? this.takers.get(name)?.[0]?.take.hook;
      if (hook === undefined) continue;
      out.set(
        name,
        this.ordered(hook).map(taker => (taker.take.key === undefined ? taker.plugin : `${taker.plugin}:${taker.take.key}`)),
      );
    }
    return out;
  }
}
