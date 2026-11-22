import type { ImportPartial } from './use-apply-import.ts';

/**
 * What an import that stopped part-way left on this machine, in the daemon's own words: what landed and what did not.
 * Names only (a key's name, a login, a settings file): never a value. Both lists are always drawn when there is something
 * to say, so a person never has to guess whether a half-finished import is safe to try again.
 */
export interface ImportPartialNoteProps {
  readonly partial: ImportPartial;
}

export function ImportPartialNote({ partial }: ImportPartialNoteProps) {
  return (
    <div
      className="kt-panel flex min-w-0 flex-col gap-2 border-warn p-panel"
      role="status"
      data-import-partial=""
      data-import-partial-tool={partial.label}
    >
      <p className="m-0 text-row font-semibold text-fg">{`Part of the ${partial.label} import is on this machine`}</p>
      <section className="flex min-w-0 flex-col gap-1" data-import-landed="">
        <h5 className="m-0 text-meta font-semibold uppercase text-muted">Brought in</h5>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-cell text-fg">
          {partial.landed.map(word => (
            <li key={word} className="[overflow-wrap:anywhere]">
              {word}
            </li>
          ))}
        </ul>
      </section>
      <section className="flex min-w-0 flex-col gap-1" data-import-not-landed="">
        <h5 className="m-0 text-meta font-semibold uppercase text-muted">Not brought in</h5>
        {partial.notLanded.length === 0 ? (
          <p className="m-0 text-cell text-muted">Nothing is known to be missing.</p>
        ) : (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-cell text-fg">
            {partial.notLanded.map(word => (
              <li key={word} className="[overflow-wrap:anywhere]">
                {word}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
