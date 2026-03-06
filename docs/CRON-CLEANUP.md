# Database Cleanup Cron

The backend exposes `POST /admin/cleanup` to prune old data. Call it from a cron job.

## Endpoint

```
POST /admin/cleanup
X-Admin-Key: <ADMIN_KEY or flush-cache-2026>
```

## What it does

- **dashboard_sessions**: Deletes rows where `expires_at` is older than 7 days
- **debug_logs**: Deletes rows where `created_at` is older than 90 days

## Cron setup

### Render (or similar)

Add a cron job that runs daily:

```bash
curl -X POST https://your-api.onrender.com/admin/cleanup \
  -H "X-Admin-Key: $ADMIN_KEY"
```

### GitHub Actions

```yaml
- name: DB cleanup
  run: |
    curl -s -X POST ${{ secrets.API_URL }}/admin/cleanup \
      -H "X-Admin-Key: ${{ secrets.ADMIN_KEY }}"
```

### Local cron

```cron
0 3 * * * curl -s -X POST https://your-api.example.com/admin/cleanup -H "X-Admin-Key: YOUR_KEY"
```

## Response

```json
{
  "success": true,
  "sessionsDeleted": 42,
  "logsDeleted": 150
}
```
