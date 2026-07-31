import { describe, expect, it } from "vitest";

import { filmIdentity, normalizeTitle } from "./match";

describe("normalizeTitle", () => {
  it("strips diacritics, case and punctuation", () => {
    expect(normalizeTitle("Odvážná Vaiana")).toBe("odvazna vaiana");
    expect(normalizeTitle("Spider-Man: Brand New Day")).toBe("spider man brand new day");
  });

  it("removes version and format markers", () => {
    expect(normalizeTitle("Odyssea TITULKY")).toBe("odyssea");
    expect(normalizeTitle("Odyssea DABING 3D")).toBe("odyssea");
    expect(normalizeTitle("Avatar IMAX 4DX")).toBe("avatar");
  });
});

describe("filmIdentity", () => {
  it("keys on the original title so the chains agree", () => {
    // Cinema City brands one showing as a children's matinee; CineStar does not.
    const cc = filmIdentity("Dětská neděle - Tlapková patrola: Dinosauří film", "Paw Patrol: The Dino Movie");
    const cs = filmIdentity("Tlapková patrola: Dinosauří film", "PAW Patrol: The Dino Movie");
    expect(cc.matchKey).toBe(cs.matchKey);
  });

  it("matches the real Spider-Man pair across chains", () => {
    const cc = filmIdentity("Spider-Man: Zbrusu nový den", "Spider-Man: Brand New Day");
    const cs = filmIdentity("Spider-Man: Zbrusu nový den", "Spider-Man: Brand New Day");
    expect(cc.matchKey).toBe(cs.matchKey);
  });

  it("falls back to the Czech title for domestic films", () => {
    // Cinema City sends an empty string rather than null here.
    const cc = filmIdentity("Bardotky", "");
    const cs = filmIdentity("Bardotky", null);
    expect(cc.matchKey).toBe("bardotky");
    expect(cc.matchKey).toBe(cs.matchKey);
  });

  it("bridges a transliteration difference via the tight key", () => {
    // Observed live: the chains disagree about where "Uma Musume" breaks.
    const cc = filmIdentity("Umamusume: Pretty Derby – Begining of a", "Uma Musume Pretty Derby: Shinjidai no Tobira");
    const cs = filmIdentity("Umamusume: Pretty Derby - Beginning of a New Era", "Umamusume Pretty Derby: Shinjidai no Tobira");
    expect(cc.matchKey).not.toBe(cs.matchKey);
    expect(cc.tightKey).toBe(cs.tightKey);
  });

  it("keeps genuinely different films apart", () => {
    const a = filmIdentity("Tlapková patrola ve velkofilmu", "");
    const b = filmIdentity("Tlapková patrola: Dinosauří film", "Paw Patrol: The Dino Movie");
    expect(a.matchKey).not.toBe(b.matchKey);
    expect(a.tightKey).not.toBe(b.tightKey);
  });

  it("never produces an empty key", () => {
    expect(filmIdentity("???", null).matchKey).not.toBe("");
  });
});
