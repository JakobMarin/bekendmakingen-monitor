"""Kleine Supabase REST-client (PostgREST) voor de dagelijkse job.

Leest SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY uit de omgeving (GitHub Secrets).
De service_role key omzeilt RLS en mag dus NOOIT in de repo, de website of logs.
"""
from __future__ import annotations

import os
import time

import requests


class Supabase:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}",
                               "Accept": "application/json", "Content-Type": "application/json"})

    @classmethod
    def from_env(cls) -> "Supabase":
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise SystemExit("SUPABASE_URL en/of SUPABASE_SERVICE_ROLE_KEY ontbreken (GitHub Secrets).")
        return cls(url, key)

    def _req(self, method, path, **kw):
        for poging in range(4):
            r = self.s.request(method, f"{self.url}/rest/v1/{path}", timeout=180, **kw)
            if r.status_code < 500:
                break
            time.sleep(3 * (poging + 1))
        if r.status_code >= 400:
            # Geen headers loggen (bevatten de key); alleen status + body.
            raise RuntimeError(f"Supabase {method} {path.split('?')[0]}: {r.status_code} {r.text[:300]}")
        return r

    def select_all(self, table: str, select: str, order: str, page: int = 500, **filters) -> list[dict]:
        out, offset = [], 0
        while True:
            params = {"select": select, "order": order, "limit": page, "offset": offset, **filters}
            rows = self._req("GET", table, params=params).json()
            out += rows
            if len(rows) < page:
                return out
            offset += page

    def count(self, table: str, **filters) -> int:
        r = self._req("GET", table, params={"select": "*", "limit": 1, **filters},
                      headers={"Prefer": "count=exact", "Range-Unit": "items"})
        return int(r.headers.get("Content-Range", "*/0").split("/")[-1])

    def existing(self, table: str, key: str, values: list[str]) -> set[str]:
        found: set[str] = set()
        for i in range(0, len(values), 100):
            chunk = values[i:i + 100]
            lst = ",".join('"' + v.replace('"', "") + '"' for v in chunk)
            rows = self._req("GET", table, params={"select": key, key: f"in.({lst})"}).json()
            found |= {r[key] for r in rows}
        return found

    def insert(self, table: str, rows: list[dict]) -> None:
        for i in range(0, len(rows), 200):
            self._req("POST", table, json=rows[i:i + 200], headers={"Prefer": "return=minimal"})

    def patch(self, table: str, filters: dict, values: dict) -> None:
        self._req("PATCH", table, params=filters, json=values, headers={"Prefer": "return=minimal"})

    def delete(self, table: str, filters: dict) -> int:
        r = self._req("DELETE", table, params=filters, headers={"Prefer": "return=representation"})
        return len(r.json())

    def rpc(self, fn: str, args: dict | None = None):
        r = self._req("POST", f"rpc/{fn}", json=args or {})
        return r.json() if r.text else None

    def asset_geoms_rd(self):
        """Asset-geometrieën in RD New (alleen voor matching in het geheugen; nooit loggen)."""
        from shapely.geometry import shape
        from geo import naar_rd
        rows = self.select_all("assets", "id,geom", "id")
        return [naar_rd(shape(r["geom"])) for r in rows if r.get("geom")]
