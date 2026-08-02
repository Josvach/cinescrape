# CineScrape

Živá návštěvnost filmů v českých multikinech. Sbírá obsazenost jednotlivých
projekcí z Cinema City, CineStaru a Golden Apple a ukazuje, jak filmu nabíhá
návštěvnost —
v reálném čase, ne s týdenním zpožděním jako oficiální data UFD.

**Žádný server, žádná databáze, žádný účet navíc.** Scraper běží v GitHub
Actions, data jsou JSON soubory, stránka je jeden statický HTML soubor na
GitHub Pages. Na telefonu se dá dát „Přidat na plochu" a chová se jako appka.

## Co to umí

- **Živá celková návštěvnost filmu** napříč všemi sledovanými sítěmi
- **Návštěvnost po dnech projekce** — lístek prodaný dnes na zítřek se počítá
  k zítřku, takže pravá část grafu je předprodej, ne odhad
- **Křivka nabíhání prodeje** ve stylu Social Blade
- **Naplnění sálů**, nejplnější projekce, srovnání sítí, kin a formátů
- **Odhad tržeb** a podílu pro filmaře
- **Recenze a články** ke každému filmu z českých médií
- **Hodnocení v procentech** (volitelně, přes TMDB)

## Rozjetí

1. **Fork nebo push do vlastního repa.** Pro sběr každých 5 minut zdarma musí
   být repo **veřejné** — v privátním je limit 2 000 minut/měsíc, což stačí
   tak na dvacetiminutový interval.
2. **Secret**: `Settings → Secrets and variables → Actions → New secret`,
   jméno `CINESTAR_API_KEY`, hodnota je klíč z veřejné konfigurace frontendu
   cinestar.cz. Volitelně proměnná `SCRAPER_CONTACT` s kontaktem na tebe.
3. **Zapni Pages**: `Settings → Pages → Source: Deploy from a branch`,
   větev `gh-pages`, složka `/`. Větev vznikne až po prvním běhu.
4. **Spusť to poprvé ručně**: `Actions → ingest → Run workflow`. Trvá to pár
   minut, protože si to načítá kapacity všech sálů.

Pak už to jede samo. Adresa je `https://<uživatel>.github.io/<repo>/`.

Lokálně:

```bash
npm install
CINESTAR_API_KEY=… npm run ingest -- discover   # sběr
npm run serve                                    # http://localhost:4000
npm test
```

## Odkud data pocházejí

| | Cinema City | CineStar | Golden Apple |
|---|---|---|---|
| Kin | 13 | 12 | 2 (Zlín) |
| Rozvrh | `GET tickets.cinemacity.cz/api/presentations/` — celá síť jedním anonymním requestem, ~30 dní dopředu | SSR payload `cinestar.cz/cz/<kino>/program`, 12 stránek | homepage gacinema.cz — 4 dny programu naráz |
| Obsazenost | `availRatio` × kapacita sálu | `POST api.cinestar.cz/api/hall/get` — plán sálu sedadlo po sedadle | `POST /umbraco/Surface/ticketinglocal/GetSeating` — SVG plán sálu |
| Kapacita | `GET /api/seats/seatplan` (načte se jednou) | délka pole `seats` | počet `<g class="seat-item">` |
| Ceny | nezveřejňuje → odhad | reálný ceník projekce | cena v `data-tooltip` volného sedadla |

Cinema City udává `availRatio` jako desetinné číslo. Ověřeno na všech 3 401
projekcích ve 122 sálech: `availRatio × kapacita` vychází na celá čísla, takže
z něj jde odvodit **přesný počet prodaných sedadel**, ne odhad.

### Co to nepokrývá

Sledované sítě dohromady dělají zhruba **55 % návštěvnosti českých kin**. Zbytek
jsou stovky jednosálových kin bez společného rezervačního systému, která
obsazenost nezveřejňují. Tenhle projekt tedy **není** náhrada celostátních čísel
UFD a dashboard to říká nahlas.

### Premiere Cinemas a CINEMAX — proč tam nejsou

Obě sítě jsou technicky dosažitelné, ale obě si automatický přístup k prodejní
části výslovně zakazují v robots.txt, takže je nescrapujeme:

