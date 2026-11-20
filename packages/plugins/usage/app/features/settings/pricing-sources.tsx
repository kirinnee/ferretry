/**
 * WHAT THE PAGE SAYS ABOUT HOW INSIGHTS PRICES, AND WHICH FEEDS IT CAN CHECK. Two groups of rows: what insights
 * applies (a state per rate kind, as a badge on its row), and the pricing feeds the operator configured. The feeds are
 * ONE answer ("which feed to check"), so they are choice cards in a row, not a second list under a dropdown; a disabled
 * feed is a card that cannot be chosen. The chosen feed's address and last-applied time are one line under the cards.
 */
import { ChoiceCards, SettingGroup, SettingRow } from '@ferretry/app';
import { Badge, Button, PanelPath } from '@ferretry/app/ui';
import type { AnalyticsPricingView, ConfiguredAnalyticsPricingSource } from '../../../contract/index.ts';
import { DateValue } from './pricing-rate-parts.tsx';

export function ApplicabilityDisclosure({ view }: { readonly view: AnalyticsPricingView }) {
  const imageStored = view.rateApplicability.image === 'stored_not_applied';
  const toolStored = view.rateApplicability.tool === 'stored_not_applied';
  const reasoningApplied = view.rateApplicability.reasoning === 'applied_when_evidenced';
  // The hint wraps to its full sentence (the row kit would cut it to one line at 900px), and it stays behind the (i) too.
  const imageToolWords =
    imageStored && toolStored
      ? 'Recorded, not applied: there is no reliable billable evidence.'
      : 'Follows the daemon record shown for this catalog.';
  const reasoningWords = reasoningApplied
    ? 'Applied when transcript evidence exists.'
    : 'Recorded; this daemon does not currently apply them.';
  return (
    <div
      className="min-w-0 [&_[data-setting-hint]]:overflow-visible [&_[data-setting-hint]]:whitespace-normal [&_[data-setting-hint]]:[text-overflow:clip]"
      data-pricing-applicability=""
    >
      <SettingGroup label="What insights applies">
        <SettingRow
          wide
          name="Image and tool rates"
          hint={imageToolWords}
          explanation={imageToolWords}
          dataAttributes={{
            'data-rate-applicability': `image:${view.rateApplicability.image},tool:${view.rateApplicability.tool}`,
            'data-usage-stack': '',
          }}
          control={() => (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Badge className="max-w-full whitespace-normal" tone={imageStored ? 'pend' : 'ok'}>
                {imageStored ? 'Image: stored only' : 'Image: applied'}
              </Badge>
              <Badge className="max-w-full whitespace-normal" tone={toolStored ? 'pend' : 'ok'}>
                {toolStored ? 'Tool: stored only' : 'Tool: applied'}
              </Badge>
            </span>
          )}
        />
        <SettingRow
          wide
          name="Reasoning rates"
          hint={reasoningWords}
          explanation={reasoningWords}
          dataAttributes={{ 'data-reasoning-applicability': view.rateApplicability.reasoning, 'data-usage-stack': '' }}
          control={() => (
            <Badge tone={reasoningApplied ? 'ok' : 'pend'}>{reasoningApplied ? 'Applied' : 'Stored only'}</Badge>
          )}
        />
      </SettingGroup>
    </div>
  );
}

export function Sources({
  sources,
  selectedSourceId,
  busy,
  onSelect,
  onPreview,
}: {
  readonly sources: readonly ConfiguredAnalyticsPricingSource[];
  readonly selectedSourceId: string;
  readonly busy: boolean;
  readonly onSelect: (sourceId: string) => void;
  readonly onPreview: () => void;
}) {
  const selected = sources.find(source => source.id === selectedSourceId);
  return (
    <div className="min-w-0" data-pricing-sources="">
      <SettingGroup label="Configured pricing feeds">
        <li className="min-w-0 px-panel py-3 text-meta leading-base text-muted">
          Anthropic and OpenAI do not provide a machine-readable first-party pricing API. Ferretry checks only the JSON
          feeds already configured by this daemon’s operator; this screen never submits an arbitrary URL.
        </li>
        {sources.length === 0 ? (
          <li className="px-panel py-3 text-meta text-muted" data-pricing-sources-empty="">
            No pricing feed is configured. Add one in the daemon configuration before checking for updates.
          </li>
        ) : (
          <li className="flex min-w-0 flex-col gap-3 px-panel py-3">
            <ChoiceCards
              label="Feed to check"
              disabled={busy}
              value={selected === undefined ? null : selected.id}
              onChange={onSelect}
              options={sources.map(source => ({
                id: source.id,
                title: source.id,
                line: `${source.provider}${source.enabled ? '' : ' · disabled'}`,
                disabled: !source.enabled,
              }))}
            />
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1" data-pricing-source={selected?.id}>
                {selected === undefined ? (
                  <span className="text-meta text-muted">Choose a configured feed to check it for updates.</span>
                ) : (
                  <>
                    <span className="flex flex-wrap items-center gap-2 text-meta text-muted">
                      <Badge tone={selected.enabled ? 'ok' : 'pend'}>{selected.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      Last applied: <DateValue value={selected.lastSyncedAt} fallback="Never" />
                    </span>
                    <PanelPath value={selected.url} className="block text-meta leading-base text-muted" label="Feed" />
                  </>
                )}
              </div>
              <Button
                type="button"
                variant="primary"
                className="min-h-[44px]"
                disabled={busy || selected === undefined || !selected.enabled}
                data-pricing-preview=""
                onClick={onPreview}
              >
                {busy ? 'Checking…' : 'Check for updates'}
              </Button>
            </div>
          </li>
        )}
      </SettingGroup>
    </div>
  );
}
