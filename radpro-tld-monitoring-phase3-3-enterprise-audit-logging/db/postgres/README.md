# Phase 2 PostgreSQL Migration

This folder contains the Phase 2 migration toolkit for moving Radpro TLD Monitoring from the Phase 1 SQLite/persistent-disk deployment to PostgreSQL.

Recommended target stack:

- Application: Render Web Service / Docker
- Database: Render PostgreSQL, Supabase PostgreSQL, Neon, or AWS RDS PostgreSQL
- File storage: keep `/app/data/uploads` on persistent disk during Phase 2A; move to object storage in Phase 3

## Migration steps

1. Keep the current SQLite app running and take a JSON backup from the software.
2. Create a PostgreSQL database and copy its connection string.
3. Set `DATABASE_URL` locally or in a secure shell.
4. Run:

```bash
npm run pg:create-schema
npm run pg:migrate
npm run pg:verify
```

5. Validate migrated row counts.
6. Keep SQLite as fallback until Phase 2B app adapter is enabled.

This migration kit does not expose the PostgreSQL password in the UI. Keep `DATABASE_URL` in environment variables only.
