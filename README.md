# Bekendmakingen-monitor Stedin hoogspanning

Dagelijkse monitor van **officiële bekendmakingen** (vergunningen, meldingen, besluiten)
die binnen **100 meter van het Stedin-hoogspanningsnet** liggen. De resultaten staan in
een PostGIS-database (Supabase), op een klikbare kaart (GitHub Pages) en als laag in QGIS.

- Website: <https://jakobmarin.github.io/bekendmakingen-monitor/>
- GeoJSON-laag: <https://jakobmarin.github.io/bekendmakingen-monitor/data/meldingen.geojson>
- Database: Supabase-project `bekendmakingen-monitor` (ref `faooiidlipaaowwjzpah`, regio eu-central-1)

Het hoogspanningsnet zelf (tabel `public.assets`) is **privé**: het staat niet in deze repo,
niet op de website en is niet leesbaar met de publieke sleutel.

---

## Hoe het werkt

```
SRU-API officiële bekendmakingen ──► scripts/daily_sync.py (GitHub Action, dagelijks)
                                        │  1. ophalen voor alle overheden in config/scope.json
                                        │  2. geometrie toetsen: ≤ 100 m van het net?
                                        │  3. alleen matches: inschatting + upsert
                                        ▼
                         Supabase / PostGIS  public.bekendmakingen
                                        │  private.refresh_buffer_matches()
                                        │  rijen buiten de buffer worden verwijderd
                                        ▼
               view public.meldingen_kaart ──► website (live via REST)
                                            ──► data/meldingen.geojson (dagelijkse export)
                                            ──► QGIS (PostGIS-koppeling of GeoJSON-URL)
```

### Bronnen (wat er dagelijks wordt opgehaald)

Alles via de SRU-API van officielebekendmakingen.nl: `https://repository.overheid.nl/sru`,
collectie `c.product-area==officielepublicaties`, op publicatiedatum (`dt.date`),
standaard de afgelopen 2 dagen (zodat late publicaties niet gemist worden).

1. **Gemeenteblad** van elke gemeente waarvan het grondgebied het Stedin-net (+100 m) kruist
   — nu 62 gemeenten (o.a. Rotterdam, ’s-Gravenhage, Utrecht, Amersfoort, Delft, Dordrecht, Goes).
2. **Provinciaal blad** van elke provincie die het net kruist — nu Zuid-Holland, Utrecht en Zeeland.
3. **Waterschapsblad** van **elk** waterschap waarvan het beheergebied het net kruist — nu 9:
   Hollandse Delta, Delfland, De Stichtse Rijnlanden, Schieland en de Krimpenerwaard,
   Vallei en Veluwe, Rivierenland, Scheldestromen, Rijnland, Amstel Gooi en Vecht.
4. **Staatscourant**: hierin publiceren ministeries, Rijkswaterstaat en andere rijksdiensten
   (ANVS, ILT, inspecties, enz.). De Staatscourant wordt volledig opgehaald maar **niet**
   ongefilterd bewaard: alleen stukken waarvan de meegeleverde geometrie binnen 100 m van
   het net ligt, komen in de database.

De lijst met overheden staat in [`config/scope.json`](config/scope.json) (alleen namen, geen
assetgeometrie). Die is bepaald met een spatial join van het net (+100 m) met de PDOK-grenzen
van gemeenten en provincies (Kadaster) en de waterschapsgrenzen (Het Waterschapshuis), met
[`scripts/build_scope.py`](scripts/build_scope.py). Draai dat opnieuw als het net verandert.

### Matching en wat er bewaard wordt

- Per publicatie wordt de RD-geometrie uit de metadata (`gebiedsmarkering`: punt, lijn, vlak,
  adres, hectometerpaal) vergeleken met het net in RD New (EPSG:28992).
  Afstand ≤ 100 m ⇒ match.
- **Publicaties zonder coördinaten worden niet automatisch gematcht** en niet bewaard: geen
  geometrie, alleen “hele gemeente/provincie/waterschap”, of een vlak groter dan 2 km²
  (bijv. een Natura 2000-gebied). Ze worden alleen geteld in de run-samenvatting
  (artifact `run-summary` van elke run). Ze worden nooit stilzwijgend als “binnen buffer” gemarkeerd.
