/**
 * Presentation formats, kept deliberately narrow.
 *
 * Both chains tag screenings with a mix of things: the presentation format
 * (3D, 4DX, IMAX), the projector and sound kit (laser-barco, atmos), seating
 * tiers (comfort, vip, premium) and pure marketing (HIT, Premiéra). Only the
 * first group changes what the audience buys, and mixing the rest in produces
 * useless breakdown rows like "atmos+comfort+laser-barco+Sup".
 */
const CANONICAL: Record<string, string> = {
  "3d": "3D",
  "4dx": "4DX",
  imax: "IMAX",
  "70mm": "70mm",
  screenx: "ScreenX",
};

/** Everything that is not a recognised format collapses to plain 2D. */
export const DEFAULT_FORMAT = "2D";

export function normalizeFormats(raw: readonly string[] | null | undefined): string[] {
  if (!raw?.length) return [];
  const out = new Set<string>();
  for (const attr of raw) {
    const canonical = CANONICAL[attr.trim().toLowerCase()];
    if (canonical) out.add(canonical);
  }
  // 3D is implied by 4DX+3D pairings but stands on its own elsewhere; keeping
  // both is correct, and sorting makes the breakdown labels stable.
  return [...out].sort();
}
