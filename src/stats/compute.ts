/**
 * Everything the dashboard needs, precomputed into one file.
 *
 * The page is a static document with no backend, so all the aggregation happens
 * here and ships as `live.json`. That keeps the phone doing nothing but drawing.
 */

import { CC_ESTIMATED_TICKET_PRICE_CZK } from "@/ingest/cinemacity";
import { recentCoverage } from "@/ingest/settle";
import { latestTotals } from "@/ingest/ufd";
import { pragueDate } from "@/lib/time";
import type { Article, History, Rating, Screening as Screening0, State } from "@/store/types";

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
  rating?: Rating;
  articles?: Article[];
  /**
   * The film's national run total as last reported by UFD, and how much our
   * live scraping has added since that report.
   */
  official?: {
    admissions: number;
    gross: number;
    /** `YYYY-MM-DD` of the weekend the figure covers. */
    asOf: string;
    /** Measured by us for screening days after that weekend. */
    sinceAdmissions: number;
  };
};

/** One film's line in a published weekly ranking. */
export type OfficialEntry = {
  rank: number;
  title: string;
  filmId?: number;
  distributor: string;
  weekOfRun: number;
  cinemas: number;
  weekendAdmissions: number;
  weekendGross: number;
  totalAdmissions: number;
  totalGross: number;
};

export type OfficialWeek = {
  weekendFrom: string;
  entries: OfficialEntry[];
  totalAdmissions: number;
};

export type LiveDay = {
  day: string;
  admissions: number;
  seatsOffered: number;
  screenings: number;
  past: boolean;
};

export type Screening = {
  film: string;
  filmId: number;
  cinema: string;
  hall: string;
  startsAt: string;
  admissions: number;
  capacity: number;
};

/** A film's standing on today alone, which is a different ranking from its run. */
export type TodayFilm = {
  id: number;
  title: string;
  admissions: number;
  screenings: number;
  seatsOffered: number;
  occupancy: number;
};

/**
 * Today is the headline.
 *
 * A film's cumulative total barely moves hour to hour, so it makes a poor thing
 * to open on. What changed since this morning is the question a live tracker
 * is for, and everything cumulative sits below it.
 */
export type Today = {
  admissions: number;
  seatsOffered: number;
  occupancy: number;
  screenings: number;
  screeningsDone: number;
  sellouts: number;
  gross: number;
  filmmaker: number;
  /** Tickets sold during each hour of today, for any screening day. */
  ramp: { at: string; sold: number }[];
  soldToday: number;
  films: TodayFilm[];
  fullest: Screening[];
  /** The next few screenings that have not started yet. */
  upcoming: Screening[];
};

export type Live = {
  generatedAt: string;
  /** `YYYY-MM-DD` in Prague. */
  date: string;
  today: Today;
  totals: {
    week: number;
    presale: number;
    gross: number;
    filmmaker: number;
  };
  days: LiveDay[];
  films: LiveFilm[];
  ramp: { at: string; sold: number }[];
  coverage: { total: number; missed: number; partial: number };
  /** The most recent published weekly ranking, if we have one. */
  official?: OfficialWeek;
};

/** Admissions for a screening: frozen if it has run, live presale if not. */
const admissionsOf = (s: Screening0) => s.settled?.sold ?? s.sold ?? 0;
const capacityOf = (s: Screening0) => s.settled?.total ?? s.total ?? 0;
const priceOf = (s: Screening0) => s.priceMin ?? CC_ESTIMATED_TICKET_PRICE_CZK;

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

  const filmMeta = (
    id: number,
  ): { title: string; originalTitle: string | null; rating?: Rating; articles?: Article[] } => {
    const known = state.films.find((f) => f.id === id);
    if (known) {
      return {
        title: known.title,
        originalTitle: known.originalTitle,
        rating: known.rating,
        articles: known.articles,
      };
    }
    // A film folded into history keeps its name but loses its live context.
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
        rating: meta.rating,
        articles: meta.articles,
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
  const weekFrom = shiftDay(today, -6);

  // --- official results own everything up to the last published weekend -----
  const officialTotals = latestTotals(history);
  for (const f of films.values()) {
    const official = officialTotals.get(f.id);
    if (!official) continue;
    // Their report covers the weekend and everything before it; our scraping
    // covers the days after. The Monday after the reported weekend is where
    // one hands over to the other.
    const handover = shiftDay(official.weekendFrom, 4);
    const since = Object.entries(f.byDay)
      .filter(([day]) => day >= handover)
      .reduce((sum, [, admissions]) => sum + admissions, 0);
    f.official = {
      admissions: official.admissions,
      gross: official.gross,
      asOf: official.weekendFrom,
      sinceAdmissions: since,
    };
  }

  const filmList = [...films.values()]
    .filter((f) => f.admissions > 0)
    // Rank on the best figure available for each film: the official run total
    // plus what we have measured since, falling back to our own count.
    .sort((a, b) => totalOf(b) - totalOf(a));

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    today: computeToday(state, today, rampTotals, filmMeta),
    totals: {
      week: dayList
        .filter((d) => d.day >= weekFrom && d.day <= today)
        .reduce((s, d) => s + d.admissions, 0),
      presale: dayList.filter((d) => d.day > today).reduce((s, d) => s + d.admissions, 0),
      gross: filmList.reduce((s, f) => s + f.gross, 0),
      filmmaker: filmList.reduce((s, f) => s + f.filmmaker, 0),
    },
    days: dayList,
    films: filmList,
    ramp: rampTotals,
    coverage: recentCoverage(state, history, 7),
    official: latestOfficialWeek(history),
  };
}

