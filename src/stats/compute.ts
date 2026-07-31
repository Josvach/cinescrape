/**
 * Everything the dashboard needs, precomputed into one file.
 *
 * The page is a static document with no backend, so all the aggregation happens
 * here and ships as `live.json`. That keeps the phone doing nothing but drawing.
 */

import { CC_ESTIMATED_TICKET_PRICE_CZK } from "@/ingest/cinemacity";
import { recentCoverage } from "@/ingest/settle";
import { pragueDate } from "@/lib/time";
import type { History, Screening, State } from "@/store/types";

/**
 * Share of box office reaching the production side. Real Czech distribution
 * splits vary by film and by week of run; 50% is the rule of thumb, exposed as
 * one clearly-labelled assumption rather than a hidden model.
 */
export const FILMMAKER_SHARE = 0.5;

/** Days of past and future shown on the daily chart. */
const WINDOW_BACK = 13;
const WINDOW_FORWARD = 13;

export type LiveFilm = {
  id: number;
  title: string;
  originalTitle: string | null;
  admissions: number;
  upcoming: number;
  screenings: number;
  seatsOffered: number;
  occupancy: number;
  gross: number;
  filmmaker: number;
  sellouts: number;
  cinemas: number;
  perScreening: number;
  /** Admissions by screening day, for the film's own chart. */
  byDay: Record<string, number>;
  chains: Record<string, { admissions: number; seatsOffered: number }>;
  formats: Record<string, { admissions: number; seatsOffered: number }>;
  topCinemas: { name: string; admissions: number; seatsOffered: number }[];
  /** Hourly measured sales, `YYYY-MM-DDTHH` → tickets. */
  ramp: Record<string, number>;
};

export type LiveDay = {
  day: string;
  admissions: number;
  seatsOffered: number;
  screenings: number;
  past: boolean;
};

export type Live = {
  generatedAt: string;
  today: string;
  totals: {
    today: number;
    week: number;
    upcoming: number;
    gross: number;
    filmmaker: number;
    todaySeatsOffered: number;
  };
  days: LiveDay[];
  films: LiveFilm[];
  ramp: { at: string; sold: number }[];
  coverage: { total: number; missed: number; partial: number };
  fullest: {
    film: string;
    cinema: string;
    hall: string;
    startsAt: string;
    admissions: number;
    capacity: number;
  }[];
};

/** Admissions for a screening: frozen if it has run, live presale if not. */
const admissionsOf = (s: Screening) => s.settled?.sold ?? s.sold ?? 0;
const capacityOf = (s: Screening) => s.settled?.total ?? s.total ?? 0;
const priceOf = (s: Screening) => s.priceMin ?? CC_ESTIMATED_TICKET_PRICE_CZK;

const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const CHAIN_LABELS: Record<string, string> = {
  cinema_city: "Cinema City",
  cinestar: "CineStar",
};

