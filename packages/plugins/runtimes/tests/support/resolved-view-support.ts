import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../daemon/lib/service/resolved-view.ts';

// The model and the launch-flag view the resolved-view tests (unit and perf) share.

export const modelWith = (components: Record<string, unknown>, profiles: Record<string, unknown>) =>
  parseAccountModel({ version: 1, components, profiles });

export const resolved = (input: ResolveInput): ResolvedProfile => {
  const result = resolveProfile(input);
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return result.resolved;
};

export function shownFlags(...layers: readonly (readonly string[])[]): { value: string; hidden?: true }[] {
  const names = layers.map((_, index) => `layer${String(index)}`);
  const model = modelWith(
    {
      settings: Object.fromEntries(
        layers.map((flags, index) => [names[index], { harness: 'claude', flags: [...flags] }]),
      ),
    },
    { p: { layers: names.map(name => `settings/${name}`) } },
  );
  return resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }))
    .filter(entry => entry.field === 'flags')
    .map(entry => (entry.hidden === true ? { value: entry.value, hidden: true } : { value: entry.value }));
}
