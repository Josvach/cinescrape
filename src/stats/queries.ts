import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CC_ESTIMATED_TICKET_PRICE_CZK } from "@/ingest/cinemacity";
import { DEFAULT_FORMAT } from "@/sources/formats";

/**
 * Share of box office that reaches the production side. Czech distribution
 * splits vary by film and by week of run; 50% is the rule of thumb the product
 * exposes as a single, clearly-labelled assumption rather than a hidden model.
 */
export const FILMMAKER_SHARE = 0.5;

/**
 * Admissions for one screening.
 *
 * A screening that has already run is frozen in `screenings_settled`. One that
 * has not is still selling, and its live count is the presale so far — which is
 * exactly what should show up under its own screening day.
 */
const ADMISSIONS = sql`coalesce(st.seats_sold, s.current_seats_sold, 0)`;

/** Best available per-ticket price: the chain's own where we have it, else our estimate. */
const TICKET_PRICE = sql`coalesce(s.price_min, ${CC_ESTIMATED_TICKET_PRICE_CZK})`;

const GROSS = sql`${ADMISSIONS} * ${TICKET_PRICE}`;

/** Only count capacity for screenings we actually have a reading for. */
const SEATS_OFFERED = sql`case when ${ADMISSIONS} > 0 or s.current_seats_total is not null
  then coalesce(st.seats_total, s.current_seats_total, s.capacity, 0) else 0 end`;

const FROM_SCREENINGS = sql`
  from screenings s
  left join screenings_settled st on st.screening_id = s.id
`;

export type FilmRow = {
  filmId: number;
  title: string;
  originalTitle: string | null;
  admissions: number;
  admissionsToday: number;
  admissionsUpcoming: number;
  screenings: number;
  seatsOffered: number;
  grossCzk: number;
  filmmakerCzk: number;
  occupancy: number;
  sellouts: number;
  cinemas: number;
};

/**
 * Leaderboard over a rolling window of screening days.
 *
 * The window is on the screening day rather than on "now", so a film's number
 * includes tickets already sold for nights that have not happened yet.
 */
export async function getFilmLeaderboard(opts: {
  from: string;
  to: string;
  limit?: number;
}): Promise<FilmRow[]> {
  const rows = await db().execute(sql`
    select
      f.id                                                      as film_id,
      f.title                                                   as title,
      f.original_title                                          as original_title,
      sum(${ADMISSIONS})::int                                   as admissions,
      sum(${ADMISSIONS}) filter (where s.screening_day = current_date)::int as admissions_today,
      sum(${ADMISSIONS}) filter (where s.starts_at > now())::int as admissions_upcoming,
      count(*)::int                                             as screenings,
      sum(${SEATS_OFFERED})::int                                as seats_offered,
      sum(${GROSS})::bigint                                     as gross_czk,
      count(*) filter (where s.sold_out)::int                   as sellouts,
      count(distinct h.cinema_id)::int                          as cinemas
    ${FROM_SCREENINGS}
    join films f on f.id = s.film_id
    join halls h on h.id = s.hall_id
    where s.screening_day between ${opts.from} and ${opts.to}
    group by f.id, f.title, f.original_title
    having sum(${ADMISSIONS}) > 0
    order by admissions desc
    limit ${opts.limit ?? 50}
  `);

  return (rows.rows as Record<string, unknown>[]).map(toFilmRow);
}

function toFilmRow(r: Record<string, unknown>): FilmRow {
  const admissions = Number(r.admissions ?? 0);
  const seatsOffered = Number(r.seats_offered ?? 0);
  const grossCzk = Number(r.gross_czk ?? 0);
  return {
    filmId: Number(r.film_id),
    title: String(r.title),
    originalTitle: (r.original_title as string) || null,
    admissions,
    admissionsToday: Number(r.admissions_today ?? 0),
    admissionsUpcoming: Number(r.admissions_upcoming ?? 0),
    screenings: Number(r.screenings ?? 0),
    seatsOffered,
    grossCzk,
    filmmakerCzk: Math.round(grossCzk * FILMMAKER_SHARE),
    occupancy: seatsOffered > 0 ? admissions / seatsOffered : 0,
    sellouts: Number(r.sellouts ?? 0),
    cinemas: Number(r.cinemas ?? 0),
  };
}

