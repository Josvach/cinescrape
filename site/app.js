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
export const VERSION = "Alpha 0.0.11";

const CZ = "cs-CZ";
const nf = new Intl.NumberFormat(CZ);
const num = (v) => nf.format(Math.round(v || 0));
const dec = (v, d = 1) =>
  new Intl.NumberFormat(CZ, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v || 0);
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

const RATING_SOURCES = { csfd: "ČSFD", tmdb: "TMDB" };

/**
 * Projected final admissions.
 *
 * Shown with its range, always, and with the range said out loud rather than
 * drawn as a thin error bar nobody reads. Off the opening weekend alone the
 * band is genuinely 0.6x to 2.1x, and a single confident-looking number there
 * would be the "times four" folklore wearing a nicer font.
 */
function forecastBlock(p) {
  if (!p) return null;
  // How the hold was arrived at: the film's own curve if it has two weekends,
  // else the opening's per-cinema intensity, else the plain market average.
  const basis = p.measured
    ? `z vlastního průběhu filmu — drží ${dec(p.strength ?? 1, 2)}× oproti trhu`
    : p.strength != null
      ? `podle síly startu (${dec(p.strength, 2)}× oproti trhu), film zatím nemá druhý víkend`
      : "z průměru trhu, film zatím nemá druhý víkend";
  // The live planned-screen signal, measured against the normal weekly decline
  // — screens always fall, so only a faster or slower fall than usual moves the
  // estimate.
  const screens =
    p.screenTrend != null && Math.abs(p.screenTrend - 1) >= 0.1
      ? ` Projekcí ubývá ${p.screenTrend < 1 ? "rychleji" : "pomaleji"} než obvykle ` +
        `(${dec(p.screenTrend, 2)}× oproti běžnému tempu), což odhad ${p.screenTrend < 1 ? "snižuje" : "zvyšuje"}.`
      : "";
  // How the estimate itself has moved week to week: up means we now think more
  // of the film than the official data did a week ago, down means less.
  let trend = null;
  if (p.trend && p.trend.length >= 2) {
    const prev = p.trend[p.trend.length - 2].predicted;
    const delta = p.total - prev;
    const rel = prev > 0 ? delta / prev : 0;
    if (Math.abs(rel) >= 0.02) {
      const up = delta > 0;
      trend = el("span", { class: up ? "trend up" : "trend down" },
        `${up ? "▲" : "▼"} odhad ${up ? "roste" : "klesá"} · minulý týden ${num(prev)}`);
    } else {
      trend = el("span", { class: "trend flat" }, `→ odhad se drží · minulý týden ${num(prev)}`);
    }
  }

  return el("div", {},
    el("h3", { class: "sub" }, "Odhad celkového nasazení"),
    el("div", { class: "readout" },
      el("b", {}, num(p.total)),
      el("span", {}, `diváků · pásmo ${num(p.low)}–${num(p.high)}`)),
    trend && el("div", { style: "margin-top:4px" }, trend),
    p.curve && forecastCurveChart(p.curve, p.low, p.high, `fc-${p.weeks}-${p.total}`),
    el("p", { class: "caption", style: "margin:6px 0 0" },
      `Po ${p.weeks}. týdnu, ${basis}.` +
      (p.multiplier ? ` To je ${dec(p.multiplier)}× úvodní víkend.` : "") +
      screens),
    // How the estimate itself has moved, week by week — a separate chart from
    // the attendance curve above: this one plots what we predicted each week.
    p.trend && p.trend.length >= 2 &&
      el("div", {},
        el("h3", { class: "sub" }, "Vývoj odhadu po týdnech"),
        predictionTrendChart(p.trend, `pt-${p.weeks}-${p.total}`)),
    el("div", { class: "notice" },
      "Osm z deseti filmů historicky skončilo uvnitř tohohle pásma. Čím dřív v nasazení, tím je širší."));
}

/**
 * The two sources do not agree and are not interchangeable, so the chip always
 * says which one the number came from. ČSFD's links back to the film's page.
 */
function ratingChip(rating) {
  if (!rating) return null;
  const where = RATING_SOURCES[rating.source] ?? rating.source ?? "";
  const label = `${num(rating.votes)} hodnocení na ${where}`;
  const body = [el("b", {}, `${rating.percent} %`), where];
  return rating.url
    ? el("a", { class: "rating", href: rating.url, title: label, target: "_blank", rel: "noopener" }, body)
    : el("span", { class: "rating", title: label }, body);
}

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

/**
 * Cumulative admissions over a film's run: how the total actually built, week
 * by week, and where the model expects it to land.
 *
 * The real weeks (from UFD) are a solid line; the projection is dashed and
 * carries the band with it, drawn as a cone that opens toward the final low-to-
 * high range — the honest picture is that the further out the dashed line runs,
 * the less certain it is.
 */
