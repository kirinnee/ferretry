/**
 * EVERY BOARD FILTER, in one compact row: project, machine, ferret, kind, PR state, activity, state, lane,
 * Mine, and the Created and Last touched ranges (Any · Today · 7 days · 30 days · Custom).
 *
 * The component holds no filter of its own: it draws `filters` and hands the next set to `onChange`, which
 * the page writes to the URL, so a view is linkable and the back button walks it. Choices it cannot know
 * (projects, machines, ferrets, lane names) arrive as props from the data the page already read.
 */

import {
  BoardActivityFilterSchema,
  BoardPrStateFilterSchema,
  BoardStateFilterSchema,
  type BoardProjectId,
  TaskKindSchema,
} from '@ferretry/protocol';
import { ListFilter, X } from 'lucide-react';
import { useId, useState } from 'react';
import { type BoardDateRange, type BoardFilters, NO_BOARD_FILTERS, NO_DATE_RANGE } from '../../lib/board-model.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { activeFilterCount } from '../../lib/board-view.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';

export interface BoardFilterChoices {
  readonly projects: readonly { readonly id: BoardProjectId; readonly name: string }[];
  readonly machines: readonly { readonly daemonId: DaemonId; readonly name: string }[];
  readonly ferrets: readonly { readonly id: string; readonly name: string }[];
  readonly lanes: readonly string[];
}

export interface BoardFiltersProps {
  readonly filters: BoardFilters;
  readonly onChange: (next: BoardFilters) => void;
  readonly choices: BoardFilterChoices;
  /** Start unfolded. A phone starts folded behind the "Filters" button. */
  readonly defaultOpen?: boolean;
  /** The Archive reads closed and dropped cards: its State choice is "both", "closed" or "dropped". */
  readonly archive?: boolean;
}

const ACTIVITY_LABEL: Readonly<Record<string, string>> = {
  active: 'Active',
  idle: 'Idle',
  stale: 'Stale',
  waiting: 'Waiting',
  orphaned: 'Orphaned',
  to_test: 'To test',
  waiting_on_you: 'Waiting on you',
  blocked: 'Blocked',
};

const PR_LABEL: Readonly<Record<string, string>> = {
  none: 'No PR',
  draft: 'Draft',
  open: 'Open',
  ci_red: 'CI red',
  merged: 'Merged',
  released: 'Released',
};

const STATE_LABEL: Readonly<Record<string, string>> = {
  open: 'Open',
  closed: 'Closed',
  dropped: 'Dropped',
  all: 'All',
};

const KIND_LABEL: Readonly<Record<string, string>> = {
  bug: 'Bug',
  feature: 'Feature',
  infra: 'Infra',
  chore: 'Chore',
};

const label = (names: Readonly<Record<string, string>>, value: string): string => names[value] ?? value;

interface SelectProps {
  readonly name: string;
  readonly title: string;
  readonly value: string;
  readonly any: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onPick: (value: string | null) => void;
}