export function computeLive(state: State, history: History): Live {
  const today = pragueDate();
  const from = shiftDay(today, -WINDOW_BACK);
  const to = shiftDay(today, WINDOW_FORWARD);

  const films = new Map<number, LiveFilm>();
  const days = new Map<string, LiveDay>();
  const cinemaTotals = new Map<number, Map<string, { admissions: number; seatsOffered: number }>>();

  const filmMeta = (id: number) => {
    const known = state.films.find((f) => f.id === id);
    if (known) return { title: known.title, originalTitle: known.originalTitle };
    const fromHistory = history.films[String(id)];
    return fromHistory ?? { title: `#${id}`, originalTitle: null };
  };

  const ensureFilm = (id: number): LiveFilm => {
    let f = films.get(id);
    if (!f) {
      const meta = filmMeta(id);
      f = {
        id,
        title: meta.title,
        originalTitle: meta.originalTitle,
        admissions: 0,
        upcoming: 0,
        screenings: 0,
        seatsOffered: 0,
        occupancy: 0,
        gross: 0,
        filmmaker: 0,
        sellouts: 0,
        cinemas: 0,
        perScreening: 0,
        byDay: {},
        chains: {},
        formats: {},
        topCinemas: [],
        ramp: {},
      };
      films.set(id, f);
    }
    return f;
  };

  const now = Date.now();

  // --- live working set -----------------------------------------------------
  for (const s of Object.values(state.screenings)) {
    if (s.day < from || s.day > to) continue;

    const admissions = admissionsOf(s);
    const capacity = capacityOf(s);
    const f = ensureFilm(s.filmId);

    f.admissions += admissions;
    f.screenings += 1;
    f.seatsOffered += capacity;
    f.gross += admissions * priceOf(s);
    if (s.soldOut) f.sellouts += 1;
    if (new Date(s.startsAt).getTime() > now) f.upcoming += admissions;
    f.byDay[s.day] = (f.byDay[s.day] ?? 0) + admissions;

    const chainLabel = CHAIN_LABELS[s.chain] ?? s.chain;
    const chain = (f.chains[chainLabel] ??= { admissions: 0, seatsOffered: 0 });
    chain.admissions += admissions;
    chain.seatsOffered += capacity;

    const formatLabel = s.formats.length ? s.formats.join(" + ") : "2D";
    const format = (f.formats[formatLabel] ??= { admissions: 0, seatsOffered: 0 });
    format.admissions += admissions;
    format.seatsOffered += capacity;

    const cinemaName = state.cinemas[state.halls[s.hallKey]?.cinemaKey ?? ""]?.name;
    if (cinemaName) {
      const perFilm = cinemaTotals.get(s.filmId) ?? new Map();
      const entry = perFilm.get(cinemaName) ?? { admissions: 0, seatsOffered: 0 };
      entry.admissions += admissions;
      entry.seatsOffered += capacity;
      perFilm.set(cinemaName, entry);
      cinemaTotals.set(s.filmId, perFilm);
    }

    const day = days.get(s.day) ?? {
      day: s.day,
      admissions: 0,
      seatsOffered: 0,
      screenings: 0,
      past: s.day < today,
    };
    day.admissions += admissions;
    day.seatsOffered += capacity;
    day.screenings += 1;
    days.set(s.day, day);
  }

  // --- folded history -------------------------------------------------------
  for (const [day, d] of Object.entries(history.days)) {
    if (day < from || day > to) continue;
    for (const [id, t] of Object.entries(d.films)) {
      const f = ensureFilm(Number(id));
      f.admissions += t.sold;
      f.screenings += t.screenings;
      f.seatsOffered += t.capacity;
      f.gross += t.gross;
      f.byDay[day] = (f.byDay[day] ?? 0) + t.sold;
    }
    const totals = Object.values(d.films).reduce(
      (acc, t) => {
        acc.admissions += t.sold;
        acc.seatsOffered += t.capacity;
        acc.screenings += t.screenings;
        return acc;
      },
      { admissions: 0, seatsOffered: 0, screenings: 0 },
    );
    const existing = days.get(day) ?? {
      day,
      admissions: 0,
      seatsOffered: 0,
      screenings: 0,
      past: true,
    };
    existing.admissions += totals.admissions;
    existing.seatsOffered += totals.seatsOffered;
    existing.screenings += totals.screenings;
    days.set(day, existing);
  }

  // --- ramp -----------------------------------------------------------------
  const rampTotals: { at: string; sold: number }[] = [];
  for (const bucket of state.ramp) {
    let total = 0;
    for (const [id, sold] of Object.entries(bucket.byFilm)) {
      total += sold;
      const f = films.get(Number(id));
      if (f) f.ramp[bucket.at] = sold;
    }
    if (total > 0) rampTotals.push({ at: bucket.at, sold: total });
  }

  // --- derived --------------------------------------------------------------
  for (const f of films.values()) {
    f.occupancy = f.seatsOffered > 0 ? f.admissions / f.seatsOffered : 0;
    f.perScreening = f.screenings > 0 ? f.admissions / f.screenings : 0;
    f.filmmaker = Math.round(f.gross * FILMMAKER_SHARE);
    const perFilm = cinemaTotals.get(f.id);
    f.cinemas = perFilm?.size ?? 0;
    f.topCinemas = [...(perFilm?.entries() ?? [])]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.admissions - a.admissions)
      .slice(0, 10);
  }

  const dayList = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const todayRow = dayList.find((d) => d.day === today);
  const weekFrom = shiftDay(today, -6);

  const filmList = [...films.values()]
    .filter((f) => f.admissions > 0)
    .sort((a, b) => b.admissions - a.admissions);

  return {
    generatedAt: new Date().toISOString(),
    today,
    totals: {
      today: todayRow?.admissions ?? 0,
      todaySeatsOffered: todayRow?.seatsOffered ?? 0,
      week: dayList
        .filter((d) => d.day >= weekFrom && d.day <= today)
        .reduce((s, d) => s + d.admissions, 0),
      upcoming: dayList.filter((d) => d.day > today).reduce((s, d) => s + d.admissions, 0),
      gross: filmList.reduce((s, f) => s + f.gross, 0),
      filmmaker: filmList.reduce((s, f) => s + f.filmmaker, 0),
    },
    days: dayList,
    films: filmList,
    ramp: rampTotals,
    coverage: recentCoverage(state, history, 7),
    fullest: fullestScreenings(state, today),
  };
}

/** The packed shows — a different question from which film sold most overall. */
function fullestScreenings(state: State, today: string, limit = 15) {
  return Object.values(state.screenings)
    .filter((s) => capacityOf(s) >= 50 && s.day >= shiftDay(today, -2) && s.day <= today)
    .map((s) => ({
      film: state.films.find((f) => f.id === s.filmId)?.title ?? `#${s.filmId}`,
      cinema: state.cinemas[state.halls[s.hallKey]?.cinemaKey ?? ""]?.name ?? "",
      hall: state.halls[s.hallKey]?.name ?? "",
      startsAt: s.startsAt,
      admissions: admissionsOf(s),
      capacity: capacityOf(s),
    }))
    .sort((a, b) => b.admissions / b.capacity - a.admissions / a.capacity)
    .slice(0, limit);
}