function forecastCurveChart(curve, low, high, uid) {
  if (curve.length < 2) return null;

  const W = 100, H = 46;
  const weeks = curve.map((c) => c.week);
  const minW = Math.min(...weeks), maxW = Math.max(...weeks);
  const top = Math.max(high, ...curve.map((c) => c.total)) * 1.04;
  const xs = (w) => (maxW === minW ? W / 2 : ((w - minW) / (maxW - minW)) * W);
  const ys = (v) => H - (v / top) * (H - 2);

  const lastReal = [...curve].filter((c) => !c.projected).at(-1) ?? curve[0];
  const realPts = curve.filter((c) => !c.projected);
  const projPts = curve.filter((c) => c.projected);
  const line = (pts) => pts.map((c, i) => `${i ? "L" : "M"}${xs(c.week)} ${ys(c.total)}`).join(" ");

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: "100%", height: 128,
    preserveAspectRatio: "none", role: "img",
    "aria-label": "Vývoj celkové návštěvnosti a odhad",
  });
  const defs = svgEl("defs");
  const grad = svgEl("linearGradient", { id: `fcfill-${uid}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svgEl("stop", { offset: "0%", "stop-color": "var(--series-1)", "stop-opacity": 0.22 }),
    svgEl("stop", { offset: "100%", "stop-color": "var(--series-1)", "stop-opacity": 0.02 }),
  );
  defs.append(grad);
  svg.append(defs);

  // Uncertainty cone: fans out from the last real point to the low-high band.
  if (projPts.length) {
    svg.append(svgEl("path", {
      d: `M${xs(lastReal.week)} ${ys(lastReal.total)} L${xs(maxW)} ${ys(high)} ` +
        `L${xs(maxW)} ${ys(low)} Z`,
      fill: "var(--series-1)", opacity: 0.1,
    }));
  }

  // Area under the real curve only, so the fill marks what actually happened.
  if (realPts.length > 1) {
    svg.append(svgEl("path", {
      d: `${line(realPts)} L${xs(lastReal.week)} ${H} L${xs(realPts[0].week)} ${H} Z`,
      fill: `url(#fcfill-${uid})`,
    }));
  }
  if (projPts.length) {
    svg.append(svgEl("path", {
      d: `M${xs(lastReal.week)} ${ys(lastReal.total)} ${line(projPts)}`,
      fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-dasharray": "3 2.5",
      "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      opacity: 0.7,
    }));
  }
  svg.append(svgEl("path", {
    d: line(realPts), fill: "none", stroke: "var(--series-1)", "stroke-width": 2.4,
    "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
  }));
  // Mark the handover between measured and projected, and the two endpoints.
  svg.append(svgEl("circle", {
    cx: xs(lastReal.week), cy: ys(lastReal.total), r: 3.2, fill: "var(--series-1)",
    stroke: "var(--surface-1)", "stroke-width": 2, "vector-effect": "non-scaling-stroke",
  }));
  const end = curve.at(-1);
  if (end.projected) {
    svg.append(svgEl("circle", {
      cx: xs(end.week), cy: ys(end.total), r: 3, fill: "var(--surface-1)",
      stroke: "var(--series-1)", "stroke-width": 2, "vector-effect": "non-scaling-stroke",
    }));
  }

  return el("div", { style: "margin-top:10px" }, svg,
    el("div", { class: "axis" },
      el("span", {}, `${minW}. týden`),
      el("span", {}, "dnes"),
      el("span", {}, `odhad k ${maxW}. týdnu`)),
    el("div", { class: "legend" },
      el("span", { class: "key" },
        el("i", { class: "swatch", style: "background:var(--series-1)" }), "skutečnost (UFD)"),
      el("span", { class: "key" },
        el("i", { class: "swatch", style: "background:repeating-linear-gradient(90deg,var(--series-1) 0 3px,transparent 3px 5px)" }),
        "dopočet + pásmo")),
    tableView(["Týden", "Celkem diváků", ""],
      curve.map((c) => [`${c.week}.`, num(c.total), c.projected ? "odhad" : "UFD"])));
}

/**
 * How the estimate itself changed, week by week.
 *
 * A line of the predicted final admissions at each week of run — this is the
 * "45 000 then 30 000 then …" the producer wants to watch: is our read of the
 * film climbing or sliding as the weekends come in. Not cumulative attendance
 * (that is the chart above); this is the forecast's own history.
 *
 * The y-axis does not start at zero — the whole point is to see the movement,
 * and a zero baseline would flatten a swing that matters into a straight line.
 */
