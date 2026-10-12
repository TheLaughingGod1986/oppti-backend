-- Mirror of fresh-stack/migrations/023_add_internal_linking_feature_type.sql
-- Extend generation_requests.feature_type check to include internal_linking.

SET lock_timeout = '5s';
SET statement_timeout = '0';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'generation_requests' AND column_name = 'feature_type'
  ) THEN
    BEGIN
      ALTER TABLE public.generation_requests
        DROP CONSTRAINT IF EXISTS chk_generation_requests_feature;
      ALTER TABLE public.generation_requests
        ADD CONSTRAINT chk_generation_requests_feature
        CHECK (feature_type IN ('alt_text', 'title_meta', 'internal_linking'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END;
$$;