- Het opgeslagen punt is het punt van de publicatiegeometrie dat het dichtst bij het net
  ligt (bij een vlak of tracé dus de plek waar het het net nadert). Het middelpunt staat in `raw`.
- Na de upsert roept de job `private.refresh_buffer_matches()` aan (afstand in RD New,
  `binnen_buffer_100m = afstand <= 100`) en verwijdert hij rijen met `binnen_buffer_100m`
  ≠ true. Bestaande rijen krijgen alleen een nieuwe `last_seen`; een handmatig aangepast
  oordeel wordt nooit overschreven.
- **Eerste inschatting** (`inschatting` / `relevantie_score`):
  `hoog` (3) graafwerk, kabels/leidingen, boringen, bouwrijp maken, netbeheerder;
  `middel` (2) grondverzet, sloop, herinrichting, nieuwbouw zonder details;
  `laag` (1) klein/ondiep werk, of niet automatisch te duiden;
  `niet relevant` (0) evenementen, horeca, puur bouwkundig, beleid, verkeersbesluiten.
  Regels in [`scripts/classify.py`](scripts/classify.py). Ook “niet relevant” blijft op de kaart
  als het binnen 100 m ligt, zodat je kunt nakijken.

---

## De website

Statische site (`index.html`, `config.js`, `assets/`) voor GitHub Pages. De kaart leest live
uit `https://faooiidlipaaowwjzpah.supabase.co/rest/v1/meldingen_kaart` met de
**publishable key** uit `config.js`. Die sleutel is bewust openbaar (zoals een anon key):
Row Level Security staat alleen lezen van de bekendmakingen toe; `public.assets` geeft 0 rijen.
Lukt de API niet, dan valt de site terug op `data/meldingen.geojson`.

- Standaard: meldingen **binnen 100 m van het net**; knop “Alle opgeslagen meldingen”.
- Filters op inschatting (hoog rood, middel oranje, laag goud, niet relevant grijs).
- Klik op een punt of in de lijst voor details en de link naar de officiële bekendmaking.
- Het hoogspanningsnet zelf wordt niet getoond.

---

## De dagelijkse job (GitHub Action)

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) draait elke dag om 05:00 UTC
(06:00 Amsterdam-tijd in de winter, 07:00 in de zomer) en is handmatig te starten
(*Actions → Dagelijkse scan bekendmakingen → Run workflow*, met `dagen` = bijv. 30 voor een backfill).

**Repository secrets** (Settings → Secrets and variables → Actions → New repository secret):

| Secret | Waarde |
|---|---|
| `SUPABASE_URL` | `https://faooiidlipaaowwjzpah.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | de **service_role / secret key** uit Supabase → Project Settings → API Keys |

De service_role key omzeilt RLS: alleen als GitHub Secret gebruiken, nooit in een bestand.

**Eenmalig in de database** (SQL Editor of via de bot): voer
[`sql/002_sync_rpc.sql`](sql/002_sync_rpc.sql) uit. Dat maakt `public.sync_refresh_buffer_matches()`,
een wrapper rond `private.refresh_buffer_matches()` die alleen de service_role mag aanroepen
(het schema `private` is niet via de REST-API bereikbaar).

De job commit `data/meldingen.geojson` als bot (`github-actions[bot]`) wanneer de inhoud
veranderde; GitHub Pages publiceert dat bestand daarna automatisch.

Lokaal testen zonder database:

```bash
pip install -r requirements.txt geopandas pyogrio
python scripts/daily_sync.py --van 2026-11-01 --tot 2026-11-10 \
  --assets-file /pad/naar/Hoogspanningsverbindingen.shp --dry-run uit.json
```

---

## QGIS

### Optie 1 — GeoJSON via HTTPS (eenvoudig, alleen lezen)

*Kaartlagen → Laag toevoegen → Vectorlaag toevoegen* → Bron: **Protocol: HTTP(S)** →
URI `https://jakobmarin.github.io/bekendmakingen-monitor/data/meldingen.geojson`.
Bijwerken: rechtsklik op de laag → *Vernieuwen* (of laag opnieuw laden). Wordt dagelijks na de scan ververst.