- **Premiere Cinemas** (4 česká multikina — Praha Hostivař, Olomouc, Teplice,
  Karlovy Vary). `robots.txt`: `User-agent: * / Disallow: /vstupenky/`. Plán
  sálu vrací `POST /ajax.php?c=PCRezervace&m=seatPlan` s `ci` a `mi`, ověřeno
  že funguje — jenže je to datový endpoint právě těch zakázaných stránek.
  Obejít to jinou URL by bylo obcházení, ne výjimka.
- **CINEMAX** má v ČR jediné kino (Olomouc Olympia, `kino` uid 15; zbytek sítě
  je slovenský a ten záměrně nechceme). Program se dá vytáhnout z
  `POST /main-ajax`, ale prodej běží na `prodej.cine-max.cz`, kde je
  `User-agent: * / Disallow: /` — tedy zákaz úplně všeho.

Kdyby to někdy mělo být jinak, správná cesta je se jich zeptat; z takového
nástroje mají hodnotu i ony. Golden Apple naproti tomu robots.txt nemá, takže
tam nic zakázané není.

## Jak to funguje

Jeden příkaz (`npm run ingest`) udělá celý cyklus: načte JSON stav, dotáhne obě
sítě, uloží stav zpátky a přegeneruje data pro stránku. Po každé iteraci se
výsledek force-pushne na větev `gh-pages`, odkud ho Pages servírují. Ta větev je
zároveň úložiště — každý běh z ní stav načte a zase ho tam uloží.

### Proč trigger jednou za hodinu, a ne za 5 minut

Protože `*/5` v cronu **nefunguje**. Naměřeno na tomhle repu: za tři hodiny
GitHub odpálil dva plánované běhy místo šestatřiceti — krátké intervaly řadí do
fronty a při zátěži zahazuje. A protože obsazenost projekce je po jejím začátku
nenávratně nečitelná, vynechaný odečet znamená trvale ztracené číslo.

Kadence proto nesmí viset na plánovači. Hodinový trigger GitHub spouští
spolehlivě, a job si pak 50 minut drží runnera a iteruje sám každých 5 minut
(`npm run ingest -- loop`). Po každé iteraci publikuje, takže dashboard se hýbe
po pěti minutách, ne po hodině.

### Tři věci, které tvarují celý návrh

**Data mizí.** Odehraná projekce zmizí z feedu (napozorováno: 3443 → 3428 za
10 minut) a CineStar u ní vrací `E_API_EVENT_NOT_SHARED`. Finální návštěvnost
se **nedá dohledat zpětně** — musí se zachytit odečtem těsně před začátkem.
Proto se frekvence dotazování s blížícím se představením zrychluje a poslední
odečet se natvrdo posouvá před čas začátku (`src/core/schedule.ts`). Každá
uzavřená projekce nese `confidence`: `final`, `partial`, nebo `missed` — a
`missed` se v UI nezamlčuje, jinak by nešlo odlišit „film se neprodával" od
„nestihli jsme to změřit".

**Náklady jsou asymetrické.** Cinema City = 1 request na celou síť. CineStar =
1 request na projekci. Poller proto nikdy nezkouší frontu vyprázdnit; běží
dokud mu nedojde rozpočet a zbytek dobere příští tik.

**Do rampy se počítá jen přírůstek.** Každý odečet se porovná s předchozím a do
hodinového kbelíku se přičte jen rozdíl. První odečet projekce se nepočítá
vůbec — to, co se prodalo, než jsme se dívali, není prodej za tuhle hodinu.
Pokles (storna, uvolněné blokace) se ignoruje, protože to není záporný prodej.

### Datové soubory

| Soubor | Životnost | Co v něm je |
|---|---|---|
| `state.json` | přepisuje se každý běh | vše, co je právě v prodeji, plus nedávná minulost čekající na uzavření |
| `history.json` | trvale | denní součty na film, po uzavření a složení |
| `live.json` | odvozený | předpočítané odpovědi pro stránku — jediné, co si telefon stahuje |

Uzavřené projekce se po 10 dnech složí do denních součtů a ze `state.json` se
smažou. Pracovní sada tak zůstává úměrná tomu, co je zrovna v prodeji, místo
aby rostla donekonečna. Naměřeno: `state.json` ~1 MB, `live.json` ~27 kB.

## Recenze, články a hodnocení

Ke každému filmu se dotahují české články a recenze přes **RSS Google News** —
zdarma, bez klíče, bez registrace. Recenze se poznají podle titulku a řadí se
nahoru.

