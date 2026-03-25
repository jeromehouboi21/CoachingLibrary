-- Seiten-Fingerprints für Duplikaterkennung (SHA-256 pro PNG)
CREATE TABLE page_hashes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hash        TEXT NOT NULL UNIQUE,   -- SHA-256 des PNG-Inhalts
  scan_id     UUID REFERENCES raw_scans(id) ON DELETE CASCADE,
  doc_id      UUID REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  page_number INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Index für schnelle Hash-Lookups
CREATE INDEX idx_page_hashes_hash ON page_hashes(hash);

-- RLS (konsistent mit den anderen Tabellen: auth_only)
ALTER TABLE page_hashes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_only" ON page_hashes FOR ALL USING (auth.uid() IS NOT NULL);
