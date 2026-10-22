/**
 * THE MODELS GUIDE EDITOR: the use cases a ferret picks a sub-ferret's model by, and for each the
 * models that suit it, best first (docs/pack-mode.md).
 *
 * Every change is made to a draft and nothing is written until Save, because a save rewrites
 * `models-guide.yaml` with EVERY use case — that is what turns the guide derived from the model
 * catalogs into the owner's. "Reset to the built-in guide" removes the use cases from the file again.
 * Order is the ranking, so every list moves with Up and Down buttons, never by dragging alone.
 *
 * Model names are recognised in the description and every "why" as they are typed, against every model
 * in every catalog in effect — not only the ones this machine runs, since a guide may name another
 * machine's — and the candidate's model field completes from the same list and fills its provider.
 */

import type {
  GuideCandidate,
  GuideRouting,
  GuideUndo,
  GuideUseCase,
  ModelsGuide,
  PackFleetModel,
} from '@ferretry/protocol';
import { MAX_GUIDE_TEXT_CHARS, MAX_ROUTING_PROMPT_CHARS, MAX_ROUTING_SHORT_CHARS } from '@ferretry/protocol';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import {
  BLANK_CANDIDATE,
  blankUseCase,
  canAddCandidate,
  canAddUseCase,
  candidateWithModel,
  guideChanged,
  keywordsText,
  moveItem,
  parseKeywords,
  removeItem,
  replaceItem,
} from '../../lib/pack/guide-draft.ts';
import { type ModelVocabulary, modelNamed, modelVocabulary } from '../../lib/pack/model-mentions.ts';
import { guideIssues, type RoutingDraft, type RoutingEdit, routingIssues } from '../../lib/pack/pack-files.ts';
import { absoluteTime } from '../../lib/session-screens.ts';
import { Badge, Button } from '../../shell/primitives.tsx';
import { ModelMentionField, NOT_HERE } from './model-mention-field.tsx';
import type { GuideWrite, PackSave } from './use-machine-pack.ts';

export interface ModelsGuideEditorProps {
  readonly guide: ModelsGuide;
  readonly models: readonly PackFleetModel[];
  /** `routing` is given only when the owner edited it: a pair writes it, `null` removes it. */
  readonly onSave: (useCases: readonly GuideUseCase[] | null, routing?: RoutingEdit) => Promise<PackSave>;
  /** Present while an accepted suggestion can be undone. */
  readonly undo?: GuideUndo;
  readonly onUndo?: () => Promise<GuideWrite>;
  /** A reviewed suggestion to edit: loaded into the draft, never saved until Save guide. `key` is new each time. */
  readonly incoming?: {
    readonly key: number;
    readonly useCases: readonly GuideUseCase[];
    readonly routing?: GuideRouting;
  };
  /** Use cases open for editing when the editor first draws (harness, tests). */
  readonly initiallyOpen?: readonly number[];
}

const NO_ROUTING: RoutingDraft = { prompt: '', short: '' };

/** The routing guidance in effect, as the editor's two plain strings. */
const routingDraftOf = (routing: RoutingDraft | undefined): RoutingDraft =>
  routing === undefined ? NO_ROUTING : { prompt: routing.prompt, short: routing.short };

const sameRouting = (left: RoutingDraft, right: RoutingDraft): boolean =>
  left.prompt === right.prompt && left.short === right.short;

