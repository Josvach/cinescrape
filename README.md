# CineScrape

Živá návštěvnost filmů v českých multikinech. Sbírá obsazenost jednotlivých
projekcí z Cinema City a CineStar a ukazuje producentovi, jak jeho filmu nabíhá
návštěvnost — v reálném čase, ne s týdenním zpožděním jako oficiální data UFD.

## Co to umí

- **Živá celková návštěvnost filmu** napříč oběma sítěmi
- **Návštěvnost po dnech projekce** — lístek prodaný dnes na zítřek se počítá
  k zítřku, takže pravá část grafu je předprodej, ne odhad
- **Křivka nabíhání prodeje** ve stylu Social Blade
- **Naplnění sálů**, žebříčky, srovnání sítí, měst a formátů
- **Odhad tržeb** a podílu pro filmaře

## Odkud data pocházejí

| | Cinema City | CineStar |
|---|---|---|
| Kin | 13 | 12 |
| Rozvrh | `GET tickets.cinemacity.cz/api/presentations/` — celá síť jedním anonymním requestem, ~30 dní dopředu | SSR payload `cinestar.cz/cz/<kino>/program`, 12 stránek |
| Obsazenost | `availRatio` × kapacita sálu | `POST api.cinestar.cz/api/hall/get` — plán sálu sedadlo po sedadle |
| Kapacita | `GET /api/seats/seatplan` (cachuje se) | délka pole `seats` |
| Ceny | nezveřejňuje → odhad | reálný ceník projekce |

Cinema City udává `availRatio` jako desetinné číslo. Ověřeno na všech 3 401
projekcích ve 122 sálech: `availRatio × kapacita` vychází na celá čísla, takže
z něj jde odvodit **přesný počet prodaných sedadel**, ne odhad.

### Co to nepokrývá

Obě sítě dohromady dělají zhruba **55 % návštěvnosti českých kin**. Zbytek jsou
stovky jednosálových kin bez společného rezervačního systému, která obsazenost
nezveřejňují. Tenhle projekt tedy **není** náhrada celostátních čísel UFD a
dashboard to říká nahlas.

## Jak to běží

Čtyři cron joby na Vercelu, každý s vlastním časovým rozpočtem:

| Job | Frekvence | Co dělá |
|---|---|---|
| `/api/cron/cinemacity` | 5 min | jeden fetch → snapshot všech projekcí |
| `/api/cron/cinestar-halls` | 5 min | prioritní fronta `hall/get` |
| `/api/cron/cinestar-schedule` | 6 h | nové projekce z programových stránek |
| `/api/cron/settle` | 15 min | uzavření odehraných projekcí |

### Dvě věci, které tvarují celý návrh

**Data mizí.** Odehraná projekce zmizí z feedu (napozorováno: 3443 → 3428 za
10 minut) a CineStar u ní vrací `E_API_EVENT_NOT_SHARED`. Finální návštěvnost
se **nedá dohledat zpětně** — musí se zachytit snapshotem těsně před začátkem.
Proto se frekvence pollingu s blížícím se představením zrychluje a poslední
odečet se natvrdo posouvá před čas začátku (`nextPollAt` v `src/ingest/schedule.ts`).
Každá uzavřená projekce nese `confidence`: `final`, `partial`, nebo `missed` —
a `missed` se v UI nezamlčuje, jinak by nešlo odlišit „film se neprodával" od
„nestihli jsme to změřit".

**Náklady jsou asymetrické.** Cinema City = 1 request na celou síť. CineStar =
1 request na projekci. Poller proto nikdy nezkouší frontu vyprázdnit; běží
dokud mu nedojde rozpočet (~50 s) a zbytek dobere příští tik.

## Rozjetí

```bash
npm install
cp .env.example .env          # doplň DATABASE_URL, CRON_SECRET, CINESTAR_API_KEY
npm run db:push
npm run dev
```

Cron joby jdou spustit ručně:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/cinemacity
```

### Vercel

- **Cron pod 1× denně vyžaduje Vercel Pro.** Hobby plán umí max 2 joby a jen
  denní frekvenci, což na real-time nestačí.
- `DATABASE_URL` musí mířit na **pooled** endpoint (Neon). Ingest posílá stovky
  malých sekvenčních dotazů na běh, takže HTTP driver by rozpočet nestihl.
- `CRON_SECRET` chrání endpointy — bez něj by kdokoli mohl přes nás zatěžovat
  API kin.

## Testy

```bash
npm test        # 56 testů, fixtures ze skutečných odpovědí obou API
npm run typecheck
```

Fixtures v `src/sources/__fixtures__/` jsou uložené reálné odpovědi, takže testy
neběží proti živému API. Klíčové testy hlídají převod `availRatio` → prodaná
sedadla, počítání `OCCUPIED` u CineStar, párování filmů napříč sítěmi a časovou
zónu včetně přechodů na letní čas.

## Slušné chování a právní stránka

- **robots.txt obojí povoluje.** CineStar má `User-agent: * / Disallow:` a
  blokuje jmenovitě jen AI crawlery; `tickets.cinemacity.cz` robots.txt nemá.
  To ale **není** souhlas se scrapingem — před ostrým provozem projdi VOP obou
  sítí.
- **Sui generis právo k databázi** (§ 88 AZ) chrání jejich programovou databázi.
  Publikuj **odvozenou analytiku**, ne kopii jejich programu.
- Crawler se představuje vlastním `User-Agent` (`SCRAPER_CONTACT` v `.env`),
  drží ~3 req/s a netahá nic navíc.
- `CINESTAR_API_KEY` je veřejná konfigurace jejich frontendu, ale je jejich —
  čte se z env, do gitu nepatří.

## Známá omezení

- **Tržby jsou odhad.** Ani jedna síť neprozradí, v jaké cenové kategorii se
  které sedadlo prodalo (dospělý/student/dítě). Skutečná tržba bude nižší než
  uváděný odhad. Podíl pro filmaře je paušálních 50 % (`FILMMAKER_SHARE`),
  reálné smlouvy se liší film od filmu a týden od týdne.
- **Metadata projekcí se po registraci neobnovují** (kromě času začátku, který
  se bere z programové stránky zdarma). Změna normalizačních pravidel proto
  vyžaduje backfill starých řádků.
- Historie se nedá získat zpětně — křivky a trendy dávají smysl až po několika
  dnech sběru.
