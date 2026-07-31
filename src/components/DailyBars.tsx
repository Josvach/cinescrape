"use client";

import { useId, useState } from "react";

import { dayLabel, num, pct, weekdayLabel } from "@/lib/format";
import type { DayPoint } from "@/stats/queries";

/**
 * Admissions per screening day.
 *
 * One series, so no legend box is needed for identity — but the bars carry two
 * *states*: days that have already played (a final count) and days still on
 * sale (tickets bought so far). That distinction is encoded with texture rather
 * than a second hue, and spelled out in a key underneath, so it survives
 * greyscale and colorblind viewing.
 */
export function DailyBars({ data, today }: { data: DayPoint[]; today: string }) {
  const uid = useId().replace(/:/g, "");
  const [active, setActive] = useState<number | null>(null);

  if (!data.length) {
    return <p className="empty">Zatím žádná data — sběr právě začal.</p>;
  }

  const width = 100;
  const height = 42;
  const gap = 0.6;
  const slot = width / data.length;
  const barW = Math.max(slot - gap, 0.8);
  const max = Math.max(...data.map((d) => d.admissions), 1);

  const shown = active ?? data.findIndex((d) => d.day === today);
  const point = data[shown] ?? data[data.length - 1];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 34 }}>
        <strong style={{ fontSize: 24, fontWeight: 640, fontVariantNumeric: "tabular-nums" }}>
          {num(point.admissions)}
        </strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          diváků &middot; {weekdayLabel(point.day)} {dayLabel(point.day)}
          {point.seatsOffered > 0 && ` · ${pct(point.admissions / point.seatsOffered)} sálu`}
          {point.day > today && " · zatím jen předprodej"}
          {point.day === today && !point.settled && " · den ještě běží"}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={132}
        preserveAspectRatio="none"
        role="img"
        aria-label="Návštěvnost podle dne projekce"
        onMouseLeave={() => setActive(null)}
        style={{ display: "block", marginTop: 6, overflow: "visible" }}
      >
        <defs>
          {/* Texture marks the days that are still selling. */}
          <pattern
            id={`presale-${uid}`}
            width="2.2"
            height="2.2"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="2.2" height="2.2" fill="var(--surface-2)" />
            <rect width="1.1" height="2.2" fill="var(--series-1)" />
          </pattern>
        </defs>

        {data.map((d, i) => {
          const h = Math.max((d.admissions / max) * (height - 2), d.admissions > 0 ? 1 : 0);
          const x = i * slot + gap / 2;
          const isFuture = d.day > today;
          return (
            <g key={d.day}>
              <rect
                x={x}
                y={height - h}
                width={barW}
                height={h}
                rx={Math.min(barW / 2.6, 0.9)}
                fill={isFuture ? `url(#presale-${uid})` : "var(--series-1)"}
                opacity={shown === i || active === null ? 1 : 0.45}
              />
              {/* Hit target is the full column, not just the bar. */}
              <rect
                x={i * slot}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                tabIndex={0}
                role="button"
                aria-label={`${dayLabel(d.day)}: ${num(d.admissions)} diváků`}
                style={{ cursor: "pointer", outline: "none" }}
              />
            </g>
          );
        })}

        <line
          x1="0"
          y1={height}
          x2={width}
          y2={height}
          stroke="var(--border)"
          strokeWidth="0.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10.5,
          color: "var(--text-muted)",
          marginTop: 4,
        }}
      >
        <span>{dayLabel(data[0].day)}</span>
        <span>{dayLabel(data[data.length - 1].day)}</span>
      </div>

      <div className="legend">
        <span className="key">
          <i className="swatch" style={{ background: "var(--series-1)" }} />
          odehráno
        </span>
        <span className="key">
          <i
            className="swatch"
            style={{
              background:
                "repeating-linear-gradient(45deg, var(--series-1) 0 3px, var(--surface-2) 3px 6px)",
            }}
          />
          v předprodeji
        </span>
      </div>

      <details className="tableview">
        <summary>Zobrazit jako tabulku</summary>
        <table className="data">
          <thead>
            <tr>
              <th>Den</th>
              <th>Diváci</th>
              <th>Naplnění</th>
              <th>Projekcí</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>
                  {weekdayLabel(d.day)} {dayLabel(d.day)}
                  {d.day > today ? " (předprodej)" : ""}
                </td>
                <td>{num(d.admissions)}</td>
                <td>{d.seatsOffered > 0 ? pct(d.admissions / d.seatsOffered) : "—"}</td>
                <td>{num(d.screenings)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
