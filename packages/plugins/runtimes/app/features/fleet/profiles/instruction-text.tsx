/**
 * The words of the instructions a profile holds, READ ONLY.
 *
 * A profile lists an instructions item by name ("Instructions · main"), and the text it sends to a ferret lived
 * nowhere an owner could read it — v4's component form showed it as the component's `body`. The catalogue already
 * carries the text (`ComponentView.content`, with any secret-looking value cut out by the daemon), so this draws it;
 * it adds no route and no write. Changing the text stays where it already is: a change the daemon previews and applies
 * behind the passkey step-up (`fy instruction edit <name>`, or the file itself).
 *
 * A profile also reaches instructions through the profiles it contains. THE ORDER IS THE RESOLVER'S, NOT A SECOND
 * ONE: the items come out of `expandStack` — the very function the daemon flattens a profile with — so a base is
 * expanded where it stands and an item named twice stands at its newest position, and a screen can never say "A then
 * B" while a ferret is told "B then A". An item that arrived through a base says which base it was inherited from.
 */

import type { ComponentView, LayeredProfileView } from '../../../../contract/index.ts';
import { expandStack } from '../../../../contract/index.ts';
import { CatalogNote, Hint, Section } from '../components/catalog-ui.tsx';

const INSTRUCTIONS_PREFIX = 'instructions/';
const PROFILE_PREFIX = 'profile/';

/** One instructions item a profile reaches, and the profile it came through (`undefined`: the profile names it itself). */
export interface HeldInstruction {
  readonly component: ComponentView;
  /** The outermost base it was inherited through — the resolver's own `origin`. */
  readonly inheritedFrom?: string;
}

/**
 * The instructions a profile reaches, in the order a ferret reads them (oldest first), or `undefined` when the stack
 * cannot be expanded (a base that is missing, a loop, a stack too deep) — the schema refuses those, so it is the
 * unreadable-catalogue case and is said, not guessed.
 */
export function profileInstructions(
  profile: LayeredProfileView,
  profiles: readonly LayeredProfileView[],
  components: readonly ComponentView[],
): readonly HeldInstruction[] | undefined {
  const byReference = new Map(components.map(component => [component.reference, component]));
  const layersOf = new Map([...profiles, profile].map(candidate => [candidate.name, candidate.layers]));
  const stack = expandStack<string>(
    name => layersOf.get(name),
    text =>
      text.startsWith(PROFILE_PREFIX)
        ? { kind: 'base', name: text.slice(PROFILE_PREFIX.length) }
        : { kind: 'leaf', key: text, item: text },
    profile.name,
  );
  if (!stack.ok) return undefined;
  return stack.entries.flatMap(entry => {
    const component = entry.key.startsWith(INSTRUCTIONS_PREFIX) ? byReference.get(entry.key) : undefined;
    if (component === undefined) return [];
    const via = entry.via[0];
    return [via === undefined ? { component } : { component, inheritedFrom: via }];
  });
}

function InstructionBody({ component }: { component: ComponentView }) {
  const content = component.content;
  if (content?.form !== 'text')
    return <Hint>The text of {component.name} could not be read, so there is nothing to show here.</Hint>;
  return (
    <>
      {content.redacted ? (
        <CatalogNote tone="info" title="Part of this text is hidden" spot="instruction-redacted">
          A value that looked like a secret was replaced by ‹hidden›. It is not shown here.
        </CatalogNote>
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
  if (held?.length === 0) return null;
  return (
    <Section title="Instructions text" spot="instruction-text">
      <Hint>
        What a ferret on this profile is told, read only, in the order it reads them. To change it, edit the
        instructions item (<code className="whitespace-nowrap font-mono">fy instruction edit ‹name›</code>); the change
        is previewed first, behind the same step-up as every other change.
      </Hint>
      {held === undefined ? (
        <Hint>
          The order of this profile’s bases could not be worked out, so its instruction text is not shown here.
        </Hint>
      ) : (
        held.map(({ component, inheritedFrom }) => (
          <details key={component.reference} className="min-w-0" data-instruction-item={component.reference}>
            <summary className="cursor-pointer text-cell font-medium text-fg">
              {component.name}
              {inheritedFrom === undefined ? null : (
                <span className="ml-2 font-normal text-muted" data-instruction-inherited={inheritedFrom}>
                  inherited from ‹{inheritedFrom}›
                </span>
              )}
            </summary>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              <InstructionBody component={component} />
            </div>
          </details>
        ))
      )}
    </Section>
  );
}