export type DayPoint = {
  day: string;
  admissions: number;
  seatsOffered: number;
  screenings: number;
  /** True once the day is over: the number stops moving. */
  settled: boolean;
};

/**
 * Admissions by screening day.
 *
 * Future days are not projections — they are tickets already paid for. That is
 * what makes the right-hand side of this chart worth looking at.
 */
export async function getDailySeries(opts: {
  from: string;
  to: string;
  filmId?: number;
}): Promise<DayPoint[]> {
  const filmFilter = opts.filmId ? sql`and s.film_id = ${opts.filmId}` : sql``;
  const rows = await db().execute(sql`
    select
      s.screening_day::text                     as day,
      sum(${ADMISSIONS})::int                   as admissions,
      sum(${SEATS_OFFERED})::int                as seats_offered,
      count(*)::int                             as screenings,
      bool_and(st.screening_id is not null)     as settled
    ${FROM_SCREENINGS}
    where s.screening_day between ${opts.from} and ${opts.to}
    ${filmFilter}
    group by s.screening_day
    order by s.screening_day
  `);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    day: String(r.day),
    admissions: Number(r.admissions ?? 0),
    seatsOffered: Number(r.seats_offered ?? 0),
    screenings: Number(r.screenings ?? 0),
    settled: Boolean(r.settled),
  }));
}

export type RampPoint = { at: string; sold: number; cumulative: number };
export type SalesRamp = {
  /** Tickets already sold when we first observed these screenings. */
  baseline: number;
  points: RampPoint[];
};

/**
 * The sales ramp: how tickets accumulated in real time.
 *
 * Summing raw snapshot values per bucket would double-count, because every
 * screening is snapshotted repeatedly. Differencing each screening against its
 * own previous snapshot and summing those deltas gives the true number of seats
 * sold in each interval.
 *
 * The first snapshot of a screening is deliberately excluded from those rates.
 * It represents every ticket sold before we started watching, so counting it as
 * an hour of sales would invent a spike that never happened — and would make
 * "fastest hour" meaningless on any newly tracked film. It is returned
 * separately as the baseline the curve starts from.
 */
export async function getSalesRamp(opts: {
  filmId?: number;
  hours?: number;
}): Promise<SalesRamp> {
  const filmFilter = opts.filmId ? sql`and s.film_id = ${opts.filmId}` : sql``;
  const hours = opts.hours ?? 24 * 14;

  const rows = await db().execute(sql`
    with observations as (
      select
        sn.screening_id,
        sn.captured_at,
        sn.seats_sold,
        lag(sn.seats_sold) over (partition by sn.screening_id order by sn.captured_at) as prev
      from screening_snapshots sn
      join screenings s on s.id = sn.screening_id
      where sn.captured_at > now() - make_interval(hours => ${hours})
      ${filmFilter}
    )
    select
      date_trunc('hour', captured_at)::text                      as at,
      sum(greatest(seats_sold - prev, 0)) filter (where prev is not null)::int as sold,
      sum(seats_sold) filter (where prev is null)::int           as baseline
    from observations
    group by 1
    order by 1
  `);

  let cumulative = 0;
  let baseline = 0;
  const points = (rows.rows as Record<string, unknown>[]).map((r) => {
    const sold = Number(r.sold ?? 0);
    // A screening discovered mid-window adds its backlog to the running total
    // without being reported as that hour's sales rate.
    baseline += Number(r.baseline ?? 0);
    cumulative += sold + Number(r.baseline ?? 0);
    return { at: String(r.at), sold, cumulative };
  });

  return { baseline, points };
}

export type Breakdown = { label: string; admissions: number; seatsOffered: number };

async function breakdown(dimension: ReturnType<typeof sql>, opts: {
  from: string;
  to: string;
  filmId?: number;
  join?: ReturnType<typeof sql>;
}): Promise<Breakdown[]> {
  const filmFilter = opts.filmId ? sql`and s.film_id = ${opts.filmId}` : sql``;
  const rows = await db().execute(sql`
    select
      ${dimension}                as label,
      sum(${ADMISSIONS})::int     as admissions,
      sum(${SEATS_OFFERED})::int  as seats_offered
    ${FROM_SCREENINGS}
    ${opts.join ?? sql``}
    where s.screening_day between ${opts.from} and ${opts.to}
    ${filmFilter}
    group by 1
    having sum(${ADMISSIONS}) > 0
    order by admissions desc
  `);
  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    label: String(r.label ?? "—"),
    admissions: Number(r.admissions ?? 0),
    seatsOffered: Number(r.seats_offered ?? 0),
  }));
}

