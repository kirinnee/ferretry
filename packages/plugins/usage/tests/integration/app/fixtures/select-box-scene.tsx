/**
 * The browser entry for "the Usage lists are the app's own SelectBox" (r11 S3f), over fake data and the REAL components:
 *
 *   ?scene=query   the Insights query editor: its Metric and Aggregation helpers rewrite the query text, which is the one
 *                  fact the page keeps (`data-query`)
 *   ?scene=zone    the "Days in" time-zone picker (every IANA zone the browser knows); the choice is `data-chosen`
 *   &theme=<family>-<mode>
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalyticsQueryEditor } from '../../../../app/features/analytics/analytics-custom-query.tsx';
import { InsightsTimeZonePicker } from '../../../../app/features/analytics/insights-time-zone-picker.tsx';
import { DEVICE_TIME_ZONE } from '../../../../app/lib/insights-time-zone.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'query';

function Query() {
  const [query, setQuery] = useState('sum(cost_usd) by (model) [7d]');
  return (
    <main style={{ padding: 16, maxWidth: 720 }}>
      <AnalyticsQueryEditor
        value={query}
        onValueChange={setQuery}
        onRun={() => undefined}
        querying={false}
        loadValues={async () => []}
      />
      <p data-query="">{query}</p>
    </main>
  );
}

function Zone() {
  const [choice, setChoice] = useState(DEVICE_TIME_ZONE);
  return (
    <main style={{ padding: 16, maxWidth: 520 }}>
      <InsightsTimeZonePicker choice={choice} onChoose={setChoice} />
      <p data-chosen="">{choice}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(scene === 'zone' ? <Zone /> : <Query />);
