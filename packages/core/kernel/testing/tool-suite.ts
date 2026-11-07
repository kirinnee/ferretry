import { describe, expect, test } from 'bun:test';
import type { TargetRef } from '../contract/act.ts';
import { AckSchema, isOp, showsSomething } from '../contract/act.ts';
import type { InputHolds } from '../contract/bound.ts';
import type { DaemonImplementation } from '../manifest/implement.ts';
import type { Manifest } from '../manifest/types.ts';
import type { TestCaller } from './admission.ts';
import { type TestHost, type TestHostOptions, testHost } from './host.ts';

/** One act the suite drives: a tool, an input, and the target that input acts on. */
export interface ToolCase {
  readonly tool: string;
  readonly input: unknown;
  readonly target: TargetRef;
  readonly as?: TestCaller;
  /** Set the target up so the act can happen (open a fake terminal, a page). */
  readonly arrange?: (host: TestHost) => Promise<void> | void;
}

/**
 * The tool conformance suite (§3.9, §4.7): every act goes through `kernel.act` with the tool's declared `Op`; a held
 * target refuses before anything runs; missing or throwing holds fail closed; a write-only act answers no more than
 * an `Ack`. Each tool plugin runs it with one case per agent tool; `act-runner` (§7.9) is its static half.
 */
export function toolConformance(
  name: string,
  setup: { readonly plugin: DaemonImplementation<any>; readonly host?: Omit<TestHostOptions, 'plugins'>; readonly cases: readonly ToolCase[] },
): void {
  const manifest = setup.plugin.manifest as Manifest;
  const declared = new Map((manifest.actions?.agentTools ?? []).map(tool => [tool.name, tool] as const));
  const make = async (holds?: InputHolds): Promise<TestHost> =>
    testHost({ ...(setup.host ?? {}), ...(holds === undefined ? {} : { holds }), plugins: [setup.plugin] });

  describe(`tool conformance: ${name}`, () => {
    test('every agent tool declares an Op and has a case', () => {
      for (const tool of declared.values()) {
        expect(isOp(tool.op)).toBe(true);
        expect(setup.cases.some(c => c.tool === tool.name)).toBe(true);
      }
    });

    for (const c of setup.cases) {
      const decl = declared.get(c.tool);
      const sameTarget = (t: TargetRef): boolean => t.kind === c.target.kind && t.key === c.target.key;

      test(`${c.tool}: acts through kernel.act with its Op`, async () => {
        const host = await make();
        await c.arrange?.(host);
        await host.tool(c.tool, c.input, c.as === undefined ? {} : { as: c.as });
        const acts = host.acts.filter(a => sameTarget(a.target));
        expect(acts.length).toBeGreaterThan(0);
        expect(acts.every(a => a.op === decl?.op)).toBe(true);
        await host.stop();
      });

      test(`${c.tool}: a held target refuses before the act runs`, async () => {
        const host = await make();
        await c.arrange?.(host);
        host.hold(c.target, 'held');
        const result = await host.tool(c.tool, c.input, c.as === undefined ? {} : { as: c.as });
        const acts = host.acts.filter(a => sameTarget(a.target));
        expect(acts.some(a => a.outcome === 'ran')).toBe(false);
        expect(acts.some(a => a.outcome !== 'ran')).toBe(true);
        expect(result.isError === true || JSON.stringify(result.data ?? '').includes('refused')).toBe(true);
        await host.stop();
      });

      test(`${c.tool}: throwing holds fail closed`, async () => {
        const host = await make({
          decide() {
            throw new Error('holds broke');
          },
        });
        await c.arrange?.(host);
        await host.tool(c.tool, c.input, c.as === undefined ? {} : { as: c.as });
        const acts = host.acts.filter(a => sameTarget(a.target));
        expect(acts.some(a => a.outcome === 'ran')).toBe(false);
        expect(acts.some(a => typeof a.outcome === 'object' && a.outcome.refused === 'holds_unavailable')).toBe(true);
        await host.stop();
      });

      if (decl?.op !== undefined && isOp(decl.op) && !showsSomething(decl.op))
        test(`${c.tool}: a write-only act answers no more than an Ack`, async () => {
          const host = await make();
          await c.arrange?.(host);
          const result = await host.tool(c.tool, c.input, c.as === undefined ? {} : { as: c.as });
          if (result.data !== undefined) expect(AckSchema.strict().safeParse(result.data).success).toBe(true);
          await host.stop();
        });
    }
  });
}
