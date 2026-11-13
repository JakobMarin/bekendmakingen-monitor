/* Bekendmakingen-monitor Stedin hoogspanning — kaart.
 * Leest live uit Supabase (view public.meldingen_kaart) met de publishable key.
 * Het Stedin-hoogspanningsnet en de zone van 100 m komen uit statische, vereenvoudigde GeoJSON
 * (data/hoogspanning.geojson en data/zone_100m.geojson); de tabel public.assets blijft afgeschermd.
 * Meldingen in CFG.vormKlassen met een vlak/lijn (vorm_geojson) worden als vorm getekend. */
(function () {
  "use strict";
  const CFG = window.MONITOR_CONFIG;
  const KLEUR = { "hoog": "#c62828", "middel": "#ef6c00", "laag": "#f9a825", "niet relevant": "#78909c" };
  const RADIUS = { "hoog": 12, "middel": 9, "laag": 9, "niet relevant": 8 };
  const ORDE = ["hoog", "middel", "laag", "niet relevant"];
  const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
    "september", "oktober", "november", "december"];

  const visible = new Set(ORDE);
  // Gedeeld met assets/lijst.js (tabblad 'Lijst').
  let klaarResolve;
  window.MONITOR = { data: [], klaar: new Promise(r => { klaarResolve = r; }), toonOpKaart: null };
  const markersById = new Map();
  const vormenById = new Map();   // kenmerk -> L.GeoJSON (alleen klassen in CFG.vormKlassen met vlak/lijn)
  const VORM_KLASSEN = new Set(CFG.vormKlassen || ["hoog"]);
  const VORM_MIN_PX = CFG.vormMinPixels || 14;
  let data = [];
  let modus = "alle";          // "buffer" of "alle"
  let bufferBeschikbaar = false;

  const $ = id => document.getElementById(id);
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nlDatum(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return d + " " + MAANDEN[m - 1] + " " + y;
  }
  function veiligeUrl(u) { return /^https:\/\//i.test(u || "") ? u : null; }
  function badgeClass(k) { return k === "niet relevant" ? "niet" : k; }
  function badge(k) { return '<span class="badge ' + badgeClass(k) + '">' + escapeHtml(k || "?") + "</span>"; }
  function setStatus(tekst, soort) { const el = $("status"); el.textContent = tekst; el.className = "status" + (soort ? " " + soort : ""); }

  function normaliseer(r) {
    let g = r.geojson;
    if (typeof g === "string") { try { g = JSON.parse(g); } catch (e) { g = null; } }
    if (!g && r.geom && r.geom.type) g = r.geom;
    let lat = null, lon = null;
    if (g && g.type === "Point" && Array.isArray(g.coordinates)) { lon = +g.coordinates[0]; lat = +g.coordinates[1]; }
    const ok = Number.isFinite(lat) && Number.isFinite(lon);
    let vorm = r.vorm_geojson;
    if (typeof vorm === "string") { try { vorm = JSON.parse(vorm); } catch (e) { vorm = null; } }
    if (!vorm || !vorm.type || vorm.type === "Point" || vorm.type === "MultiPoint") vorm = null;
    return Object.assign({}, r, {
      inschatting: ORDE.includes(r.inschatting) ? r.inschatting : "niet relevant",
      relevantie_score: r.relevantie_score == null ? 0 : r.relevantie_score,
      lat: ok ? lat : null, lon: ok ? lon : null, heeft_coordinaat: ok, vorm: vorm,
      datum: r.datum || "", datum_nl: nlDatum(r.datum)
    });
  }

  async function laad() {
    // PostgREST levert max. 1000 rijen per verzoek: pagineren.
    const PAGINA = 1000;
    const headers = { apikey: CFG.publishableKey, Authorization: "Bearer " + CFG.publishableKey, Accept: "application/json" };
    try {
      let rows = [];
      for (let offset = 0; ; offset += PAGINA) {
        const url = CFG.supabaseUrl + "/rest/v1/" + CFG.view + "?select=*&order=kenmerk.asc&limit=" + PAGINA + "&offset=" + offset;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const deel = await res.json();
        rows = rows.concat(deel);
        if (deel.length < PAGINA) break;
      }
      return { rows, bron: "live" };
    } catch (e) {
      const res = await fetch(CFG.fallbackGeojson, { cache: "no-store" });
      if (!res.ok) throw e;
      const fc = await res.json();
      const vormen = new Map();
      try {
        const rv = await fetch(CFG.fallbackVormen, { cache: "no-store" });
        if (rv.ok) (await rv.json()).features.forEach(f => vormen.set(f.properties.kenmerk, f.geometry));
      } catch (e2) { /* zonder vormen verder */ }
      return { rows: fc.features.map(f => Object.assign({}, f.properties, { geojson: f.geometry, vorm_geojson: vormen.get(f.properties.kenmerk) || null })), bron: "geojson" };
    }
  }

  // ---------------------------------------------------------------- kaart ---
  const map = L.map("map", { zoomSnap: 0.25, maxZoom: 21 }).setView([51.95, 4.5], 9);

  // Basiskaarten (radiokeuze in de lagenknop). Tegels gecontroleerd: BRT 0–19, luchtfoto 0–21, Esri tot 19 (daarna overzoom).
  const BASISKAART_OPSLAAN = "monitor-basiskaart";
  const BASISKAART_NAMEN = { brt: "Kaart (PDOK BRT)", luchtfoto: "Luchtfoto (PDOK)", esri: "Satelliet (Esri)" };
  const LUCHTFOTO_IDS = new Set(["luchtfoto", "esri"]);
  const BASISKAARTEN = {
    brt: L.tileLayer("https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png", {
      maxZoom: 21, maxNativeZoom: 19,
      attribution: 'Kaart: <a href="https://www.pdok.nl/">PDOK</a> / <a href="https://www.kadaster.nl/">Kadaster</a> (BRT-Achtergrondkaart, <a href="https://creativecommons.org/licenses/by/4.0/deed.nl">CC BY 4.0</a>)'
    }),
    luchtfoto: L.tileLayer("https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg", {
      maxZoom: 21, maxNativeZoom: 21,
      attribution: 'Luchtfoto: <a href="https://www.pdok.nl/">PDOK</a> / Beeldmateriaal Nederland (<a href="https://creativecommons.org/licenses/by/4.0/deed.nl">CC BY 4.0</a>)'
    }),
    esri: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21, maxNativeZoom: 19,
      attribution: 'Beeld: Esri, Maxar, Earthstar Geographics en de GIS-gebruikersgemeenschap'
    })
  };
  function basiskaartIdVanLaag(laag) {
    return Object.keys(BASISKAARTEN).find(k => BASISKAARTEN[k] === laag);
  }
  let actieveBasiskaart = "brt";
  try {
    const opgeslagen = localStorage.getItem(BASISKAART_OPSLAAN);
    if (opgeslagen && BASISKAARTEN[opgeslagen]) actieveBasiskaart = opgeslagen;
  } catch (e) { /* privémodus */ }
  BASISKAARTEN[actieveBasiskaart].addTo(map);

  // Lagenvolgorde: achtergrond (tilePane 200) < zone 100 m < hoogspanningsverbinding < meldingen (markerPane, z 600).
  map.createPane("zonePane").style.zIndex = 410;
  map.createPane("lijnPane").style.zIndex = 420;
  map.getPane("zonePane").style.pointerEvents = "none";
  map.createPane("vormPane").style.zIndex = 450;   // boven net/zone, onder de stippen (markerPane 600)
  const vormRenderer = L.svg({ pane: "vormPane" });
  const vormGroep = L.layerGroup().addTo(map);
  const zoneLaag = L.layerGroup().addTo(map);
  const lijnLaag = L.layerGroup().addTo(map);
  const netLagen = {};
  netLagen['<span class="lc-lijn"></span> Hoogspanningsverbinding'] = lijnLaag;
  netLagen['<span class="lc-zone"></span> Zone ' + CFG.bufferMeters + " m"] = zoneLaag;
  const basisLagen = {};
  Object.keys(BASISKAART_NAMEN).forEach(k => { basisLagen[BASISKAART_NAMEN[k]] = BASISKAARTEN[k]; });
  L.control.layers(basisLagen, netLagen, { collapsed: false, position: "topright" }).addTo(map);

  let zoneGeo = null, lijnCasing = null, lijnKern = null;
  function isLuchtfoto() { return LUCHTFOTO_IDS.has(actieveBasiskaart); }
  function pasOverlayStijlAan() {
    const lucht = isLuchtfoto();
    map.getContainer().classList.toggle("basiskaart-luchtfoto", lucht);
    if (zoneGeo) zoneGeo.setStyle({ color: "#66bd63", weight: lucht ? 1.25 : 1, opacity: lucht ? 0.85 : 0.6, fillColor: "#a6d96a", fillOpacity: lucht ? 0.4 : 0.35 });
    if (lijnCasing) lijnCasing.setStyle({ color: "#ffffff", weight: lucht ? 7 : 5.5, opacity: lucht ? 0.95 : 0.8, lineCap: "round", lineJoin: "round" });
    if (lijnKern) lijnKern.setStyle({ color: "#1a9641", weight: lucht ? 3.1 : 2.75, opacity: 0.95, lineCap: "round", lineJoin: "round" });
    vormenById.forEach(v => stijlVorm(v, v.options.klasse, !!v._actief));
  }
  map.on("baselayerchange", function (e) {
    const id = basiskaartIdVanLaag(e.layer);
    if (!id) return;
    actieveBasiskaart = id;
    try { localStorage.setItem(BASISKAART_OPSLAAN, id); } catch (err) { /* privémodus */ }
    pasOverlayStijlAan();
  });
  map.getContainer().classList.toggle("basiskaart-luchtfoto", isLuchtfoto());

  const NetLaden = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () { const d = L.DomUtil.create("div", "net-laden"); d.textContent = "Net laden…"; return d; }
  });
  const netLaden = new NetLaden().addTo(map);

  async function laadNet() {
    const haal = url => fetch(url).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    try {
      const [zone, lijnen] = await Promise.all([haal("data/zone_100m.geojson"), haal("data/hoogspanning.geojson")]);
      const lucht = isLuchtfoto();
      zoneGeo = L.geoJSON(zone, {
        pane: "zonePane", interactive: false, renderer: L.canvas({ pane: "zonePane" }),
        style: { color: "#66bd63", weight: lucht ? 1.25 : 1, opacity: lucht ? 0.85 : 0.6, fillColor: "#a6d96a", fillOpacity: lucht ? 0.4 : 0.35 }
      }).addTo(zoneLaag);
      // Witte rand onder de groene lijn, zodat die op de luchtfoto leesbaar blijft.
      lijnCasing = L.geoJSON(lijnen, {
        pane: "lijnPane", interactive: false, renderer: L.canvas({ pane: "lijnPane" }),
        style: { color: "#ffffff", weight: lucht ? 7 : 5.5, opacity: lucht ? 0.95 : 0.8, lineCap: "round", lineJoin: "round" }
      }).addTo(lijnLaag);
      lijnKern = L.geoJSON(lijnen, {
        pane: "lijnPane", renderer: L.canvas({ pane: "lijnPane", tolerance: 4 }),
        style: { color: "#1a9641", weight: lucht ? 3.1 : 2.75, opacity: 0.95, lineCap: "round", lineJoin: "round" },
        onEachFeature: (f, l) => { if (f.properties && f.properties.naam) l.bindTooltip(escapeHtml(f.properties.naam), { sticky: true }); }
      }).addTo(lijnLaag);
      map.removeControl(netLaden);
    } catch (e) {
      const el = netLaden.getContainer();
      el.textContent = "Net kon niet worden geladen (" + e.message + ")";
      el.classList.add("err");
    }
  }
  laadNet();

  const clusters = L.markerClusterGroup({
    maxClusterRadius: 36, spiderfyOnMaxZoom: true, spiderfyDistanceMultiplier: 1.7, showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      let best = -1, kleur = KLEUR["niet relevant"];
      cluster.getAllChildMarkers().forEach(m => { const s = m.options.relevantie_score || 0; if (s > best) { best = s; kleur = KLEUR[m.options.klasse]; } });
      const n = cluster.getChildCount(), size = n > 8 ? 40 : n > 3 ? 34 : 30;
      return L.divIcon({ html: '<div class="cluster-icon" style="width:' + size + "px;height:" + size + "px;line-height:" + (size - 6) + "px;background:" + kleur + '">' + n + "</div>", className: "", iconSize: [size, size] });
    }
  });
  map.addLayer(clusters);

  function divIcon(klasse, active) {
    const size = (RADIUS[klasse] || 8) * 2 + (active ? 3 : 0);
    return L.divIcon({
      html: '<div class="marker-core" style="width:' + size + "px;height:" + size + "px;background:" + KLEUR[klasse] + ";" +
        (active ? "box-shadow:0 0 0 3px rgba(27,42,74,0.55),0 1px 3px rgba(0,0,0,0.25);" : "") + '"></div>',
      className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2]
    });
  }

  function kleurDonker(hex) {
    const n = parseInt(hex.slice(1), 16), f = 0.62;
    return "rgb(" + Math.round((n >> 16) * f) + "," + Math.round(((n >> 8) & 255) * f) + "," + Math.round((n & 255) * f) + ")";
  }
  function stijlVorm(groep, klasse, actief) {
    const kleur = KLEUR[klasse], rand = kleurDonker(kleur), lucht = isLuchtfoto();
    groep.eachLayer(function stijl(l) {
      if (l.eachLayer && !(l instanceof L.Path)) { l.eachLayer(stijl); return; }
      if (l instanceof L.Polygon) l.setStyle({ color: lucht ? "#fff" : rand, weight: actief ? 3.5 : (lucht ? 2.2 : 1.5), opacity: 0.95, fillColor: kleur, fillOpacity: actief ? 0.5 : (lucht ? 0.42 : 0.35) });
      else if (l instanceof L.Polyline) l.setStyle({ color: kleur, weight: actief ? 6 : (lucht ? 5 : 4), opacity: actief ? 1 : 0.85 });
    });
  }
  // Toon de vorm alleen als die op het scherm groot genoeg is; anders blijft het een stip.
  function alsVorm(d) {
    const v = vormenById.get(d.kenmerk);
    if (!v) return false;
    const b = v.getBounds();
    const a = map.project(b.getNorthWest()), c = map.project(b.getSouthEast());
    return Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y)) >= VORM_MIN_PX;
  }

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = "<h3>Legenda</h3>" +
      '<div class="row"><i style="width:16px;height:16px;background:#c62828"></i> hoog</div>' +
      '<div class="row"><i style="width:13px;height:13px;background:#ef6c00"></i> middel</div>' +
      '<div class="row"><i style="width:13px;height:13px;background:#f9a825"></i> laag</div>' +
      '<div class="row"><i style="width:11px;height:11px;background:#78909c"></i> niet relevant</div>' +
      '<div class="row"><i class="lg-lijn"></i> Hoogspanningsverbinding</div>' +
      '<div class="row"><i class="lg-zone"></i> Zone ' + CFG.bufferMeters + ' m</div>' +
      '<p class="note">' + escapeHtml(Array.from(VORM_KLASSEN).join(", ")) + ': als vlak of lijn uit de publicatie (bij inzoomen); zonder vlak/lijn of te klein: stip.</p>';
    return div;
  };
  legend.addTo(map);

  // ---------------------------------------------------------------- details -
  function bufferTekst(d) {
    if (d.binnen_buffer_100m == null) return "nog niet berekend";
    return (d.binnen_buffer_100m ? "ja" : "nee") + (d.afstand_tot_asset_m == null ? "" : " (" + Math.round(d.afstand_tot_asset_m) + " m van het net)");
  }
  function regel(label, waarde, leeg, popup) {
    const isLeeg = waarde == null || String(waarde).trim() === "";
    const inhoud = isLeeg ? '<span class="muted">' + escapeHtml(leeg || "—") + "</span>" : escapeHtml(waarde);
    return popup ? '<div class="row"><span class="lbl">' + escapeHtml(label) + ": </span>" + inhoud + "</div>"
      : "<dt>" + escapeHtml(label) + "</dt><dd>" + inhoud + "</dd>";
  }
  function velden(d, popup) {
    let h = "";
    h += regel("Kenmerk", d.kenmerk, "", popup);
    h += regel("Datum", d.datum_nl, "", popup);
    h += regel("Eerste inschatting", d.inschatting + " (score " + d.relevantie_score + ")", "", popup);
    h += regel("Bron", d.bron, "", popup);
    h += regel("Type", d.type, "", popup);
    if (!popup) h += regel("Titel", d.titel, "", popup);
    h += regel("Locatie", d.locatie, "", popup);
    h += regel("Wat er gebeurt / toelichting", d.toelichting, "", popup);
    h += regel("Waarom deze inschatting", d.waarom, "", popup);
    if (d.ontbreekt && String(d.ontbreekt).trim()) h += regel("Ontbreekt", d.ontbreekt, "", popup);
    h += regel("Binnen " + CFG.bufferMeters + " m van het net", bufferTekst(d), "", popup);
    return h;
  }
  function popupHtml(d) {
    const u = veiligeUrl(d.url);
    return '<div class="popup"><h3>' + escapeHtml(d.titel) + "</h3>" + badge(d.inschatting) + velden(d, true) +
      (u ? '<div class="row"><a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">Officiële bekendmaking</a></div>' : "") + "</div>";
  }

  function toonDetail(kenmerk, vanLijst) {
    const d = data.find(x => x.kenmerk === kenmerk);
    if (!d) return;
    const u = veiligeUrl(d.url);
    const el = $("detail");
    el.classList.add("is-open");
    $("list-view").classList.add("is-hidden");
    el.innerHTML = '<button type="button" class="back" id="btn-terug">← Terug naar de lijst</button>' + badge(d.inschatting) +
      "<h2>" + escapeHtml(d.titel) + "</h2><dl>" + velden(d, false) + "</dl>" +
      (u ? '<a class="officieel" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">Open officiële bekendmaking</a>' : "");
    $("btn-terug").addEventListener("click", sluitDetail);
    const marker = markersById.get(kenmerk);
    markeerActief(kenmerk);
    const vorm = vormenById.get(kenmerk);
    if (vorm && vanLijst) {
      map.once("moveend", () => {
        if (alsVorm(d)) vorm.openPopup(vorm.getBounds().getCenter());
        else if (marker) clusters.zoomToShowLayer(marker, () => marker.openPopup());
      });
      map.fitBounds(vorm.getBounds(), { padding: [60, 60], maxZoom: 17 });
    } else if (vorm && alsVorm(d)) {
      if (!vorm.isPopupOpen()) vorm.openPopup(vorm.getBounds().getCenter());
    } else if (marker) {
      if (vanLijst) clusters.zoomToShowLayer(marker, () => marker.openPopup()); else marker.openPopup();
    }
  }
  let actiefId = null;
  function markeerActief(kenmerk) {
    actiefId = kenmerk;
    markersById.forEach((m, id) => { const a = id === kenmerk; if (a !== !!m._actief) { m._actief = a; m.setIcon(divIcon(m.options.klasse, a)); } });
    vormenById.forEach((v, id) => { const a = id === kenmerk; if (a !== !!v._actief) { v._actief = a; stijlVorm(v, v.options.klasse, a); if (a) v.bringToFront(); } });
  }
  function sluitDetail() {
    $("detail").classList.remove("is-open");
    $("detail").innerHTML = "";
    $("list-view").classList.remove("is-hidden");
    markeerActief(null);
  }

  // ---------------------------------------------------------------- filters -
  function inModus(d) { return modus === "alle" || d.binnen_buffer_100m === true; }
  function zichtbaar(d) { return inModus(d) && visible.has(d.inschatting); }

  function itemButton(d) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item";
    btn.innerHTML = '<div class="top">' + badge(d.inschatting) + (d.binnen_buffer_100m === true ? '<span class="buffer-tag">≤ ' + CFG.bufferMeters + " m</span>" : "") +
      '<span class="meta">' + escapeHtml(d.datum_nl) + " · " + escapeHtml(d.kenmerk) + "</span></div>" +
      '<div class="titel">' + escapeHtml(d.titel) + '</div><div class="loc">' + escapeHtml(d.locatie || d.bron || "") + "</div>";
    btn.addEventListener("click", () => toonDetail(d.kenmerk, true));
    return btn;
  }
  const sorteer = (a, b) => (b.relevantie_score - a.relevantie_score) || b.datum.localeCompare(a.datum) || a.kenmerk.localeCompare(b.kenmerk);

  // Kaartlagen: stip of vorm per melding, afhankelijk van filters en zoomniveau.
  function renderKaart() {
    const stippen = [];
    markersById.forEach(m => { const d = m.options.rec; if (zichtbaar(d) && !alsVorm(d)) stippen.push(m); });
    clusters.clearLayers();
    clusters.addLayers(stippen);
    vormGroep.clearLayers();
    vormenById.forEach(v => { const d = v.options.rec; if (zichtbaar(d) && alsVorm(d)) vormGroep.addLayer(v); });
  }
  map.on("zoomend", renderKaart);

  function render() {
    renderKaart();
    const mShow = data.filter(d => d.heeft_coordinaat && zichtbaar(d)).sort(sorteer);
    const uShow = data.filter(d => !d.heeft_coordinaat && zichtbaar(d)).sort(sorteer);
    $("mapped-title").textContent = "Op de kaart (" + mShow.length + ")";
    $("unlocated-title").textContent = "Zonder coördinaat (" + uShow.length + ")";
    const ml = $("mapped-list"), ul = $("unlocated-list");
    ml.innerHTML = ""; ul.innerHTML = "";
    if (!mShow.length) ml.innerHTML = '<p class="empty">Geen meldingen in deze weergave.</p>'; else mShow.forEach(d => ml.appendChild(itemButton(d)));
    if (!uShow.length) ul.innerHTML = '<p class="empty">Geen meldingen zonder coördinaat.</p>'; else uShow.forEach(d => ul.appendChild(itemButton(d)));
    document.querySelectorAll(".filter-btn").forEach(btn => {
      const k = btn.dataset.klasse;
      btn.querySelector(".n").textContent = "(" + data.filter(d => d.inschatting === k && inModus(d)).length + ")";
    });
    $("btn-buffer").setAttribute("aria-pressed", modus === "buffer" ? "true" : "false");
    $("btn-alle").setAttribute("aria-pressed", modus === "alle" ? "true" : "false");
  }

  function bouwFilters() {
    const row = $("filter-row");
    ORDE.forEach(k => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "filter-btn"; btn.dataset.klasse = k; btn.setAttribute("aria-pressed", "true");
      btn.innerHTML = '<span class="dot"></span>' + escapeHtml(k) + ' <span class="n"></span>';
      btn.addEventListener("click", () => {
        if (visible.has(k)) visible.delete(k); else visible.add(k);
        btn.setAttribute("aria-pressed", visible.has(k) ? "true" : "false");
        render();
      });
      row.appendChild(btn);
    });
    $("btn-buffer").addEventListener("click", () => { if (bufferBeschikbaar) { modus = "buffer"; sluitDetail(); render(); } });
    $("btn-alle").addEventListener("click", () => { modus = "alle"; sluitDetail(); render(); });
  }

  // ---------------------------------------------------------------- start ---
  bouwFilters();
  laad().then(({ rows, bron }) => {
    data = rows.map(normaliseer);
    data.filter(d => d.heeft_coordinaat).forEach(d => {
      const m = L.marker([d.lat, d.lon], { icon: divIcon(d.inschatting, false), title: d.kenmerk + " — " + d.titel, riseOnHover: true, klasse: d.inschatting, relevantie_score: d.relevantie_score, rec: d });
      m.bindPopup(popupHtml(d), { maxWidth: 340, autoPanPadding: [40, 40] });
      m.on("click", () => toonDetail(d.kenmerk, false));
      markersById.set(d.kenmerk, m);
      if (d.vorm && VORM_KLASSEN.has(d.inschatting)) {
        try {
          const v = L.geoJSON(d.vorm, { pane: "vormPane", renderer: vormRenderer, klasse: d.inschatting, rec: d });
          stijlVorm(v, d.inschatting, false);
          v.bindPopup(popupHtml(d), { maxWidth: 340, autoPanPadding: [40, 40] });
          v.on("click", () => toonDetail(d.kenmerk, false));
          v.bindTooltip(escapeHtml(d.titel), { sticky: true, direction: "top", opacity: 0.9 });
          vormenById.set(d.kenmerk, v);
        } catch (e) { /* ongeldige vorm: stip blijft */ }
      }
    });
    const nBuffer = data.filter(d => d.binnen_buffer_100m === true).length;
    const allesNull = data.every(d => d.binnen_buffer_100m == null);
    bufferBeschikbaar = nBuffer > 0;
    $("btn-buffer").disabled = !bufferBeschikbaar;
    modus = bufferBeschikbaar ? "buffer" : "alle";
    const laatst = data.reduce((m, d) => (d.last_seen && d.last_seen > m ? d.last_seen : m), "");
    $("header-counts").textContent = data.length + " opgeslagen · " + nBuffer + " binnen " + CFG.bufferMeters + " m" + (laatst ? " · laatst bijgewerkt " + nlDatum(laatst) : "");
    if (!data.length) setStatus("Nog geen bekendmakingen binnen " + CFG.bufferMeters + " m van het net opgeslagen. De dagelijkse scan vult dit aan.", "warn");
    else if (allesNull) setStatus("De bufferberekening is nog niet uitgevoerd; alle opgeslagen meldingen worden getoond.", "warn");
    else setStatus("Standaard zie je meldingen binnen " + CFG.bufferMeters + " m van het Stedin-hoogspanningsnet." + (bron === "geojson" ? " (Uit de dagelijkse GeoJSON; live API niet bereikbaar.)" : ""));
    render();
    const pts = data.filter(d => d.heeft_coordinaat && inModus(d)).map(d => [d.lat, d.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 14 });
    window.MONITOR.data = data;
    klaarResolve(data);
  }).catch(err => {
    setStatus("Gegevens konden niet worden geladen (" + err.message + ").", "err");
    $("header-counts").textContent = "";
    klaarResolve([]);
  });

  // ---------------------------------------------------------------- tabbladen (hash-routing) ---
  function toonOpKaart(kenmerk) {
    const d = data.find(x => x.kenmerk === kenmerk);
    if (!d) return;
    // Zorg dat de melding niet door een filter verborgen is.
    if (!zichtbaar(d)) {
      visible.add(d.inschatting);
      document.querySelectorAll(".filter-btn").forEach(b => b.setAttribute("aria-pressed", visible.has(b.dataset.klasse) ? "true" : "false"));
      if (!inModus(d)) modus = "alle";
      render();
    }
    toonDetail(kenmerk, true);
  }
  window.MONITOR.toonOpKaart = toonOpKaart;

  function toonView(v) {
    document.body.dataset.view = v;
    $("tab-kaart").setAttribute("aria-selected", v === "kaart" ? "true" : "false");
    $("tab-lijst").setAttribute("aria-selected", v === "lijst" ? "true" : "false");
    if (v === "kaart") setTimeout(() => map.invalidateSize(), 0);
    document.dispatchEvent(new CustomEvent("monitor:view", { detail: v }));
  }
  function route() {
    const h = location.hash || "";
    if (/access_token=|error_description=|[#&]error=/.test(h)) return;   // Supabase-login verwerkt dit zelf
    if (h.startsWith("#lijst")) { toonView("lijst"); return; }
    toonView("kaart");
    const m = h.match(/^#kaart\/(.+)$/);
    if (m) {
      const kenmerk = decodeURIComponent(m[1]);
      window.MONITOR.klaar.then(() => {
        setTimeout(() => { map.invalidateSize(); toonOpKaart(kenmerk); }, 30);
        history.replaceState(null, "", "#kaart");
      });
    }
  }
  window.addEventListener("hashchange", route);
  route();
})();
