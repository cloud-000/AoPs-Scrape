# Syncing to the cloud from the db

Note to AI: Do NOT execute unless explictly stated so. Never execute this.

# 1. Generate sync-export file

bun cli/index.js sync-export scrape_data/staging_load.sql

# 2. Execute SQL

Get the ClOUD_DB_URL from the problem-cloud project .env
psql "$CLOUD_DB_URL" -f scrape_data/staging_load.sql

# 3. Dry-run first — reports inserted/updated/unmatched, changes nothing

psql "$CLOUD_DB_URL" -c "select * from public.sync_scraped_content(true);"

# 4. If the counts look right, apply for real

psql "$CLOUD_DB_URL" -c "select * from public.sync_scraped_content(false);"

# 5. Review anything the scrape no longer covers (removed/renumbered upstream)

psql "$CLOUD_DB_URL" -c "select * from public.sync_unmatched_problems();"
