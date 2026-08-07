/**
 * Everything the dashboard needs, precomputed into one file.
 *
 * The page is a static document with no backend, so all the aggregation happens
 * here and ships as `live.json`. That keeps the phone doing nothing but drawing.
 *
 * The shape follows what each source is actually good for:
 *
 *   today   scraped, minutes old, the only place live data beats the official
 *           numbers and therefore the reason the scraping exists at all
 *   week    scraped, since Monday — the stretch UFD has not reported on yet
 *   allTime official UFD only, because for anything settled their national
 *           figures are simply better than our two-chain sample
 */

import { CC_ESTIMATED_TICKET_PRICE_CZK } from "@/ingest/cinemacity";
import { recentCoverage } from "@/ingest/settle";
import { allTimeRanking, latestTotals, runSeries, type AllTimeEntry } from "@/ingest/ufd";
import { CHAIN_LABELS } from "@/lib/format";
import { pragueDate } from "@/lib/time";
import { forecast, originOf, type Forecast } from "./forecast";
import type { Article, History, Rating, Screening as Stored, State } from "@/store/types";

// --- shared shapes ---------------------------------------------------------

export type Screening = {
  film: string;
  filmId: number;
  cinema: string;
  hall: string;
  startsAt: string;
  admissions: number;
  capacity: number;
};

export type DayPoint = {
  day: string;
  admissions: number;
  seatsOffered: number;
  screenings: number;
  past: boolean;
};

/** A film's standing within one period. */
export type PeriodFilm = {
  id: number;
  title: string;
  admissions: number;
  screenings: number;
  seatsOffered: number;
  occupancy: number;
};

export type Today = {
  admissions: number;
  seatsOffered: number;
  occupancy: number;
  screenings: number;
  screeningsDone: number;
  sellouts: number;
  gross: number;
  /** Tickets sold during each hour of today, for any screening day. */
  ramp: { at: string; sold: number }[];
  soldToday: number;
  /** Tickets sold in the most recent completed hour. */
  soldLastHour: number;
  films: PeriodFilm[];
  fullest: Screening[];
  upcoming: Screening[];
};

export type Week = {
  /** `YYYY-MM-DD` of Monday. */
  from: string;
  to: string;
  admissions: number;
  seatsOffered: number;
  occupancy: number;
  screenings: number;
  gross: number;
  /** Already sold for the rest of the week. */
  presale: number;
  days: DayPoint[];
  films: PeriodFilm[];
  ramp: { at: string; sold: number }[];
};

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

export type AllTime = {
  weekendFrom?: string;
  weekendTotal: number;
  /** The published top 20 for that weekend. */
  weekend: OfficialEntry[];
  /** Most successful releases since the archive begins. */
  ranking: AllTimeEntry[];
  weeksStored: number;
  archiveFrom?: string;
};

export type LiveFilm = {
  id: number;
  title: string;
  originalTitle: string | null;
  today: PeriodFilm;
  week: PeriodFilm & { byDay: Record<string, number> };
  /** Official national run total, when the film has appeared in a top 20. */
  official?: { admissions: number; gross: number; asOf: string; sinceAdmissions: number };
  /** Projected final admissions for the run; absent until UFD has reported it. */
  forecast?: Forecast;
  cinemas: number;
  sellouts: number;
  presale: number;
  chains: Record<string, { admissions: number; seatsOffered: number }>;
  formats: Record<string, { admissions: number; seatsOffered: number }>;
  topCinemas: { name: string; admissions: number; seatsOffered: number }[];
  todayScreenings: Screening[];
  /** Hourly measured sales, `YYYY-MM-DDTHH` → tickets. */
  ramp: Record<string, number>;
  rating?: Rating;
  articles?: Article[];
};

export type Live = {
  generatedAt: string;
  /** `YYYY-MM-DD` in Prague. */
  date: string;
  today: Today;
  week: Week;
  allTime: AllTime;
  films: LiveFilm[];
  coverage: { total: number; missed: number; partial: number };
};

// --- helpers ---------------------------------------------------------------

