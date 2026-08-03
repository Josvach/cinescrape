/**
 * The dashboard.
 *
 * Three screens behind a bottom bar, in the order the data is actually worth
 * anything:
 *
 *   Dnes     scraped minutes ago. The only place live data beats the official
 *            figures, and therefore the whole reason for scraping at all.
 *   Týden    scraped, since Monday — the stretch UFD has not reported on yet.
 *   Celkově  official UFD only. For anything settled, their national numbers
 *            are simply better than our two-chain sample.
 *
 * Each screen is short enough to take in at a glance. A film opens into the
 * same three levels, switched by the same bar, so the structure never changes
 * under the reader.
 */

/**
 * Shown top right on every screen.
 *
 * Bumped by hand when something visible changes, which is the point: it is
 * there so a screenshot or a "u mě to vypadá jinak" can be pinned to a
 * specific build. Kept apart from package.json's semver — that number tracks
 * the code's shape (dropping Postgres took it to 2.0.0), this one tracks what
 * the phone is looking at.
 */
export const VERSION = "Alpha 0.07";

const CZ = "cs-CZ";
const nf = new Intl.NumberFormat(CZ);
const num = (v) => nf.format(Math.round(v || 0));
const pct = (v, d = 0) =>
  new Intl.NumberFormat(CZ, { style: "percent", maximumFractionDigits: d }).format(v || 0);

function czk(v) {
  v = v || 0;
  if (Math.abs(v) >= 1e6)
    return new Intl.NumberFormat(CZ, { maximumFractionDigits: 1 }).format(v / 1e6) + " mil. Kč";
  if (Math.abs(v) >= 1e4)
    return new Intl.NumberFormat(CZ, { maximumFractionDigits: 0 }).format(v / 1e3) + " tis. Kč";
  return num(v) + " Kč";
}

const dayFmt = new Intl.DateTimeFormat(CZ, { day: "numeric", month: "numeric" });
const wdFmt = new Intl.DateTimeFormat(CZ, { weekday: "short" });
// A `YYYY-MM-DD` is a calendar day; anchoring at noon keeps any timezone from
// nudging it onto the day before.
const dayLabel = (iso) => dayFmt.format(new Date(iso + "T12:00:00Z"));
const fullDayFmt = new Intl.DateTimeFormat(CZ, { day: "numeric", month: "numeric", year: "numeric" });
/** For dates far enough back that the year is the point of the sentence. */
const fullDayLabel = (iso) => fullDayFmt.format(new Date(iso + "T12:00:00Z"));
const wdLabel = (iso) => wdFmt.format(new Date(iso + "T12:00:00Z"));
const hourLabel = (at) =>
  new Date(at + ":00:00Z").toLocaleString(CZ, {
    day: "numeric", month: "numeric", hour: "2-digit", timeZone: "Europe/Prague",
  });
const clockLabel = (iso) =>
  new Date(iso).toLocaleTimeString(CZ, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" });

function relativeDay(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return "dnes";
  if (days === 1) return "včera";
  if (days < 7) return `před ${days} dny`;
  return new Date(iso).toLocaleDateString(CZ, { day: "numeric", month: "numeric" });
}

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : String(kid));
  }
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

const card = (title, caption, ...body) =>
  el("section", { class: "card" },
    title && el("h2", {}, title),
    caption && el("p", { class: "caption" }, caption),
    ...body);

