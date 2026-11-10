"""Ophalen en parsen van officiële bekendmakingen via de SRU-API.

Endpoint: https://repository.overheid.nl/sru (SRU 2.0, CQL, geen API-sleutel).
Gebaseerd op scripts/fetch.py van de eerste weekscan (10 november 2026).
"""
from __future__ import annotations

import html
import re
import time
import xml.etree.ElementTree as ET

import requests

BASE = "https://repository.overheid.nl/sru"
NS = {
    "sru": "http://docs.oasis-open.org/ns/search-ws/sruResponse",
    "dcterms": "http://purl.org/dc/terms/",
    "ow": "http://standaarden.overheid.nl/wetgeving/",
    "gzd": "http://standaarden.overheid.nl/sru",
    "c": "http://standaarden.overheid.nl/collectie/",
    "overheid": "http://standaarden.overheid.nl/owms/terms/",
    "diag": "http://docs.oasis-open.org/ns/search-ws/diagnostic",
}
UA = {"User-Agent": "bekendmakingen-monitor (github.com/JakobMarin/bekendmakingen-monitor)"}


def _q(naam: str) -> str:
    return '"' + naam.replace('"', "") + '"'


def queries(van: str, tot: str, scope: dict, chunk: int = 10) -> dict[str, str]:
    """SRU-queries voor het dekkingsgebied (config/scope.json), periode dt.date inclusief.

    - Gemeenteblad: per blok van `chunk` gemeenten (dt.creator OR ...), organisatietype gemeente
    - Provinciaal blad: per provincie, organisatietype provincie
    - Waterschapsblad: per waterschap (naam zoals 'Waterschap Hollandse Delta')
    - Staatscourant: alles in de periode (ministeries, Rijkswaterstaat, ANVS, ILT, ...);
      de dagelijkse job bewaart alleen stukken waarvan de geometrie binnen de buffer valt.
    """
    p = f"c.product-area==officielepublicaties AND dt.date>={van} AND dt.date<={tot}"
    q: dict[str, str] = {}
    gem = scope.get("gemeenten", [])
    for i in range(0, len(gem), chunk):
        blok = " OR ".join(f"dt.creator=={_q(n)}" for n in gem[i:i + chunk])
        q[f"gemeenteblad_{i // chunk + 1:02d}"] = f"{p} AND ({blok}) AND w.organisatietype==gemeente"
    for n in scope.get("provincies", []):
        q[f"provinciaal_blad_{n}"] = f"{p} AND dt.creator=={_q(n)} AND w.organisatietype==provincie"
    for n in scope.get("waterschappen", []):
        q[f"waterschapsblad_{n}"] = f"{p} AND dt.creator=={_q(n)}"
    if scope.get("staatscourant", True):
        q["staatscourant"] = f'{p} AND w.publicatienaam=="Staatscourant"'
    return q


def _get(url: str, params: dict | None = None, timeout: int = 120) -> requests.Response:
    last = None
    for poging in range(4):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            r.raise_for_status()
            return r
        except requests.RequestException as exc:  # pragma: no cover - netwerk
            last = exc
            time.sleep(3 * (poging + 1))
    raise RuntimeError(f"Ophalen mislukt: {url} ({last})")


def run_query(q: str, max_records: int = 1000) -> tuple[int, list[dict]]:
    recs: list[dict] = []
    start = 1
    total = 0
    while True:
        x = _get(BASE, {"query": q, "maximumRecords": max_records, "startRecord": start}).content
        root = ET.fromstring(x)
        diag = root.find(".//diag:message", NS)
        if diag is not None:
            det = root.find(".//diag:details", NS)
            raise RuntimeError(f"SRU-fout: {diag.text} {det.text if det is not None else ''} :: {q}")
        total = int(root.find("sru:numberOfRecords", NS).text)
        rs = root.findall(".//sru:record", NS)
        for rec in rs:
            recs.append(_parse(rec))
        nxt = root.find("sru:nextRecordPosition", NS)
        if nxt is None or not rs:
            break
        start = int(nxt.text)
    return total, recs


def _parse(rec) -> dict:
    def g(p):
        return [e.text for e in rec.findall(p, NS)]

    def first(p):
        v = g(p)
        return v[0] if v else None

    geos = []
    for gm in rec.findall(".//ow:gebiedsmarkering/*", NS):
        f = {ch.tag.split("}")[1]: ch.text for ch in gm}
        geos.append({
            "type": gm.tag.split("}")[1],
            "rd": f.get("geometrie"),
            "wgs84": f.get("locatiegebied"),
            "label": f.get("geometrielabel"),
            "gemeente": f.get("ligtInGemeente"),
            "fields": f,
        })
    return {
        "id": first(".//dcterms:identifier"),
        "title": first(".//dcterms:title"),
        "type": g(".//dcterms:type"),
        "creator": g(".//dcterms:creator"),
        "date": first(".//dcterms:date"),
        "available": first(".//dcterms:available"),
        "modified": first(".//dcterms:modified"),
        "abstract": first(".//dcterms:abstract"),
        "subject": g(".//dcterms:subject"),
        "activiteit": g(".//ow:activiteit"),
        "publicatienaam": first(".//ow:publicatienaam"),
        "geo": geos,
        "xml": first(".//gzd:url"),
        "html": first(".//gzd:preferredUrl"),
    }


def fetch_text(xml_url: str | None) -> str:
    """Platte tekst van de publicatie (zonder metadata). Leeg bij fout."""
    if not xml_url:
        return ""
    try:
        x = _get(xml_url, timeout=30).content.decode("utf-8", "ignore")
    except RuntimeError:
        return ""
    x = re.sub(r"<meta.*?</meta>", "", x, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", x)
    return html.unescape(re.sub(r"\s+", " ", t)).strip()
