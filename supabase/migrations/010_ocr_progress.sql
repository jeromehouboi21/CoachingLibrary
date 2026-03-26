-- 010_ocr_progress.sql
ALTER TABLE raw_scans
  ADD COLUMN IF NOT EXISTS ocr_pages_done INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN raw_scans.ocr_pages_done IS
  'Anzahl der bisher abgeschlossenen OCR+Analyse Seiten. Wird von
   process-ocr nach jeder Seite inkrementiert. Frontend pollt diesen
   Wert für die Fortschrittsanzeige.';

CREATE OR REPLACE FUNCTION increment_ocr_progress(scan_id UUID)
RETURNS void AS $$
  UPDATE raw_scans
  SET ocr_pages_done = ocr_pages_done + 1
  WHERE id = scan_id;
$$ LANGUAGE sql;