const tile = (label, value, note) =>
  el("div", { class: "tile" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    note && el("div", { class: "note" }, note));

const tiles = (...items) => el("div", { class: "tiles" }, items.filter(Boolean));

// ---------------------------------------------------------------- charts

/**
 * Admissions per day. One series, so no legend is needed for identity — but the
 * bars carry two states, played and still selling, and that is encoded with
 * texture rather than a second hue so it survives greyscale and colourblind
 * viewing.
 */
function dailyBars(days, today, uid) {
  if (!days.length) return el("p", { class: "empty" }, "Zatím žádná data.");

  const W = 100, H = 42, gap = 1.2;
  const slot = W / days.length;
  const barW = Math.max(slot - gap, 1);
  const max = Math.max(...days.map((d) => d.admissions), 1);

  const readout = el("div", { class: "readout" });
  const strong = el("b");
  const note = el("span");
  readout.append(strong, note);

  const show = (i) => {
    const d = days[i];
    strong.textContent = num(d.admissions);
    const bits = [`diváků · ${wdLabel(d.day)} ${dayLabel(d.day)}`];
    if (d.seatsOffered > 0) bits.push(`${pct(d.admissions / d.seatsOffered)} sálu`);
    if (d.day > today) bits.push("zatím jen předprodej");
    else if (d.day === today) bits.push("den ještě běží");
    note.textContent = bits.join(" · ");
  };

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: "100%", height: 120,
    preserveAspectRatio: "none", role: "img",
    "aria-label": "Návštěvnost podle dne projekce",
  });
  const defs = svgEl("defs");
  const pat = svgEl("pattern", {
    id: `presale-${uid}`, width: 2.2, height: 2.2,
    patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)",
  });
  pat.append(
    svgEl("rect", { width: 2.2, height: 2.2, fill: "var(--surface-2)" }),
    svgEl("rect", { width: 1.1, height: 2.2, fill: "var(--series-1)" }),
  );
  defs.append(pat);
  svg.append(defs);

  const bars = [];
  days.forEach((d, i) => {
    const h = Math.max((d.admissions / max) * (H - 2), d.admissions > 0 ? 1 : 0);
    const bar = svgEl("rect", {
      x: i * slot + gap / 2, y: H - h, width: barW, height: h,
      rx: Math.min(barW / 2.6, 1),
      fill: d.day > today ? `url(#presale-${uid})` : "var(--series-1)",
    });
    bars.push(bar);
    // The hit target is the whole column, not just the drawn bar.
    const hit = svgEl("rect", {
      x: i * slot, y: 0, width: slot, height: H, fill: "transparent",
      tabindex: 0, role: "button",
      "aria-label": `${dayLabel(d.day)}: ${num(d.admissions)} diváků`,
    });
    const focus = () => {
      show(i);
      bars.forEach((b, j) => b.setAttribute("opacity", j === i ? 1 : 0.45));
    };
    hit.addEventListener("mouseenter", focus);
    hit.addEventListener("focus", focus);
    hit.addEventListener("click", focus);
    svg.append(bar, hit);
  });
  svg.addEventListener("mouseleave", () => {
    bars.forEach((b) => b.setAttribute("opacity", 1));
    show(Math.max(days.findIndex((d) => d.day === today), 0));
  });
  svg.append(svgEl("line", {
    x1: 0, y1: H, x2: W, y2: H, stroke: "var(--border)",
    "stroke-width": 0.4, "vector-effect": "non-scaling-stroke",
  }));

  show(Math.max(days.findIndex((d) => d.day === today), 0));

  const labels = el("div", { class: "daylabels" },
    days.map((d) => el("span", { class: d.day === today ? "now" : "" }, wdLabel(d.day))));

  return el("div", {}, readout, svg, labels,
    el("div", { class: "legend" },
      el("span", { class: "key" },
        el("i", { class: "swatch", style: "background:var(--series-1)" }), "odehráno"),
      el("span", { class: "key" },
        el("i", { class: "swatch", style: "background:repeating-linear-gradient(45deg,var(--series-1) 0 3px,var(--surface-2) 3px 6px)" }),
        "v předprodeji")),
    tableView(["Den", "Diváci", "Naplnění", "Projekcí"],
      days.map((d) => [
        `${wdLabel(d.day)} ${dayLabel(d.day)}`,
        num(d.admissions),
        d.seatsOffered > 0 ? pct(d.admissions / d.seatsOffered) : "—",
        num(d.screenings),
      ])));
}

/**
 * Tickets sold per hour. Change over time, one series: a 2px line over a faint
 * fill, crosshair on hover, and a table for anyone who cannot use the hover.
 */
