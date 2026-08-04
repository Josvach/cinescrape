/**
 * Merging the same film across both chains.
 *
 * Both chains publish the original-language title next to the Czech one —
 * Cinema City as `featureAdditionalName`, CineStar as `subtitle_group` — and
 * for foreign films those agree exactly ("Spider-Man: Brand New Day"). That
 * makes the normalized original title a far better join key than the Czech
 * title, which the chains punctuate and subtitle differently.
 *
 * Czech films have no original title, so they fall back to the Czech one.
 */

/** Version and format noise that one chain bakes into the title and the other does not. */
const NOISE = [
  /\b(dabing|dabovan[eyá]|titulky|tit\.?)\b/gi,
  /\b(2d|3d|4dx|imax|screenx|4k|hfr|vip|premium)\b/gi,
  /\b(cz|sk|en|ua)\s*(dab|tit)\b/gi,
];

export function normalizeTitle(input: string): string {
  let s = input.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  s = s.toLowerCase();
  for (const re of NOISE) s = s.replace(re, " ");
  // Drop anything that is not a letter or digit so that ":", "-" and stray
  // whitespace cannot split one film into two.
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return s.replace(/\s+/g, " ");
}

/**
 * Same key with word breaks removed, used as a fallback.
 *
 * The chains transliterate some titles differently: Cinema City lists
 * "Uma Musume Pretty Derby: Shinjidai no Tobira" where CineStar writes
 * "Umamusume Pretty Derby: Shinjidai no Tobira". Collapsing spaces makes those
 * one film without loosening the match enough for unrelated titles to collide.
 */
export function tightKey(input: string): string {
  return normalizeTitle(input).replace(/ /g, "");
}

export type FilmIdentity = {
  matchKey: string;
  tightKey: string;
  /**
   * The Czech title on its own.
   *
   * Not every source publishes the original title — Golden Apple gives only the
   * Czech one, and so do the UFD tables. For those the primary key is built
   * from the Czech title and can never equal the original-title key the other
   * chains produce, which is how one film ends up in the ranking twice. This is
   * the key that bridges them.
   */
  czechKey: string;
  title: string;
  originalTitle: string | null;
};

export function filmIdentity(title: string, originalTitle: string | null): FilmIdentity {
  const cleanTitle = title.trim();
  // Cinema City sends "" rather than null when it has no original title.
  const cleanOriginal = originalTitle?.trim() || null;
  const basis = cleanOriginal || cleanTitle;
  const normalized = normalizeTitle(basis);
  // An empty key would collapse unrelated films into one row.
  const matchKey = normalized || normalizeTitle(cleanTitle) || cleanTitle.toLowerCase();
  return {
    matchKey,
    tightKey: matchKey.replace(/ /g, ""),
    czechKey: normalizeTitle(cleanTitle) || cleanTitle.toLowerCase(),
    title: cleanTitle,
    originalTitle: cleanOriginal,
  };
}
