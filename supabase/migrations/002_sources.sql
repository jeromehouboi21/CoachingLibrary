-- Upload raw files and pipeline status
CREATE TABLE raw_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending',      -- pending | processing | processed | error
  page_count INTEGER,
  pipeline_results JSONB,             -- [{ status, topic_label, doc_id }, ...]
  error_message TEXT,
  upload_date TIMESTAMPTZ DEFAULT NOW()
);

-- Source links: which scans contributed to which knowledge doc
CREATE TABLE doc_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES raw_scans(id) ON DELETE CASCADE,
  filename TEXT,
  pages INTEGER[]
);

-- RLS
ALTER TABLE raw_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_only" ON raw_scans FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_only" ON doc_sources FOR ALL USING (auth.uid() IS NOT NULL);

-- Storage bucket (run via Supabase dashboard or CLI):
-- INSERT INTO storage.buckets (id, name, public) VALUES ('raw-scans', 'raw-scans', false);
