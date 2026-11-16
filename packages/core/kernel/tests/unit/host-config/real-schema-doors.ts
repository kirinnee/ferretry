/**
 * The door sweep of `real-schema-bound.test.ts` (unit: a small text, every answer capped) and of
 * `tests/perf/host-config/real-schema-bound.test.ts` (perf: the text at the size cap, every door timed). What it
 * MEASURES is the caller's: it is handed a `Measure`, and this file reads no clock.
 */
import { expect } from 'bun:test';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import type { ConfigTarget } from '../../../contract/ports.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { type DeclaredKind, declaredKinds } from './real-schemas.ts';
import { captureLog, HOME, manualClock } from './support.ts';

export const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
export const KINDS = declaredKinds();
export const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

/** What a door cost, as the caller measures it; the unit tier measures nothing (every cost is 0). */
export interface Measure {
  /** The answer of `act` and what it cost, in ms. */
  readonly timed: <T>(act: () => Promise<T> | T) => Promise<{ readonly ms: number; readonly value: T }>;
  /** Re-sample a door whose best cost so far is `ms`? */
  readonly resample: (ms: number) => boolean;
  /** Each door's best cost. */
  readonly within: (ms: number) => void;
  /** Called last with every door's best cost. */
  readonly done: (spent: readonly number[]) => void;
}

/** The unit tier's measure: nothing is timed, nothing is re-sampled. */
export const UNTIMED: Measure = {
  timed: async act => ({ ms: 0, value: await act() }),
  resample: () => false,
  within: () => undefined,
  done: () => undefined,
};

/** Every kind declared, the swept one's file seeded with `text` before the first load. */
export function world(kind: DeclaredKind, text?: string) {
  const fs = createMemoryHostFs();
  if (text !== undefined) fs.seed(`${HOME}/config/${kind.path}`, text);
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: KINDS.map(({ plugin, def }) => ({ plugin, def })),
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const target: ConfigTarget = {
    plugin: kind.plugin,
    def: kind.def,
    ...(kind.name === undefined ? {} : { name: kind.name }),
  };
  return { fs, files, agent, target };
}

type World = ReturnType<typeof world>;

/**
 * The BEST of up to three samples (the same shape as `issue-cap.test.ts`): a quadratic path is slow in every sample and
 * fails, a collection or a busy moment on a shared runner lands in one and does not. A further sample is taken only
 * while the best so far fails the bound: a sample that passes cannot be made to pass more, and re-sampling one cost a
 * fresh world and a reload each, enough to cross bun's 5 s test timeout at 750 ms a call
 * (T-0032, 5.7 s on CI). `sample` is told which
 * attempt it is: a later one starts from a world of its own, because a check one load made is remembered and a second
 * call on the same world would measure the memo, not the parse.
 */
async function bestOf<T>(
  measure: Measure,
  sample: (attempt: number) => Promise<{ readonly ms: number; readonly value: T }>,
): Promise<{ readonly ms: number; readonly value: T }> {
  let best = Number.POSITIVE_INFINITY;
  let value: T | undefined;
  for (let attempt = 0; attempt < 3 && (attempt === 0 || measure.resample(best)); attempt += 1) {
    const taken = await sample(attempt);
    best = Math.min(best, taken.ms);
    value = taken.value;
  }
  return { ms: best, value: value as T };
}

/** At most the cap's issues and one more, and a count that is every problem. */
function capped(issues: readonly { readonly message: string }[] | undefined): void {
  expect((issues ?? []).length).toBeLessThanOrEqual(MAX_CONFIG_ISSUES + 1);
}

/** Every door, for one kind and one hostile text. */
export async function everyDoor(kind: DeclaredKind, text: string, measure: Measure): Promise<void> {
  const settledText = `${text.slice(0, -1)}\n`;
  // A world a later sample starts from: the file as the second reload leaves it, loaded.
  const settled = async (): Promise<World> => {
    const again = world(kind, settledText);
    await again.files.reload();
    return again;
  };
  // A reload of the file hand-written (the first load of a home that holds it is what boot runs).
  const first = world(kind, text);
  // Every door's CPU, so the slowest can prove the clock reads: a small read or listing is under the clock's 1 ms tick
  // and may read 0, but the parse of a file at the cap is tens to hundreds of ms.
  const spent: number[] = [];
  const within = (ms: number): void => {
    spent.push(ms);
    measure.within(ms);
  };
  within(
    (
      await bestOf(
        measure,
        async attempt => await measure.timed(() => (attempt === 0 ? first : world(kind, text)).files.reload()),
      )
    ).ms,
  );
  let loaded = first;
  const second = await bestOf(measure, async attempt => {
    if (attempt === 0) loaded = first;
    else {
      loaded = world(kind, text);
      await loaded.files.reload();
    }
    loaded.fs.seed(`${HOME}/config/${kind.path}`, settledText);
    return await measure.timed(() => loaded.files.reload());
  });
  within(second.ms);
  capped(loaded.files.status().issues.filter(issue => issue.path === kind.path));
  // Each door below is sampled on the world as it stands, then (if the sample is slow) on a settled one of its own.
  const door = <T>(act: (at: World) => Promise<T> | T) =>
    bestOf(measure, async attempt => {
      const at = attempt === 0 ? loaded : await settled();
      return await measure.timed(() => act(at));
    });
  // A text that is not the one on disk, so no check made of it before is reused.
  const fresh = `${text.slice(0, -1)} `;
  if (kind.agentMayName) {
    const read = await door(at => at.agent.run(call({ tool: 'config.read', path: kind.path }), ferretStanding));
    within(read.ms);
    capped(read.value.issues);
    const validate = await door(at =>
      at.agent.run(call({ tool: 'config.validate', path: kind.path, text: fresh }), ferretStanding),
    );
    within(validate.ms);
    capped(validate.value.issues);
    const write = await door(at =>
      at.agent.run(call({ tool: 'config.write', path: kind.path, text: `${fresh.slice(0, -1)}\t` }), ferretStanding),
    );
    within(write.ms);
    capped(write.value.issues);
  } else {
    const read = await door(at => at.files.writer().read(at.target));
    within(read.ms);
    capped(read.value?.issues);
    const write = await door(at => at.files.writer().write(at.target, fresh, { confirmedLoosening: true }));
    within(write.ms);
    if (write.value.kind === 'refused') capped(write.value.issues);
  }
  // Nothing the listing says grows with the file either.
  const listing = await door(at => at.agent.run(call({ tool: 'config.read' }), ferretStanding));
  within(listing.ms);
  capped(listing.value.issues);
  measure.done(spent);
}