function rampChart(points, uid, cumulative) {
  if (points.length < 2)
    return el("p", { class: "empty" }, "Křivka se objeví, jakmile naběhne pár hodin sběru.");

  let sum = 0;
  const data = points.map((p) => ({ at: p.at, sold: p.sold, cumulative: (sum += p.sold) }));
  const value = (d) => (cumulative ? d.cumulative : d.sold);
  const W = 100, H = 38;
  const max = Math.max(...data.map(value), 1);
  const xs = (i) => (i / (data.length - 1)) * W;
  const ys = (v) => H - (v / max) * (H - 2);
  const path = data.map((d, i) => `${i ? "L" : "M"}${xs(i)} ${ys(value(d))}`).join(" ");

  const readout = el("div", { class: "readout" });
  const strong = el("b");
  const note = el("span");
  readout.append(strong, note);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: "100%", height: 120,
    preserveAspectRatio: "none", role: "img",
    "aria-label": "Prodej lístků v čase",
  });
  const defs = svgEl("defs");
  const grad = svgEl("linearGradient", { id: `fill-${uid}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svgEl("stop", { offset: "0%", "stop-color": "var(--series-1)", "stop-opacity": 0.24 }),
    svgEl("stop", { offset: "100%", "stop-color": "var(--series-1)", "stop-opacity": 0.02 }),
  );
  defs.append(grad);
  svg.append(defs);
  svg.append(svgEl("path", { d: `${path} L${W} ${H} L0 ${H} Z`, fill: `url(#fill-${uid})` }));
  svg.append(svgEl("path", {
    d: path, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
    "vector-effect": "non-scaling-stroke",
  }));

  const cross = svgEl("line", {
    stroke: "var(--text-muted)", "stroke-width": 1, "stroke-dasharray": "2 2",
    "vector-effect": "non-scaling-stroke", opacity: 0,
  });
  // A surface ring keeps the marker readable wherever it lands.
  const dot = svgEl("circle", {
    r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)",
    "stroke-width": 2, "vector-effect": "non-scaling-stroke",
  });
  svg.append(cross, dot);

  const show = (i, withCross) => {
    const d = data[i];
    strong.textContent = num(value(d));
    note.textContent = cumulative
      ? `lístků · ${hourLabel(d.at)}`
      : `lístků v hodině ${hourLabel(d.at)}`;
    dot.setAttribute("cx", xs(i));
    dot.setAttribute("cy", ys(value(d)));
    cross.setAttribute("x1", xs(i));
    cross.setAttribute("x2", xs(i));
    cross.setAttribute("y1", 0);
    cross.setAttribute("y2", H);
    cross.setAttribute("opacity", withCross ? 1 : 0);
  };

  const hit = svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  const move = (clientX, target) => {
    const box = target.getBoundingClientRect();
    const ratio = (clientX - box.left) / box.width;
    show(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))), true);
  };
  hit.addEventListener("mousemove", (e) => move(e.clientX, e.currentTarget));
  hit.addEventListener("touchmove", (e) => {
    move(e.touches[0].clientX, e.currentTarget);
    e.preventDefault();
  }, { passive: false });
  hit.addEventListener("mouseleave", () => show(data.length - 1, false));
  svg.append(hit);
  show(data.length - 1, false);

  const peak = Math.max(...data.map((d) => d.sold), 0);
  return el("div", {}, readout, svg,
    el("div", { class: "axis" },
      el("span", {}, hourLabel(data[0].at)),
      el("span", {}, peak > 0 ? `nejsilnější hodina +${num(peak)}` : ""),
      el("span", {}, "teď")),
    tableView(["Hodina", "Prodáno", "Celkem"],
      [...data].reverse().slice(0, 48).map((d) => [hourLabel(d.at), num(d.sold), num(d.cumulative)])));
}

function tableView(head, rows) {
  return el("details", { class: "tableview" },
    el("summary", {}, "Zobrazit jako tabulku"),
    el("table", { class: "data" },
      el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c)))))));
}

// ---------------------------------------------------------------- rows

function filmRow(f, i, top, subtitle, value, unit, badge) {
  return el("button", { class: "rank", onclick: () => go({ view: "film", filmId: f.id, tab: state.tab }) },
    el("span", { class: "pos" }, i + 1),
    el("span", { class: "body" },
      el("span", { class: "name" }, f.title,
        badge && el("span", { class: "official", title: badge.title }, badge.text)),
      subtitle && el("span", { class: "meta" }, subtitle),
      el("span", { class: "sharebar" },
        el("i", { style: `width:${top ? (value / top) * 100 : 0}%` }))),
    el("span", { class: "num" }, el("b", {}, num(value)), el("span", {}, unit)));
}