function predictionTrendChart(trend, uid) {
  if (trend.length < 2) return null;

  const W = 100, H = 40;
  const vals = trend.map((t) => t.predicted);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.25 || hi * 0.1 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const xs = (i) => (i / (trend.length - 1)) * W;
  const ys = (v) => H - ((v - yMin) / (yMax - yMin)) * (H - 4) - 2;
  const path = trend.map((t, i) => `${i ? "L" : "M"}${xs(i)} ${ys(t.predicted)}`).join(" ");

  const readout = el("div", { class: "readout" });
  const strong = el("b");
  const note = el("span");
  readout.append(strong, note);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: "100%", height: 110,
    preserveAspectRatio: "none", role: "img", "aria-label": "Vývoj odhadu po týdnech",
  });
  const defs = svgEl("defs");
  const grad = svgEl("linearGradient", { id: `ptfill-${uid}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svgEl("stop", { offset: "0%", "stop-color": "var(--series-2)", "stop-opacity": 0.2 }),
    svgEl("stop", { offset: "100%", "stop-color": "var(--series-2)", "stop-opacity": 0.02 }),
  );
  defs.append(grad);
  svg.append(defs);
  svg.append(svgEl("path", { d: `${path} L${W} ${H} L0 ${H} Z`, fill: `url(#ptfill-${uid})` }));
  svg.append(svgEl("path", {
    d: path, fill: "none", stroke: "var(--series-2)", "stroke-width": 2.2,
    "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
  }));
  // A dot per week, the last one filled to mark the current estimate.
  trend.forEach((t, i) => {
    svg.append(svgEl("circle", {
      cx: xs(i), cy: ys(t.predicted), r: i === trend.length - 1 ? 3.4 : 2.4,
      fill: i === trend.length - 1 ? "var(--series-2)" : "var(--surface-1)",
      stroke: "var(--series-2)", "stroke-width": 2, "vector-effect": "non-scaling-stroke",
    }));
  });

  const show = (i) => {
    const t = trend[i];
    strong.textContent = num(t.predicted);
    const prev = i > 0 ? trend[i - 1].predicted : null;
    const arrow = prev == null ? "" : t.predicted > prev ? " ▲" : t.predicted < prev ? " ▼" : " →";
    note.textContent = `odhad po ${t.week}. týdnu${arrow}`;
  };
  const hit = svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  const move = (clientX, target) => {
    const box = target.getBoundingClientRect();
    show(Math.max(0, Math.min(trend.length - 1, Math.round(((clientX - box.left) / box.width) * (trend.length - 1)))));
  };
  hit.addEventListener("mousemove", (e) => move(e.clientX, e.currentTarget));
  hit.addEventListener("touchmove", (e) => { move(e.touches[0].clientX, e.currentTarget); e.preventDefault(); }, { passive: false });
  hit.addEventListener("mouseleave", () => show(trend.length - 1));
  svg.append(hit);
  show(trend.length - 1);

  return el("div", {}, readout, svg,
    el("div", { class: "axis" },
      el("span", {}, `${trend[0].week}. týden`),
      el("span", {}, `${trend[trend.length - 1].week}. týden`)),
    tableView(["Týden", "Odhad diváků"], trend.map((t) => [`${t.week}.`, num(t.predicted)])));
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
        tile("Tržby", czk(t.gross), "odhad"))),

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
        tile("Tržby", czk(w.gross), "odhad"))),

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
      el("h1", {}, f.title, ratingChip(f.rating))),
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
              tile("Tržby UFD", czk(f.official.gross), "hrubé")),
            forecastBlock(f.forecast))
        : card("Oficiální celkem", null,
            el("p", { class: "empty" },
              "Tenhle film zatím nebyl v TOP 20 UFD, takže oficiální celkové číslo neexistuje. " +
              "Ukazujeme jen vlastní měření na záložkách Dnes a Týden.")),
      ramp.length > 1 &&
        card("Jak nabíhá prodej", "Kumulativně změřené lístky.", rampChart(ramp, "filmramp", true)),
      articlesSection(f));
  }

  const top = f.todayScreenings.slice().sort((a, b) => b.admissions - a.admissions);
  // Only today's hours. `f.ramp` holds the film's whole measured history, and
  // the cumulative version of it lives on the Celkově tab.
  const todayRamp = Object.entries(f.ramp)
    .filter(([at]) => at.slice(0, 10) === d.date)
    .sort()
    .map(([at, sold]) => ({ at, sold }));

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
    todayRamp.length > 1 &&
      card("Prodej po hodinách", "Lístky na tenhle film změřené dnes — na jakoukoli projekci, ne jen dnešní.",
        rampChart(todayRamp, "filmtodayramp", false)),
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
