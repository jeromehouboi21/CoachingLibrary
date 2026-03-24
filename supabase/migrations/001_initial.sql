-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge documents (the heart of the app)
CREATE TABLE knowledge_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  summary TEXT,
  summary_embedding vector(1536),   -- for merge-candidate search
  category TEXT,
  subcategory TEXT,
  content_html TEXT,
  content_text TEXT,                -- plain text for full-text search
  difficulty TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Text chunks for semantic RAG search (pgvector)
CREATE TABLE doc_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  chunk_index INTEGER,
  content TEXT,
  embedding vector(1536)
);

-- RLS
ALTER TABLE knowledge_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_only" ON knowledge_docs FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_only" ON doc_chunks FOR ALL USING (auth.uid() IS NOT NULL);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_knowledge_docs_updated_at
  BEFORE UPDATE ON knowledge_docs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── RPC: chunk-level RAG search ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_doc_chunks(
  query_embedding vector(1536),
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  doc_id UUID,
  content TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    id,
    doc_id,
    content,
    1 - (embedding <=> query_embedding) AS similarity
  FROM doc_chunks
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ─── RPC: doc-level merge-candidate search ───────────────────────────────────
CREATE OR REPLACE FUNCTION match_knowledge_docs(
  query_embedding vector(1536),
  match_count int DEFAULT 3
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  summary TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    id,
    title,
    summary,
    1 - (summary_embedding <=> query_embedding) AS similarity
  FROM knowledge_docs
  WHERE summary_embedding IS NOT NULL
  ORDER BY summary_embedding <=> query_embedding
  LIMIT match_count;
$$;
