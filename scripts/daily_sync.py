#!/usr/bin/env python3
"""Dagelijkse scan: officiële bekendmakingen binnen 100 m van het Stedin-hoogspanningsnet.

Stappen
  1. Zoekgebied lezen uit config/scope.json (gemeenten, provincies en waterschappen
     waarvan het grondgebied het net + buffer raakt; zie scripts/build_scope.py).
  2. SRU-API (repository.overheid.nl/sru, officielepublicaties) bevragen:
     Gemeenteblad per gemeente, Provinciaal blad per provincie, Waterschapsblad per
     waterschap, en de Staatscourant (ministeries, Rijkswaterstaat, ANVS, ILT, ...).
  3. Per publicatie de RD-geometrie (gebiedsmarkering) toetsen aan de assets:
     afstand <= buffer (100 m) => match. Publicaties zonder bruikbare geometrie
     (geen locatie, of alleen 'hele gemeente/provincie/waterschap', of een vlak groter
     dan --max-vlak-km2) worden NIET gematcht en niet bewaard; ze worden alleen geteld.
  4. Alleen matches: tekst ophalen, eerste inschatting (scripts/classify.py), en
     upsert naar public.bekendmakingen. Als punt wordt het punt van de publicatie-
     geometrie opgeslagen dat het dichtst bij het net ligt (zodat de PostGIS-functie
     dezelfde afstand berekent). Bestaande rijen: alleen last_seen bijwerken; een
     eerder (handmatig) oordeel wordt nooit overschreven.
  5. private.refresh_buffer_matches() via de wrapper public.sync_refresh_buffer_matches()
     (sql/002_sync_rpc.sql), daarna rijen met binnen_buffer_100m <> true verwijderen.
  4c. Vormen (vlak/lijn uit de metadata) bijvullen voor klassen in config/vormen.json.
  7. Menselijke review (public.feedback) naar feedback/feedback.jsonl (scripts/export_feedback.py).
  6. Optioneel GeoJSON-export van public.meldingen_kaart (nooit assets), plus
     meldingen_vormen.geojson met de vlakken/lijnen.

Gebruik (GitHub Action)
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/daily_sync.py --dagen 2 \\
      --export data/meldingen.geojson
Lokaal testen zonder database
  python scripts/daily_sync.py --van 2026-11-01 --tot 2026-11-10 \\
      --assets-file pad/naar/assets.shp --dry-run uit.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

import shapely
from shapely import wkt
from shapely.ops import nearest_points, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify  # noqa: E402
import sru  # noqa: E402
import vormen  # noqa: E402
import export_feedback  # noqa: E402
from geo import naar_rd, naar_wgs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCOPE = ROOT / "config" / "scope.json"
BREED = {"Gemeente", "Provincie", "Waterschap", "Land", "GeometrieRef"}
BRON = {"gmb": "Gemeenteblad", "prb": "Provinciaal blad", "wsb": "Waterschapsblad",
        "stcrt": "Staatscourant", "trb": "Tractatenblad", "stb": "Staatsblad"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- assets ------
def assets_uit_bestand(pad: Path):
    import geopandas as gpd  # alleen lokaal nodig
    gdf = gpd.read_file(pad)
    if gdf.crs is None:
        raise SystemExit("Assetbestand zonder CRS")
    return [g for g in gdf.to_crs(28992).geometry if g is not None and not g.is_empty]


# ---------------------------------------------------------------- geometrie ---
def rd_geom(rec: dict, max_vlak_km2: float):
    """Union van bruikbare RD-geometrieën, of (None, reden)."""
    gs, breed = [], False
    for g in rec.get("geo") or []:
        if not g.get("rd"):
            continue
        if g["type"] in BREED:
            breed = True
            continue
        try:
            gs.append(wkt.loads(g["rd"]))
        except Exception:  # noqa: BLE001
            pass
    if not gs:
        return None, ("alleen_hele_gebied" if breed else "zonder_geometrie")
    u = unary_union(gs)
    if u.area / 1e6 > max_vlak_km2:
        return None, "vlak_te_groot"
    return u, None


def locatie(rec: dict, tekst: str = "") -> str:
    m = re.search(r"\b(?:aan|op) de (.{3,80}?) te ([A-Z’'][\w’' -]{2,40}?)[.,]", tekst)
    if m and "melding ontvangen" in tekst:
        return f"{m.group(1)}, {m.group(2)}"
    labs = [g["label"] for g in rec.get("geo") or []
            if g.get("label") and not re.match(r"(Vlak|Punt|Lijn) \d", g["label"])]
    if labs:
        return labs[0]
    titel = rec.get("title") or ""
    return titel.split(" - ", 1)[0] if " - " in titel else ""


def bron_naam(rec: dict) -> str:
    prefix = (rec.get("id") or "").split("-")[0]
    blad = BRON.get(prefix, rec.get("publicatienaam") or prefix)
    org = "; ".join(rec.get("creator") or [])
    return f"{blad} {org}".strip() if prefix in ("gmb", "prb", "wsb") else blad


def bouw_rij(rec: dict, afstand: float, punt_rd, centroid_rd, tekst: str | None = None, g_rd=None) -> dict:
    if tekst is None:
        tekst = sru.fetch_text(rec.get("xml"))
    oordeel = classify.inschatting(rec, tekst)
    p = naar_wgs(punt_rd)
    c = naar_wgs(centroid_rd)
    rid = rec["id"]
    raw = {  # bewust compact en zonder assetgegevens (bekendmakingen is publiek leesbaar)
        "id": rid, "title": rec.get("title"), "type": rec.get("type"), "creator": rec.get("creator"),
        "date": rec.get("date"), "modified": rec.get("modified"), "publicatienaam": rec.get("publicatienaam"),
        "subject": rec.get("subject"), "html": rec.get("html"), "xml": rec.get("xml"),
        "geo": [{"type": g["type"], "label": g.get("label"), "gemeente": g.get("gemeente")}
                for g in rec.get("geo") or []],
        "centroid_wgs84": [round(c.x, 6), round(c.y, 6)],
        "punt": "dichtstbijzijnde punt van de publicatiegeometrie tot het net",
        "classificatie_bron": "automatisch-v1",
    }
    rij = {
        "kenmerk": rid,
        "datum": rec.get("date"),
        "inschatting": oordeel["inschatting"],
        "relevantie_score": oordeel["relevantie_score"],
        "bron": bron_naam(rec),
        "type": "; ".join(rec.get("type") or []),
        "titel": rec.get("title"),
        "locatie": locatie(rec, tekst),
        "toelichting": classify.toelichting(rec, tekst),
        "waarom": oordeel["waarom"],
        "ontbreekt": oordeel["ontbreekt"],
        "url": rec.get("html") or f"https://zoek.officielebekendmakingen.nl/{rid}.html",
        "uitgever": "; ".join(rec.get("creator") or []),
        "geom": f"SRID=4326;POINT({p.x:.7f} {p.y:.7f})",
        "binnen_buffer_100m": True,
        "afstand_tot_asset_m": round(afstand, 1),
        "raw": raw,
    }
    # originele vlak/lijn-geometrie voor de klassen in config/vormen.json (standaard: hoog)
    rij.update(vormen.velden(rec, g_rd, oordeel["inschatting"]))
    return rij


# ---------------------------------------------------------------- export ------
def export_geojson(rows: list[dict], pad: Path, vorm: bool = False) -> bool:
    rows = sorted(rows, key=lambda r: r["kenmerk"])
    rows.sort(key=lambda r: r.get("datum") or "", reverse=True)
    rows.sort(key=lambda r: -(r.get("relevantie_score") or 0))  # stabiel: score, dan nieuwste
    feats = []
    for r in rows:
        props = {k: r.get(k) for k in ("kenmerk", "datum", "inschatting", "relevantie_score", "bron", "type",
                                        "titel", "locatie", "toelichting", "waarom", "ontbreekt", "url",
                                        "uitgever", "binnen_buffer_100m", "afstand_tot_asset_m")}
        props["eerst_gezien"] = (r.get("first_seen") or "")[:10] or None
        if vorm:
            props["vorm_type"] = r.get("vorm_type")
        if props["afstand_tot_asset_m"] is not None:
            props["afstand_tot_asset_m"] = round(float(props["afstand_tot_asset_m"]), 1)
        feats.append({"type": "Feature", "geometry": r.get("geojson"), "properties": props})
    fc = {"type": "FeatureCollection", "name": "meldingen_vormen" if vorm else "meldingen_kaart", "features": feats}
    nieuw = json.dumps(fc, ensure_ascii=False, indent=1) + "\n"
    oud = pad.read_text(encoding="utf-8") if pad.exists() else ""
    if nieuw != oud:
        pad.parent.mkdir(parents=True, exist_ok=True)
        pad.write_text(nieuw, encoding="utf-8")
        return True
    return False


def sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    return "'" + str(v).replace("'", "''") + "'"


def schrijf_sql(rijen: list[dict], pad: Path) -> None:
    """Upsert-SQL (zelfde semantiek als de REST-weg) voor een handmatige backfill."""
    cols = ["kenmerk", "datum", "inschatting", "relevantie_score", "bron", "type", "titel", "locatie",
            "toelichting", "waarom", "ontbreekt", "url", "uitgever", "geom", "binnen_buffer_100m",
            "afstand_tot_asset_m", "raw", "geom_vorm", "vorm_type"]
    vals = []
    for r in rijen:
        v = [sql_literal(r[c]) for c in cols]
        v[cols.index("geom")] = f"extensions.ST_GeomFromEWKT({sql_literal(r['geom'])})"
        v[cols.index("raw")] = sql_literal(r["raw"]) + "::jsonb"
        if r.get("geom_vorm"):
            v[cols.index("geom_vorm")] = f"extensions.ST_GeomFromEWKT({sql_literal(r['geom_vorm'])})"
        vals.append("(" + ", ".join(v) + ")")
    sql = (f"INSERT INTO public.bekendmakingen ({', '.join(cols)}) VALUES\n" + ",\n".join(vals) +
           "\nON CONFLICT (kenmerk) DO UPDATE SET last_seen = now();\n")
    pad.write_text(sql, encoding="utf-8")


# ---------------------------------------------------------------- main --------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dagen", type=int, default=2, help="terugkijken over N dagen t/m vandaag (standaard 2)")
    ap.add_argument("--van", help="begindatum YYYY-MM-DD (overschrijft --dagen)")
    ap.add_argument("--tot", help="einddatum YYYY-MM-DD (standaard vandaag)")
    ap.add_argument("--buffer-m", type=float, default=100.0)
    ap.add_argument("--max-vlak-km2", type=float, default=2.0,
                    help="grotere vlakken gelden als 'geen precieze locatie' (standaard 2 km²)")
    ap.add_argument("--assets-file", type=Path, help="lokaal assetbestand i.p.v. public.assets")
    ap.add_argument("--dry-run", metavar="JSON", help="niets naar de database; schrijf matches naar JSON")
    ap.add_argument("--sql-out", metavar="SQL", help="schrijf upsert-SQL i.p.v. REST (handmatige backfill)")
    ap.add_argument("--export", metavar="GEOJSON", help="exporteer public.meldingen_kaart naar dit pad")
    ap.add_argument("--summary", metavar="JSON", help="schrijf een samenvatting (aantallen, geen assets)")
    a = ap.parse_args()

    offline = bool(a.dry_run or a.sql_out)
    sb = None
    if not offline or not a.assets_file:
        from supa import Supabase
        sb = Supabase.from_env()

    tot = a.tot or dt.date.today().isoformat()
    van = a.van or (dt.date.fromisoformat(tot) - dt.timedelta(days=a.dagen)).isoformat()
    scope = json.loads(SCOPE.read_text(encoding="utf-8"))
    log(f"Periode dt.date {van} t/m {tot}; scope: {len(scope['gemeenten'])} gemeenten, "
        f"{len(scope['provincies'])} provincies, {len(scope['waterschappen'])} waterschappen, Staatscourant")

    geoms = assets_uit_bestand(a.assets_file) if a.assets_file else sb.asset_geoms_rd()
    if not geoms:
        log("Geen assets gevonden: stop (anders zou alles buiten de buffer vallen).")
        return 3
    tree = shapely.STRtree(geoms)
    log(f"{len(geoms)} asset-geometrieën geladen (alleen in het geheugen)")

    # 1-2. ophalen
    recs: dict[str, dict] = {}
    per_query: dict[str, int] = {}
    for naam, q in sru.queries(van, tot, scope).items():
        total, rs = sru.run_query(q)
        per_query[naam] = total
        for r in rs:
            if r.get("id"):
                recs.setdefault(r["id"], r)
    log(f"Opgehaald: {sum(per_query.values())} hits, {len(recs)} unieke publicaties")

    # 3. matchen
    tel = Counter()
    matches = []
    for rid, rec in recs.items():
        g, reden = rd_geom(rec, a.max_vlak_km2)
        if g is None:
            tel[reden] += 1
            continue
        idx, dist = tree.query_nearest(g, max_distance=a.buffer_m, return_distance=True)
        if len(idx) == 0:
            tel["buiten_buffer"] += 1
            continue
        i = int(idx[int(dist.argmin())])
        p_pub, _ = nearest_points(g, geoms[i])
        matches.append((rec, float(dist.min()), p_pub, g.centroid, g))
    tel["binnen_buffer"] = len(matches)
    log(f"Resultaat: {dict(tel)}")

    # 4. rijen bouwen (tekst alleen voor matches)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        teksten = list(pool.map(lambda m: sru.fetch_text(m[0].get("xml")), matches))
    log(f"Tekst opgehaald voor {len(teksten)} matches")
    rijen = [bouw_rij(rec, d, p, c, t, g) for (rec, d, p, c, g), t in zip(matches, teksten)]
    per_klasse = Counter(r["inschatting"] for r in rijen)
    samenvatting = {"periode": {"van": van, "tot": tot}, "hits_per_query": per_query,
                    "unieke_publicaties": len(recs), "telling": dict(tel), "per_klasse": dict(per_klasse)}

    if a.sql_out:
        schrijf_sql(rijen, Path(a.sql_out))
        log(f"SQL geschreven: {a.sql_out} ({len(rijen)} rijen)")
    if a.dry_run:
        Path(a.dry_run).write_text(json.dumps(dict(samenvatting, rijen=rijen), ensure_ascii=False, indent=1),
                                   encoding="utf-8")
        log(f"Dry-run: {a.dry_run} geschreven")
    if offline:
        if a.summary:
            Path(a.summary).write_text(json.dumps(samenvatting, ensure_ascii=False, indent=1), encoding="utf-8")
        return 0

    # 4b. upsert via REST (service role)
    bestaand = sb.existing("bekendmakingen", "kenmerk", [r["kenmerk"] for r in rijen])
    nieuw = [r for r in rijen if r["kenmerk"] not in bestaand]
    sb.insert("bekendmakingen", nieuw)
    nu = dt.datetime.now(dt.timezone.utc).isoformat()
    oud = sorted(bestaand)
    for i in range(0, len(oud), 100):
        lst = ",".join(f'"{k}"' for k in oud[i:i + 100])
        sb.patch("bekendmakingen", {"kenmerk": f"in.({lst})"}, {"last_seen": nu})
    log(f"Upsert: {len(nieuw)} nieuw, {len(oud)} al bekend (last_seen bijgewerkt)")

    # 4c. vormen bijvullen (herklassificeerde of oudere rijen in de vormklassen zonder vorm_type)
    try:
        samenvatting["vormen"] = vormen.vul_ontbrekend(sb)
        log(f"Vormen ({', '.join(vormen.KLASSEN)}): {samenvatting['vormen']}")
    except RuntimeError as exc:
        log(f"WAARSCHUWING: vormen bijvullen mislukt ({exc}). Is sql/004_vormen.sql toegepast?")
        samenvatting["vormen"] = "mislukt"

    # 5. refresh + opschonen
    try:
        sb.rpc("sync_refresh_buffer_matches")
        log("private.refresh_buffer_matches() uitgevoerd")
        samenvatting["refresh"] = "ok"
    except RuntimeError as exc:
        log(f"WAARSCHUWING: refresh-RPC niet beschikbaar ({exc}). Pas sql/002_sync_rpc.sql toe. "
            "Buffervelden van nieuwe rijen zijn wel lokaal berekend.")
        samenvatting["refresh"] = "rpc ontbreekt"
    n_assets = sb.count("assets")
    if n_assets > 0:
        weg = sb.delete("bekendmakingen", {"binnen_buffer_100m": "not.is.true"})
        log(f"{weg} rij(en) buiten de buffer verwijderd")
        samenvatting["verwijderd_buiten_buffer"] = weg
    totaal = sb.count("bekendmakingen")
    samenvatting.update(nieuw=len(nieuw), al_bekend=len(oud), totaal_in_database=totaal)
    log(f"Totaal in database: {totaal}")

    # 6. export
    if a.export:
        rows = sb.select_all("meldingen_kaart", "*", "kenmerk")
        veranderd = export_geojson(rows, Path(a.export))
        log(f"GeoJSON {'bijgewerkt' if veranderd else 'ongewijzigd'}: {a.export} ({len(rows)} features)")
        pad_vormen = Path(a.export).with_name("meldingen_vormen.geojson")
        veranderd = export_geojson([dict(r, geojson=r.get("vorm_geojson")) for r in rows if r.get("vorm_geojson")],
                                   pad_vormen, vorm=True)
        log(f"Vormen-GeoJSON {'bijgewerkt' if veranderd else 'ongewijzigd'}: {pad_vormen}")

    # 7. menselijke review exporteren voor de feedbackloop (zonder e-mailadressen)
    try:
        samenvatting["feedback"] = export_feedback.export(sb)
        log(f"Feedback geëxporteerd: {samenvatting['feedback']}")
    except RuntimeError as exc:
        log(f"WAARSCHUWING: feedback-export mislukt ({exc}). Is sql/005_review.sql toegepast?")
        samenvatting["feedback"] = "mislukt"

    if a.summary:
        Path(a.summary).write_text(json.dumps(samenvatting, ensure_ascii=False, indent=1), encoding="utf-8")
    gh = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write(f"### Bekendmakingen {van} t/m {tot}\n\n```json\n"
                    f"{json.dumps(samenvatting, ensure_ascii=False, indent=1)}\n```\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
