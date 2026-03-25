-- Migration 008: Add status tracking columns to page_hashes
-- Allows per-page progress tracking and reprocessing of failed pages

ALTER TABLE page_hashes
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS ocr_text TEXT,
  ADD COLUMN IF NOT EXISTS analysis JSONB,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_page_hashes_scan_status
  ON page_hashes(scan_id, status);
