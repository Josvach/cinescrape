"use client";

import { useId, useMemo, useState } from "react";

import { num } from "@/lib/format";
import type { SalesRamp } from "@/stats/queries";

/**
 * Cumulative tickets sold over real time — the Social Blade view.
 *
 * Change over time, one series, so: a 2px line over a faint fill, a crosshair
 * on hover, no legend box (the title names the series), and a table view for
 * anyone who cannot use the hover layer.
 */
export function RampChart({ ramp }: { ramp: SalesRamp }) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const data = ramp.points;

  const geometry = useMemo(() => {
    if (data.length < 2) return null;
    const w = 100;
    const h = 40;
    const max = Math.max(...data.map((d) => d.cumulative), 1);
    const xs = (i: number) => (i / (data.length - 1)) * w;
    const ys = (v: number) => h - (v / max) * (h - 2);
    const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${xs(i)} ${ys(d.cumulative)}`).join(" ");
    const area = `${line} L${w} ${h} L0 ${h} Z`;
    return { w, h, max, xs, ys, line, area };
  }, [data]);

  if (!geometry) {
    return <p className="empty">Křivka se objeví, jakmile naběhne pár hodin sběru.</p>;
  }

  const { w, h, xs, ys, line, area } = geometry;
  const idx = hover ?? data.length - 1;
  const point = data[idx];
  const peakRate = Math.max(...data.map((d) => d.sold), 0);
  const measured = data.reduce((s, d) => s + d.sold, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 34 }}>
        <strong style={{ fontSize: 24, fontWeight: 640, fontVariantNumeric: "tabular-nums" }}>
          {num(point.cumulative)}
        </strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          lístků celkem &middot; {new Date(point.at).toLocaleString("cs-CZ", {
            day: "numeric",
            month: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Prague",
          })}
          {point.sold > 0 && ` · +${num(point.sold)} za hodinu`}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={140}
        preserveAspectRatio="none"
        role="img"
        aria-label="Kumulativní prodej lístků v čase"
        onMouseLeave={() => setHover(null)}
        style={{ display: "block", marginTop: 6, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#fill-${uid})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null && (
          <line
            x1={xs(idx)}
            y1={0}
            x2={xs(idx)}
            y2={h}
            stroke="var(--text-muted)"
            strokeWidth="1"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* A surface ring keeps the marker readable wherever it lands. */}
        <circle
          cx={xs(idx)}
          cy={ys(point.cumulative)}
          r="4"
          fill="var(--series-1)"
          stroke="var(--surface-1)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />

        <rect
          x="0"
          y="0"
          width={w}
          height={h}
          fill="transparent"
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - box.left) / box.width;
            setHover(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))));
          }}
          style={{ cursor: "crosshair" }}
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
        <span>
          {new Date(data[0].at).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" })}
        </span>
        <span>{peakRate > 0 ? `nejrychlejší hodina: +${num(peakRate)}` : ""}</span>
        <span>teď</span>
      </div>

      {ramp.baseline > 0 && (
        <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
          Z toho {num(ramp.baseline)} lístků bylo prodáno ještě před začátkem měření — křivka od nich
          startuje, do hodinových přírůstků se nepočítají. Změřeno {num(measured)} lístků.
        </p>
      )}

      <details className="tableview">
        <summary>Zobrazit jako tabulku</summary>
        <table className="data">
          <thead>
            <tr>
              <th>Hodina</th>
              <th>Prodáno</th>
              <th>Celkem</th>
            </tr>
          </thead>
          <tbody>
            {[...data]
              .reverse()
              .slice(0, 48)
              .map((d) => (
                <tr key={d.at}>
                  <td>
                    {new Date(d.at).toLocaleString("cs-CZ", {
                      day: "numeric",
                      month: "numeric",
                      hour: "2-digit",
                      timeZone: "Europe/Prague",
                    })}
                  </td>
                  <td>{num(d.sold)}</td>
                  <td>{num(d.cumulative)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
