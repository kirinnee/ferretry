/**
 * Plain stand-ins for the three drawn parts the app shell has not lent plugin halves yet (`app/shell.ts`
 * `provideShell`): the Markdown reader, the model select and the per-day chart. They draw what a test reads
 * (text, options, the chart's title and notes) and nothing of the shell's look. Importing this file installs them.
 */

import { createElement } from 'react';
import { provideShell } from '../../../app/shell.ts';

interface ChartProps {
  readonly title: string;
  readonly points: readonly { readonly key: string; readonly label: string; readonly flagged?: boolean }[];
  readonly series: readonly { readonly key: string; readonly label: string }[];
  readonly flagNote?: string;
  readonly emptyText?: string;
}

const chart = ({ title, points, series, flagNote, emptyText }: ChartProps) =>
  createElement(
    'div',
    { 'data-analytics-chart': '' },
    createElement('h4', null, title),
    createElement('ul', null, ...series.map(entry => createElement('li', { key: entry.key }, entry.label))),
    createElement('ol', null, ...points.map(point => createElement('li', { key: point.key }, point.label))),
    points.some(point => point.flagged === true) && flagNote !== undefined ? createElement('p', null, flagNote) : null,
    points.length === 0 && emptyText !== undefined ? createElement('p', null, emptyText) : null,
  );

const markdown = ({ text }: { readonly text: string }) => createElement('div', { 'data-markdown': '' }, text);

const modelSelect = ({
  id,
  models,
  value,
  onChange,
  defaultLabel = 'Login default',
  disabled = false,
}: {
  readonly id: string;
  readonly models: readonly { readonly id: string; readonly label?: string }[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly defaultLabel?: string;
  readonly disabled?: boolean;
}) =>
  createElement(
    'select',
    { id, value, disabled, onChange: (event: { target: { value: string } }) => onChange(event.target.value) },
    createElement('option', { value: '' }, defaultLabel),
    ...models.map(model => createElement('option', { key: model.id, value: model.id }, model.label ?? model.id)),
  );

provideShell({ AnalyticsMetricChart: chart, Markdown: markdown, ModelSelect: modelSelect });
