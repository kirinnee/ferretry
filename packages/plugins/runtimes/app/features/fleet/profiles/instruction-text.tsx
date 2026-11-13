/**
 * The words of the instructions a profile holds, READ ONLY.
 *
 * A profile lists an instructions item by name ("Instructions · main"), and the text it sends to a ferret lived
 * nowhere an owner could read it — v4's component form showed it as the component's `body`. The catalogue already
 * carries the text (`ComponentView.content`, with any secret-looking value cut out by the daemon), so this draws it;
 * it adds no route and no write. Changing the text stays where it already is: a change the daemon previews and applies
 * behind the passkey step-up (`fy component edit instructions/<name>`, or the file itself).
 *
 * A profile also reaches instructions through the profiles it contains, so those are read through the same way
 * (a base's text comes first, as a base's layers do), each item named once however many layers reach it.
 */

import type { ComponentView, LayeredProfileView } from '../../../../contract/index.ts';
import { Hint, Section } from '../components/catalog-ui.tsx';

const INSTRUCTIONS_PREFIX = 'instructions/';
const PROFILE_PREFIX = 'profile/';

/** The instructions a profile reaches, as the components that hold them, in the order a ferret reads them. */
export function profileInstructions(
  profile: LayeredProfileView,
  profiles: readonly LayeredProfileView[],
  components: readonly ComponentView[],
): readonly ComponentView[] {
  const byReference = new Map(components.map(component => [component.reference, component]));
  const seenProfiles = new Set<string>();
  const found = new Map<string, ComponentView>();
  const walk = (current: LayeredProfileView): void => {
    if (seenProfiles.has(current.name)) return;
    seenProfiles.add(current.name);
    for (const layer of current.layers) {
      if (layer.startsWith(PROFILE_PREFIX)) {
        const base = profiles.find(candidate => candidate.name === layer.slice(PROFILE_PREFIX.length));
        if (base !== undefined) walk(base);
        continue;
      }
      const component = layer.startsWith(INSTRUCTIONS_PREFIX) ? byReference.get(layer) : undefined;
      if (component !== undefined) found.set(component.reference, component);
    }
  };
  walk(profile);
  return [...found.values()];
}

function InstructionBody({ component }: { component: ComponentView }) {
  const content = component.content;
  if (content?.form !== 'text')
    return <Hint>The text of {component.name} could not be read, so there is nothing to show here.</Hint>;
  return (
    <>
      {content.redacted ? (
        <Hint>A value that looked like a secret was replaced by ‹hidden›. It is not shown here.</Hint>
      ) : null}
      {content.text === '' ? (
        <Hint>This document is empty.</Hint>
      ) : (
        <pre
          className="m-0 max-h-[24rem] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-2 p-xs font-mono text-2xs text-fg"
          data-instruction-text={component.reference}
        >
          {content.text}
        </pre>
      )}
    </>
  );
}

export function InstructionTexts({
  profile,
  profiles,
  components,
}: {
  readonly profile: LayeredProfileView;
  readonly profiles: readonly LayeredProfileView[];
  readonly components: readonly ComponentView[];
}) {
  const held = profileInstructions(profile, profiles, components);
  if (held.length === 0) return null;
  return (
    <Section title="Instructions text" spot="instruction-text">
      <Hint>
        What a ferret on this profile is told, read only. To change it, edit the instructions item (
        <span className="font-mono">fy component edit instructions/‹name›</span>); the change is previewed first, behind
        the same step-up as every other change.
      </Hint>
      {held.map(component => (
        <details key={component.reference} className="min-w-0" data-instruction-item={component.reference}>
          <summary className="cursor-pointer text-row font-semibold text-fg">{component.name}</summary>
          <div className="mt-2 flex min-w-0 flex-col gap-2">
            <InstructionBody component={component} />
          </div>
        </details>
      ))}
    </Section>
  );
}