const admissionsOf = (s: Stored) => s.settled?.sold ?? s.sold ?? 0;
const capacityOf = (s: Stored) => s.settled?.total ?? s.total ?? 0;
const priceOf = (s: Stored) => s.priceMin ?? CC_ESTIMATED_TICKET_PRICE_CZK;

const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Monday of the week a given day falls in. */
export function startOfWeek(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.getUTCDay();
  return shiftDay(iso, dow === 0 ? -6 : 1 - dow);
}

const emptyPeriod = (id: number, title: string): PeriodFilm => ({
  id,
  title,
  admissions: 0,
  screenings: 0,
  seatsOffered: 0,
  occupancy: 0,
});

const finish = (p: PeriodFilm) => {
  p.occupancy = p.seatsOffered > 0 ? p.admissions / p.seatsOffered : 0;
  return p;
};

// --- main ------------------------------------------------------------------

export function computeLive(state: State, history: History): Live {
  const today = pragueDate();
  const weekFrom = startOfWeek(today);
  const weekTo = shiftDay(weekFrom, 6);
  const now = Date.now();

  const meta = (id: number) => {
    const known = state.films.find((f) => f.id === id);
    if (known) return known;
    const folded = history.films[String(id)];
    return folded
      ? { id, title: folded.title, originalTitle: folded.originalTitle }
      : { id, title: `#${id}`, originalTitle: null };
  };

  const films = new Map<number, LiveFilm>();
  const ensure = (id: number): LiveFilm => {
    let f = films.get(id);
    if (!f) {
      const m = meta(id) as { title: string; originalTitle: string | null; rating?: Rating; articles?: Article[] };
      f = {
        id,
        title: m.title,
        originalTitle: m.originalTitle,
        today: emptyPeriod(id, m.title),
        week: { ...emptyPeriod(id, m.title), byDay: {} },
        cinemas: 0,
        sellouts: 0,
        presale: 0,
        chains: {},
        formats: {},
        topCinemas: [],
        todayScreenings: [],
        ramp: {},
        rating: m.rating,
        articles: m.articles,
      };
      films.set(id, f);
    }
    return f;
  };

  const describe = (s: Stored, title: string): Screening => ({
    film: title,
    filmId: s.filmId,
    cinema: state.cinemas[state.halls[s.hallKey]?.cinemaKey ?? ""]?.name ?? "",
    hall: state.halls[s.hallKey]?.name ?? "",
    startsAt: s.startsAt,
    admissions: admissionsOf(s),
    capacity: capacityOf(s),
  });

  // --- one pass over the working set ---------------------------------------
  const todayAgg = { admissions: 0, seats: 0, screenings: 0, done: 0, sellouts: 0, gross: 0 };
  const weekAgg = { admissions: 0, seats: 0, screenings: 0, gross: 0, presale: 0 };
  const days = new Map<string, DayPoint>();
  const cinemasPerFilm = new Map<number, Map<string, { admissions: number; seatsOffered: number }>>();
  const todayScreenings: Screening[] = [];

  // Concerts and opera relays are sold like screenings but are not films, and
  // a Cirque du Soleil that sold out a month ago would top a ranking of how
  // films are doing this week.
  const notFilm = new Set(state.films.filter((f) => f.kind === "event").map((f) => f.id));

  for (const s of Object.values(state.screenings)) {
    if (notFilm.has(s.filmId)) continue;
    const inWeek = s.day >= weekFrom && s.day <= weekTo;
    const isToday = s.day === today;
    if (!inWeek && !isToday) continue;

    const sold = admissionsOf(s);
    const capacity = capacityOf(s);
    const started = new Date(s.startsAt).getTime() <= now;
    const f = ensure(s.filmId);

    if (isToday) {
      todayAgg.admissions += sold;
      todayAgg.seats += capacity;
      todayAgg.screenings += 1;
      todayAgg.gross += sold * priceOf(s);
      if (started) todayAgg.done += 1;
      if (s.soldOut) todayAgg.sellouts += 1;

      f.today.admissions += sold;
      f.today.screenings += 1;
      f.today.seatsOffered += capacity;

      const described = describe(s, f.title);
      todayScreenings.push(described);
      f.todayScreenings.push(described);
    }

    if (!inWeek) continue;

    weekAgg.admissions += sold;
    weekAgg.seats += capacity;
    weekAgg.screenings += 1;
    weekAgg.gross += sold * priceOf(s);
    if (!started) weekAgg.presale += sold;

    f.week.admissions += sold;
    f.week.screenings += 1;
    f.week.seatsOffered += capacity;
    f.week.byDay[s.day] = (f.week.byDay[s.day] ?? 0) + sold;
    if (s.soldOut) f.sellouts += 1;
    if (!started) f.presale += sold;

    const chain = (f.chains[CHAIN_LABELS[s.chain] ?? s.chain] ??= {
      admissions: 0,
      seatsOffered: 0,
    });
    chain.admissions += sold;
    chain.seatsOffered += capacity;

    const format = (f.formats[s.formats.length ? s.formats.join(" + ") : "2D"] ??= {
      admissions: 0,
      seatsOffered: 0,
    });
    format.admissions += sold;
    format.seatsOffered += capacity;

    const cinemaName = state.cinemas[state.halls[s.hallKey]?.cinemaKey ?? ""]?.name;
    if (cinemaName) {
      const per = cinemasPerFilm.get(s.filmId) ?? new Map();
      const entry = per.get(cinemaName) ?? { admissions: 0, seatsOffered: 0 };
      entry.admissions += sold;
      entry.seatsOffered += capacity;
      per.set(cinemaName, entry);
      cinemasPerFilm.set(s.filmId, per);
    }

    const day = days.get(s.day) ?? {
      day: s.day,
      admissions: 0,
      seatsOffered: 0,
      screenings: 0,
      past: s.day < today,
    };
    day.admissions += sold;
    day.seatsOffered += capacity;
    day.screenings += 1;
    days.set(s.day, day);
  }

  // --- ramp ----------------------------------------------------------------
  const rampAll: { at: string; sold: number }[] = [];
  for (const bucket of state.ramp) {
    let total = 0;
    for (const [id, sold] of Object.entries(bucket.byFilm)) {
      total += sold;
      const f = films.get(Number(id));
      if (f) f.ramp[bucket.at] = sold;
    }
    if (total > 0) rampAll.push({ at: bucket.at, sold: total });
  }
  const todayRamp = rampAll.filter((b) => b.at.slice(0, 10) === today);
  const weekRamp = rampAll.filter((b) => b.at.slice(0, 10) >= weekFrom);

  // --- planned-screen trend, from our own schedule --------------------------
  // How a film's screen count is about to move: screenings booked for the next
  // seven days against those in the last seven. This is the forward signal UFD
  // cannot give, and it feeds the forecast's screen elasticity, where it is
  // measured against the normal weekly decline — screens always fall, so only a
  // faster or slower fall than usual counts. A ratio built from our three-chain
  // sample is robust where an absolute count would not be: the sampling
  // fraction cancels top and bottom.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const screenWindow = new Map<number, { past: number; next: number }>();
  for (const s of Object.values(state.screenings)) {
    const t = new Date(s.startsAt).getTime();
    const bucket = t >= now - WEEK_MS && t < now ? "past" : t >= now && t < now + WEEK_MS ? "next" : null;
    if (!bucket) continue;
    const w = screenWindow.get(s.filmId) ?? { past: 0, next: 0 };
    w[bucket] += 1;
    screenWindow.set(s.filmId, w);
  }
  // Too few screenings to trust a ratio is worse than no ratio at all.
  const MIN_SCREENINGS_FOR_TREND = 8;
  const plannedScreenRatio = (filmId: number): number | undefined => {
    const w = screenWindow.get(filmId);
    if (!w || w.past < MIN_SCREENINGS_FOR_TREND) return undefined;
    return w.next / w.past;
  };

  // --- official ------------------------------------------------------------
  const officialTotals = latestTotals(history);
  const series = runSeries(history);
  for (const f of films.values()) {
    const official = officialTotals.get(f.id);
    if (!official) continue;
    // Their report covers the weekend and everything before it; the Monday
    // after is where our measurement takes over.
    const handover = shiftDay(official.weekendFrom, 4);
    const since = Object.entries(f.week.byDay)
      .filter(([day]) => day >= handover)
      .reduce((sum, [, admissions]) => sum + admissions, 0);
    f.official = {
      admissions: official.admissions,
      gross: official.gross,
      asOf: official.weekendFrom,
      sinceAdmissions: since,
    };

    const run = series.get(f.id);
    if (run?.points.length) {
      const origin = originOf({ country: run.country, title: f.title, originalTitle: f.originalTitle });
      f.forecast =
        forecast(origin, run.points, { plannedScreenRatio: plannedScreenRatio(f.id) }) ?? undefined;
    }
  }

  for (const f of films.values()) {
    finish(f.today);
    finish(f.week);
    const per = cinemasPerFilm.get(f.id);
    f.cinemas = per?.size ?? 0;
    f.topCinemas = [...(per?.entries() ?? [])]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.admissions - a.admissions)
      .slice(0, 10);
    f.todayScreenings.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  const weeks = Object.values(history.ufd ?? {})
    .filter((w) => w.weekendFrom)
    .sort((a, b) => a.weekendFrom.localeCompare(b.weekendFrom));
  const lastWeek = weeks[weeks.length - 1];

  const lastCompleteHour = todayRamp.length >= 2 ? todayRamp[todayRamp.length - 2].sold : 0;

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    today: {
      admissions: todayAgg.admissions,
      seatsOffered: todayAgg.seats,
      occupancy: todayAgg.seats > 0 ? todayAgg.admissions / todayAgg.seats : 0,
      screenings: todayAgg.screenings,
      screeningsDone: todayAgg.done,
      sellouts: todayAgg.sellouts,
      gross: todayAgg.gross,
      ramp: todayRamp,
      soldToday: todayRamp.reduce((s, b) => s + b.sold, 0),
      soldLastHour: lastCompleteHour,
      films: [...films.values()]
        .map((f) => f.today)
        .filter((f) => f.admissions > 0)
        .sort((a, b) => b.admissions - a.admissions),
      fullest: todayScreenings
        .filter((s) => s.capacity >= 40)
        .sort((a, b) => b.admissions / b.capacity - a.admissions / a.capacity)
        .slice(0, 10),
      upcoming: todayScreenings
        .filter((s) => new Date(s.startsAt).getTime() > now)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .slice(0, 10),
    },
    week: {
      from: weekFrom,
      to: weekTo,
      admissions: weekAgg.admissions,
      seatsOffered: weekAgg.seats,
      occupancy: weekAgg.seats > 0 ? weekAgg.admissions / weekAgg.seats : 0,
      screenings: weekAgg.screenings,
      gross: weekAgg.gross,
      presale: weekAgg.presale,
      // Always the full Monday-to-Sunday span. Showing only the days we have
      // data for would silently redraw the axis as the week fills in, and hide
      // that the early days were never measured.
      days: Array.from({ length: 7 }, (_, i) => {
        const day = shiftDay(weekFrom, i);
        return (
          days.get(day) ?? {
            day,
            admissions: 0,
            seatsOffered: 0,
            screenings: 0,
            past: day < today,
          }
        );
      }),
      films: [...films.values()]
        .map((f) => f.week)
        .filter((f) => f.admissions > 0)
        .sort((a, b) => b.admissions - a.admissions),
      ramp: weekRamp,
    },
    allTime: {
      weekendFrom: lastWeek?.weekendFrom,
      weekendTotal: lastWeek?.entries.reduce((s, e) => s + e.weekendAdmissions, 0) ?? 0,
      weekend: lastWeek?.entries ?? [],
      ranking: allTimeRanking(history, 100),
      weeksStored: weeks.length,
      archiveFrom: weeks[0]?.weekendFrom,
    },
    films: [...films.values()].sort((a, b) => b.week.admissions - a.week.admissions),
    coverage: recentCoverage(state, history, 7),
  };
}
