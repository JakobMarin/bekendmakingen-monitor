#!/usr/bin/env python3
"""Bepaal het zoekgebied (scope) van de monitor uit de assets.

Spatial join: assets (+ buffer, standaard 100 m, in RD New) <-> PDOK-grenzen van
gemeenten, provincies (Kadaster bestuurlijke gebieden, OGC API) en waterschappen
(Het Waterschapshuis, waterschapsgrenzen IMSO, GeoPackage).

Resultaat: config/scope.json met alleen NAMEN van overheden (geen assetgeometrie),
plus de SRU-namen (dt.creator) die de dagelijkse scan gebruikt. Draai dit opnieuw
als het assetbestand verandert.

Bronnen voor de assets (kies één):
  --shp PAD.shp          lokaal shapefile/GeoPackage (via geopandas), CRS uit bestand
  --uit-database         download public.assets via SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

  python scripts/build_scope.py --shp ../private-assets/Hoogspanningsverbindingen.shp
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
from pathlib import Path

import requests
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992"
BG = "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/{c}/items"
WS_GPKG = ("https://service.pdok.nl/hwh/waterschappen-waterschapsgrenzen-imso/atom/"
           "downloads/hwh_waterschapsgrenzenimso_geopackage_IMWA.gpkg")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def assets_uit_bestand(pad: Path):
    import geopandas as gpd
    gdf = gpd.read_file(pad)
    if gdf.crs is None:
        raise SystemExit("Assetbestand zonder CRS")
    return list(gdf.to_crs(28992).geometry.dropna())


def assets_uit_database():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from supa import Supabase
    sb = Supabase.from_env()
    return [g for g in sb.asset_geoms_rd()]


def pdok_items(collectie: str) -> list[dict]:
    feats, url = [], BG.format(c=collectie)
    params = {"f": "json", "limit": 1000, "crs": RD_CRS}
    while url:
        r = requests.get(url, params=params, timeout=120)
        r.raise_for_status()
        j = r.json()
        feats += j.get("features", [])
        url = next((l["href"] for l in j.get("links", []) if l.get("rel") == "next"), None)
        params = None
    return feats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shp", type=Path)
    ap.add_argument("--uit-database", action="store_true")
    ap.add_argument("--buffer-m", type=float, default=100)
    ap.add_argument("--uit", type=Path, default=ROOT / "config" / "scope.json")
    a = ap.parse_args()
    if not a.shp and not a.uit_database:
        ap.error("geef --shp of --uit-database")

    geoms = assets_uit_bestand(a.shp) if a.shp else assets_uit_database()
    log(f"{len(geoms)} asset-geometrieën")
    tree = shapely.STRtree(geoms)

    def raakt(g):
        # bestuursgebied ligt binnen buffer_m van minstens één asset
        return len(tree.query(g, predicate="dwithin", distance=a.buffer_m)) > 0

    gemeenten = sorted({f["properties"]["naam"] for f in pdok_items("gemeentegebied")
                        if raakt(shape(f["geometry"]))})
    provincies = sorted({f["properties"]["naam"] for f in pdok_items("provinciegebied")
                         if raakt(shape(f["geometry"]))})
    import geopandas as gpd
    ws = gpd.read_file(io.BytesIO(requests.get(WS_GPKG, timeout=300).content)).to_crs(28992)
    waterschappen = sorted({row["waterbeheerder"] for _, row in ws.iterrows()
                            if row.geometry is not None and raakt(row.geometry)})
    scope = {
        "toelichting": ("Overheden waarvan het grondgebied het assetnet (+buffer) raakt. "
                        "Alleen namen, geen assetgeometrie. Gegenereerd met scripts/build_scope.py."),
        "gegenereerd": dt.date.today().isoformat(),
        "buffer_m": a.buffer_m,
        "aantal_asset_geometrieen": len(geoms),
        "gemeenten": gemeenten,
        "provincies": provincies,
        "waterschappen": waterschappen,
        "staatscourant": True,
    }
    a.uit.parent.mkdir(parents=True, exist_ok=True)
    a.uit.write_text(json.dumps(scope, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"{len(gemeenten)} gemeenten, {len(provincies)} provincies, {len(waterschappen)} waterschappen "
        f"-> {a.uit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
