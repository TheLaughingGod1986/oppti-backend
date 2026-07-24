-- Attribute shared-wallet usage to the plugin that spent it.
--
-- 20260608120000_add_title_meta_generation.sql added `feature_type` to the
-- shared ledger tables with DEFAULT 'alt_text', but the functions that write
-- those rows -- bbai_reserve_site_generation and bbai_finalize_site_generation
-- -- never set the column. The backend does send the value: titleQuota.js puts
-- feature_type='title_meta' into the request metadata, which the RPCs store
-- faithfully in `metadata` jsonb. Nothing ever copied it across, so every row
-- from either plugin silently took the default.
--
-- Result before this migration: 100% of generation_requests and usage_events
-- were labelled 'alt_text', including every title/meta generation. Credit
-- arithmetic was unaffected (site_quotas.used_credits is correct and no site
-- was mischarged) -- only per-feature attribution was wrong, which is what the
-- per-plugin usage breakdown reads.
--
-- Fix: a BEFORE INSERT trigger copies the value out of `metadata` when it is
-- present and recognised. This deliberately does NOT touch the two reservation
-- functions -- they are billing-critical and ~14KB combined, and the data they
-- already write is sufficient. The alt-text path sends no feature_type, so it
-- keeps falling through to the 'alt_text' default and its behaviour is
-- unchanged.

-- 1. Trigger function -- copy a recognised feature_type out of the metadata.
--    Unrecognised or absent values leave the column default in place, so a junk
--    metadata value can never violate the generation_requests CHECK constraint.
CREATE OR REPLACE FUNCTION public.bbai_sync_feature_type_from_metadata()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	meta_feature text;
BEGIN
	meta_feature := NEW.metadata->>'feature_type';

	IF meta_feature IN ('alt_text', 'title_meta') THEN
		NEW.feature_type := meta_feature;
	END IF;

	RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.bbai_sync_feature_type_from_metadata() IS
	'Copies a recognised feature_type from metadata jsonb into the typed column on insert. Keeps shared-wallet usage attributable per plugin without modifying the reservation RPCs.';

-- 2. Attach to both shared ledger tables. INSERT only: rows are always created
--    with their metadata already populated, so there is no update path to sync,
--    and an UPDATE trigger could overwrite a deliberately corrected value.
DROP TRIGGER IF EXISTS trg_generation_requests_sync_feature_type ON public.generation_requests;
CREATE TRIGGER trg_generation_requests_sync_feature_type
	BEFORE INSERT ON public.generation_requests
	FOR EACH ROW
	EXECUTE FUNCTION public.bbai_sync_feature_type_from_metadata();

DROP TRIGGER IF EXISTS trg_usage_events_sync_feature_type ON public.usage_events;
CREATE TRIGGER trg_usage_events_sync_feature_type
	BEFORE INSERT ON public.usage_events
	FOR EACH ROW
	EXECUTE FUNCTION public.bbai_sync_feature_type_from_metadata();

-- 3. Backfill. The correct value is already recorded in metadata on every
--    affected row, so this is an exact correction rather than an inference.
--    Restricted to recognised values and to rows that actually disagree.
UPDATE public.generation_requests
SET feature_type = metadata->>'feature_type'
WHERE metadata->>'feature_type' IN ('alt_text', 'title_meta')
	AND metadata->>'feature_type' <> feature_type;

UPDATE public.usage_events
SET feature_type = metadata->>'feature_type'
WHERE metadata->>'feature_type' IN ('alt_text', 'title_meta')
	AND metadata->>'feature_type' <> feature_type;