function FilterSelect({ name, title, value, any, options, onPick }: SelectProps) {
  return (
    <select
      aria-label={title}
      className="fy-board-filters__select"
      data-filter={name}
      data-set={value === '' ? undefined : ''}
      onChange={event => onPick(event.target.value === '' ? null : event.target.value)}
      value={value}
    >
      <option value="">{any}</option>
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const;

interface RangeProps {
  readonly name: 'created' | 'touched';
  readonly title: string;
  readonly range: BoardDateRange;
  readonly onChange: (next: BoardDateRange) => void;
}

/** A date range: a preset, or `Custom` which unfolds a from and a to. */
function DateRangeField({ name, title, range, onChange }: RangeProps) {
  const [custom, setCustom] = useState(range.preset === null && (range.from !== null || range.to !== null));
  const value = range.preset ?? (custom ? 'custom' : '');
  return (
    <span className="fy-board-filters__range" data-filter={name}>
      <select
        aria-label={title}
        className="fy-board-filters__select"
        data-filter={`${name}-preset`}
        data-set={value === '' ? undefined : ''}
        onChange={event => {
          const next = event.target.value;
          if (next === 'custom') {
            setCustom(true);
            onChange(NO_DATE_RANGE);
            return;
          }
          setCustom(false);
          const preset = PRESETS.find(candidate => candidate.value === next);
          onChange(preset === undefined ? NO_DATE_RANGE : { preset: preset.value, from: null, to: null });
        }}
        value={value}
      >
        <option value="">{title}: any</option>
        {PRESETS.map(preset => (
          <option key={preset.value} value={preset.value}>
            {title}: {preset.label.toLocaleLowerCase()}
          </option>
        ))}
        <option value="custom">{title}: custom…</option>
      </select>
      {custom && range.preset === null ? (
        <span className="fy-board-filters__dates">
          <input
            aria-label={`${title} from`}
            className="fy-board-filters__date"
            max={range.to ?? undefined}
            onChange={event => onChange({ preset: null, from: event.target.value || null, to: range.to })}
            type="date"
            value={range.from ?? ''}
          />
          <span aria-hidden="true">–</span>
          <input
            aria-label={`${title} to`}
            className="fy-board-filters__date"
            min={range.from ?? undefined}
            onChange={event => onChange({ preset: null, from: range.from, to: event.target.value || null })}
            type="date"
            value={range.to ?? ''}
          />
        </span>
      ) : null}
    </span>
  );
}

const optionsOf = (values: readonly string[], names: Readonly<Record<string, string>>) =>
  values.map(value => ({ value, label: label(names, value) }));

interface FieldsProps {
  readonly filters: BoardFilters;
  readonly onChange: (next: BoardFilters) => void;
  readonly choices: BoardFilterChoices;
  readonly archive: boolean;
}

/** Every filter control, as one run of fields; the bar lays them in a row and the phone sheet in a column. */
function BoardFilterFields({ filters, onChange, choices, archive }: FieldsProps) {
  const set = (patch: Partial<BoardFilters>): void => onChange({ ...filters, ...patch });
  const laneChoices =
    filters.lane === null || choices.lanes.includes(filters.lane) ? choices.lanes : [...choices.lanes, filters.lane];
  return (
    <>
      <FilterSelect
        any="All projects"
        name="project"
        onPick={value => set({ project: value as BoardProjectId | null })}
        options={choices.projects.map(project => ({ value: project.id, label: project.name }))}
        title="Project"
        value={filters.project ?? ''}
      />
      {choices.machines.length > 1 ? (
        <FilterSelect
          any="All machines"
          name="machine"
          onPick={value => set({ machine: value as DaemonId | null })}
          options={choices.machines.map(machine => ({ value: machine.daemonId, label: machine.name }))}
          title="Machine"
          value={filters.machine ?? ''}
        />
      ) : null}
      <FilterSelect
        any="All ferrets"
        name="ferret"
        onPick={value => set({ ferret: value })}
        options={choices.ferrets.map(ferret => ({ value: ferret.id, label: ferret.name }))}
        title="Ferret"
        value={filters.ferret ?? ''}
      />
      <FilterSelect
        any="All kinds"
        name="kind"
        onPick={value => set({ kind: TaskKindSchema.safeParse(value).data ?? null })}
        options={optionsOf(TaskKindSchema.options, KIND_LABEL)}
        title="Kind"
        value={filters.kind ?? ''}
      />
      <FilterSelect
        any="Any PR"
        name="pr"
        onPick={value => set({ pr: BoardPrStateFilterSchema.safeParse(value).data ?? null })}
        options={optionsOf(BoardPrStateFilterSchema.options, PR_LABEL)}
        title="PR state"
        value={filters.pr ?? ''}
      />
      <FilterSelect
        any="Any activity"
        name="activity"
        onPick={value => set({ activity: BoardActivityFilterSchema.safeParse(value).data ?? null })}
        options={optionsOf(BoardActivityFilterSchema.options, ACTIVITY_LABEL)}
        title="Activity"
        value={filters.activity ?? ''}
      />
      <select
        aria-label="State"
        className="fy-board-filters__select"
        data-filter="state"
        data-set={filters.state === NO_BOARD_FILTERS.state ? undefined : ''}
        onChange={event => set({ state: BoardStateFilterSchema.parse(event.target.value) })}
        value={filters.state}
      >
        {BoardStateFilterSchema.options
          .filter(state => !archive || state !== 'all')
          .map(state => (
            <option key={state} value={state}>
              {archive && state === 'open'
                ? 'Closed + dropped'
                : `State: ${label(STATE_LABEL, state).toLocaleLowerCase()}`}
            </option>
          ))}
      </select>
      <FilterSelect
        any="All lanes"
        name="lane"
        onPick={value => set({ lane: value })}
        options={laneChoices.map(lane => ({ value: lane, label: lane }))}
        title="Lane"
        value={filters.lane ?? ''}
      />
      <label className="fy-board-filters__mine">
        <input
          checked={filters.mine}
          data-filter="mine"
          onChange={event => set({ mine: event.target.checked })}
          type="checkbox"
        />
        Mine
      </label>
      <DateRangeField name="created" onChange={created => set({ created })} range={filters.created} title="Created" />
      <DateRangeField name="touched" onChange={touched => set({ touched })} range={filters.touched} title="Touched" />
    </>
  );
}

export function BoardFilterBar({ filters, onChange, choices, defaultOpen = true, archive = false }: BoardFiltersProps) {
  const [open, setOpen] = useState(defaultOpen);
  const count = activeFilterCount(filters);
  return (
    <div className="fy-board-filters" data-open={open ? '' : undefined}>
      <div className="fy-board-filters__bar">
        <button
          aria-expanded={open}
          className="fy-board-filters__toggle"
          onClick={() => setOpen(value => !value)}
          type="button"
        >
          <ListFilter aria-hidden="true" size={12} />
          Filters
          {count > 0 ? <span className="fy-board-filters__n">{count}</span> : null}
        </button>
        {count > 0 ? (
          <button className="fy-board-filters__clear" onClick={() => onChange({ ...NO_BOARD_FILTERS })} type="button">
            <X aria-hidden="true" size={11} />
            Clear
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="fy-board-filters__row">
          <BoardFilterFields archive={archive} choices={choices} filters={filters} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The phone's filters: a button that opens a bottom sheet holding every field, so the page keeps its height.
 * Fields apply as they are picked (the URL is the state); "Done" only closes the sheet.
 */
export function BoardFilterSheet({
  filters,
  onChange,
  choices,
  archive = false,
}: Omit<BoardFiltersProps, 'defaultOpen'>) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const titleId = useId();
  return (
    <div className="fy-board-filters" data-sheet="">
      <div className="fy-board-filters__bar">
        <button
          aria-controls="board-filter-sheet"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="fy-board-filters__toggle"
          onClick={() => setOpen(true)}
          type="button"
        >
          <ListFilter aria-hidden="true" size={14} />
          <span className="fy-board-filters__label">Filters</span>
          {count > 0 ? <span className="fy-board-filters__n">{count}</span> : null}
        </button>
        {count > 0 ? (
          <button className="fy-board-filters__clear" onClick={() => onChange({ ...NO_BOARD_FILTERS })} type="button">
            <X aria-hidden="true" size={12} />
            Clear
          </button>
        ) : null}
      </div>
      <BottomSheet
        closeLabel="Close filters"
        id="board-filter-sheet"
        labelledBy={titleId}
        onClose={() => setOpen(false)}
        open={open}
        panelClassName="fy-board-filter-sheet"
      >
        <h2 className="fy-board-filter-sheet__title" id={titleId}>
          Filters
        </h2>
        <div className="fy-board-filter-sheet__fields">
          <BoardFilterFields archive={archive} choices={choices} filters={filters} onChange={onChange} />
        </div>
        <div className="fy-board-filter-sheet__actions">
          {count > 0 ? (
            <button
              className="kt-btn"
              data-variant="ghost"
              onClick={() => onChange({ ...NO_BOARD_FILTERS })}
              type="button"
            >
              Clear all
            </button>
          ) : null}
          <button className="kt-btn" data-variant="primary" onClick={() => setOpen(false)} type="button">
            Done
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
