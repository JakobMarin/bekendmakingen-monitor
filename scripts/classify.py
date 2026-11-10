"""Automatische eerste inschatting van een bekendmaking.

Regels afgeleid uit de handmatige beoordeling van een proefweek (4-10 november 2026,
39 meldingen) en bedoeld voor publicaties nabij ondergrondse/bovengrondse assets.
Dit is een eerste inschatting: twijfelgevallen krijgen 'laag', zodat ze op de
kaart blijven en nagekeken kunnen worden. Handmatige oordelen in de database
worden door de dagelijkse job nooit overschreven.

Klassen en score:
  hoog = 3   graafwerk, kabels/leidingen, boringen, bouwrijp maken,
             werk door netbeheerder, bodemenergie
  middel = 2 indirect/onduidelijk grondwerk: grondverzet, weg/berm,
             herinrichting, sloop, grotere nieuwbouw zonder details
  laag = 1   klein/ondiep werk (uitrit, aanbouw, overkapping, poeren,
             bouwplaatsinrichting) of niet automatisch te duiden
  niet relevant = 0
"""
from __future__ import annotations

import re

SCORE = {"hoog": 3, "middel": 2, "laag": 1, "niet relevant": 0}

NETBEHEERDERS = (
    r"stedin|enduris|evides|tennet|gasunie|liander|enexis|kpn|eurofiber|"
    r"delta ?fiber|glaspoort|relined|open dutch fiber|ziggo|vodafone"
)

# (patroon, klasse, waarom, ontbreekt). Eerste match wint; volgorde is belangrijk.
REGELS: list[tuple[str, str, str, str]] = [
    # --- duidelijk niet relevant -------------------------------------------------
    (r"evenement|alcoholwet|drank- en horeca|exploitatievergunning|festiviteit|"
     r"twaalfdagenregeling|geluidsnormen|koopzondag|collecte|loterij",
     "niet relevant", "Evenement/horeca, geen grondroering.", ""),
    (r"standplaats", "niet relevant",
     "Standplaatsvergunning (kraam/verkoopwagen), tijdelijk, geen grondroering.", ""),
    (r"obstakels? op (de )?openbare weg.*bouwplaats|bouwplaatsinrichting", "laag",
     "Zelf een tijdelijk obstakel, maar een bouwplaats wijst op een bouwproject ter plaatse.",
     "Welk bouwwerk er wordt uitgevoerd."),
    (r"obstakels? op (de )?openbare weg|container|steiger|verhuislift|autolaadkraan|"
     r"\bdepot\b", "niet relevant", "Tijdelijk obstakel op de openbare weg, geen graafwerk.", ""),
    (r"verordening|beleidsregel|mandaat|subsidie|delegatie|reglement|begroting|"
     r"benoeming|aanwijzingsbesluit|tarieven|legesverordening|jeugdhulp|wmo",
     "niet relevant", "Beleid/regelgeving zonder fysieke uitvoering.", ""),
    (r"natura 2000|faunabeheer|vossenbeheer|rattenbeheer|wet natuurbescherming|"
     r"omgevingsvergunning voor een natura", "niet relevant",
     "Natuurbeheer/-vergunning zonder grondwerk.", ""),
    (r"stralingsbescherming|nucleaire|anvs", "niet relevant",
     "Vergunning voor stralingstoestellen in een bestaand pand, geen grondroering.", ""),
    (r"gevelreclame|reclame|lichtreclame|uithangbord", "niet relevant",
     "Reclame aan de gevel, geen grondroering.", ""),
    (r"dakkapel|kozijn", "niet relevant",
     "Puur bouwkundige wijziging aan bestaand pand, geen grondroering.", ""),
    (r"legaliser", "niet relevant", "Legalisatie van iets dat er al staat: geen nieuw grondwerk.", ""),
    # --- hoog ---------------------------------------------------------------------
    (rf"({NETBEHEERDERS}).*(graven|bodem|melding|kabel|leiding)|"
     rf"(graven|bodem|kabel|leiding).*({NETBEHEERDERS})", "hoog",
     "Graafwerk door netbeheerder: vrijwel zeker werk aan kabels/leidingen.",
     "Exacte tracé, uitvoeringsdatum en soort kabel/leiding."),
    (r"graven in (de )?bodem|graafwerk|graafvergunning|kabels?\b|bekabeling|"
     r"leidingen?\b|leidingtracé|glasvezel|riolering|\briool|persleiding|"
     r"gestuurde boring|\bboring|horizontaal gestuurd|bodemenergie|bodemwarmte|"
     r"warmte-koudeopslag|\bwko\b|bouwrijp|damwand|heien|sonderingen|"
     r"grondwateronttrekking|bemaling|bodemsanering|saneren van de bodem|"
     r"interventiewaarde|kruising.*(water|weg)|transformatorstation|"
     r"\bmast\b|zendmast|laadpaal|laadpalen|zonnepark|windturbine", "hoog",
     "Graaf-/boorwerk, kabels of leidingen in de grond genoemd.",
     "Exacte tracé/locatie en uitvoeringsdatum."),
    # --- middel -------------------------------------------------------------------
    (r"grondverzet|ophogen|afgraven|dempen|demping|watergang|sloot|"
     r"herinrichting|reconstructie|aanleg(gen)? van (een )?(weg|fietspad|parkeer)|"
     r"slopen|sloop|nieuwbouw|\bbouwen van (\d+|een|twee|drie|vier|vijf|zes|tien) "
     r"(woningen|appartementen|bedrijfs|loods|hal|schuur)|bedrijfshal|bedrijfspand|"
     r"loods|kas\b|kassen|parkeerterrein|verharding", "middel",
     "Mogelijk grondwerk (bouw, sloop of herinrichting), maar zonder details over diepte of tracé.",
     "Omvang en diepte van het grondwerk."),
    (r"\bbouwen van (een|de) (woning|vrijstaande woning|recreatiewoning|huis)", "middel",
     "Nieuwbouw van een woning: fundering en nieuwe aansluitingen.",
     "Funderingswijze en ligging van de aansluitingen."),
    # --- laag ---------------------------------------------------------------------
    (r"uitbrei|aanbouw|uitbouw|bijgebouw|overkapping|carport|serre|veranda|"
     r"schuilstal|uitrit|inrit|poeren|zwembad|tuinhuis|berging|routeborden|"
     r"borden|vlaggenmast|transformeren|splitsen|appartementen|wooneenheden|"
     r"zonnepanelen op (het )?(veld|maaiveld)", "laag",
     "Klein of ondiep werk dat assets licht kan raken (bv. fundering, poeren of nieuwe aansluiting).",
     "Plek op het perceel en funderingswijze."),
    # --- niet relevant (bouwkundig / overig) -------------------------------------
    (r"dakkapel|kozijn|gevelwijziging|gevel|dak\b|het dak|isoleren|renoveren|"
     r"inpandig|interne verbouwing|balkon|beglazing|schutting|erfafscheiding|"
     r"hekwerk|fietsenhok|fietsenstalling|zonnepanelen|monument|"
     r"bestemmingsplan|functiewijziging|wijzigen van (de )?(bestemming|functie)|"
     r"gebruik(en)? van|kamerverhuur|bed (&|en) breakfast|"
     r"verkeersbesluit|parkeerverbod|parkeerplaats voor|gehandicaptenparkeer|"
     r"snelheid|bebording|eenrichtingsverkeer|"
     r"kapvergunning|vellen van|bomen", "niet relevant",
     "Bouwkundig, planologisch of verkeersbesluit zonder genoemd graafwerk.", ""),
]