export const getChainBreakdown = (o: { from: string; to: string; filmId?: number }) =>
  breakdown(sql`s.chain`, o);

export const getCinemaBreakdown = (o: { from: string; to: string; filmId?: number }) =>
  breakdown(sql`c.name`, {
    ...o,
    join: sql`join halls h on h.id = s.hall_id join cinemas c on c.id = h.cinema_id`,
  });

export const getFormatBreakdown = (o: { from: string; to: string; filmId?: number }) =>
  breakdown(sql`coalesce(nullif(array_to_string(s.format_attrs, ' + '), ''), ${DEFAULT_FORMAT})`, o);

/**
 * Fullest screenings in the window — the "which shows are actually packed"
 * ranking, as opposed to which film sold the most tickets overall.
 */
export type OccupancyRow = {
  film: string;
  cinema: string;
  hall: string;
  startsAt: string;
  admissions: number;
  capacity: number;
  occupancy: number;
};

export async function getFullestScreenings(opts: {
  from: string;
  to: string;
  limit?: number;
  minCapacity?: number;
}): Promise<OccupancyRow[]> {
  const rows = await db().execute(sql`
    select
      f.title                          as film,
      c.name                           as cinema,
      coalesce(h.name, '')             as hall,
      s.starts_at::text                as starts_at,
      ${ADMISSIONS}::int               as admissions,
      ${SEATS_OFFERED}::int            as capacity
    ${FROM_SCREENINGS}
    join films f on f.id = s.film_id
    join halls h on h.id = s.hall_id
    join cinemas c on c.id = h.cinema_id
    where s.screening_day between ${opts.from} and ${opts.to}
      and ${SEATS_OFFERED} >= ${opts.minCapacity ?? 50}
    order by (${ADMISSIONS}::numeric / nullif(${SEATS_OFFERED}, 0)) desc nulls last,
             ${ADMISSIONS} desc
    limit ${opts.limit ?? 20}
  `);

  return (rows.rows as Record<string, unknown>[]).map((r) => {
    const admissions = Number(r.admissions ?? 0);
    const capacity = Number(r.capacity ?? 0);
    return {
      film: String(r.film),
      cinema: String(r.cinema),
      hall: String(r.hall ?? ""),
      startsAt: String(r.starts_at),
      admissions,
      capacity,
      occupancy: capacity > 0 ? admissions / capacity : 0,
    };
  });
}

export type FilmMeta = { id: number; title: string; originalTitle: string | null };

export async function getFilm(filmId: number): Promise<FilmMeta | null> {
  const rows = await db().execute(sql`
    select id, title, original_title from films where id = ${filmId} limit 1
  `);
  const r = (rows.rows as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    title: String(r.title),
    originalTitle: (r.original_title as string) || null,
  };
}

/**
 * Presale share: tickets bought more than a day before the screening.
 *
 * A film that fills its halls late behaves very differently from one that sells
 * out a week out, and the difference shows up here before it shows up anywhere else.
 */
export async function getPresaleIndex(opts: { filmId?: number }): Promise<number | null> {
  const filmFilter = opts.filmId ? sql`and s.film_id = ${opts.filmId}` : sql``;
  const rows = await db().execute(sql`
    with per_screening as (
      select
        s.id,
        coalesce(st.seats_sold, s.current_seats_sold, 0) as final_sold,
        (
          select sn.seats_sold
          from screening_snapshots sn
          where sn.screening_id = s.id
            and sn.captured_at <= s.starts_at - interval '24 hours'
          order by sn.captured_at desc
          limit 1
        ) as sold_day_before
      from screenings s
      left join screenings_settled st on st.screening_id = s.id
      where s.starts_at between now() - interval '14 days' and now()
      ${filmFilter}
    )
    select
      sum(sold_day_before)::int as early,
      sum(final_sold)::int      as total
    from per_screening
    where sold_day_before is not null and final_sold > 0
  `);
  const r = (rows.rows as Record<string, unknown>[])[0];
  const total = Number(r?.total ?? 0);
  if (!total) return null;
  return Number(r?.early ?? 0) / total;
}
