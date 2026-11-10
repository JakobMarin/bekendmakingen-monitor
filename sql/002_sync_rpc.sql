-- ============================================================================
-- NIEUW — NOG TOE TE PASSEN (eenmalig, Supabase SQL Editor of via de bot).
-- Nodig voor de GitHub Action.
--
-- 1) Snellere private.refresh_buffer_matches(): zelfde uitkomst (afstand in
--    EPSG:28992, binnen_buffer_100m = afstand <= 100, NULL zonder assets of punt),
--    maar met de GiST-index op assets.geom. De oorspronkelijke versie rekent elke
--    bekendmaking tegen elk asset (ST_Transform per paar) en liep bij 1.435
--    meldingen x 1.012 circuits in een time-out.
-- 2) public.sync_refresh_buffer_matches(): wrapper die ALLEEN de service_role via
--    de REST-API mag aanroepen (schema `private` is niet via REST bereikbaar).
-- ============================================================================
CREATE OR REPLACE FUNCTION private.refresh_buffer_matches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assets) THEN
    UPDATE public.bekendmakingen SET afstand_tot_asset_m = NULL, binnen_buffer_100m = NULL;
    RETURN;
  END IF;

  UPDATE public.bekendmakingen b
  SET afstand_tot_asset_m = d.min_dist,
      binnen_buffer_100m  = (d.min_dist IS NOT NULL AND d.min_dist <= 100)
  FROM (
    SELECT b2.kenmerk,
           COALESCE(
             -- exact, index-gestuurd: assets binnen ~170 m bbox (0.0025 graad)
             (SELECT min(ST_Distance(ST_Transform(b2.geom, 28992), ST_Transform(a.geom, 28992)))
                FROM public.assets a
               WHERE a.geom && ST_Expand(b2.geom, 0.0025)),
             -- verder weg: afstand tot de 10 dichtstbijzijnde (KNN) assets
             (SELECT min(ST_Distance(ST_Transform(b2.geom, 28992), ST_Transform(k.geom, 28992)))
                FROM (SELECT a.geom FROM public.assets a ORDER BY a.geom <-> b2.geom LIMIT 10) k)
           ) AS min_dist
    FROM public.bekendmakingen b2
    WHERE b2.geom IS NOT NULL
  ) d
  WHERE b.kenmerk = d.kenmerk;

  UPDATE public.bekendmakingen SET afstand_tot_asset_m = NULL, binnen_buffer_100m = NULL
  WHERE geom IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.refresh_buffer_matches() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_buffer_matches() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_refresh_buffer_matches()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '120s'
AS $$ SELECT private.refresh_buffer_matches(); $$;

REVOKE ALL ON FUNCTION public.sync_refresh_buffer_matches() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_refresh_buffer_matches() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_refresh_buffer_matches() TO service_role;
