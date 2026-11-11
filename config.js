// Publieke configuratie voor de website.
// De publishable key is bewust openbaar (net als een anon key): Row Level Security
// in Supabase laat alleen lezen van public.bekendmakingen / meldingen_kaart toe.
// De tabel public.assets is voor deze key volledig afgeschermd.
// Zet hier NOOIT een service_role key of databasewachtwoord.
window.MONITOR_CONFIG = {
  supabaseUrl: "https://faooiidlipaaowwjzpah.supabase.co",
  publishableKey: "sb_publishable_C15GEqOsfbvpUnuajdAYPQ_Vp3BZQUL",
  view: "meldingen_kaart",
  // Terugval als de API niet bereikbaar is: de dagelijks geëxporteerde GeoJSON.
  fallbackGeojson: "data/meldingen.geojson",
  bufferMeters: 100,
  // Klassen die (als de publicatie een vlak/lijn heeft) als vorm i.p.v. stip worden getekend.
  // Houd gelijk aan config/vormen.json (die bepaalt voor welke klassen de vorm wordt opgeslagen).
  vormKlassen: ["hoog"],
  // Terugval voor de vormen als de API niet bereikbaar is.
  fallbackVormen: "data/meldingen_vormen.geojson",
  // Vorm pas tekenen als hij op het scherm minstens zo groot is (pixels); anders een stip.
  vormMinPixels: 14
};
