-- ============================================================================
-- 004 — Originele publicatiegeometrie (vlak/lijn) voor geselecteerde klassen.
-- Toegepast op 11 november 2026 via de Supabase-migratie `vormen_geom`.
--
-- geom_vorm : vlak- en lijndelen van de gebiedsmarkering uit de SRU-metadata
--             (EPSG:4326, ca. 1 m vereenvoudigd in RD New, 6 decimalen).
--             Alleen gevuld voor klassen in config/vormen.json (standaard: hoog).
-- vorm_type : 'vlak', 'lijn', 'vlak+lijn' of 'punt' (alleen punt/adres in de
--             metadata, dus geen vorm). NULL = nog niet bepaald.
-- De kaartview krijgt vorm_type en vorm_geojson erbij (achteraan, zodat
-- CREATE OR REPLACE VIEW werkt).
-- ============================================================================
ALTER TABLE public.bekendmakingen
  ADD COLUMN IF NOT EXISTS geom_vorm extensions.geometry(Geometry, 4326),
  ADD COLUMN IF NOT EXISTS vorm_type text;

CREATE INDEX IF NOT EXISTS bekendmakingen_geom_vorm_gix ON public.bekendmakingen USING gist (geom_vorm);

CREATE OR REPLACE VIEW public.meldingen_kaart WITH (security_invoker = true) AS
SELECT kenmerk, datum, inschatting, relevantie_score, bron, type, titel, locatie,
       toelichting, waarom, ontbreekt, url, uitgever, geom,
       extensions.ST_AsGeoJSON(geom)::json AS geojson,
       binnen_buffer_100m, afstand_tot_asset_m, first_seen, last_seen,
       vorm_type,
       extensions.ST_AsGeoJSON(geom_vorm, 6)::json AS vorm_geojson
FROM public.bekendmakingen;

GRANT SELECT ON public.meldingen_kaart TO anon, authenticated;