function screeningTable(rows, showTime) {
  if (!rows.length) return el("p", { class: "empty" }, "Nic k zobrazení.");
  return el("table", { class: "data" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Projekce"), el("th", {}, "Diváci"), el("th", {}, "Naplnění"))),
    el("tbody", {}, rows.map((s) => el("tr", {},
      el("td", {},
        showTime ? `${clockLabel(s.startsAt)} · ${s.film}` : s.film,
        el("span", { class: "sub" },
          [s.cinema, s.hall, !showTime && clockLabel(s.startsAt)].filter(Boolean).join(" · "))),
      el("td", {}, `${num(s.admissions)}/${num(s.capacity)}`),
      el("td", {}, s.capacity > 0 ? pct(s.admissions / s.capacity) : "—")))));
}

function breakdown(title, rows) {
  if (!rows.length) return null;
  return el("div", {},
    el("h3", { class: "sub" }, title),
    el("table", { class: "data" },
      el("thead", {}, el("tr", {},
        el("th", {}, " "), el("th", {}, "Diváci"), el("th", {}, "Naplnění"))),
      el("tbody", {}, rows.map((r) => el("tr", {},
        el("td", {}, r.label),
        el("td", {}, num(r.admissions)),
        el("td", {}, r.seatsOffered > 0 ? pct(r.admissions / r.seatsOffered) : "—"))))));
}

const toRows = (obj) =>
  Object.entries(obj)
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.admissions - a.admissions);

// ---------------------------------------------------------------- screens

function todayScreen(d) {
  const t = d.today;
  const lead = t.films[0];
  const top = lead?.admissions || 0;

  return el("div", {},
    lead
      ? card(null, null,
          el("div", { class: "eyebrow" }, "Nejsilnější film dneška"),
          el("button", { class: "herofilm", onclick: () => go({ view: "film", filmId: lead.id, tab: "today" }) },
            el("div", { class: "herotitle" }, lead.title),
            el("div", { class: "hero" }, num(lead.admissions)),
            el("div", { class: "hero-unit" },
              `diváků dnes · ${num(lead.screenings)} projekcí · ${pct(lead.occupancy)} naplnění`)))
      : card(null, null, el("p", { class: "empty" }, "Na dnešek zatím nejsou data.")),

    card("Dnes celkem", `${wdLabel(d.date)} ${dayLabel(d.date)} · včetně projekcí, které ještě neproběhly`,
      tiles(
        tile("Diváci", num(t.admissions), t.seatsOffered > 0 ? `${pct(t.occupancy)} sálů` : null),
        tile("Projekce", num(t.screenings), `${num(t.screeningsDone)} odehráno`),
        tile("Prodáno dnes", `+${num(t.soldToday)}`, t.soldLastHour > 0 ? `+${num(t.soldLastHour)} za hodinu` : "lístků"),
        tile("Tržby", czk(t.gross), `pro filmaře ${czk(t.filmmaker)}`))),

    t.ramp.length > 1 &&
      card("Prodej po hodinách", "Kolik lístků se dnes prodalo — na jakoukoli projekci, ne jen dnešní.",
        rampChart(t.ramp, "todayramp", false)),

    t.films.length > 1 &&
      card("Filmy dnes", "Podle dnešní návštěvnosti.",
        t.films.slice(0, 12).map((f, i) =>
          filmRow(f, i, top, `${num(f.screenings)} projekcí · ${pct(f.occupancy)} sálu`,
            f.admissions, "diváků"))),

    t.fullest.length > 0 &&
      card("Nejplnější sály dneška", "Sály od 40 míst.", screeningTable(t.fullest, false)),

    t.upcoming.length > 0 &&
      card("Ještě dnes začíná", "Nejbližší projekce a jak jsou zatím prodané.",
        screeningTable(t.upcoming, true)),

    ...coverageNotices(d.coverage));
}

