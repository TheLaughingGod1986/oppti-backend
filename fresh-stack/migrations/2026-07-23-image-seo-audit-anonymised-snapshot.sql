-- Anonymised public snapshot for State of WordPress Image SEO.
-- Never returns emails, URLs, domains, or page-level samples.
-- Applied remotely via Supabase MCP (2026-07-23); kept here for repo history.

CREATE OR REPLACE FUNCTION public.image_seo_audit_anonymised_snapshot(
  publish_threshold integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold integer := GREATEST(COALESCE(publish_threshold, 25), 1);
  v_sample_size integer := 0;
  v_as_of timestamptz;
  v_avg_score numeric;
  v_avg_missing numeric;
  v_avg_weak numeric;
  v_avg_coverage numeric;
  v_avg_quality numeric;
  v_top_issues jsonb := '[]'::jsonb;
  v_published boolean := false;
BEGIN
  WITH eligible AS (
    SELECT DISTINCT ON (normalized_domain)
      score,
      images_scanned,
      summary_json,
      completed_at
    FROM public.image_seo_audit_requests
    WHERE status = 'completed'
      AND images_scanned > 0
      AND COALESCE(summary_json->>'crawlStatus', '') = 'ok'
    ORDER BY normalized_domain, completed_at DESC NULLS LAST
  )
  SELECT
    count(*)::integer,
    max(completed_at),
    avg(score),
    avg(NULLIF(summary_json->>'missingAltPercent', '')::numeric),
    avg(
      CASE
        WHEN images_scanned > 0 THEN ((NULLIF(summary_json->>'weakAltCount', '')::numeric) / images_scanned) * 100
        ELSE NULL
      END
    ),
    avg(NULLIF(summary_json->>'coverageScore', '')::numeric),
    avg(NULLIF(summary_json->>'averageQuality', '')::numeric)
  INTO
    v_sample_size,
    v_as_of,
    v_avg_score,
    v_avg_missing,
    v_avg_weak,
    v_avg_coverage,
    v_avg_quality
  FROM eligible;

  v_sample_size := COALESCE(v_sample_size, 0);
  v_published := v_sample_size >= v_threshold;

  IF v_published THEN
    WITH eligible AS (
      SELECT DISTINCT ON (normalized_domain)
        summary_json
      FROM public.image_seo_audit_requests
      WHERE status = 'completed'
        AND images_scanned > 0
        AND COALESCE(summary_json->>'crawlStatus', '') = 'ok'
      ORDER BY normalized_domain, completed_at DESC NULLS LAST
    ),
    issues AS (
      SELECT
        x.issue,
        sum(x.count)::bigint AS total
      FROM eligible e
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(e.summary_json->'topIssues', '[]'::jsonb))
        AS x(issue text, count integer)
      WHERE x.issue IS NOT NULL AND length(trim(x.issue)) > 0
      GROUP BY x.issue
      ORDER BY total DESC
      LIMIT 5
    ),
    issue_sum AS (
      SELECT GREATEST(sum(total), 1)::numeric AS denom FROM issues
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'issue', i.issue,
          'sharePercent', round((i.total / s.denom) * 100)::integer
        )
        ORDER BY i.total DESC
      ),
      '[]'::jsonb
    )
    INTO v_top_issues
    FROM issues i
    CROSS JOIN issue_sum s;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_published THEN 'published' ELSE 'collecting' END,
    'publishThreshold', v_threshold,
    'eligibleSampleSize', v_sample_size,
    'sampleSize', CASE WHEN v_published THEN v_sample_size ELSE NULL END,
    'asOf', CASE WHEN v_as_of IS NULL THEN NULL ELSE to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD') END,
    'metrics', CASE
      WHEN v_published THEN jsonb_build_object(
        'avgScore', round(COALESCE(v_avg_score, 0))::integer,
        'avgMissingAltPercent', round(COALESCE(v_avg_missing, 0))::integer,
        'avgWeakAltPercent', round(COALESCE(v_avg_weak, 0))::integer,
        'avgCoverageScore', round(COALESCE(v_avg_coverage, 0))::integer,
        'avgQualityScore', round(COALESCE(v_avg_quality, 0))::integer
      )
      ELSE NULL
    END,
    'topIssues', CASE WHEN v_published THEN COALESCE(v_top_issues, '[]'::jsonb) ELSE NULL END,
    'note', CASE
      WHEN v_published THEN
        'Anonymised averages across distinct sites from OpptiAI free public-page audits. Domains, emails, and page URLs are never published.'
      ELSE
        'Collecting anonymised free-audit samples. Metrics publish after ' || v_threshold::text ||
        ' distinct sites with successful image crawls (currently ' || v_sample_size::text || ').'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.image_seo_audit_anonymised_snapshot(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.image_seo_audit_anonymised_snapshot(integer) TO service_role;

COMMENT ON FUNCTION public.image_seo_audit_anonymised_snapshot(integer) IS
  'Returns anonymised free image SEO audit aggregates for the public State of report. No PII or URLs.';
