-- AI Intelligence Extraction System
-- Database initialization script
--
-- This script is executed automatically by PostgreSQL when the container starts.
-- Tables are created by storage.ts initializeDatabase() on first application run.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create index for full-text search on content (applied after tables exist)
-- These are created manually or by the application on first run

-- Grant permissions (if using non-superuser app user)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO aiintel;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aiintel;

-- Verify extensions are installed
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'vector extension not installed';
  END IF;
  RAISE NOTICE 'Database initialized with vector extension';
END $$;
