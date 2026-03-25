-- Add ocr_results column to store intermediate OCR + Haiku analysis results
-- between process-ocr and process-cluster edge functions

ALTER TABLE raw_scans
  ADD COLUMN IF NOT EXISTS ocr_results JSONB;

COMMENT ON COLUMN raw_scans.ocr_results IS
  'Intermediate storage for OCR + Haiku analysis results between process-ocr and process-cluster. '
  'Contains array of AnalyzedPage objects including embeddings.';

-- Status values: pending → processing → ocr_complete → processed | error
