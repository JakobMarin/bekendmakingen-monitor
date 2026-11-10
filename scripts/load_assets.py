#!/usr/bin/env python3
"""Laad assets (fabriek, pijpleiding, kabel, ...) in public.assets en herbereken de buffer.

De assets-tabel is privé: RLS blokkeert anon/authenticated, dus de publieke website
en de publishable key zien deze geometrieën nooit. Dit script gebruikt daarom
SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (alleen lokaal in je shell zetten; nooit
committen). Draai het op je eigen computer, niet in een publieke Action.

Ondersteund
  .geojson / .json   FeatureCollection of Feature (WGS84; of crs EPSG:28992)
  .csv / .txt        kolommen lat/lon (WGS84) of x/y (RD New), of een kolom wkt
                     (WGS84, of RD New met --csv-crs 28992)
  .gpkg / .shp / ... via geopandas (pip install geopandas), CRS uit het bestand

Voorbeelden
  export SUPABASE_URL=https://faooiidlipaaowwjzpah.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=...          # uit Supabase-dashboard, nooit in de repo
  python scripts/load_assets.py assets.geojson --bron "assets-2026-11" --naam-kolom naam
  python scripts/load_assets.py leidingen.gpkg --vervang --bron leidingen
  python scripts/load_assets.py assets.csv --dry-run     # alleen controleren

Na het laden roept het script public.sync_refresh_buffer_matches() aan (wrapper rond
private.refresh_buffer_matches(), zie sql/002_sync_rpc.sql). Werk daarna ook
config/scope.json bij met scripts/build_scope.py als het net een ander gebied beslaat.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely import wkt
from shapely.geometry import mapping, shape

LON = ("lon", "lng", "long", "longitude")
LAT = ("lat", "latitude")
X_RD = ("x", "x_rd", "rdx", "rd_x", "easting")
Y_RD = ("y", "y_rd", "rdy", "rd_y", "northing")
NAAM = ("naam", "name", "omschrijving", "description", "id")
TYPE = ("type", "soort", "categorie", "category")


def _kol(velden, opties, voorkeur=None):
    look = {str(v).strip().lower(): v for v in velden or []}
    if voorkeur:
        if voorkeur.lower() in look:
            return look[voorkeur.lower()]
        raise SystemExit(f"Kolom '{voorkeur}' niet gevonden. Beschikbaar: {list(velden)}")
    for o in opties:
        if o in look:
            return look[o]
    return None


def _naar_wgs(g, epsg: int):
    if epsg == 4326:
        return g
    t = Transformer.from_crs(epsg, 4326, always_xy=True)

    def f(xy):
        import numpy as np
        x, y = t.transform(xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])
    return shapely.transform(g, f)


def lees_geojson(pad: Path, a) -> list[dict]:
    raw = json.loads(pad.read_text(encoding="utf-8"))
    feats = raw.get("features") if raw.get("type") == "FeatureCollection" else [raw]
    crsnaam = str(((raw.get("crs") or {}).get("properties") or {}).get("name", ""))
    epsg = 28992 if "28992" in crsnaam else 4326
    out = []
    for i, f in enumerate(feats or [], 1):
        if not f or not f.get("geometry"):
            continue
        p = f.get("properties") or {}
        out.append({"geom": _naar_wgs(shape(f["geometry"]), epsg),
                    "naam": str(p.get(_kol(p.keys(), NAAM, a.naam_kolom) or "", "") or f"asset {i}"),
                    "type": p.get(_kol(p.keys(), TYPE, a.type_kolom) or "") if p else None})
    return out


def lees_csv(pad: Path, a) -> list[dict]:
    with pad.open(newline="", encoding="utf-8-sig") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        r = csv.DictReader(fh, dialect=dialect)
        velden = r.fieldnames
        wktk = _kol(velden, ("wkt", "geom", "geometry", "geometrie"))
        lon, lat = _kol(velden, LON), _kol(velden, LAT)
        x, y = _kol(velden, X_RD), _kol(velden, Y_RD)
        naamk, typek = _kol(velden, NAAM, a.naam_kolom), _kol(velden, TYPE, a.type_kolom)
        out = []
        for i, row in enumerate(r, 2):
            try:
                if wktk and row.get(wktk):
                    g = _naar_wgs(wkt.loads(row[wktk]), a.csv_crs)
                elif lon and lat:
                    g = shape({"type": "Point", "coordinates": [
                        float(row[lon].replace(",", ".")), float(row[lat].replace(",", "."))]})
                elif x and y:
                    g = _naar_wgs(shape({"type": "Point", "coordinates": [
                        float(row[x].replace(",", ".")), float(row[y].replace(",", "."))]}), 28992)
                else:
                    raise SystemExit(f"Geen coördinaatkolommen (lat/lon, x/y of wkt) in {velden}")
            except (ValueError, TypeError) as exc:
                print(f"  regel {i} overgeslagen: {exc}", file=sys.stderr)
                continue
            out.append({"geom": g, "naam": (row.get(naamk) if naamk else None) or f"asset regel {i}",
                        "type": row.get(typek) if typek else None})
        return out


def lees_gis(pad: Path, a) -> list[dict]:
    try:
        import geopandas as gpd
    except ImportError:
        raise SystemExit("Voor Shapefile/GeoPackage: pip install geopandas")
    gdf = gpd.read_file(pad)
    if gdf.crs is None:
        raise SystemExit(f"{pad} heeft geen CRS.")
    gdf = gdf.to_crs(4326)
    naamk, typek = _kol(gdf.columns, NAAM, a.naam_kolom), _kol(gdf.columns, TYPE, a.type_kolom)
    return [{"geom": row.geometry, "naam": str(row[naamk]) if naamk else f"asset {i}",
             "type": str(row[typek]) if typek else None}
            for i, row in gdf.iterrows() if row.geometry is not None and not row.geometry.is_empty]


def lees(pad: Path, a) -> list[dict]:
    s = pad.suffix.lower()
    if s in (".geojson", ".json"):
        items = lees_geojson(pad, a)
    elif s in (".csv", ".txt", ".tsv"):
        items = lees_csv(pad, a)
    else:
        items = lees_gis(pad, a)
    items = [i for i in items if i["geom"] is not None and not i["geom"].is_empty]
    for i in items:
        b = i["geom"].bounds  # sanity check: Nederland in WGS84
        if not (2.5 <= b[0] <= 7.5 and 50.5 <= b[1] <= 54):
            raise SystemExit(f"Asset '{i['naam']}' ligt niet in Nederland ({b}); klopt het CRS?")
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bestand", type=Path)
    ap.add_argument("--bron", help="label voor deze import (kolom bron), standaard de bestandsnaam")
    ap.add_argument("--naam-kolom")
    ap.add_argument("--type-kolom")
    ap.add_argument("--csv-crs", type=int, default=4326, help="EPSG van een wkt-kolom in CSV (4326 of 28992)")
    ap.add_argument("--vervang", action="store_true", help="verwijder eerst bestaande assets met dezelfde bron")
    ap.add_argument("--dry-run", action="store_true", help="alleen lezen en controleren, niets schrijven")
    a = ap.parse_args()
    if not a.bestand.is_file():
        print(f"Bestand bestaat niet: {a.bestand}", file=sys.stderr)
        return 2
    bron = a.bron or a.bestand.name
    items = lees(a.bestand, a)
    soorten = sorted({i["geom"].geom_type for i in items})
    print(f"{len(items)} asset(s) gelezen uit {a.bestand} ({', '.join(soorten)}), bron='{bron}'")
    if a.dry_run or not items:
        return 0
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from supa import Supabase
    sb = Supabase.from_env()
    if a.vervang:
        n = sb.delete("assets", {"bron": f"eq.{bron}"})
        print(f"{n} bestaande asset(s) met bron '{bron}' verwijderd")
    sb.insert("assets", [{"naam": i["naam"], "type": i["type"], "bron": bron,
                          "geom": "SRID=4326;" + i["geom"].wkt} for i in items])
    try:
        sb.rpc("sync_refresh_buffer_matches")
    except RuntimeError as exc:
        print(f"Refresh-RPC mislukt ({exc}); pas sql/002_sync_rpc.sql toe.", file=sys.stderr)
    print(f"Klaar: {sb.count('assets')} assets in de database; "
          f"{sb.count('bekendmakingen', binnen_buffer_100m='is.true')} bekendmakingen binnen 100 m.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
