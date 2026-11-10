/* Bekendmakingen-monitor Stedin hoogspanning — kaart.
 * Leest live uit Supabase (view public.meldingen_kaart) met de publishable key.
 * Toont NOOIT asset-geometrie: de tabel public.assets is voor deze key afgeschermd. */
(function () {
  "use strict";
  const CFG = window.MONITOR_CONFIG;
  const KLEUR = { "hoog": "#c62828", "middel": "#ef6c00", "laag": "#f9a825", "niet relevant": "#78909c" };
  const RADIUS = { "hoog": 12, "middel": 9, "laag": 9, "niet relevant": 8 };
  const ORDE = ["hoog", "middel", "laag", "niet relevant"];
  const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
    "september", "oktober", "november", "december"];

  const visible = new Set(ORDE);
  const markersById = new Map();
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
    return Object.assign({}, r, {
      inschatting: ORDE.includes(r.inschatting) ? r.inschatting : "niet relevant",
      relevantie_score: r.relevantie_score == null ? 0 : r.relevantie_score,
      lat: ok ? lat : null, lon: ok ? lon : null, heeft_coordinaat: ok,
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
      return { rows: fc.features.map(f => Object.assign({}, f.properties, { geojson: f.geometry })), bron: "geojson" };
    }
  }

  // ---------------------------------------------------------------- kaart ---
  const map = L.map("map", { zoomSnap: 0.25 }).setView([51.95, 4.5], 9);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers'
  }).addTo(map);

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

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = "<h3>Legenda</h3>" +
      '<div class="row"><i style="width:16px;height:16px;background:#c62828"></i> hoog</div>' +
      '<div class="row"><i style="width:13px;height:13px;background:#ef6c00"></i> middel</div>' +
      '<div class="row"><i style="width:13px;height:13px;background:#f9a825"></i> laag</div>' +
      '<div class="row"><i style="width:11px;height:11px;background:#78909c"></i> niet relevant</div>' +
      '<p class="note">Het hoogspanningsnet zelf wordt bewust niet getoond.</p>';
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
    if (marker) {
      markersById.forEach((m, id) => { m._actief = id === kenmerk; m.setIcon(divIcon(m.options.klasse, m._actief)); });
      if (vanLijst) clusters.zoomToShowLayer(marker, () => marker.openPopup()); else marker.openPopup();
    }
  }
  function sluitDetail() {
    $("detail").classList.remove("is-open");
    $("detail").innerHTML = "";
    $("list-view").classList.remove("is-hidden");
    markersById.forEach(m => { if (m._actief) { m._actief = false; m.setIcon(divIcon(m.options.klasse, false)); } });
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

  function render() {
    clusters.clearLayers();
    markersById.forEach(m => { if (zichtbaar(m.options.rec)) clusters.addLayer(m); });
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
  }).catch(err => {
    setStatus("Gegevens konden niet worden geladen (" + err.message + ").", "err");
    $("header-counts").textContent = "";
  });
})();