/** Best available run total: official plus what we have measured since. */
export const totalOf = (f: LiveFilm): number =>
  f.official ? f.official.admissions + f.official.sinceAdmissions : f.admissions;

function latestOfficialWeek(history: History): OfficialWeek | undefined {
  const weeks = Object.values(history.ufd ?? {})
    .filter((w) => w.weekendFrom)
    .sort((a, b) => a.weekendFrom.localeCompare(b.weekendFrom));
  const latest = weeks[weeks.length - 1];
  if (!latest) return undefined;

  return {
    weekendFrom: latest.weekendFrom,
    entries: latest.entries,
    totalAdmissions: latest.entries.reduce((s, e) => s + e.weekendAdmissions, 0),
  };
}

function describe(state: State, s: Screening0, title: string): Screening {
  return {
    film: title,
    filmId: s.filmId,
    cinema: state.cinemas[state.halls[s.hallKey]?.cinemaKey ?? ""]?.name ?? "",
    hall: state.halls[s.hallKey]?.name ?? "",
    startsAt: s.startsAt,
    admissions: admissionsOf(s),
    capacity: capacityOf(s),
  };
}

function computeToday(
  state: State,
  today: string,
  ramp: { at: string; sold: number }[],
  meta: (id: number) => { title: string },
): Today {
  const now = Date.now();
  const screenings = Object.values(state.screenings).filter((s) => s.day === today);

  const perFilm = new Map<number, TodayFilm>();
  let admissions = 0;
  let seatsOffered = 0;
  let sellouts = 0;
  let done = 0;
  let gross = 0;

  for (const s of screenings) {
    const sold = admissionsOf(s);
    const capacity = capacityOf(s);
    admissions += sold;
    seatsOffered += capacity;
    gross += sold * priceOf(s);
    if (s.soldOut) sellouts += 1;
    if (new Date(s.startsAt).getTime() <= now) done += 1;

    const f = perFilm.get(s.filmId) ?? {
      id: s.filmId,
      title: meta(s.filmId).title,
      admissions: 0,
      screenings: 0,
      seatsOffered: 0,
      occupancy: 0,
    };
    f.admissions += sold;
    f.screenings += 1;
    f.seatsOffered += capacity;
    perFilm.set(s.filmId, f);
  }

  for (const f of perFilm.values()) {
    f.occupancy = f.seatsOffered > 0 ? f.admissions / f.seatsOffered : 0;
  }

  // Sales made today, whichever day they are for — this is the "what is
  // happening right now" trend, not a breakdown of today's screenings.
  const todayHours = ramp.filter((b) => b.at.slice(0, 10) === today);

  const withCapacity = screenings.filter((s) => capacityOf(s) >= 40);

  return {
    admissions,
    seatsOffered,
    occupancy: seatsOffered > 0 ? admissions / seatsOffered : 0,
    screenings: screenings.length,
    screeningsDone: done,
    sellouts,
    gross,
    filmmaker: Math.round(gross * FILMMAKER_SHARE),
    ramp: todayHours,
    soldToday: todayHours.reduce((s, b) => s + b.sold, 0),
    // Capped so the today section stays scannable on a phone; the complete
    // list is right below it under the cumulative view.
    films: [...perFilm.values()]
      .filter((f) => f.admissions > 0)
      .sort((a, b) => b.admissions - a.admissions)
      .slice(0, 10),
    fullest: withCapacity
      .map((s) => describe(state, s, meta(s.filmId).title))
      .sort((a, b) => b.admissions / b.capacity - a.admissions / a.capacity)
      .slice(0, 8),
    upcoming: screenings
      .filter((s) => new Date(s.startsAt).getTime() > now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((s) => describe(state, s, meta(s.filmId).title))
      .slice(0, 8),
  };
}
