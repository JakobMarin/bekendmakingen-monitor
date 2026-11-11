-- ============================================================================
-- 005 — Menselijke review (feedbackloop) vanuit het tabblad 'Lijst'.
-- Toegepast op 11 november 2026 via de Supabase-migratie `review_feedback`.
--
-- Beveiliging (site en publishable key zijn openbaar):
--  * private.reviewers  : e-mail-allowlist; niet via de REST-API bereikbaar.
--  * public.is_reviewer(): true als de ingelogde gebruiker (Supabase Auth, magic link)
--    een bevestigd e-mailadres heeft dat in de allowlist staat.
--  * public.feedback    : append-only (geen UPDATE/DELETE via de API). INSERT alleen
--    voor reviewers; reviewer/e-mail/tijd/snapshot worden door een trigger gezet,
--    niet door de client. Lezen van de volledige tabel alleen voor reviewers.
--  * Publiek ziet via public.feedback_status() alleen de laatste status per melding
--    (oordeel, klasse-correctie, datum) — geen reden en geen e-mailadres.
--  * Reviewers zien via de view public.feedback_laatste (security_invoker) ook reden,
--    reviewer-e-mail en tijdstip.
-- Feedback blijft bewaard als een melding later uit public.bekendmakingen verdwijnt
-- (FK ON DELETE SET NULL; kenmerk + snapshot van titel/type/bron/klasse/score blijven).
-- ============================================================================

CREATE TABLE IF NOT EXISTS private.reviewers (
  email    text PRIMARY KEY CHECK (email = lower(email)),
  naam     text,
  added_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.reviewers FROM PUBLIC, anon, authenticated;

INSERT INTO private.reviewers (email, naam) VALUES ('reviewer@example.nl', 'Reviewer')
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_reviewer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN private.reviewers r ON r.email = lower(u.email)
    WHERE u.id = (SELECT auth.uid())
      AND u.email_confirmed_at IS NOT NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_reviewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_reviewer() TO authenticated, service_role;  -- anon: altijd false, dus niet nodig

CREATE TABLE IF NOT EXISTS public.feedback (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bekendmaking_id       text REFERENCES public.bekendmakingen (kenmerk) ON UPDATE CASCADE ON DELETE SET NULL,
  kenmerk               text NOT NULL,
  oordeel               text NOT NULL CHECK (oordeel IN ('relevant', 'niet_relevant', 'twijfel')),
  klasse_correctie      text CHECK (klasse_correctie IN ('hoog', 'middel', 'laag', 'niet relevant')),
  reden                 text CHECK (char_length(reden) <= 2000),
  reviewer              uuid NOT NULL DEFAULT auth.uid(),
  reviewer_email        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- snapshot op het moment van beoordelen (voor de feedbackloop van classify.py)
  titel                 text,
  type                  text,
  bron                  text,
  uitgever              text,
  inschatting_origineel text,
  score_origineel       integer
);
CREATE INDEX IF NOT EXISTS feedback_kenmerk_created_idx ON public.feedback (kenmerk, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_bekendmaking_id_idx ON public.feedback (bekendmaking_id);

-- Trigger: server zet identiteit, tijd en snapshot; client kan die niet vervalsen.
CREATE OR REPLACE FUNCTION private.feedback_vul()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE b public.bekendmakingen%ROWTYPE;
BEGIN
  IF NEW.bekendmaking_id IS NULL THEN
    RAISE EXCEPTION 'bekendmaking_id is verplicht';
  END IF;
  SELECT * INTO b FROM public.bekendmakingen WHERE kenmerk = NEW.bekendmaking_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onbekende bekendmaking %', NEW.bekendmaking_id;
  END IF;
  NEW.kenmerk := NEW.bekendmaking_id;
  NEW.reviewer := (SELECT auth.uid());
  NEW.reviewer_email := (SELECT lower(u.email) FROM auth.users u WHERE u.id = NEW.reviewer);
  NEW.created_at := now();
  NEW.reden := NULLIF(btrim(NEW.reden), '');
  NEW.titel := b.titel; NEW.type := b.type; NEW.bron := b.bron; NEW.uitgever := b.uitgever;
  NEW.inschatting_origineel := b.inschatting; NEW.score_origineel := b.relevantie_score;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.feedback_vul() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS feedback_vul ON public.feedback;
CREATE TRIGGER feedback_vul BEFORE INSERT ON public.feedback
  FOR EACH ROW EXECUTE FUNCTION private.feedback_vul();

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.feedback TO authenticated;
GRANT ALL ON public.feedback TO service_role;

DROP POLICY IF EXISTS feedback_insert_reviewers ON public.feedback;
CREATE POLICY feedback_insert_reviewers ON public.feedback
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_reviewer()) AND reviewer = (SELECT auth.uid()));
DROP POLICY IF EXISTS feedback_select_reviewers ON public.feedback;
CREATE POLICY feedback_select_reviewers ON public.feedback
  FOR SELECT TO authenticated
  USING ((SELECT public.is_reviewer()));

-- Laatste oordeel per melding, volledig (alleen zichtbaar voor reviewers via RLS).
CREATE OR REPLACE VIEW public.feedback_laatste WITH (security_invoker = true) AS
SELECT DISTINCT ON (kenmerk)
       kenmerk, oordeel, klasse_correctie, reden, reviewer_email, created_at, id
FROM public.feedback
ORDER BY kenmerk, created_at DESC, id DESC;
REVOKE ALL ON public.feedback_laatste FROM PUBLIC, anon;
GRANT SELECT ON public.feedback_laatste TO authenticated, service_role;

-- Publieke status: alleen oordeel, correctie en datum (geen reden, geen e-mail).
CREATE OR REPLACE FUNCTION public.feedback_status()
RETURNS TABLE (kenmerk text, oordeel text, klasse_correctie text, beoordeeld_op timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT ON (f.kenmerk) f.kenmerk, f.oordeel, f.klasse_correctie, f.created_at
  FROM public.feedback f
  ORDER BY f.kenmerk, f.created_at DESC, f.id DESC;
$$;
REVOKE ALL ON FUNCTION public.feedback_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feedback_status() TO anon, authenticated, service_role;

-- Reviewer toevoegen (alleen via SQL Editor / service role):
--   INSERT INTO private.reviewers (email, naam) VALUES (lower('naam@example.nl'), 'Naam')
--   ON CONFLICT (email) DO NOTHING;
-- Reviewer verwijderen:
--   DELETE FROM private.reviewers WHERE email = lower('naam@example.nl');

-- Extra hardening (migratie `review_hardening_grants`): de publieke rollen hebben op
-- bekendmakingen alleen leesrechten nodig. RLS blokkeerde schrijven al (0 rijen), maar
-- zonder deze grants geeft de API meteen 'permission denied'.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.bekendmakingen FROM anon, authenticated;
