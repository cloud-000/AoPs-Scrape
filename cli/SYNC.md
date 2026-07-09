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

# 6. (Optional) Seed starting ratings from the difficulty policy

Gives cold problems a difficulty-aware starting rating instead of the flat 1500.
The policy lives in rating_policy.js. Idempotent + safe to re-run: the default
mode only seeds untouched rows (attempts = 0 AND rating = 1500). Add
--overwrite-seeds to re-tune every matched problem (also resets rd to 350 on any
rating that changes). Run this AFTER a sync so the sync_key join resolves.

bun cli/index.js seed-ratings-export scrape_data/seed_ratings.sql
psql "$CLOUD_DB_URL" -f scrape_data/seed_ratings.sql

Note: a later public.recompute_ratings() flattens unplayed problems back to 1500;
re-run this file afterward if needed.
