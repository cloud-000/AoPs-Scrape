# Syncing to the cloud from the db

Note to AI: Do NOT execute unless explictly stated so. Never execute this.

# 0. (If duplicates changed) refresh links, then rebuild before exporting

Duplicate problems (alias -> canonical) are authored in SQLite and carried to the
cloud via each problem's canonical_sync_key. Refresh them before exporting:
`bun cli/index.js link-duplicates` # ingest comp-OCR duplicates.json
`bun cli/index.js preprocess` # resolve wiki redirects + normalize link chains
`bun cli/index.js build` # propagate canonical content + canonical_test_id/n

# 1. Generate sync-export file

`bun cli/index.js sync-export scrape_data/staging_load.sql`

# 2. Execute SQL

Get the ClOUD_DB_URL from the problem-cloud project .env
`psql "$DB_URL" -f scrape_data/staging_load.sql`

# 3. Dry-run first — reports inserted/updated/unmatched, changes nothing

`psql "$DB_URL" -c "select * from public.sync_scraped_content(true);"`

# 4. If the counts look right, apply for real

`psql "$DB_URL" -c "select * from public.sync_scraped_content(false);"`

# 5. Review anything the scrape no longer covers (removed/renumbered upstream)

`psql "$DB_URL" -c "select * from public.sync_unmatched_problems();"`

# 5b. (One-time, first sync that introduces duplicates) migrate existing user data

The sync above populates problems.canonical_id. Run this ONCE afterward to move any
pre-existing user history (submissions, progress, ratings) from alias problems onto
their canonicals so it is shared. Idempotent; service_role/postgres only.
`psql "$DB_URL" -c "select * from public.canonicalize_existing_user_data();"`

# 6. (Optional) Seed starting ratings from the difficulty policy

Gives cold problems a difficulty-aware starting rating instead of the flat 1500.
The policy lives in rating_policy.js. Idempotent + safe to re-run: the default
mode only seeds untouched rows (attempts = 0 AND rating = 1500). Add
--overwrite-seeds to re-tune every matched problem (also resets rd to 350 on any
rating that changes). Run this AFTER a sync so the sync_key join resolves.

`bun cli/index.js seed-ratings-export scrape_data/seed_ratings.sql`

`psql "$DB_URL" -f scrape_data/seed_ratings.sql`

Note: a later public.recompute_ratings() flattens unplayed problems back to 1500;
re-run this file afterward if needed.