function RoutingEditor({
  draft,
  source,
  onChange,
}: {
  readonly draft: RoutingDraft;
  readonly source: 'file' | 'derived' | undefined;
  readonly onChange: (draft: RoutingDraft) => void;
}) {
  const base = useId().replace(/:/gu, '');
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border-strong bg-surface-2 p-3"
      data-guide-routing=""
    >
      <h4 className="m-0 text-ui font-semibold">Routing guidance</h4>
      <p className="m-0 text-meta leading-base text-muted">
        How a ferret picks a model, in words, next to the use cases.
        {source === 'derived' ? ' This is rendered from the use cases now; editing it writes your own.' : ''}
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${base}-prompt`} className="text-meta font-semibold text-fg-soft">
          Guidance{' '}
          <span className="font-normal text-muted">
            ({draft.prompt.length}/{MAX_ROUTING_PROMPT_CHARS})
          </span>
        </label>
        <textarea
          id={`${base}-prompt`}
          className="kt-input min-h-[44px] w-full resize-y"
          rows={6}
          maxLength={MAX_ROUTING_PROMPT_CHARS}
          value={draft.prompt}
          onChange={event => onChange({ ...draft, prompt: event.currentTarget.value })}
          data-routing-prompt=""
        />
      </div>
      <TextField
        id={`${base}-short`}
        label="One-line summary"
        maxLength={MAX_ROUTING_SHORT_CHARS}
        value={draft.short}
        onChange={short => onChange({ ...draft, short })}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-11 w-11 shrink-0 p-0"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Up, down and remove for one item in an ordered list. */
function OrderButtons({
  noun,
  index,
  count,
  onMove,
  onRemove,
}: {
  readonly noun: string;
  readonly index: number;
  readonly count: number;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      <IconButton label={`Move ${noun} up`} disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUp size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={`Move ${noun} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDown size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={`Remove ${noun}`} onClick={onRemove}>
        <Trash2 size={16} aria-hidden="true" />
      </IconButton>
    </span>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  mono = false,
  maxLength,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly mono?: boolean;
  readonly maxLength?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta font-semibold text-fg-soft">
        {label}
      </label>
      <input
        id={id}
        type="text"
        className={cn('kt-input min-h-[44px] w-full', mono && 'mono')}
        value={value}
        maxLength={maxLength}
        spellCheck={!mono}
        onChange={event => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

/** Keywords as one comma-separated line, kept as typed so a comma can be written before the next word. */
function KeywordsField({
  id,
  keywords,
  onChange,
}: {
  readonly id: string;
  readonly keywords: readonly string[] | undefined;
  readonly onChange: (keywords: readonly string[]) => void;
}) {
  const [text, setText] = useState(() => keywordsText(keywords));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta font-semibold text-fg-soft">
        Keywords <span className="font-normal text-muted">(comma-separated words a task may use)</span>
      </label>
      <input
        id={id}
        type="text"
        className="kt-input min-h-[44px] w-full"
        value={text}
        onChange={event => {
          setText(event.currentTarget.value);
          onChange(parseKeywords(event.currentTarget.value));
        }}
      />
    </div>
  );
}

/** Whether the model a candidate names runs here, is listed elsewhere, or is listed nowhere. */
function ModelStatus({ vocabulary, name }: { readonly vocabulary: ModelVocabulary; readonly name: string }) {
  if (name.trim() === '') return null;
  const model = modelNamed(vocabulary, name);
  if (model === undefined)
    return (
      <Badge tone="err" data-candidate-model-status="unknown">
        Unknown model
      </Badge>
    );
  return model.runtimes.length > 0 ? (
    <Badge tone="ok" data-candidate-model-status="known" title={`Runs here on ${model.runtimes.join(', ')}`}>
      Runs here
    </Badge>
  ) : (
    <Badge tone="pend" data-candidate-model-status="absent" title={NOT_HERE}>
      Not on this machine
    </Badge>
  );
}

function CandidateEditor({
  idPrefix,
  candidate,
  index,
  count,
  vocabulary,
  onChange,
  onMove,
  onRemove,
}: {
  readonly idPrefix: string;
  readonly candidate: GuideCandidate;
  readonly index: number;
  readonly count: number;
  readonly vocabulary: ModelVocabulary;
  readonly onChange: (candidate: GuideCandidate) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const named = modelNamed(vocabulary, candidate.model);
  const efforts = named?.efforts ?? [];
  const id = `${idPrefix}-c${index}`;
  const typeModel = (text: string): void => {
    // A typed id that is exactly a listed model fills the provider as a pick would.
    const exact = modelNamed(vocabulary, text);
    onChange(
      exact !== undefined && exact.id.toLocaleLowerCase() === text.trim().toLocaleLowerCase()
        ? candidateWithModel({ ...candidate, model: text }, exact, vocabulary.models)
        : { ...candidate, model: text },
    );
  };
  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-border-strong bg-surface-2 p-3"
      data-guide-candidate=""
    >
      <div className="flex items-center gap-2">
        <span className="text-ui font-semibold">#{index + 1}</span>
        <span className="hidden min-w-0 flex-1 truncate text-meta text-muted sm:block">
          {named?.label ?? candidate.model}
        </span>
        <span className="flex-1 sm:hidden" />
        <ModelStatus vocabulary={vocabulary} name={candidate.model} />
        <OrderButtons noun={`candidate ${index + 1}`} index={index} count={count} onMove={onMove} onRemove={onRemove} />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[2fr_1fr_1fr]">
        <ModelMentionField
          id={`${id}-model`}
          label="Model"
          multiline={false}
          value={candidate.model}
          vocabulary={vocabulary}
          maxLength={128}
          placeholder="Type to search every model"
          onChange={typeModel}
          onPick={model => onChange(candidateWithModel(candidate, model, vocabulary.models))}
        />
        <TextField
          id={`${id}-provider`}
          label="Provider"
          mono
          maxLength={64}
          value={candidate.provider}
          onChange={provider => onChange({ ...candidate, provider })}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-effort`} className="text-meta font-semibold text-fg-soft">
            Effort
          </label>
          {efforts.length > 0 ? (
            <select
              id={`${id}-effort`}
              className="kt-input min-h-[44px] w-full"
              value={candidate.effort ?? ''}
              onChange={event => {
                const { effort: _effort, ...rest } = candidate;
                const effort = event.currentTarget.value;
                onChange(effort === '' ? rest : { ...rest, effort });
              }}
            >
              <option value="">Default</option>
              {efforts.map(effort => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${id}-effort`}
              type="text"
              className="kt-input mono min-h-[44px] w-full"
              maxLength={32}
              placeholder="Default"
              value={candidate.effort ?? ''}
              onChange={event => onChange({ ...candidate, effort: event.currentTarget.value })}
            />
          )}
        </div>
      </div>
      <ModelMentionField
        id={`${id}-why`}
        label="Why"
        rows={2}
        maxLength={MAX_GUIDE_TEXT_CHARS}
        value={candidate.why}
        vocabulary={vocabulary}
        onChange={why => onChange({ ...candidate, why })}
      />
    </li>
  );
}