_COMPILED = [(re.compile(p, re.I), k, w, o) for p, k, w, o in REGELS]


def toelichting(rec: dict, tekst: str) -> str:
    """Korte beschrijving uit de tekst; verzint niets."""
    m = re.search(
        r"[Oo]p (\d{1,2} \w+ \d{4}) hebben wij een melding ontvangen van (.+?) in het kader "
        r"van het Besluit activiteiten leefomgeving \(Bal\), over (.+?)\.(?= U kunt| Wanneer| De melding| Tegen|$)", tekst)
    if m:
        return f"{m.group(2)} meldt {m.group(3)} (melding Bal, ontvangen {m.group(1)})."
    m = re.search(r"De aanvraag betreft: (.+?)(?: Procedure| Inzage| Zienswijze|$)", tekst)
    if m:
        return f"Aanvraag omgevingsvergunning voor {m.group(1).strip().rstrip('.')}."
    m = re.search(r"(?:Het besluit|De vergunning|Het verzoek) betreft:? (.+?)\.", tekst)
    if m:
        return m.group(1).strip()[:400] + "."
    titel = rec.get("title") or ""
    deel = titel.split(" - ", 1)[1] if " - " in titel else titel
    return deel.strip()[:400]


def inschatting(rec: dict, tekst: str, buiten_goes: str | None = None) -> dict:
    """Geef dict met inschatting, relevantie_score, waarom, ontbreekt."""
    if buiten_goes:
        return {
            "inschatting": "niet relevant",
            "relevantie_score": 0,
            "waarom": f"Ligt buiten gemeente Goes ({buiten_goes}); wel gepubliceerd in een Goes-bron.",
            "ontbreekt": "",
        }
    titel = rec.get("title") or ""
    soort = " ".join(rec.get("type") or [])
    # Titel + type eerst (betrouwbaarder), daarna eerste deel van de tekst.
    for bron in (f"{titel} {soort}", tekst[:2500]):
        for rx, klasse, waarom, ontbreekt in _COMPILED:
            if rx.search(bron):
                return {"inschatting": klasse, "relevantie_score": SCORE[klasse],
                        "waarom": waarom + " (automatische inschatting)", "ontbreekt": ontbreekt}
    if "omgevingsvergunning" in soort or "omgevingsmelding" in soort:
        klasse, waarom = "laag", "Omgevingsvergunning/-melding die niet automatisch te duiden is; handmatig nakijken."
    else:
        klasse, waarom = "niet relevant", "Geen aanwijzing voor grondroering gevonden in titel of tekst."
    return {"inschatting": klasse, "relevantie_score": SCORE[klasse],
            "waarom": waarom + " (automatische inschatting)", "ontbreekt": ""}