function weekScreen(d) {
  const w = d.week;
  const top = w.films[0]?.admissions || 0;

  return el("div", {},
    card("Tento týden", `${dayLabel(w.from)} – ${dayLabel(w.to)} · naše měření, než UFD zveřejní oficiální čísla`,
      el("div", { class: "hero" }, num(w.admissions)),
      el("div", { class: "hero-unit" },
        `diváků` + (w.seatsOffered > 0 ? ` · ${pct(w.occupancy)} naplnění sálů` : "")),
      tiles(
        tile("Projekce", num(w.screenings), "za týden"),
        tile("Předprodej", num(w.presale), "na zbytek týdne"),
        tile("Tržby", czk(w.gross), "odhad"),
        tile("Pro filmaře", czk(w.filmmaker), "50 % podíl"))),

    card("Po dnech", "Lístek se počítá ke dni projekce — co se dnes prodá na zítřek, roste v zítřejším sloupci.",
      dailyBars(w.days, d.date, "week")),

    w.films.length > 0 &&
      card("Filmy tento týden", null,
        w.films.slice(0, 20).map((f, i) =>
          filmRow(f, i, top, `${num(f.screenings)} projekcí · ${pct(f.occupancy)} sálu`,
            f.admissions, "diváků"))),

    w.ramp.length > 1 &&
      card("Jak nabíhal prodej", "Kumulativně změřené lístky za tento týden.",
        rampChart(w.ramp, "weekramp", true)));
}