function UseCaseEditor({
  useCase,
  index,
  count,
  open,
  vocabulary,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  readonly useCase: GuideUseCase;
  readonly index: number;
  readonly count: number;
  readonly open: boolean;
  readonly vocabulary: ModelVocabulary;
  readonly onToggle: () => void;
  readonly onChange: (useCase: GuideUseCase) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const base = useId().replace(/:/gu, '');
  const bodyId = `${base}-body`;
  const top = useCase.candidates[0];
  const topName = top === undefined ? 'No candidates yet' : (modelNamed(vocabulary, top.model)?.label ?? top.model);
  const setCandidates = (candidates: readonly GuideCandidate[]): void =>
    onChange({ ...useCase, candidates: [...candidates] });
  return (
    <li className="kt-panel flex min-w-0 flex-col" data-guide-use-case={useCase.id}>
      <div className="flex min-w-0 items-center gap-1 p-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left hover:bg-surface-2"
        >
          {open ? (
            <ChevronDown size={16} aria-hidden="true" className="shrink-0" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" className="shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-semibold">{useCase.title || 'Untitled use case'}</span>
            <span className="block truncate text-meta text-muted">
              <span className="mono">{useCase.id}</span> · {topName}
              {useCase.candidates.length > 1 ? ` +${useCase.candidates.length - 1}` : ''}
            </span>
          </span>
        </button>
        <OrderButtons
          noun={`use case ${useCase.title || index + 1}`}
          index={index}
          count={count}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>
      {open ? (
        <div id={bodyId} className="flex min-w-0 flex-col gap-3 border-t border-border-soft p-3">
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[2fr_1fr]">
            <TextField
              id={`${base}-title`}
              label="Title"
              maxLength={80}
              value={useCase.title}
              onChange={title => onChange({ ...useCase, title })}
            />
            <TextField
              id={`${base}-id`}
              label="Id"
              mono
              maxLength={40}
              value={useCase.id}
              onChange={id => onChange({ ...useCase, id })}
            />
          </div>
          <ModelMentionField
            id={`${base}-description`}
            label="Description"
            rows={3}
            maxLength={MAX_GUIDE_TEXT_CHARS}
            value={useCase.description}
            vocabulary={vocabulary}
            onChange={description => onChange({ ...useCase, description })}
          />
          <KeywordsField
            id={`${base}-keywords`}
            keywords={useCase.keywords}
            onChange={keywords => onChange({ ...useCase, keywords: [...keywords] })}
          />
          <div className="flex flex-col gap-2">
            <h4 className="m-0 text-ui font-semibold">Candidates, best first</h4>
            {useCase.candidates.length === 0 ? (
              <p className="m-0 text-meta text-muted">No candidates yet — add the model that suits this best first.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {useCase.candidates.map((candidate, at) => (
                  <CandidateEditor
                    // biome-ignore lint/suspicious/noArrayIndexKey: a candidate has no identity but its place
                    key={at}
                    idPrefix={base}
                    candidate={candidate}
                    index={at}
                    count={useCase.candidates.length}
                    vocabulary={vocabulary}
                    onChange={next => setCandidates(replaceItem(useCase.candidates, at, next))}
                    onMove={delta => setCandidates(moveItem(useCase.candidates, at, delta))}
                    onRemove={() => setCandidates(removeItem(useCase.candidates, at))}
                  />
                ))}
              </ol>
            )}
            <Button
              size="sm"
              className="min-h-[44px] self-start"
              disabled={!canAddCandidate(useCase)}
              onClick={() => setCandidates([...useCase.candidates, { ...BLANK_CANDIDATE }])}
            >
              <Plus size={14} aria-hidden="true" /> Add candidate
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ModelsGuideEditor({
  guide,
  models,
  onSave,
  undo,
  onUndo,
  incoming,
  initiallyOpen = [],
}: ModelsGuideEditorProps) {
  const vocabulary = useMemo(() => modelVocabulary(models), [models]);
  const saved = guide.useCases;
  const [draft, setDraft] = useState<readonly GuideUseCase[]>(saved);
  const [openSet, setOpenSet] = useState<ReadonlySet<number>>(() => new Set(initiallyOpen));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PackSave | null>(null);
  const savedRouting = useMemo(() => routingDraftOf(guide.routing), [guide.routing]);
  const [routingDraft, setRoutingDraft] = useState<RoutingDraft>(savedRouting);
  const routingEdited = !sameRouting(routingDraft, savedRouting);
  const changed = guideChanged(draft, saved) || routingEdited;
  const issues = useMemo(
    () => [
      ...(guideChanged(draft, saved) || routingEdited ? guideIssues(draft) : []),
      ...(routingEdited ? routingIssues(routingDraft) : []),
    ],
    [draft, saved, routingEdited, routingDraft],
  );
  const [undoOutcome, setUndoOutcome] = useState<GuideWrite | null>(null);
  const headingId = useId();

  // The guide moved under an untouched editor (another device, `fy`, a hand edit): show the new one.
  // Untouched means equal to the guide it was drawn from, which is the PREVIOUS saved one.
  const drawnFrom = useRef(saved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new saved guide resets the draft
  useEffect(() => {
    if (!guideChanged(draft, drawnFrom.current)) setDraft(saved);
    drawnFrom.current = saved;
  }, [saved]);

  // The routing guidance moved under an untouched editor: show the new words.
  const routingDrawnFrom = useRef(savedRouting);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new saved routing resets its draft
  useEffect(() => {
    if (sameRouting(routingDraft, routingDrawnFrom.current)) setRoutingDraft(savedRouting);
    routingDrawnFrom.current = savedRouting;
  }, [savedRouting]);

  // A reviewed suggestion sent here to be edited replaces the draft; saving it is still the owner's to do.
  const loaded = useRef<number | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `incoming.key` loads
  useEffect(() => {
    if (incoming === undefined || loaded.current === incoming.key) return;
    loaded.current = incoming.key;
    setDraft(incoming.useCases);
    if (incoming.routing !== undefined) setRoutingDraft(routingDraftOf(incoming.routing));
    setOpenSet(new Set());
    setOutcome(null);
  }, [incoming?.key]);

  const routingEdit = (): RoutingEdit => {
    if (!routingEdited) return undefined;
    return routingDraft.prompt.trim() === '' && routingDraft.short.trim() === '' ? null : routingDraft;
  };
  const commit = (useCases: readonly GuideUseCase[] | null): void => {
    setBusy(true);
    setOutcome(null);
    const edit = useCases === null ? undefined : routingEdit();
    void onSave(useCases, edit).then(result => {
      // A written draft is what the next guide read is drawn from, so it replaces the draft.
      if (result.kind === 'applied') {
        drawnFrom.current = draft;
        routingDrawnFrom.current = edit === undefined ? routingDrawnFrom.current : (edit ?? NO_ROUTING);
      }
      setOutcome(result);
      setBusy(false);
    });
  };
  const undoLast = (): void => {
    if (onUndo === undefined) return;
    setBusy(true);
    setUndoOutcome(null);
    void onUndo().then(result => {
      setUndoOutcome(result);
      setBusy(false);
    });
  };
  const toggle = (index: number): void =>
    setOpenSet(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  // Moving or removing a use case keeps the open ones open: the open set follows positions.
  const reorderOpen = (from: number, to: number | null): void =>
    setOpenSet(current => {
      const next = new Set<number>();
      for (const index of current) {
        if (index === from) {
          if (to !== null) next.add(to);
        } else if (to !== null && index === to) next.add(from);
        else if (to === null && index > from) next.add(index - 1);
        else next.add(index);
      }
      return next;
    });

  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-4" aria-labelledby={headingId} data-models-guide="">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-[260px]">
          <h3 id={headingId} className="m-0 text-ui font-semibold">
            Models guide
          </h3>
          <p className="m-0 mt-1 text-meta leading-base text-muted">
            What each kind of work should run on, best first. A ferret starting a sub-ferret reads it — or Jev ranks it,
            when Jev decides. Any model in any catalog can be named, including ones only another machine runs.
          </p>
        </div>
        <Badge tone={guide.source === 'file' ? 'accent' : 'pend'} data-guide-source={guide.source}>
          {guide.source === 'file' ? 'Your guide · models-guide.yaml' : 'Built-in · from the model catalogs'}
        </Badge>
      </div>
      {draft.length === 0 ? (
        <p className="m-0 text-meta text-muted">No use cases. Add one, or reset to the built-in guide.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {draft.map((useCase, index) => (
            <UseCaseEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: an id is editable, so only the place is stable
              key={index}
              useCase={useCase}
              index={index}
              count={draft.length}
              open={openSet.has(index)}
              vocabulary={vocabulary}
              onToggle={() => toggle(index)}
              onChange={next => setDraft(replaceItem(draft, index, next))}
              onMove={delta => {
                setDraft(moveItem(draft, index, delta));
                reorderOpen(index, index + delta);
              }}
              onRemove={() => {
                setDraft(removeItem(draft, index));
                reorderOpen(index, null);
              }}
            />
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="min-h-[44px]"
          disabled={!canAddUseCase(draft)}
          onClick={() => {
            setDraft([...draft, blankUseCase(draft)]);
            setOpenSet(current => new Set(current).add(draft.length));
          }}
        >
          <Plus size={14} aria-hidden="true" /> Add use case
        </Button>
      </div>
      <RoutingEditor draft={routingDraft} source={guide.routing?.source} onChange={setRoutingDraft} />
      {issues.length > 0 ? (
        <ul className="m-0 flex flex-col gap-1 pl-5 text-meta text-err" data-guide-issues="">
          {issues.map(issue => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
        <Button
          variant="primary"
          className="min-h-[44px]"
          disabled={busy || !changed || issues.length > 0}
          onClick={() => commit(draft)}
        >
          Save guide
        </Button>
        <Button
          className="min-h-[44px]"
          disabled={busy || !changed}
          onClick={() => {
            setDraft(saved);
            setRoutingDraft(savedRouting);
          }}
        >
          Discard changes
        </Button>
        {undo !== undefined && onUndo !== undefined ? (
          <Button className="min-h-[44px]" disabled={busy} onClick={undoLast} data-guide-undo-last="">
            Undo last accepted suggestion (saved {absoluteTime(undo.savedAt)})
          </Button>
        ) : null}
        {guide.source === 'file' ? (
          <Button className="min-h-[44px]" disabled={busy} onClick={() => commit(null)}>
            Reset to the built-in guide
          </Button>
        ) : null}
      </div>
      {guide.source === 'derived' ? (
        <p className="m-0 text-meta text-faint">
          Saving writes every use case to <code>models-guide.yaml</code>, so the guide stops following the catalogs.
        </p>
      ) : null}
      {undoOutcome === null ? null : (
        <p
          role="status"
          className={cn('m-0 text-meta leading-base', undoOutcome.kind === 'refused' ? 'text-err' : 'text-muted')}
        >
          {undoOutcome.message}
        </p>
      )}
      {outcome !== null && outcome.kind !== 'applied' ? (
        <p
          role="status"
          className={cn('m-0 text-meta leading-base', outcome.kind === 'refused' ? 'text-err' : 'text-warn')}
        >
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}
