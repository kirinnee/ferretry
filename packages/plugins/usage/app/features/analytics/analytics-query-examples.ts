/**
 * The curated example queries on the Query page, one click each. Every query here is parsed by the
 * protocol grammar in the unit test, so an example can never drift out of what the daemon accepts.
 */

export interface AnalyticsQueryExample {
  readonly id: string;
  readonly title: string;
  readonly query: string;
  readonly hint: string;
}

export const ANALYTICS_QUERY_EXAMPLES: readonly AnalyticsQueryExample[] = [
  {
    id: 'cost-by-model',
    title: 'Cost by model, 7 days',
    query: 'sum(cost_usd) by (model) [7d]',
    hint: 'Equivalent API cost per model; sessions without a price are counted, not zeroed.',
  },
  {
    id: 'tokens-by-runtime',
    title: 'Tokens by runtime',
    query: 'sum(tokens) by (runtime) [30d]',
    hint: 'Total tokens per runtime over the last 30 days.',
  },
  {
    id: 'active-by-project-week',
    title: 'Active time by project per week',
    query: 'sum(duration_active_seconds) by (project, week) [56d]',
    hint: 'Time agents spent working on a turn, per project and ISO week.',
  },
  {
    id: 'top-sessions-duration',
    title: 'Top sessions by duration',
    query: 'max(duration_wall_seconds) by (session) [7d]',
    hint: 'Longest wall-clock sessions of the week.',
  },
  {
    id: 'avg-active-by-model',
    title: 'Average active time by model',
    query: 'avg(duration_active_seconds) by (model) [14d]',
    hint: 'Mean active seconds per session for each model.',
  },
  {
    id: 'active-per-turn-by-model',
    title: 'Active seconds per turn, by model',
    query: 'sum(duration_active_seconds_per_turn) by (model) [14d]',
    hint: 'Total active time divided by total turns, so a long session does not outweigh a short one.',
  },
  {
    id: 'turns-by-machine',
    title: 'Turns by machine',
    query: 'sum(turns) by (machine) [7d]',
    hint: 'How many turns each connected machine ran.',
  },
  {
    id: 'cache-read-by-day',
    title: 'Cache reads per day',
    query: 'sum(tokens_cache_read) by (day) [14d]',
    hint: 'Cached input tokens read each UTC day.',
  },
  {
    id: 'sessions-by-harness',
    title: 'Sessions by harness',
    query: 'count(sessions) by (harness) [30d]',
    hint: 'How many sessions each harness ran.',
  },
];
