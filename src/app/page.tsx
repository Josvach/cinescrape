import Link from "next/link";

import { Coverage } from "@/components/Coverage";
import { DailyBars } from "@/components/DailyBars";
import { czk, num, pct, shiftDay } from "@/lib/format";
import { pragueDate } from "@/lib/time";
import { recentCoverage } from "@/ingest/settle";
import { FILMMAKER_SHARE, getDailySeries, getFilmLeaderboard } from "@/stats/queries";

// The whole point is that these numbers are current, so the page is rendered
// per request rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const today = pragueDate();
  const from = shiftDay(today, -13);
  const to = shiftDay(today, 13);

  const [films, daily, coverage] = await Promise.all([
    getFilmLeaderboard({ from, to, limit: 25 }),
    getDailySeries({ from, to }),
    recentCoverage(7),
  ]);

  const todayRow = daily.find((d) => d.day === today);
  const upcoming = daily.filter((d) => d.day > today).reduce((s, d) => s + d.admissions, 0);
  const week = daily
    .filter((d) => d.day <= today && d.day > shiftDay(today, -7))
    .reduce((s, d) => s + d.admissions, 0);
  const grossWeek = films.reduce((s, f) => s + f.grossCzk, 0);
  const topShare = films[0]?.admissions ?? 0;

  return (
    <main className="page">
      <header className="masthead">
        <h1>CineScrape</h1>
        <span className="sub">živě · Cinema City + CineStar</span>
      </header>

      <section className="card">
        <h2>Dnes v kinech</h2>
        <p className="caption">
          Prodané lístky na dnešní projekce, včetně těch, které ještě neproběhly.
        </p>
        <div className="hero">{num(todayRow?.admissions ?? 0)}</div>
        <div className="hero-unit">
          diváků dnes
          {todayRow && todayRow.seatsOffered > 0 && (
            <> · {pct(todayRow.admissions / todayRow.seatsOffered)} naplnění sálů</>
          )}
        </div>

        <div className="tiles" style={{ marginTop: 18 }}>
          <div className="tile">
            <div className="label">Posledních 7 dní</div>
            <div className="value">{num(week)}</div>
            <div className="note">diváků</div>
          </div>
          <div className="tile">
            <div className="label">Předprodej</div>
            <div className="value">{num(upcoming)}</div>
            <div className="note">na příští dny</div>
          </div>
          <div className="tile">
            <div className="label">Tržby (odhad)</div>
            <div className="value">{czk(grossWeek)}</div>
            <div className="note">za sledované období</div>
          </div>
          <div className="tile">
            <div className="label">Pro filmaře</div>
            <div className="value">{czk(grossWeek * FILMMAKER_SHARE)}</div>
            <div className="note">při {pct(FILMMAKER_SHARE)} podílu</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Návštěvnost po dnech</h2>
        <p className="caption">
          Lístek se počítá ke dni projekce — co se dnes prodá na zítřek, roste v zítřejším sloupci.
        </p>
        <DailyBars data={daily} today={today} />
      </section>

      <section className="card">
        <h2>Žebříček filmů</h2>
        <p className="caption">Za posledních 14 dní plus vše, co je už prodáno dopředu.</p>

        {films.length === 0 ? (
          <p className="empty">Zatím žádná data — sběr právě začal.</p>
        ) : (
          films.map((f, i) => (
            <Link key={f.filmId} href={`/film/${f.filmId}`} className="rank">
              <span className="pos">{i + 1}</span>
              <span className="body">
                <span className="name">{f.title}</span>
                <span className="meta">
                  {num(f.screenings)} projekcí · {f.cinemas} kin · {pct(f.occupancy)} sálu
                  {f.sellouts > 0 && ` · ${f.sellouts}× vyprodáno`}
                  {f.admissionsUpcoming > 0 && ` · ${num(f.admissionsUpcoming)} v předprodeji`}
                </span>
                <span className="sharebar">
                  <i style={{ width: `${topShare ? (f.admissions / topShare) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="num">
                <b>{num(f.admissions)}</b>
                <span>diváků</span>
              </span>
            </Link>
          ))
        )}
      </section>

      <Coverage total={coverage.total} missed={coverage.missed} partial={coverage.partial} />
    </main>
  );
}
