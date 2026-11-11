#!/usr/bin/env python3
"""Originele publicatiegeometrie (vlak/lijn) voor geselecteerde klassen.

De dagelijkse job matcht op de RD-geometrie uit de SRU-metadata (gebiedsmarkering)
maar bewaarde tot nu toe alleen één punt. Voor de klassen in config/vormen.json
(standaard alleen 'hoog') bewaren we nu ook de vlak- en lijndelen in
public.bekendmakingen.geom_vorm (EPSG:4326, ~1 m vereenvoudigd, 6 decimalen), zodat de
website ze als vorm kan tekenen. Punten/adressen leveren geen vorm op (vorm_type 'punt').

Los draaien (backfill, bijv. na het uitbreiden van de klassenlijst):
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/vormen.py [--limiet 500]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import shapely
from shapely import wkt
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sru  # noqa: E402
from geo import naar_wgs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config" / "vormen.json").read_text(encoding="utf-8"))
KLASSEN: list[str] = CONFIG.get("klassen", ["hoog"])
TOL_M: float = float(CONFIG.get("vereenvoudiging_m", 1.0))
BREED = {"Gemeente", "Provincie", "Waterschap", "Land", "GeometrieRef"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def rd_union(rec: dict):
    gs = []
    for g in rec.get("geo") or []:
        if g.get("rd") and g["type"] not in BREED:
            try:
                gs.append(wkt.loads(g["rd"]))
            except Exception:  # noqa: BLE001
                pass
    return unary_union(gs) if gs else None


def vorm(g_rd) -> tuple[str | None, str]:
    """(EWKT in 4326 of None, vorm_type) uit een RD-geometrie."""
    if g_rd is None or g_rd.is_empty:
        return None, "punt"
    delen = [p for p in shapely.get_parts(g_rd) if p.geom_type in ("Polygon", "LineString", "LinearRing")]
    # GeometryCollections kunnen genest zijn: nog een niveau dieper kijken
    for p in shapely.get_parts(g_rd):
        if p.geom_type in ("MultiPolygon", "MultiLineString", "GeometryCollection"):
            delen += [q for q in shapely.get_parts(p) if q.geom_type in ("Polygon", "LineString")]
    if not delen:
        return None, "punt"
    vl = [p for p in delen if p.geom_type == "Polygon"]
    li = [p for p in delen if p.geom_type != "Polygon"]
    soort = "vlak+lijn" if vl and li else ("vlak" if vl else "lijn")
    u = unary_union(delen)
    u = shapely.simplify(u, TOL_M, preserve_topology=True)
    u = shapely.make_valid(u) if not u.is_valid else u
    w = naar_wgs(u)
    return "SRID=4326;" + shapely.to_wkt(w, rounding_precision=6, trim=True), soort


def velden(rec: dict | None, g_rd=None, inschatting: str | None = None) -> dict:
    """Kolommen geom_vorm/vorm_type voor een rij (leeg buiten de geselecteerde klassen)."""
    if inschatting not in KLASSEN:
        return {"geom_vorm": None, "vorm_type": None}
    ewkt, soort = vorm(g_rd if g_rd is not None else rd_union(rec or {}))
    return {"geom_vorm": ewkt, "vorm_type": soort}


def haal_records(kenmerken: list[str], blok: int = 20) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(kenmerken), blok):
        q = " OR ".join(f'dt.identifier=="{k}"' for k in kenmerken[i:i + blok])
        _, rs = sru.run_query(q, max_records=blok * 2)
        for r in rs:
            if r.get("id"):
                out.setdefault(r["id"], r)
    return out


def vul_ontbrekend(sb, limiet: int = 300) -> dict:
    """Vormen bijvullen voor rijen in KLASSEN zonder vorm_type (nieuw of herklassificeerd)."""
    lst = ",".join(f'"{k}"' for k in KLASSEN)
    rows = sb.select_all("bekendmakingen", "kenmerk", "kenmerk",
                         inschatting=f"in.({lst})", vorm_type="is.null")[:limiet]
    tel = {"te_doen": len(rows)}
    if not rows:
        return tel
    recs = haal_records([r["kenmerk"] for r in rows])
    for r in rows:
        rec = recs.get(r["kenmerk"])
        if rec is None:
            tel["niet_gevonden"] = tel.get("niet_gevonden", 0) + 1
            continue
        ewkt, soort = vorm(rd_union(rec))
        sb.patch("bekendmakingen", {"kenmerk": f"eq.{r['kenmerk']}"}, {"geom_vorm": ewkt, "vorm_type": soort})
        tel[soort] = tel.get(soort, 0) + 1
    # buiten de klassen geen vorm bewaren (bijv. na het verkleinen van de lijst of herklassificatie)
    sb.patch("bekendmakingen", {"inschatting": f"not.in.({lst})", "vorm_type": "not.is.null"},
             {"geom_vorm": None, "vorm_type": None})
    return tel


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limiet", type=int, default=1000)
    a = ap.parse_args()
    from supa import Supabase
    tel = vul_ontbrekend(Supabase.from_env(), a.limiet)
    log(f"Vormen ({', '.join(KLASSEN)}): {tel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
