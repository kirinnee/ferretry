/**
 * "DAYS IN …" — the control that says which clock Insights counts a day on.
 *
 * A `SelectBox` (the app's own list: a phone gets a centred dialog, and 400 zones are searchable). The first option
 * is the device's zone and is the default; the choice is kept on this device and shared by every
 * Insights page (see `insights-time-zone.ts`). The visible text always names the zone in force, so a
 * number is never read against an unstated day.
 */
import { SelectBox } from '@ferretry/app/ui';
import { useId, useMemo } from 'react';

import { DEVICE_TIME_ZONE, deviceTimeZone, knownTimeZones } from '../../lib/insights-time-zone.ts';

export interface InsightsTimeZonePickerProps {
  /** `device` or an IANA zone. */
  readonly choice: string;
  readonly onChoose: (choice: string) => void;
}

export function InsightsTimeZonePicker({ choice, onChoose }: InsightsTimeZonePickerProps) {
  const id = useId();
  const device = deviceTimeZone();
  const zones = useMemo(() => knownTimeZones(), []);
  return (
    <div className="flex min-w-0 items-center gap-xs text-meta text-muted" data-insights-time-zone="">
      <label htmlFor={id} className="shrink-0">
        Days in
      </label>
      <SelectBox
        id={id}
        className="min-w-0 max-w-[14rem] flex-1"
        label="Days in"
        value={choice}
        onChange={onChoose}
        options={[
          { value: DEVICE_TIME_ZONE, label: `This device (${device})` },
          ...zones.map(zone => ({ value: zone, label: zone })),
        ]}
      />
    </div>
  );
}
