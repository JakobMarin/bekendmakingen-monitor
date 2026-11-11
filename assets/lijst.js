/* Bekendmakingen-monitor — tabblad 'Lijst & review'.
 * Alle meldingen als tabel (Tabulator): sorteren/filteren per kolom, vrij zoeken (losse woorden,
 * EN-logica, hoofdletter- en accentongevoelig), kolommen tonen/verbergen, export CSV/XLSX.
 * Review (relevant / niet relevant / twijfel + reden + klasse-correctie) alleen voor ingelogde
 * reviewers (Supabase Auth, magic link). Schrijfrechten worden in de database afgedwongen
 * (RLS op public.feedback + allowlist private.reviewers); de knoppen hier zijn alleen gemak. */
(function () {
  "use strict";
  const CFG = window.MONITOR_CONFIG;
  const $ = id => document.getElementById(id);
  const OORDEEL = { relevant: "relevant", niet_relevant: "niet relevant", twijfel: "twijfel" };
  const OPEN = "nog niet beoordeeld";
  const KLASSEN = ["hoog", "middel", "laag", "niet relevant"];
  const ZOEKVELDEN = ["kenmerk", "datum", "titel", "bron", "uitgever", "type", "inschatting", "relevantie_score",
    "afstand", "binnen", "vorm_type", "locatie", "toelichting", "waarom", "ontbreekt", "eerst_gezien",
    "review_oordeel", "klasse_correctie", "reden", "reviewer", "beoordeeld_op"];
  const KOLOM_OPSLAG = "bm-lijst-kolommen-v1";

  const sb = window.supabase && window.supabase.createClient
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" }
    })
    : null;

  let tabel = null, tabelKlaar = false, rijen = [], sessie = null, isReviewer = false;
  let zoekWoorden = [], alleenOpen = false;

  // ------------------------------------------------------------ hulpfuncties ---
  const norm = s => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function melding(tekst, soort) {
    const el = $("lijst-melding");
    el.textContent = tekst || "";
    el.className = "lijst-melding" + (soort ? " " + soort : "");
    if (tekst && soort !== "err") { clearTimeout(melding._t); melding._t = setTimeout(() => melding(""), 6000); }
  }
  function nlTijd(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function zoekTekst(r) { return norm(ZOEKVELDEN.map(k => r[k]).join(" \u2016 ")); }

  async function alleRijen(maak) {   // PostgREST levert max. 1000 rijen per verzoek
    let uit = [];
    for (let van = 0; ; van += 1000) {
      const { data, error } = await maak().range(van, van + 999);
      if (error) throw error;
      uit = uit.concat(data || []);
      if (!data || data.length < 1000) return uit;
    }
  }

  function naarRij(d) {
    return {
      kenmerk: d.kenmerk, datum: d.datum || "", titel: d.titel || "", bron: d.bron || "", uitgever: d.uitgever || "",
      type: d.type || "", inschatting: d.inschatting, relevantie_score: d.relevantie_score,
      afstand: d.afstand_tot_asset_m == null ? null : Math.round(+d.afstand_tot_asset_m),
      binnen: d.binnen_buffer_100m === true ? "ja" : d.binnen_buffer_100m === false ? "nee" : "onbekend",
      vorm_type: d.vorm_type || "n.v.t.", locatie: d.locatie || "",
      toelichting: d.toelichting || "", waarom: d.waarom || "", ontbreekt: d.ontbreekt || "",
      eerst_gezien: (d.first_seen || d.eerst_gezien || "").slice(0, 10), url: d.url || "",
      heeft_coordinaat: !!d.heeft_coordinaat,
      oordeel_code: null, review_oordeel: OPEN, klasse_correctie: "", reden: "", reviewer: "", beoordeeld_op: "",
      _opslaan: ""
    };
  }

  // ------------------------------------------------------------ filters ---
  function tekstFilter(hv, rv) {
    const w = norm(hv).split(/\s+/).filter(Boolean);
    if (!w.length) return true;
    const t = norm(rv);
    return w.every(x => t.includes(x));
  }
  function bereikEditor(type) {
    return function (cell, onRendered, success, cancel) {
      const wrap = document.createElement("span");
      wrap.className = "bereik";
      const a = document.createElement("input"), b = document.createElement("input");
      a.type = b.type = type; a.placeholder = "van"; b.placeholder = "t/m";
      a.setAttribute("aria-label", "van"); b.setAttribute("aria-label", "tot en met");
      const zet = () => success({ van: a.value, tot: b.value });
      [a, b].forEach(i => {
        i.addEventListener("input", zet); i.addEventListener("change", zet);
        i.addEventListener("keydown", e => { if (e.key === "Escape") { a.value = b.value = ""; zet(); } });
      });
      wrap.append(a, b);
      return wrap;
    };
  }
  function bereikFilter(hv, rv) {
    const leeg = v => v === "" || v == null;
    if (!hv || (leeg(hv.van) && leeg(hv.tot))) return true;
    if (rv === null || rv === undefined || rv === "") return false;
    const num = typeof rv === "number";
    const v = num ? rv : String(rv);
    if (!leeg(hv.van) && v < (num ? parseFloat(hv.van) : hv.van)) return false;
    if (!leeg(hv.tot) && v > (num ? parseFloat(hv.tot) : hv.tot)) return false;
    return true;
  }
  const bereikLeeg = v => !v || ((v.van === "" || v.van == null) && (v.tot === "" || v.tot == null));
  const lijstFilter = { headerFilter: "list", headerFilterParams: { valuesLookup: "all", clearable: true, sort: "asc" }, headerFilterFunc: "=" };
  const tekstKolom = { headerFilter: "input", headerFilterPlaceholder: "filter…", headerFilterFunc: tekstFilter };

  function globaalFilter(d) {
    if (alleenOpen && d.oordeel_code) return false;
    if (!zoekWoorden.length) return true;
    if (!d._zoek) d._zoek = zoekTekst(d);
    return zoekWoorden.every(w => d._zoek.includes(w));
  }
  function pasGlobaalFilterToe() {
    if (!tabel) return;
    tabel.setFilter(globaalFilter);
  }

  // ------------------------------------------------------------ review ---
  function reviewTitel() {
    if (!sessie) return "Log in om te beoordelen";
    if (!isReviewer) return "Dit account staat niet op de lijst van reviewers";
    return "";
  }
  function reviewFormatter(cell) {
    const r = cell.getRow().getData();
    const uit = !isReviewer, t = reviewTitel();
    const knop = (o, label, icoon) => '<button type="button" class="rv-btn rv-' + o + (r.oordeel_code === o ? " actief" : "") +
      '" data-o="' + o + '"' + (uit ? " disabled" : "") + ' title="' + esc(uit ? t : label) + '" aria-label="' + esc(label) + '">' + icoon + "</button>";
    const st = r._opslaan === "bezig" ? '<span class="rv-st" title="Opslaan…">…</span>'
      : r._opslaan === "ok" ? '<span class="rv-st ok" title="Opgeslagen">✓</span>'
        : r._opslaan === "fout" ? '<span class="rv-st err" title="Niet opgeslagen">!</span>' : "";
    return '<div class="rv"' + (uit ? ' title="' + esc(t) + '"' : "") + ">" +
      knop("relevant", "relevant", "✔") + knop("niet_relevant", "niet relevant", "✖") + knop("twijfel", "twijfel", "?") + st +
      (uit ? '<span class="rv-hint">' + esc(t.toLowerCase()) + "</span>" : "") + "</div>";
  }
  function oordeelFormatter(cell) {
    const v = cell.getValue();
    const cls = v === "relevant" ? "relevant" : v === "niet relevant" ? "niet_relevant" : v === "twijfel" ? "twijfel" : "open";
    return '<span class="oordeel ' + cls + '">' + esc(v) + "</span>";
  }

  async function slaOp(row, wijziging) {
    if (!isReviewer || !sb) { melding(reviewTitel() + ".", "warn"); return; }
    const r = row.getData();
    const oordeel = wijziging.oordeel || r.oordeel_code;
    if (!oordeel) { melding("Kies eerst relevant, niet relevant of twijfel; de reden en correctie worden dan meegestuurd.", "warn"); return; }
    const reden = "reden" in wijziging ? wijziging.reden : r.reden;
    const kc = "klasse_correctie" in wijziging ? wijziging.klasse_correctie : r.klasse_correctie;
    const oud = { oordeel_code: r.oordeel_code, review_oordeel: r.review_oordeel, reden: r._reden_opgeslagen ?? r.reden,
      klasse_correctie: r._kc_opgeslagen ?? r.klasse_correctie, reviewer: r.reviewer, beoordeeld_op: r.beoordeeld_op };
    const nieuw = { oordeel_code: oordeel, review_oordeel: OORDEEL[oordeel], reden: reden || "", klasse_correctie: kc || "",
      reviewer: (sessie.user.email || "").toLowerCase(), beoordeeld_op: new Date().toISOString(), _opslaan: "bezig" };
    nieuw._zoek = zoekTekst(Object.assign({}, r, nieuw));
    await row.update(nieuw);     // optimistisch
    row.reformat();
    const { error } = await sb.from("feedback").insert({
      bekendmaking_id: r.kenmerk, oordeel: oordeel, klasse_correctie: kc || null, reden: (reden || "").trim() || null
    });
    if (error) {
      oud._opslaan = "fout";
      oud._zoek = zoekTekst(Object.assign({}, r, oud));
      await row.update(oud);
      row.reformat();
      melding("Opslaan mislukt voor " + r.kenmerk + ": " + error.message, "err");
    } else {
      await row.update({ _opslaan: "ok", _reden_opgeslagen: nieuw.reden, _kc_opgeslagen: nieuw.klasse_correctie });
      row.reformat();
      werkTellerBij();
    }
  }

  // ------------------------------------------------------------ tabel ---
  function kolommen() {
    const kaartKnop = cell => cell.getRow().getData().heeft_coordinaat
      ? '<button type="button" class="kaart-btn" title="Toon op kaart">Kaart</button>' : '<span class="muted" title="Geen coördinaat">—</span>';
    return [
      { title: "", field: "_kaart", formatter: kaartKnop, headerSort: false, width: 64, frozen: true, download: false,
        cellClick: (e, cell) => { e.stopPropagation(); naarKaart(cell.getRow().getData().kenmerk); }, vast: true },
      { title: "Review", field: "_review", formatter: reviewFormatter, headerSort: false, width: 150, frozen: true, download: false,
        cellClick: (e, cell) => {
          const b = e.target.closest("button[data-o]");
          if (!b || b.disabled) return;
          e.stopPropagation();
          slaOp(cell.getRow(), { oordeel: b.dataset.o });
        }, vast: true },
      Object.assign({ title: "Oordeel", field: "review_oordeel", formatter: oordeelFormatter, width: 130 }, lijstFilter),
      Object.assign({ title: "Klasse-correctie", field: "klasse_correctie", width: 125,
        editor: "list", editorParams: { values: ["", ...KLASSEN] }, editable: () => isReviewer,
        cellEdited: cell => { if (cell.getValue() !== cell.getOldValue()) slaOp(cell.getRow(), { klasse_correctie: cell.getValue() }); } }, lijstFilter),
      Object.assign({ title: "Reden", field: "reden", width: 220, editor: "input", editable: () => isReviewer,
        cellEdited: cell => {
          if (cell.getValue() === cell.getOldValue()) return;
          if (cell.getRow().getData().oordeel_code) slaOp(cell.getRow(), { reden: cell.getValue() });
          else melding("Reden genoteerd; kies nu relevant, niet relevant of twijfel om op te slaan.", "warn");
        } }, tekstKolom),
      Object.assign({ title: "Reviewer", field: "reviewer", width: 150 }, lijstFilter),
      { title: "Beoordeeld op", field: "beoordeeld_op", width: 150, formatter: c => esc(nlTijd(c.getValue())),
        headerFilter: bereikEditor("date"), headerFilterFunc: (hv, rv) => bereikFilter(hv, rv ? String(rv).slice(0, 10) : rv),
        headerFilterEmptyCheck: bereikLeeg },
      { title: "Datum", field: "datum", width: 120, sorter: "string", headerFilter: bereikEditor("date"), headerFilterFunc: bereikFilter, headerFilterEmptyCheck: bereikLeeg },
      Object.assign({ title: "Kenmerk", field: "kenmerk", width: 150,
        formatter: c => { const u = c.getRow().getData().url; return /^https:\/\//.test(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(c.getValue()) + "</a>" : esc(c.getValue()); } }, tekstKolom),
      Object.assign({ title: "Titel", field: "titel", width: 360, formatter: "plaintext" }, tekstKolom),
      Object.assign({ title: "Klasse", field: "inschatting", width: 115, sorter: (a, b) => KLASSEN.indexOf(b) - KLASSEN.indexOf(a),
        formatter: c => '<span class="badge ' + (c.getValue() === "niet relevant" ? "niet" : esc(c.getValue())) + '">' + esc(c.getValue()) + "</span>" }, lijstFilter,
        { headerFilterParams: { values: KLASSEN, clearable: true } }),
      { title: "Score", field: "relevantie_score", width: 100, sorter: "number", hozAlign: "right",
        headerFilter: bereikEditor("number"), headerFilterFunc: bereikFilter, headerFilterEmptyCheck: bereikLeeg },
      { title: "Afstand (m)", field: "afstand", width: 110, sorter: "number", hozAlign: "right",
        headerFilter: bereikEditor("number"), headerFilterFunc: bereikFilter, headerFilterEmptyCheck: bereikLeeg },
      Object.assign({ title: "≤ 100 m", field: "binnen", width: 95 }, lijstFilter),
      Object.assign({ title: "Vorm", field: "vorm_type", width: 100 }, lijstFilter),
      Object.assign({ title: "Bron", field: "bron", width: 220 }, lijstFilter),
      Object.assign({ title: "Orgaan / gemeente", field: "uitgever", width: 190 }, lijstFilter),
      Object.assign({ title: "Type", field: "type", width: 180 }, tekstKolom),
      Object.assign({ title: "Locatie", field: "locatie", width: 220 }, tekstKolom),
      Object.assign({ title: "Toelichting", field: "toelichting", width: 280, visible: false }, tekstKolom),
      Object.assign({ title: "Waarom (inschatting)", field: "waarom", width: 280 }, tekstKolom),
      Object.assign({ title: "Ontbreekt", field: "ontbreekt", width: 200, visible: false }, tekstKolom),
      { title: "Eerst gezien", field: "eerst_gezien", width: 120, visible: false, headerFilter: bereikEditor("date"), headerFilterFunc: bereikFilter, headerFilterEmptyCheck: bereikLeeg },
      Object.assign({ title: "URL", field: "url", width: 260, visible: false, formatter: "plaintext" }, tekstKolom)
    ];
  }

  function bewaarKolommen() {
    const zichtbaar = {};
    tabel.getColumns().forEach(c => { const f = c.getField(); if (f && !f.startsWith("_")) zichtbaar[f] = c.isVisible(); });
    try { localStorage.setItem(KOLOM_OPSLAG, JSON.stringify(zichtbaar)); } catch (e) { /* ok */ }
  }
  function bouwKolommenMenu() {
    const menu = $("kolommen-menu");
    menu.innerHTML = "";
    tabel.getColumns().forEach(c => {
      const def = c.getDefinition();
      if (!c.getField() || c.getField().startsWith("_")) return;
      const lab = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = c.isVisible();
      cb.addEventListener("change", () => { cb.checked ? c.show() : c.hide(); bewaarKolommen(); });
      lab.append(cb, " " + def.title);
      menu.appendChild(lab);
    });
  }

  function werkTellerBij() {
    if (!tabel) return;
    const n = tabel.getDataCount("active"), tot = rijen.length;
    const open = rijen.filter(r => !r.oordeel_code).length;
    $("lijst-teller").textContent = n + " van " + tot + " meldingen · " + (tot - open) + " beoordeeld · " + open + " nog niet";
  }

  function naarKaart(kenmerk) { location.hash = "#kaart/" + encodeURIComponent(kenmerk); }

  function maakTabel() {
    let opgeslagen = {};
    try { opgeslagen = JSON.parse(localStorage.getItem(KOLOM_OPSLAG) || "{}"); } catch (e) { opgeslagen = {}; }
    const cols = kolommen().map(c => (c.field in opgeslagen ? Object.assign(c, { visible: opgeslagen[c.field] }) : c));
    cols.forEach(c => delete c.vast);
    tabel = new Tabulator("#tabel", {
      data: rijen,
      index: "kenmerk",
      height: "100%",
      layout: "fitData",
      movableColumns: true,
      placeholder: "Geen meldingen voor deze zoekopdracht of filters.",
      columnDefaults: { tooltip: true, headerTooltip: true, resizable: true },
      columns: cols
    });
    window.__bmTabel = tabel;   // handig voor debuggen in de console
    tabel.on("tableBuilt", () => {
      tabelKlaar = true;
      tabel.setSort([{ column: "relevantie_score", dir: "desc" }, { column: "datum", dir: "desc" }]);
      bouwKolommenMenu();
      pasGlobaalFilterToe();
      werkTellerBij();
    });
    tabel.on("dataFiltered", () => setTimeout(werkTellerBij, 0));
    tabel.on("rowDblClick", (e, row) => { if (!e.target.closest("button, a, input, select")) naarKaart(row.getData().kenmerk); });
  }

  // ------------------------------------------------------------ data laden ---
  async function laadStatus() {
    if (!sb) return;
    try {
      const status = await alleRijen(() => sb.rpc("feedback_status"));
      const per = new Map(status.map(s => [s.kenmerk, s]));
      let details = new Map();
      if (isReviewer) {
        const lt = await alleRijen(() => sb.from("feedback_laatste").select("kenmerk,oordeel,klasse_correctie,reden,reviewer_email,created_at"));
        details = new Map(lt.map(s => [s.kenmerk, s]));
      }
      rijen.forEach(r => {
        const s = details.get(r.kenmerk) || per.get(r.kenmerk);
        Object.assign(r, s ? {
          oordeel_code: s.oordeel, review_oordeel: OORDEEL[s.oordeel] || s.oordeel, klasse_correctie: s.klasse_correctie || "",
          reden: s.reden || "", reviewer: s.reviewer_email || (s.reden === undefined && s.oordeel ? "(alleen zichtbaar voor reviewers)" : ""),
          beoordeeld_op: s.created_at || s.beoordeeld_op || ""
        } : { oordeel_code: null, review_oordeel: OPEN, klasse_correctie: "", reden: "", reviewer: "", beoordeeld_op: "" });
        r._reden_opgeslagen = r.reden; r._kc_opgeslagen = r.klasse_correctie;
        r._zoek = zoekTekst(r);
      });
      if (tabel && tabelKlaar) { await tabel.replaceData(rijen); werkTellerBij(); }
    } catch (e) {
      melding("Reviewstatus kon niet worden geladen (" + (e.message || e) + ").", "err");
    }
  }

  async function initLijst() {
    if (initLijst.gestart) return;
    initLijst.gestart = true;
    const data = await window.MONITOR.klaar;
    rijen = data.map(naarRij);
    await laadStatus();
    maakTabel();
  }

  // ------------------------------------------------------------ inloggen ---
  async function werkAuthBij(s) {
    sessie = s;
    isReviewer = false;
    if (sessie && sb) {
      const { data, error } = await sb.rpc("is_reviewer");
      isReviewer = !error && data === true;
    }
    $("login-form").hidden = !!sessie;
    $("btn-uitloggen").hidden = !sessie;
    $("auth-status").innerHTML = !sb ? '<span class="err">Inloggen niet beschikbaar (Supabase-bibliotheek niet geladen)</span>'
      : !sessie ? '<span class="muted">Log in om te beoordelen</span>'
        : esc(sessie.user.email) + (isReviewer ? ' · <span class="ok">reviewer</span>' : ' · <span class="err">geen reviewerrechten</span>');
    if (initLijst.gestart) await laadStatus();
    if (tabel && tabelKlaar) tabel.getColumn("_review") && tabel.redraw(true);
  }

  function koppelUi() {
    let t;
    $("zoek").addEventListener("input", e => {
      clearTimeout(t);
      t = setTimeout(() => { zoekWoorden = norm(e.target.value).split(/\s+/).filter(Boolean); pasGlobaalFilterToe(); }, 150);
    });
    $("alleen-open").addEventListener("change", e => { alleenOpen = e.target.checked; pasGlobaalFilterToe(); });
    $("filters-wissen").addEventListener("click", () => {
      $("zoek").value = ""; zoekWoorden = []; $("alleen-open").checked = false; alleenOpen = false;
      if (tabel) { tabel.clearHeaderFilter(); pasGlobaalFilterToe(); }
    });
    $("btn-kolommen").addEventListener("click", () => {
      const m = $("kolommen-menu"); m.hidden = !m.hidden; $("btn-kolommen").setAttribute("aria-expanded", String(!m.hidden));
    });
    document.addEventListener("click", e => { if (!e.target.closest(".dropdown")) $("kolommen-menu").hidden = true; });
    $("btn-csv").addEventListener("click", () => tabel && tabel.download("csv", "bekendmakingen-stedin.csv", { delimiter: ";", bom: true }));
    $("btn-xlsx").addEventListener("click", () => {
      if (!tabel) return;
      const doe = () => tabel.download("xlsx", "bekendmakingen-stedin.xlsx", { sheetName: "Meldingen" });
      if (window.XLSX) return doe();
      const s = document.createElement("script");
      s.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      s.integrity = "sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT";
      s.crossOrigin = "anonymous";
      s.onload = doe;
      s.onerror = () => melding("XLSX-bibliotheek kon niet worden geladen; gebruik CSV.", "err");
      document.head.appendChild(s);
    });
    $("login-form").addEventListener("submit", async e => {
      e.preventDefault();
      if (!sb) return;
      const email = $("login-email").value.trim();
      try { localStorage.setItem("bm-na-login", "lijst"); } catch (x) { /* ok */ }
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      melding(error ? "Inloglink versturen mislukt: " + error.message : "Inloglink verstuurd naar " + email + ". Open de link in deze browser.", error ? "err" : "ok");
    });
    $("btn-uitloggen").addEventListener("click", async () => { if (sb) await sb.auth.signOut(); });
  }

  koppelUi();
  document.addEventListener("monitor:view", e => {
    if (e.detail !== "lijst") return;
    initLijst();
    if (tabel && tabelKlaar) setTimeout(() => tabel.redraw(), 0);
  });
  if (document.body.dataset.view === "lijst") initLijst();

  if (sb) {
    sb.auth.onAuthStateChange((event, s) => {
      setTimeout(() => {   // geen Supabase-aanroepen binnen de callback zelf
        werkAuthBij(s);
        if (event === "SIGNED_IN") {
          let naar = null;
          try { naar = localStorage.getItem("bm-na-login"); localStorage.removeItem("bm-na-login"); } catch (x) { /* ok */ }
          if (naar === "lijst" && !location.hash.startsWith("#lijst")) location.hash = "#lijst";
        }
      }, 0);
    });
  } else {
    werkAuthBij(null);
  }
})();
