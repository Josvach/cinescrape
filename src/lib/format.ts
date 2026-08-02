const CZ = "cs-CZ";

export const num = (v: number) => new Intl.NumberFormat(CZ).format(Math.round(v));

export const pct = (v: number, digits = 0) =>
  new Intl.NumberFormat(CZ, { style: "percent", maximumFractionDigits: digits }).format(v);

/** Money in whole crowns, abbreviated once it stops fitting on a phone. */
export function czk(v: number): string {
  if (Math.abs(v) >= 1_000_000) {
    return `${new Intl.NumberFormat(CZ, { maximumFractionDigits: 1 }).format(v / 1_000_000)} mil. Kč`;
  }
  if (Math.abs(v) >= 10_000) {
    return `${new Intl.NumberFormat(CZ, { maximumFractionDigits: 0 }).format(v / 1000)} tis. Kč`;
  }
  return `${num(v)} Kč`;
}

const dayFmt = new Intl.DateTimeFormat(CZ, { day: "numeric", month: "numeric" });
const weekdayFmt = new Intl.DateTimeFormat(CZ, { weekday: "short" });
const timeFmt = new Intl.DateTimeFormat(CZ, {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Prague",
});

/** `YYYY-MM-DD` is a calendar day, so render it without a timezone shift. */
export const dayLabel = (iso: string) => dayFmt.format(new Date(`${iso}T12:00:00Z`));
export const weekdayLabel = (iso: string) => weekdayFmt.format(new Date(`${iso}T12:00:00Z`));

export const timeLabel = (iso: string) => timeFmt.format(new Date(iso));

export const CHAIN_LABELS: Record<string, string> = {
  cinema_city: "Cinema City",
  cinestar: "CineStar",
  golden_apple: "Golden Apple",
};

/** Shifts a `YYYY-MM-DD` day by whole days without tripping over DST. */
export function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