**Hodnocení je volitelné** a bere se z **TMDB**. Chce to bezplatný klíč
(themoviedb.org → Settings → API) uložený jako secret `TMDB_API_KEY`. Bez něj
se hodnocení prostě nezobrazí, nic dalšího se nerozbije.

### Proč ne ČSFD

ČSFD by bylo přirozenější — je to hodnocení, které se v Česku cituje. Nemá ale
veřejné API a na všechno, co není prohlížeč, posílá proof-of-work výzvu
(„Making sure you're not a bot"). Kinobox je za Cloudflare a vrací 403.
Obcházet tyhle bariéry by znamenalo prolomit ochranu, kterou tam provozovatel
dal schválně — tohle to nedělá. Recenze z ČSFD se ale stejně objeví
v Google News jako odkaz, což je způsob, jak je vydavatelé číst chtějí.

Kontext se obnovuje jednou za 6 hodin a jen u filmů s aspoň 50 diváky. Článek
publikovaný ráno tam bude i večer — na rozdíl od obsazenosti, kterou nelze
dohnat.

## Proč to nejde jako soubor přímo v telefonu

Obě API blokují prohlížeč přes CORS:

- **Cinema City** neposílá hlavičku `access-control-allow-origin` vůbec.
- **CineStar** ji posílá jen pro vlastní doménu:
  `access-control-allow-origin: https://websale.cinestar.cz`.

Soubor otevřený z `file://` má origin `null`, takže mu prohlížeč fetch
zablokuje. Scraping proto musí běžet mimo prohlížeč — a jakmile běží v Actions,
sbírá se historie i když je telefon vypnutý, což lokální soubor nikdy neumí.

## Testy

```bash
npm test        # 79 testů, fixtures ze skutečných odpovědí obou API
npm run typecheck
```

Fixtures v `src/sources/__fixtures__/` jsou uložené reálné odpovědi, takže testy
neběží proti živému API. Klíčové testy hlídají převod `availRatio` → prodaná
sedadla, počítání `OCCUPIED` u CineStar a `occupied` u Golden Apple, párování
filmů napříč sítěmi, delta
logiku rampy a časovou zónu včetně přechodů na letní čas.

## Slušné chování a právní stránka

- **robots.txt sledované sítě povolují.** CineStar má `User-agent: * / Disallow:`
  a blokuje jmenovitě jen AI crawlery; `tickets.cinemacity.cz` a `gacinema.cz`
  robots.txt nemají vůbec. To ale **není** souhlas se scrapingem — před delším
  provozem projdi VOP. Kde robots.txt scraping zakazuje, tam nelezeme; viz
  Premiere Cinemas a CINEMAX výš.
- **Sui generis právo k databázi** (§ 88 AZ) chrání jejich programovou databázi.
  Pro soukromý nástroj je to jiná situace než pro veřejnou publikaci, ale kdyby
  se z toho někdy stala veřejná služba, publikuj **odvozenou analytiku**, ne
  kopii jejich programu.
- Crawler se představuje vlastním `User-Agent` (`SCRAPER_CONTACT`), drží
  ~3 req/s a netahá nic navíc.
- `CINESTAR_API_KEY` je veřejná konfigurace jejich frontendu, ale je jejich —
  čte se z env, do gitu nepatří.

## Známá omezení

- **Tržby jsou odhad.** Ani jedna síť neprozradí, v jaké cenové kategorii se
  které sedadlo prodalo (dospělý/student/dítě). Skutečná tržba bude nižší.
  Podíl pro filmaře je paušálních 50 % (`FILMMAKER_SHARE`), reálné smlouvy se
  liší film od filmu a týden od týdne.
- **Metadata projekcí se po registraci neobnovují**, kromě času začátku, který
  se bere z programové stránky zdarma.
- Historie se nedá získat zpětně — křivky a trendy dávají smysl až po několika
  dnech sběru.
- Pokud by repo bylo 60 dní bez aktivity, GitHub plánovaná workflow vypne.
- Sběr běží ~50 minut z každé hodiny, takže mezi 50. a 60. minutou je krátká
  mezera. Na veřejném repu jsou minuty zdarma neomezené, ale runner je po tu
  dobu obsazený.

## Předchozí verze

Verze s Postgresem, Next.js a nasazením na Vercel je commit `636b53d`:

```bash
git checkout 636b53d
```

Dávala smysl pro veřejný produkt s více uživateli. Pro soukromý nástroj přidávala
tři služby, tři přihlášení a placený plán navíc, aniž by dělala něco víc.
