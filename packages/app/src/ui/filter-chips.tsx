/**
 * A ROW OF TOGGLE CHIPS that narrow a list, each with its count (copied from today's PWA
 * `features/context-rail/context-rail-parts.tsx` and `context-rail-model.ts`): the Agenda tab's filters and the
 * context rail's sub-tabs draw it.
 */

/** One filter chip: its key, its words, and how many rows it would show under the current search. */
export interface ContextChip<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly count: number;
}

export interface ContextFilterChipsProps<K extends string> {
  readonly label: string;
  readonly chips: readonly ContextChip<K>[];
  readonly value: K;
  readonly onChange: (next: K) => void;
}

/**
 * A row of toggle chips with their counts. Toggle buttons with `aria-pressed`, not a tablist — the
 * sub-tabs above are the tabs; these only narrow the list under them — and the family's own `.kt-tab`
 * treatment, so the pressed chip looks native in every theme.
 */
export function ContextFilterChips<K extends string>({ label, chips, value, onChange }: ContextFilterChipsProps<K>) {
  return (
    <div aria-label={label} className="flex min-w-0 flex-wrap gap-xs" role="toolbar" data-context-chips="">
      {chips.map(chip => (
        <button
          aria-pressed={chip.key === value}
          className="kt-tab !px-xs min-w-0 gap-1"
          data-context-chip={chip.key}
          key={chip.key}
          onClick={() => onChange(chip.key)}
          type="button"
        >
          <span className="truncate">{chip.label}</span>
          <span className="mono shrink-0 text-2xs text-faint">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}
