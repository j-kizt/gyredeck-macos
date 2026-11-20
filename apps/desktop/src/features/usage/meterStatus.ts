export type MeterLevel = "ok" | "low" | "critical" | "out" | "unavailable";
export type MeterLabel = "Available" | "Running low" | "Nearly exhausted" | "Exhausted" | "Unavailable";

/** Percent left above which each row holds, checked top down. A level is the CSS tone
 *  (`--tone-<level>`), so the dot, the label and the bar cannot disagree with the words. */
const METER_STATUSES: ReadonlyArray<{ above: number; level: MeterLevel; label: MeterLabel }> = [
  { above: 45, level: "ok", label: "Available" },
  { above: 20, level: "low", label: "Running low" },
  { above: 0, level: "critical", label: "Nearly exhausted" },
];

export const meterStatus = (left: number | null): { level: MeterLevel; label: MeterLabel } => {
  if (left === null) return { level: "unavailable", label: "Unavailable" };
  const row = METER_STATUSES.find((status) => left > status.above);
  return row ? { level: row.level, label: row.label } : { level: "out", label: "Exhausted" };
};
