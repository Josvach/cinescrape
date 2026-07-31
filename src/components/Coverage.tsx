import { num, pct } from "@/lib/format";

/**
 * Honest framing of what the numbers do and do not cover.
 *
 * Two separate caveats, and conflating them would mislead: the product only
 * watches two chains (roughly half the national market), and within those
 * chains a few screenings slip past the poller before showtime. A producer
 * reading a total needs to be able to tell "few tickets sold" from "not measured".
 */
export function Coverage({
  total,
  missed,
  partial,
}: {
  total: number;
  missed: number;
  partial: number;
}) {
  const missRate = total > 0 ? missed / total : 0;
  const noisy = missRate > 0.05;

  return (
    <>
      <div className="notice">
        <span aria-hidden>ⓘ</span>
        <span>
          Sledujeme <strong>Cinema City a CineStar</strong> — 26 multikin, zhruba 55 % návštěvnosti
          českých kin. Jednosálová kina nemají veřejná data o obsazenosti, takže celostátní čísla
          tohle nenahrazuje.
        </span>
      </div>

      {total > 0 && (
        <div className={noisy ? "notice warn" : "notice"}>
          <span aria-hidden>{noisy ? "⚠" : "✓"}</span>
          <span>
            Za posledních 7 dní zachyceno {num(total - missed)} z {num(total)} projekcí
            {missed > 0 && <> · {pct(missRate, 1)} se nestihlo změřit před začátkem</>}
            {partial > 0 && <> · {num(partial)} má jen starší odečet</>}.
          </span>
        </div>
      )}
    </>
  );
}