function allTimeScreen(d) {
  const a = d.allTime;
  const topWeekend = a.weekend[0]?.weekendAdmissions || 0;
  const topAll = a.ranking[0]?.admissions || 0;

  return el("div", {},
    card("Oficiální data UFD",
      a.weeksStored
        ? `${num(a.weeksStored)} týdnů od ${fullDayLabel(a.archiveFrom)} · národní čísla za všechna kina`
        : "Archiv se ještě nenačetl.",
      a.weekendFrom &&
        el("div", {},
          el("div", { class: "eyebrow" }, `Poslední víkend · ${dayLabel(a.weekendFrom)}`),
          el("div", { class: "hero" }, num(a.weekendTotal)),
          el("div", { class: "hero-unit" }, "diváků v TOP 20"))),

    a.weekend.length > 0 &&
      card("TOP 20 posledního víkendu", "Přesně jak to publikuje Unie filmových distributorů.",
        el("table", { class: "data" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Film"), el("th", {}, "Víkend"), el("th", {}, "Celkem"), el("th", {}, "Týd."))),
          el("tbody", {}, a.weekend.map((e) => el("tr", {},
            el("td", {},
              e.filmId
                ? el("button", { class: "linkish", onclick: () => go({ view: "film", filmId: e.filmId, tab: "today" }) },
                    `${e.rank}. ${e.title}`)
                : `${e.rank}. ${e.title}`,
              el("span", { class: "sub" }, [e.distributor, `${e.cinemas} kin`].filter(Boolean).join(" · "))),
            el("td", {}, num(e.weekendAdmissions)),
            el("td", {}, num(e.totalAdmissions)),
            el("td", {}, `${e.weekOfRun}.`)))))),

    a.ranking.length > 0 &&
      card("Nejúspěšnější filmy v ČR", `Podle celkové návštěvnosti od ${fullDayLabel(a.archiveFrom)}.`,
        a.ranking.slice(0, 50).map((e, i) =>
          el("div", { class: "rank static" },
            el("span", { class: "pos" }, i + 1),
            el("span", { class: "body" },
              el("span", { class: "name" }, e.title),
              el("span", { class: "meta" }, `${e.year} · ${czk(e.gross)}`),
              el("span", { class: "sharebar" },
                el("i", { style: `width:${topAll ? (e.admissions / topAll) * 100 : 0}%` }))),
            el("span", { class: "num" }, el("b", {}, num(e.admissions)), el("span", {}, "diváků"))))));
}

// ---------------------------------------------------------------- film

function filmScreen(d, id, tab) {
  const f = d.films.find((x) => x.id === id);
  if (!f) return el("div", {}, el("p", { class: "empty" }, "Film nenalezen."));

  const header = el("div", {},
    el("header", { class: "masthead" },
      el("h1", {}, f.title,
        f.rating && el("span", { class: "rating", title: `${num(f.rating.votes)} hlasů na TMDB` },
          el("b", {}, `${f.rating.percent} %`), "hodnocení"))),
    f.originalTitle && f.originalTitle !== f.title &&
      el("p", { class: "subtitle" }, f.originalTitle));

  if (tab === "week") {
    const days = d.week.days.map((day) => ({
      ...day,
      admissions: f.week.byDay[day.day] || 0,
      seatsOffered: 0,
    }));
    return el("div", {}, header,
      card("Tento týden", `${dayLabel(d.week.from)} – ${dayLabel(d.week.to)}`,
        el("div", { class: "hero" }, num(f.week.admissions)),
        el("div", { class: "hero-unit" },
          `diváků · ${pct(f.week.occupancy)} naplnění sálů`),
        tiles(
          tile("Projekce", num(f.week.screenings), "za týden"),
          tile("Kin", num(f.cinemas), "hraje"),
          tile("Předprodej", num(f.presale), "na zbytek týdne"),
          tile("Vyprodáno", num(f.sellouts), "projekcí"))),
      card("Po dnech", null, dailyBars(days, d.date, "filmweek")),
      card("Kde se hraje", null,
        breakdown("Podle sítě", toRows(f.chains)),
        breakdown("Podle formátu", toRows(f.formats)),
        breakdown("Nejsilnější kina", f.topCinemas.map((c) => ({ label: c.name, ...c })))));
  }

  if (tab === "alltime") {
    const ramp = Object.entries(f.ramp).sort().map(([at, sold]) => ({ at, sold }));
    return el("div", {}, header,
      f.official
        ? card("Oficiální celkem", `Data UFD k víkendu ${dayLabel(f.official.asOf)}, národní za všechna kina.`,
            el("div", { class: "hero" }, num(f.official.admissions + f.official.sinceAdmissions)),
            el("div", { class: "hero-unit" }, "diváků za celé nasazení"),
            tiles(
              tile("Oficiálně UFD", num(f.official.admissions), `k ${dayLabel(f.official.asOf)}`),
              tile("Naměřeno od té doby", `+${num(f.official.sinceAdmissions)}`, "naše měření"),
              tile("Tržby UFD", czk(f.official.gross), "hrubé"),
              tile("Pro filmaře", czk(f.official.gross * 0.5), "50 % podíl")))
        : card("Oficiální celkem", null,
            el("p", { class: "empty" },
              "Tenhle film zatím nebyl v TOP 20 UFD, takže oficiální celkové číslo neexistuje. " +
              "Ukazujeme jen vlastní měření na záložkách Dnes a Týden.")),
      ramp.length > 1 &&
        card("Jak nabíhá prodej", "Kumulativně změřené lístky.", rampChart(ramp, "filmramp", true)),
      articlesSection(f));
  }

  const top = f.todayScreenings.slice().sort((a, b) => b.admissions - a.admissions);
  return el("div", {}, header,
    card("Dnes", `${wdLabel(d.date)} ${dayLabel(d.date)}`,
      el("div", { class: "hero" }, num(f.today.admissions)),
      el("div", { class: "hero-unit" },
        `diváků dnes` + (f.today.seatsOffered > 0 ? ` · ${pct(f.today.occupancy)} naplnění sálů` : "")),
      tiles(
        tile("Projekce dnes", num(f.today.screenings), null),
        tile("Kin", num(f.cinemas), "hraje"),
        tile("Volných míst", num(Math.max(f.today.seatsOffered - f.today.admissions, 0)), "dnes"),
        tile("Diváků/projekci", num(f.today.screenings ? f.today.admissions / f.today.screenings : 0), null))),
    f.todayScreenings.length > 0 &&
      card("Dnešní projekce", "Seřazeno podle naplnění.", screeningTable(top.slice(0, 20), true)),
    articlesSection(f));
}

function articlesSection(f) {
  if (!f.articles?.length) return null;
  const reviews = f.articles.filter((a) => a.isReview);
  const rest = f.articles.filter((a) => !a.isReview);
  return card("Recenze a články", "Z Google News. Odkazy vedou na weby vydavatelů.",
    [...reviews, ...rest].map((a) =>
      el("a", { class: "article", href: a.url, target: "_blank", rel: "noopener noreferrer" },
        el("span", { class: "head" },
          a.isReview && el("span", { class: "tag" }, "recenze"),
          a.title),
        el("span", { class: "meta" },
          [a.source, relativeDay(a.publishedAt)].filter(Boolean).join(" · ")))));
}

function coverageNotices(c) {
  const rate = c.total > 0 ? c.missed / c.total : 0;
  return [
    el("div", { class: "notice" }, el("span", { "aria-hidden": "true" }, "ⓘ"),
      el("span", {},
        "Dnešní a týdenní čísla jsou naše měření Cinema City a CineStar — zhruba 55 % trhu. " +
        "Celkové součty jsou oficiální národní data UFD.")),
    c.total > 0 && rate > 0.05 &&
      el("div", { class: "notice warn" }, el("span", { "aria-hidden": "true" }, "⚠"),
        el("span", {}, `${pct(rate, 1)} projekcí se nestihlo změřit před začátkem.`)),
  ].filter(Boolean);
}

// ---------------------------------------------------------------- shell

const TABS = [
  { id: "today", label: "Dnes", icon: "M12 2 3 9v12h6v-7h6v7h6V9z" },
  { id: "week", label: "Týden", icon: "M4 4h16v4H4zm0 6h16v10H4zm3 3v4h4v-4z" },
  { id: "alltime", label: "Celkově", icon: "M4 20h4V10H4zm6 0h4V4h-4zm6 0h4v-7h-4z" },
];

let LIVE = null;
let state = { view: "home", tab: "today", filmId: null };
const app = document.getElementById("app");
const nav = document.getElementById("nav");

function go(next) {
  state = { ...state, ...next };
  const hash =
    state.view === "film" ? `#film-${state.filmId}-${state.tab}` : `#${state.tab}`;
  if (location.hash !== hash) history.pushState(state, "", hash);
  render();
  scrollTo(0, 0);
}

function readHash() {
  const film = location.hash.match(/^#film-(\d+)-(today|week|alltime)$/);
  if (film) return { view: "film", filmId: Number(film[1]), tab: film[2] };
  const tab = location.hash.match(/^#(today|week|alltime)$/);
  return { view: "home", tab: tab ? tab[1] : "today", filmId: null };
}

function render() {
  if (!LIVE) return;

  const body =
    state.view === "film"
      ? filmScreen(LIVE, state.filmId, state.tab)
      : state.tab === "week"
        ? weekScreen(LIVE)
        : state.tab === "alltime"
          ? allTimeScreen(LIVE)
          : todayScreen(LIVE);

  app.replaceChildren(
    el("header", { class: "topbar" },
      state.view === "film"
        ? el("button", { class: "back", onclick: () => go({ view: "home", filmId: null }) }, "‹ Zpět")
        : el("span", { class: "brand" }, "CineScrape"),
      el("div", { class: "meta" },
        el("span", { class: "version" }, VERSION),
        el("span", { class: "stamp" }, "aktualizováno ", clockLabel(LIVE.generatedAt)))),
    body,
  );

  nav.replaceChildren(
    ...TABS.map((t) =>
      el("button", {
        class: state.tab === t.id ? "tab active" : "tab",
        "aria-current": state.tab === t.id ? "page" : null,
        onclick: () => go({ tab: t.id }),
      },
        (() => {
          const svg = svgEl("svg", { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" });
          svg.append(svgEl("path", { d: t.icon, fill: "currentColor" }));
          return svg;
        })(),
        el("span", {}, t.label))),
  );
}

addEventListener("popstate", () => {
  state = readHash();
  render();
});

async function load() {
  try {
    // Cache-busted so a phone that kept the page open sees fresh numbers.
    const res = await fetch(`data/live.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    LIVE = await res.json();
    state = readHash();
    render();
  } catch (err) {
    app.replaceChildren(
      card("Data se nenačetla", String(err),
        el("p", { class: "caption" },
          "Pokud jsi právě nasadil, počkej na první běh sběru — data/live.json ještě nemusí existovat.")),
    );
  }
}

load();
addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
setInterval(() => {
  if (!document.hidden) load();
}, 5 * 60 * 1000);
