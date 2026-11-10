-- ============================================================================
-- DOCUMENTATIE — NIET OPNIEUW TOEPASSEN.
-- Kopie van de migraties die al in Supabase-project bekendmakingen-monitor
-- (ref faooiidlipaaowwjzpah, eu-central-1) staan:
--   20261110192551 enable_postgis_and_core_tables
--   20261110192618 assets_explicit_deny_public
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;   -- PostGIS 3.3.7
CREATE SCHEMA IF NOT EXISTS private;

-- Assets (Stedin-hoogspanningsnet). PRIVÉ: niet via de publieke API leesbaar.
CREATE TABLE public.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  naam text NOT NULL,
  type text,
  geom geometry(Geometry, 4326) NOT NULL,
  bron text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_geom_gix ON public.assets USING gist (geom);

-- Bekendmakingen (publiek leesbaar).
CREATE TABLE public.bekendmakingen (
  kenmerk text PRIMARY KEY,
  datum date,
  inschatting text CHECK (inschatting IN ('hoog', 'middel', 'laag', 'niet relevant')),
  relevantie_score integer,
  bron text, type text, titel text, locatie text,
  toelichting text, waarom text, ontbreekt text,
  url text, uitgever text,
  geom geometry(Point, 4326),
  binnen_buffer_100m boolean,
  afstand_tot_asset_m double precision,
  raw jsonb,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bekendmakingen_geom_gix ON public.bekendmakingen USING gist (geom);
CREATE INDEX bekendmakingen_buffer_idx ON public.bekendmakingen (binnen_buffer_100m);
CREATE INDEX bekendmakingen_datum_idx ON public.bekendmakingen (datum DESC);

-- Afstand tot het dichtstbijzijnde asset in RD New (EPSG:28992); buffer 100 m.
-- Geen assets => buffervelden NULL.
CREATE OR REPLACE FUNCTION private.refresh_buffer_matches()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assets) THEN
    UPDATE public.bekendmakingen SET afstand_tot_asset_m = NULL, binnen_buffer_100m = NULL;
    RETURN;
  END IF;
  UPDATE public.bekendmakingen b
  SET afstand_tot_asset_m = sub.min_dist,
      binnen_buffer_100m = (sub.min_dist IS NOT NULL AND sub.min_dist <= 100)
  FROM (
    SELECT b2.kenmerk,
           MIN(ST_Distance(ST_Transform(b2.geom, 28992), ST_Transform(a.geom, 28992))) AS min_dist
    FROM public.bekendmakingen b2
    JOIN public.assets a ON b2.geom IS NOT NULL AND a.geom IS NOT NULL
    GROUP BY b2.kenmerk
  ) sub
  WHERE b.kenmerk = sub.kenmerk;
  UPDATE public.bekendmakingen SET afstand_tot_asset_m = NULL, binnen_buffer_100m = NULL
  WHERE geom IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.refresh_buffer_matches() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_buffer_matches() FROM anon, authenticated;

-- Kaartview (security_invoker: RLS van de aanroeper geldt).
CREATE VIEW public.meldingen_kaart WITH (security_invoker = true) AS
SELECT kenmerk, datum, inschatting, relevantie_score, bron, type, titel, locatie,
       toelichting, waarom, ontbreekt, url, uitgever, geom,
       ST_AsGeoJSON(geom)::json AS geojson,
       binnen_buffer_100m, afstand_tot_asset_m, first_seen, last_seen
FROM public.bekendmakingen;

-- Row Level Security
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bekendmakingen ENABLE ROW LEVEL SECURITY;
CREATE POLICY bekendmakingen_select_public ON public.bekendmakingen
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY assets_deny_anon_authenticated ON public.assets
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.bekendmakingen TO anon, authenticated;
GRANT SELECT ON public.meldingen_kaart TO anon, authenticated;
REVOKE ALL ON TABLE public.assets FROM anon, authenticated;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