### Optie 2 — Directe PostGIS-laag (live)

*Kaartlagen → Laag toevoegen → PostGIS-laag* → *Nieuw*:

| Veld | Waarde |
|---|---|
| Naam | Bekendmakingen-monitor |
| Host | `db.faooiidlipaaowwjzpah.supabase.co` |
| Poort | `5432` |
| Database | `postgres` |
| SSL-modus | `require` |
| Gebruiker | `postgres` |
| Wachtwoord | ophalen in het Supabase-dashboard → *Project Settings → Database* (niet opslaan op een gedeelde pc) |

Kies daarna de laag **`public.meldingen_kaart`** (of `public.bekendmakingen`), geometriekolom `geom`, EPSG:4326.
Vernieuwen: *Beeld → Vernieuwen* (F5), of in de laageigenschappen → *Weergave* een automatisch
verversingsinterval instellen.

Lukt verbinden niet? De directe host is vaak alleen via IPv6 bereikbaar. Gebruik dan de
**Session pooler** uit het dashboard (*Connect → Session pooler*): host in de vorm
`aws-…-eu-central-1.pooler.supabase.com`, poort 5432, gebruiker `postgres.faooiidlipaaowwjzpah`.

**Let op met assets in QGIS:** de gebruiker `postgres` kan ook `public.assets` (het
hoogspanningsnet) lezen. Voeg die tabel alleen toe op je eigen, beveiligde computer, en sla het
wachtwoord niet op in een gedeeld QGIS-project. Voor gedeelde pc’s: maak met
[`sql/003_optioneel_qgis_leesrol.sql`](sql/003_optioneel_qgis_leesrol.sql) een rol die alleen
de kaartview mag lezen.

---

## Assets bijwerken

De assets (nu: Stedin-hoogspanningsverbindingen, 1.012 samengevoegde circuits, `bron = 'Stedin'`)
staan alleen in de database. Nieuwe of andere assets laden:

- stuur het bestand (Shapefile, GeoPackage, GeoJSON of CSV) naar de bot, of
- lokaal: [`scripts/load_assets.py`](scripts/load_assets.py)

```bash
export SUPABASE_URL=https://faooiidlipaaowwjzpah.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...        # alleen in je shell, nooit committen
python scripts/load_assets.py leidingen.gpkg --bron leidingen --vervang
python scripts/build_scope.py --uit-database   # zoekgebied opnieuw bepalen → config/scope.json
```

`load_assets.py` roept daarna de bufferherberekening aan.

---

## Bestanden

| Pad | Wat |
|---|---|
| `index.html`, `config.js`, `assets/app.js`, `assets/app.css` | website (Leaflet) |
| `data/meldingen.geojson` | dagelijkse export van `meldingen_kaart` (geen assets) |
| `config/scope.json` | zoekgebied: gemeenten, provincies, waterschappen (+ Staatscourant) |
| `scripts/daily_sync.py` | dagelijkse scan, matching, upsert, refresh, export |
| `scripts/sru.py`, `scripts/classify.py`, `scripts/geo.py`, `scripts/supa.py` | hulpmodules |
| `scripts/build_scope.py` | zoekgebied bepalen uit de assets (PDOK-grenzen) |
| `scripts/load_assets.py` | assets laden in `public.assets` |
| `sql/001_schema_documentatie.sql` | kopie van het bestaande schema (niet opnieuw uitvoeren) |
| `sql/002_sync_rpc.sql` | **eenmalig uitvoeren**: RPC-wrapper voor de Action |
| `sql/003_optioneel_qgis_leesrol.sql` | optioneel: alleen-lezen-rol voor QGIS |
| `.github/workflows/daily.yml` | GitHub Action |

Bron van de data: [officiële bekendmakingen](https://zoek.officielebekendmakingen.nl/) (KOOP).
Een inschatting is een eerste, automatische beoordeling; controleer altijd de officiële publicatie.
