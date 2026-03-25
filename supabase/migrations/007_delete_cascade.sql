-- Sicherstellen dass doc_sources und notes kaskadierend gelöscht werden
-- wenn ein knowledge_docs Eintrag gelöscht wird.

-- doc_sources
ALTER TABLE doc_sources
  DROP CONSTRAINT IF EXISTS doc_sources_doc_id_fkey,
  ADD CONSTRAINT doc_sources_doc_id_fkey
    FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE;

-- notes
ALTER TABLE notes
  DROP CONSTRAINT IF EXISTS notes_doc_id_fkey,
  ADD CONSTRAINT notes_doc_id_fkey
    FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE;

-- doc_chunks hat ON DELETE CASCADE bereits laut 001_initial.sql ✓
-- page_hashes hat ON DELETE SET NULL bereits laut 006_page_hashes.sql ✓
