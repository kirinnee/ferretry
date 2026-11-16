/**
 * Which way the Query page shows an answer — one result, or a trend over time — kept on this device.
 *
 * How the reader likes to read a page, not daemon data, so it is a device preference like the Insights time
 * zone: it survives a reload, follows the reader across daemons and falls back to a single result whenever
 * the stored value is anything else.
 */
import { localKey } from '@ferretry/app';
import { devicePreference } from '../../lib/device-preference.ts';
import { QUERY_VIEWS, type QueryView } from './analytics-query-trend.ts';

/** The sole browser-storage key for the Query page's Single/Trend choice. */
const QUERY_VIEW_KEY = localKey('usage', 'query-view');

export const queryViewPreference = devicePreference<QueryView>(QUERY_VIEW_KEY, QUERY_VIEWS, 'single');
