import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Which multiplex chain a row came from. */
export const CHAINS = ["cinema_city", "cinestar"] as const;
export type Chain = (typeof CHAINS)[number];

/**
 * How much we trust a settled screening's admissions number.
 *
 * `final`   - snapshot taken inside the capture window before showtime
 * `partial` - only an older snapshot exists, so late sales are missing
 * `missed`  - the screening vanished from the feed before we ever snapshotted it
 *
 * `missed` rows must stay visible in the UI. Silently dropping them would bias
 * every total downwards without anyone noticing.
 */
export const SETTLE_CONFIDENCE = ["final", "partial", "missed"] as const;
export type SettleConfidence = (typeof SETTLE_CONFIDENCE)[number];

export const cinemas = pgTable(
  "cinemas",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    city: text("city"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cinemas_chain_external_idx").on(t.chain, t.externalId)],
);

export const halls = pgTable(
  "halls",
  {
    id: serial("id").primaryKey(),
    cinemaId: integer("cinema_id")
      .notNull()
      .references(() => cinemas.id),
    externalId: text("external_id").notNull(),
    name: text("name"),
    /** Total sellable seats. Cinema City needs a separate seatplan fetch for this. */
    capacity: integer("capacity"),
    /** Cinema City `seatplanId`, required alongside venueId to fetch the seatplan. */
    seatplanExternalId: text("seatplan_external_id"),
    capacityUpdatedAt: timestamp("capacity_updated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("halls_cinema_external_idx").on(t.cinemaId, t.externalId)],
);

/**
 * A film as a single entity across both chains. `matchKey` is the normalized
 * original-language title, which is what lets us merge Cinema City's
 * "Spider-Man: Brand New Day" with CineStar's identically-named `subtitle_group`.
 */
export const films = pgTable(
  "films",
  {
    id: serial("id").primaryKey(),
    matchKey: text("match_key").notNull(),
    /** Fallback key with word breaks removed; see ingest/match.ts. */
    tightKey: text("tight_key").notNull(),
    title: text("title").notNull(),
    originalTitle: text("original_title"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("films_match_key_idx").on(t.matchKey), index("films_tight_key_idx").on(t.tightKey)],
);

/** Per-chain identity of a film, plus the raw title we matched it from. */
export const filmAliases = pgTable(
  "film_aliases",
  {
    id: serial("id").primaryKey(),
    filmId: integer("film_id")
      .notNull()
      .references(() => films.id),
    chain: text("chain").notNull(),
    externalId: text("external_id").notNull(),
    rawTitle: text("raw_title").notNull(),
  },
  (t) => [uniqueIndex("film_aliases_chain_external_idx").on(t.chain, t.externalId)],
);

export const screenings = pgTable(
  "screenings",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    /** Cinema City presentation id / CineStar EventId. */
    externalId: text("external_id").notNull(),
    filmId: integer("film_id")
      .notNull()
      .references(() => films.id),
    hallId: integer("hall_id")
      .notNull()
      .references(() => halls.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /**
     * The day this screening's admissions are attributed to. Tickets sold today
     * for tomorrow's screening count towards tomorrow, which is what makes the
     * per-day view a genuine attendance forecast rather than a sales log.
     */
    screeningDay: date("screening_day").notNull(),
    capacity: integer("capacity"),
    /** e.g. ["4dx", "3d", "imax"] */
    formatAttrs: text("format_attrs").array(),
    /** "dabing" | "titulky" | null */
    languageVersion: text("language_version"),
    soldOut: boolean("sold_out").notNull().default(false),
    priceMin: numeric("price_min", { precision: 10, scale: 2 }),
    priceMax: numeric("price_max", { precision: 10, scale: 2 }),
    /** "chain" when the chain published real prices, "estimate" when we applied a fallback. */
    priceSource: text("price_source"),
    /**
     * Latest known occupancy, denormalized from the newest snapshot. The
     * dashboard reads live totals from here so it never has to do a
     * latest-row-per-screening join across the whole snapshot history.
     */
    currentSeatsSold: integer("current_seats_sold"),
    currentSeatsTotal: integer("current_seats_total"),
    currentAt: timestamp("current_at", { withTimezone: true }),
    /** Priority-queue cursor for the per-screening CineStar poller. */
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("screenings_chain_external_idx").on(t.chain, t.externalId),
    index("screenings_day_idx").on(t.screeningDay),
    index("screenings_film_idx").on(t.filmId),
    index("screenings_poll_idx").on(t.nextPollAt),
    index("screenings_starts_idx").on(t.startsAt),
  ],
);

/**
 * The time series. Every poll appends one row, which is the only way to
 * reconstruct how a film's presales ramped — that history cannot be recovered
 * later, because both chains drop a screening from their feeds once it has run.
 */
export const screeningSnapshots = pgTable(
  "screening_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    screeningId: integer("screening_id")
      .notNull()
      .references(() => screenings.id),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    seatsSold: integer("seats_sold").notNull(),
    seatsTotal: integer("seats_total").notNull(),
  },
  (t) => [index("snapshots_screening_captured_idx").on(t.screeningId, t.capturedAt)],
);

/** Final admissions for a screening that has already run. */
export const screeningsSettled = pgTable("screenings_settled", {
  screeningId: integer("screening_id")
    .primaryKey()
    .references(() => screenings.id),
  seatsSold: integer("seats_sold").notNull(),
  seatsTotal: integer("seats_total").notNull(),
  confidence: text("confidence").notNull(),
  /** When the snapshot we settled from was captured. */
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Observability for the cron jobs, so a silently failing poller is visible. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    job: text("job").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    itemsProcessed: integer("items_processed").notNull().default(0),
    note: text("note"),
  },
  (t) => [index("job_runs_job_started_idx").on(t.job, t.startedAt)],
);
