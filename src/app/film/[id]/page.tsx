import Link from "next/link";
import { notFound } from "next/navigation";

import { DailyBars } from "@/components/DailyBars";
import { RampChart } from "@/components/RampChart";
import { CHAIN_LABELS, czk, num, pct, shiftDay } from "@/lib/format";
import { pragueDate } from "@/lib/time";
import {
  FILMMAKER_SHARE,
  getChainBreakdown,
  getCinemaBreakdown,
  getDailySeries,
  getFilm,
  getFilmLeaderboard,
  getFormatBreakdown,
  getPresaleIndex,
  getSalesRamp,
} from "@/stats/queries";

export const dynamic = "force-dynamic";

export default async function FilmPage({ params }: { params: Promise<{ id: string }> }) {
  const filmId = Number((await params).id);
  if (!Number.isInteger(filmId)) notFound();

  const today = pragueDate();
  const from = shiftDay(today, -27);
  const to = shiftDay(today, 27);

  const [film, daily, ramp, chains, cinemas, formats, presale, leaderboard] = await Promise.all([
    getFilm(filmId),
    getDailySeries({ from, to, filmId }),
    getSalesRamp({ filmId, hours: 24 * 10 }),
    getChainBreakdown({ from, to, filmId }),
    getCinemaBreakdown({ from, to, filmId }),
    getFormatBreakdown({ from, to, filmId }),
    getPresaleIndex({ filmId }),
    getFilmLeaderboard({ from, to, limit: 200 }),
  ]);

  if (!film) notFound();

  const totals = leaderboard.find((f) => f.filmId === filmId);
  const admissions = totals?.admissions ?? 0;
  const admissionsPerScreening =
    totals && totals.screenings > 0 ? totals.admissions / totals.screenings : 0;

  return (
    <main className="page">
      <Link href="/" className="backlink">
        ← zpět na přehled
      </Link>

      <header className="masthead">
        <h1>{film.title}</h1>
      </header>
      {film.originalTitle && film.originalTitle !== film.title && (
        <p style={{ marginTop: -14, marginBottom: 16, fontSize: 12.5, color: "var(--text-muted)" }}>
          {film.originalTitle}
        </p>
      )}

      <section className="card">
        <h2>Celková návštěvnost</h2>
        <p className="caption">Prodané lístky napříč Cinema City a CineStar, včetně předprodeje.</p>
        <div className="hero">{num(admissions)}</div>
        <div className="hero-unit">
          diváků
          {totals && totals.admissionsUpcoming > 0 && (
            <> · z toho {num(totals.admissionsUpcoming)} na budoucí projekce</>
          )}
        </div>

        <div className="tiles" style={{ marginTop: 18 }}>
          <div className="tile">
            <div className="label">Naplnění sálu</div>
            <div className="value">{totals ? pct(totals.occupancy) : "—"}</div>
            <div className="note">průměr</div>
          </div>
          <div className="tile">
            <div className="label">Diváků / projekci</div>
            <div className="value">{num(admissionsPerScreening)}</div>
            <div className="note">{num(totals?.screenings ?? 0)} projekcí</div>
          </div>
          <div className="tile">
            <div className="label">Tržby (odhad)</div>
            <div className="value">{czk(totals?.grossCzk ?? 0)}</div>
            <div className="note">hrubé</div>
          </div>
          <div className="tile">
            <div className="label">Pro filmaře</div>
            <div className="value">{czk(totals?.filmmakerCzk ?? 0)}</div>
            <div className="note">{pct(FILMMAKER_SHARE)} podíl</div>
          </div>
        </div>

        <div className="notice">
          <span aria-hidden>ⓘ</span>
          <span>
            Tržby jsou <strong>odhad</strong>. CineStar zveřejňuje ceník projekce, u Cinema City
            počítáme s průměrnou cenou lístku. Ani jedna síť neprozradí, kolik lístků šlo za
            sníženou cenu, takže skutečná tržba bude o něco nižší.
          </span>
        </div>
      </section>

      <section className="card">
        <h2>Jak nabíhá prodej</h2>
        <p className="caption">Kumulativně prodané lístky za posledních 10 dní sběru.</p>
        <RampChart ramp={ramp} />
      </section>

      <section className="card">
        <h2>Návštěvnost po dnech</h2>
        <p className="caption">Podle dne projekce, ne dne prodeje.</p>
        <DailyBars data={daily} today={today} />
      </section>

      {presale !== null && (
        <section className="card">
          <h2>Předprodejní index</h2>
          <p className="caption">
            Podíl lístků koupených víc než den předem. Vysoká hodnota znamená, že se film prodává
            dopředu — víkend jde odhadnout dřív, než začne.
          </p>
          <div className="hero" style={{ fontSize: 40 }}>
            {pct(presale)}
          </div>
          <div className="hero-unit">z lístků koupeno v předstihu</div>
        </section>
      )}

      <section className="card">
        <h2>Kde se hraje</h2>
        <p className="caption">Návštěvnost a naplnění podle sítě, kina a formátu.</p>

        <BreakdownTable
          title="Podle sítě"
          rows={chains.map((c) => ({ ...c, label: CHAIN_LABELS[c.label] ?? c.label }))}
        />
        <BreakdownTable title="Podle formátu" rows={formats} />
        <BreakdownTable title="Nejsilnější kina" rows={cinemas.slice(0, 10)} />
      </section>
    </main>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; admissions: number; seatsOffered: number }[];
}) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <h3
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          color: "var(--text-muted)",
          fontWeight: 600,
          margin: "0 0 4px",
        }}
      >
        {title}
      </h3>
      <table className="data">
        <thead>
          <tr>
            <th>&nbsp;</th>
            <th>Diváci</th>
            <th>Naplnění</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{num(r.admissions)}</td>
              <td>{r.seatsOffered > 0 ? pct(r.admissions / r.seatsOffered) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
