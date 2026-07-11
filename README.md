# Radpro TLD Personal Monitoring Service — Phase 3.2

PostgreSQL-only production runtime. SQLite fallback and SQLite migration utilities have been removed.

Required environment: `DB_DRIVER=postgres`, Supabase Session Pooler `DATABASE_URL`, `PGSSLMODE=no-verify`, strong `SESSION_SECRET`, `DATA_DIR`, and `UPLOAD_DIR`. The application exits when `DATABASE_URL` is absent. `/app/data` is used only for uploads and generated files.

Commands: `npm install`, `npm run check`, `npm run pg:health`, `npm start`.
