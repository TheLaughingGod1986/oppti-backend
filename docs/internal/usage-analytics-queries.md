# Usage Analytics Queries

These queries target `usage_logs` after migration `014_usage_logs_telemetry_refactor.sql`.

## Active users + active sites

```sql
SELECT
  COUNT(DISTINCT user_id)
    FILTER (WHERE user_id IS NOT NULL)
    AS active_authenticated_users,
  COUNT(DISTINCT COALESCE(install_hash, site_hash))
    AS active_sites,
  SUM(credits_used)
    AS total_credits_used,
  COUNT(*)
    AS total_generation_events
FROM usage_logs
WHERE created_at >= NOW() - INTERVAL '7 days';
```

## Daily active sites

```sql
SELECT
  DATE(created_at) AS day,
  COUNT(DISTINCT user_id)
    FILTER (WHERE user_id IS NOT NULL)
    AS active_authenticated_users,
  COUNT(DISTINCT COALESCE(install_hash, site_hash))
    AS active_sites,
  SUM(credits_used)
    AS credits_used,
  COUNT(*)
    AS generation_events
FROM usage_logs
GROUP BY DATE(created_at)
ORDER BY day DESC
LIMIT 30;
```

## Top sites

```sql
SELECT
  COALESCE(domain, site_url, site_hash, install_hash, 'unknown') AS site,
  COUNT(DISTINCT user_id)
    FILTER (WHERE user_id IS NOT NULL)
    AS authenticated_users,
  SUM(credits_used) AS credits_used,
  COUNT(*) AS generation_events,
  MAX(created_at) AS last_activity
FROM usage_logs
GROUP BY COALESCE(domain, site_url, site_hash, install_hash, 'unknown')
ORDER BY credits_used DESC
LIMIT 50;
```

## Trial vs authenticated usage

```sql
SELECT
  COALESCE(
    auth_state,
    CASE
      WHEN user_id IS NULL THEN 'anonymous_or_trial'
      ELSE 'authenticated_unknown'
    END
  ) AS usage_type,
  COUNT(*) AS events,
  SUM(credits_used) AS credits_used,
  COUNT(DISTINCT COALESCE(install_hash, site_hash)) AS sites
FROM usage_logs
GROUP BY usage_type
ORDER BY credits_used DESC;
```

## Returning sites

```sql
SELECT
  COALESCE(domain, site_url, site_hash, install_hash, 'unknown') AS site,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen,
  COUNT(DISTINCT DATE(created_at)) AS active_days,
  SUM(credits_used) AS credits_used,
  COUNT(*) AS generation_events
FROM usage_logs
GROUP BY COALESCE(domain, site_url, site_hash, install_hash, 'unknown')
HAVING COUNT(DISTINCT DATE(created_at)) > 1
ORDER BY active_days DESC, credits_used DESC;
```
