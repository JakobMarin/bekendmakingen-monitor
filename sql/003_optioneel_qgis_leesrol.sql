-- ============================================================================
-- OPTIONEEL — alleen toepassen als je QGIS niet met de postgres-superuser wilt
-- koppelen (aanrader op een gedeelde pc). Maakt een rol die ALLEEN de publieke
-- kaartview mag lezen, niet de assets.
-- Vervang <KIES-EEN-STERK-WACHTWOORD> in de SQL Editor; zet het nooit in de repo.
-- ============================================================================
CREATE ROLE qgis_lezer LOGIN PASSWORD '<KIES-EEN-STERK-WACHTWOORD>';
GRANT USAGE ON SCHEMA public, extensions TO qgis_lezer;
GRANT SELECT ON public.meldingen_kaart, public.bekendmakingen TO qgis_lezer;
-- De view is security_invoker; RLS-policy voor bekendmakingen geldt voor anon/authenticated.
CREATE POLICY bekendmakingen_select_qgis ON public.bekendmakingen FOR SELECT TO qgis_lezer USING (true);
-- Geen rechten op public.assets.
