#!/usr/bin/env python3
"""Exporteer de menselijke review (public.feedback) naar feedback/feedback.jsonl.

Eén regel per beoordeling (append-only geschiedenis; de laatste per kenmerk heeft
"laatste": true). Bedoeld om classify.py later te verbeteren. Bevat GEEN e-mailadressen
of andere persoonsgegevens van reviewers.

  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/export_feedback.py [--uit feedback/feedback.jsonl]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
STANDAARD = ROOT / "feedback" / "feedback.jsonl"
VELDEN = "id,kenmerk,oordeel,klasse_correctie,reden,created_at,titel,type,bron,uitgever,inschatting_origineel,score_origineel"


def export(sb, pad: Path = STANDAARD) -> dict:
    rows = sb.select_all("feedback", VELDEN, "created_at.asc,id.asc")
    laatste = {}
    for r in rows:
        laatste[r["kenmerk"]] = r["id"]
    regels = []
    for r in rows:
        regels.append(json.dumps({
            "kenmerk": r["kenmerk"],
            "url": f"https://zoek.officielebekendmakingen.nl/{r['kenmerk']}.html",
            "titel": r.get("titel"),
            "type": r.get("type"),
            "bron": r.get("bron"),
            "uitgever": r.get("uitgever"),
            "inschatting_origineel": r.get("inschatting_origineel"),
            "score_origineel": r.get("score_origineel"),
            "oordeel": r["oordeel"],
            "klasse_correctie": r.get("klasse_correctie"),
            "reden": r.get("reden"),
            "beoordeeld_op": r["created_at"],
            "laatste": laatste[r["kenmerk"]] == r["id"],
        }, ensure_ascii=False))
    nieuw = "\n".join(regels) + ("\n" if regels else "")
    oud = pad.read_text(encoding="utf-8") if pad.exists() else None
    if nieuw != oud:
        pad.parent.mkdir(parents=True, exist_ok=True)
        pad.write_text(nieuw, encoding="utf-8")
    return {"beoordelingen": len(rows), "meldingen": len(laatste), "bijgewerkt": nieuw != oud}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uit", type=Path, default=STANDAARD)
    a = ap.parse_args()
    from supa import Supabase
    print(export(Supabase.from_env(), a.uit), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
