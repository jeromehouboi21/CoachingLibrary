-- 009_cluster_groups.sql
ALTER TABLE raw_scans
  ADD COLUMN IF NOT EXISTS cluster_groups JSONB;

COMMENT ON COLUMN raw_scans.cluster_groups IS
  'Gespeicherte Clustering-Gruppen für Batch-Folgeaufrufe von process-cluster.
   Wird beim ersten process-cluster Aufruf (startIndex=0) befüllt und von
   Folgeaufrufen gelesen. Verhindert Re-Clustering bei jedem Batch-Aufruf.';
