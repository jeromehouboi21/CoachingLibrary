# Coaching Bibliothek – Architektur-Dokumentation

**Produkt:** Coaching Bibliothek · KI-gestützte Wissensdatenbank für systemisches Coaching
**Version:** Design-Dokument v0.1
**Stand:** März 2026

---

## Überblick

Coaching Bibliothek ist eine PWA, in der Nutzer Lernmaterialien (PDFs, Bilder) hochladen können, die automatisch per OCR und KI-Analyse verarbeitet, thematisch geclustert und in einer semantisch durchsuchbaren Wissensdatenbank gespeichert werden. Ein RAG-Chat erlaubt natürlichsprachige Fragen an die eigene Bibliothek. Das System erkennt Duplikate, führt ähnliche Inhalte intelligent zusammen und wächst mit jedem Upload.

```
Nutzer (Browser / PWA)
    │
    ├── React 18 + Vite (src/)
    │       ├── Screens (src/screens/)
    │       ├── Hooks (src/hooks/)
    │       ├── Components (src/components/)
    │       └── Lib (src/lib/)
    │
    └── Supabase
            ├── Auth (JWT)
            ├── Storage (raw-scans Bucket)
            ├── PostgreSQL + pgvector
            └── Edge Functions (Deno / TypeScript)
                    ├── Anthropic Claude API
                    ├── OpenAI Embeddings API
                    └── Google Cloud Vision API
```

---

## System-Komponenten

### Frontend

| Datei / Verzeichnis | Zweck |
|---|---|
| `src/screens/library/LibraryScreen.jsx` | Hauptansicht: Dokumenten-Galerie mit Kategorie-Filter und Suche |
| `src/screens/document/DocumentScreen.jsx` | Dokument-Detailansicht mit Inhalt, Tags, Quellen und Notizen |
| `src/screens/chat/ChatScreen.jsx` | RAG-Chat-Interface mit Streaming und Quellenangaben |
| `src/screens/search/SearchScreen.jsx` | Dual-Suche: Volltext + semantische Vektorsuche |
| `src/screens/methods/MethodsScreen.jsx` | Gefilterter Zugang zu Methoden, Übungen, Aufstellungsarbeit |
| `src/screens/upload/UploadScreen.jsx` | Upload-Pipeline: Drag-and-drop, 4-Phasen-Fortschritt, Ergebnisanzeige |
| `src/screens/processing/ProcessingScreen.jsx` | Pipeline-Historie, Fehler-Monitoring, Wiederverarbeitung |
| `src/screens/admin/AdminScreen.jsx` | Beta-Datenverwaltung: Reset aller Nutzerdaten |
| `src/screens/login/LoginScreen.jsx` | Auth-Gateway: Login + Registrierung |
| `src/hooks/useLibrary.js` | Dokumenten-Listing mit reaktivem Filter und Suche |
| `src/hooks/useChat.js` | RAG-Chat: Streaming-Empfang, Quell-Extraktion aus `[[DOC:uuid]]`-Markern |
| `src/hooks/useNotes.js` | CRUD-Operationen für Dokument-Notizen |
| `src/hooks/useUpload.js` | Upload-Pipeline-Orchestrierung: PDF-Konvertierung, Hashing, OCR, Clustering |
| `src/hooks/useProcessing.js` | Pipeline-Historie, Filterung, Auto-Refresh, Wiederverarbeitung |
| `src/components/Layout.jsx` | App-Shell mit Bottom-Navigation und aktivem Zustand |
| `src/components/SourceCard.jsx` | Quell-Dokument-Karte in Chat-Antworten |
| `src/lib/supabase.js` | Supabase-Client-Instanz |
| `src/lib/pdfToPages.js` | PDF → PNG-Seiten (PDF.js + SHA-256-Hashing via Web Crypto API) |
| `src/lib/prompts.js` | Alle LLM-Prompt-Templates für die Verarbeitungs-Pipeline |

### Backend (Supabase Edge Functions)

| Function | Wann aufgerufen | Was es tut |
|---|---|---|
| `chat` | Jede Nutzer-Nachricht im Chat | Semantische Suche → Kontext aufbauen → Claude Sonnet streamen (SSE) |
| `process-ocr` | Upload-Phase 3 (pro Scan) | Google Vision OCR + `analyze-page` für alle Seiten parallel |
| `analyze-page` | Von `process-ocr` aufgerufen | Haiku-Analyse: topic_key, content_html, key_concepts, Embedding |
| `process-cluster` | Upload-Phase 4 (selbst-orchestrierend) | Seiten clustern → Merge/Neu-Entscheidung → Dokumente erstellen/mergen |
| `find-merge-candidate` | Von `process-cluster` aufgerufen | pgvector-Suche + Sonnet-Entscheidung: merge / new |
| `merge-into-document` | Von `process-cluster` bei Merge-Entscheidung | Neuen Inhalt in bestehendes Dokument integrieren (Sonnet) |
| `create-document` | Von `process-cluster` bei Neu-Entscheidung | Neues Wissensdokument erstellen, chunken, embedden |
| `semantic-search` | SearchScreen (semantischer Modus) | OpenAI-Embedding → pgvector-Suche auf `doc_chunks` |
| `admin-reset` | AdminScreen | Alle Nutzdaten und Storage-Dateien löschen |

---

## Datenflüsse

### 1. Upload-Pipeline (4 Phasen)

```
Nutzer lädt Datei hoch (PDF / PNG / JPEG)
    │
    ├── [Frontend – Phase 1: Konvertierung]
    │       └── PDF → PNG-Seiten via PDF.js (client-seitig)
    │               └── SHA-256-Hash jeder PNG-Seite (Web Crypto API)
    │
    ├── [Frontend – Phase 2: Upload + Deduplication]
    │       ├── Prüfen: Hash bereits in page_hashes?
    │       │       └── Ja → Seite überspringen (Duplikat)
    │       └── Nein → PNG in Supabase Storage hochladen
    │               └── Hash + scan_id in page_hashes speichern
    │
    ├── [Edge Function: process-ocr – Phase 3: OCR & KI-Analyse]
    │       ├── PNG von Storage herunterladen
    │       ├── Google Cloud Vision API (DOCUMENT_TEXT_DETECTION, Sprache: de)
    │       └── [Edge Function: analyze-page] für jede Seite (parallel, pLimit)
    │               ├── Claude Haiku: topic_key, topic_label, content_html, key_concepts
    │               ├── OpenAI Embedding (text-embedding-3-small, 1536 dim)
    │               └── Ergebnis → ocr_results (JSONB) in raw_scans
    │                       + ocr_pages_done (Live-Fortschritt)
    │
    └── [Edge Function: process-cluster – Phase 4: Clustering + Dokumente]
            ├── Seiten nach Embedding-Ähnlichkeit clustern (Schwellwert 0.82)
            ├── cluster_groups in raw_scans speichern
            └── Pro Gruppe (selbst-orchestrierende Batches):
                    ├── Gruppen-Embedding (Durchschnitt der Seiten-Embeddings)
                    ├── [Edge Function: find-merge-candidate]
                    │       ├── pgvector: match_knowledge_docs RPC
                    │       └── Claude Sonnet: merge / new + merge_type
                    │
                    ├── Entscheidung: merge
                    │       └── [Edge Function: merge-into-document]
                    │               └── Claude Sonnet: Inhalt integrieren → knowledge_docs.content_html updaten
                    │
                    └── Entscheidung: new
                            └── [Edge Function: create-document]
                                    ├── Claude Sonnet: title, summary, category, tags, difficulty, content_html
                                    ├── OpenAI Embedding → knowledge_docs.summary_embedding
                                    ├── Inhalt in doc_chunks aufteilen + embedden
                                    └── doc_sources + page_hashes.doc_id verknüpfen
```

### 2. RAG-Chat

```
Nutzer schreibt Nachricht
    │
    └── [Frontend] useChat.sendMessage()
            ├── Nachricht in UI + messages-Array einfügen
            └── POST /functions/v1/chat
                    ├── Header: Authorization Bearer JWT
                    └── Body: { messages (letzte 10), query, sessionId }

    [Edge Function: chat]
            ├── JWT validieren
            ├── OpenAI Embedding für Query
            ├── pgvector: match_doc_chunks RPC (cosine similarity)
            │       Fallback: ILIKE Volltext-Suche (wenn kein OpenAI-Key)
            ├── Kontext-String aufbauen mit [[DOC:uuid]]-Markern
            └── Claude Sonnet stream (SSE)
                    └── RAG_SYSTEM_PROMPT + Kontext + Gesprächsverlauf

    [Frontend] SSE-Stream empfangen
            ├── Token für Token in UI einblenden
            ├── [[DOC:uuid]]-Marker aus Antwort extrahieren
            └── Quell-Dokument-Metadaten laden → SourceCards anzeigen
```

### 3. Semantische Suche

```
Nutzer gibt Suchbegriff ein (SearchScreen, semantischer Modus)
    │
    └── POST /functions/v1/semantic-search
            ├── OpenAI Embedding für Suchbegriff
            ├── pgvector: match_doc_chunks RPC
            ├── knowledge_docs-Metadaten nachladen
            └── Ergebnis nach Ähnlichkeit sortiert + optional nach Kategorie gefiltert
```

### 4. Wiederverarbeitung (ProcessingScreen)

```
Nutzer klickt "Erneut verarbeiten" für einen Scan
    │
    ├── POST /functions/v1/process-ocr (falls OCR fehlgeschlagen)
    └── POST /functions/v1/process-cluster (falls Clustering fehlgeschlagen)
            └── Frontend Auto-Refresh alle 3 Sekunden solange status = 'processing'
```

---

## Datenbankschema

### Kern-Tabellen

```
knowledge_docs – Wissensdokumente (Kerntabelle)
├── id (UUID)
├── title
├── summary
├── summary_embedding (vector(1536)) → für Merge-Kandidaten-Suche
├── category ('Grundlagen' | 'Methoden' | 'Theorie' | 'Übungen' |
│            'Kommunikation' | 'Systemtheorie' | 'Aufstellungsarbeit' | 'Selbstreflexion')
├── subcategory
├── content_html
├── content_text (Klartext für Volltextsuche)
├── difficulty ('Grundlagen' | 'Fortgeschritten' | 'Experten')
├── tags (TEXT[])
├── created_at / updated_at (TIMESTAMPTZ)

doc_chunks – Semantischer Suchindex
├── id (UUID)
├── doc_id (FK → knowledge_docs) ON DELETE CASCADE
├── chunk_index
├── content
├── embedding (vector(1536)) → pgvector cosine similarity

raw_scans – Upload-Pipeline-Zustand
├── id (UUID)
├── filename / storage_path
├── status ('pending' | 'processing' | 'processed' | 'error')
├── page_count
├── ocr_results (JSONB) → Array aus AnalyzedPage-Objekten
├── ocr_pages_done (INTEGER) → Live-Fortschrittszähler
├── cluster_groups (JSONB) → gespeicherte PageGroup[] für Batch-Verarbeitung
├── pipeline_results (JSONB) → [{ status, topic_label, doc_id, error_message }]
├── error_message
├── upload_date (TIMESTAMPTZ)

doc_sources – Herkunfts-Tracking
├── id (UUID)
├── doc_id (FK → knowledge_docs) ON DELETE CASCADE
├── scan_id (FK → raw_scans) ON DELETE CASCADE
├── filename
├── pages (INTEGER[]) → Seitennummern aus diesem Scan

page_hashes – Duplikaterkennung
├── id (UUID)
├── hash (TEXT UNIQUE) → SHA-256 der PNG-Seite
├── scan_id (FK → raw_scans) ON DELETE CASCADE
├── doc_id (FK → knowledge_docs) ON DELETE SET NULL
├── page_number
├── status ('uploaded' | 'processing' | 'ocr_complete' | 'processed' | 'error')
├── ocr_text / analysis (JSONB) / error_message
├── created_at (TIMESTAMPTZ)
    INDEX: idx_page_hashes_hash, idx_page_hashes_scan_status

notes – Nutzer-Annotationen zu Dokumenten
├── id (UUID)
├── doc_id (FK → knowledge_docs) ON DELETE CASCADE
├── content / position_hint
├── created_at / updated_at (TIMESTAMPTZ)
```

### Chat-Tabellen

```
chat_sessions
├── id (UUID)
├── title
├── created_at (TIMESTAMPTZ)

chat_messages
├── id (UUID)
├── session_id (FK → chat_sessions) ON DELETE CASCADE
├── role ('user' | 'assistant')
├── content
├── sources (JSONB[])
├── created_at (TIMESTAMPTZ)
```

### RPC-Funktionen (pgvector)

```
match_doc_chunks(query_embedding, match_count)
    → cosine similarity auf doc_chunks.embedding

match_knowledge_docs(query_embedding, match_count)
    → cosine similarity auf knowledge_docs.summary_embedding
```

> **RLS:** Alle Tabellen haben Row Level Security (`auth.uid() IS NOT NULL`). Nutzer sehen ausschließlich ihre eigenen Daten.

---

## Migrationen

| Datei | Inhalt |
|---|---|
| `001_initial.sql` | knowledge_docs, doc_chunks, pgvector-Funktionen, RLS |
| `002_sources.sql` | raw_scans, doc_sources, RLS-Policies |
| `003_content.sql` | notes, Trigger |
| `004_chat.sql` | chat_sessions, chat_messages |
| `005_pipeline_split.sql` | raw_scans.ocr_results-Spalte |
| `006_page_hashes.sql` | page_hashes (Duplikat-Erkennung) |
| `007_delete_cascade.sql` | ON DELETE CASCADE für alle FK-Beziehungen |
| `008_page_status.sql` | Status-Tracking auf page_hashes |
| `009_cluster_groups.sql` | raw_scans.cluster_groups-Spalte |
| `010_ocr_progress.sql` | raw_scans.ocr_pages_done-Spalte (Live-Fortschritt) |

Deployment: `supabase db push` (lokal) oder Migration-Datei im Supabase Dashboard ausführen.

---

## Prompt-Architektur

Alle LLM-Prompts sind zentral in `src/lib/prompts.js` definiert und werden sowohl im Frontend als auch in den Edge Functions referenziert.

```
ANALYZE_PAGE_SYSTEM + buildAnalyzePagePrompt
    → Claude Haiku (pro Seite)
    → Extraktion: topic_key, topic_label, topic_embedding_text, content_html, key_concepts

FIND_MERGE_CANDIDATE_SYSTEM + buildFindMergeCandidatePrompt
    → Claude Sonnet (pro Cluster-Gruppe)
    → Entscheidung: merge (append | deepen | duplicate) / new + reasoning

buildMergeIntoDocumentSystem + buildMergeIntoDocumentPrompt
    → Claude Sonnet (bei Merge)
    → Integration: neues HTML in bestehendes Dokument einarbeiten

CREATE_DOCUMENT_SYSTEM + buildCreateDocumentPrompt
    → Claude Sonnet (bei Neu-Erstellung)
    → Generierung: title, summary, category, subcategory, tags, difficulty, content_html

RAG_SYSTEM_PROMPT
    → Claude Sonnet (Chat)
    → Regeln: nur aus Kontext antworten, [[DOC:uuid]]-Marker verwenden
```

---

## Streaming (SSE)

Alle Chat-Antworten kommen token-by-token über Server-Sent Events:

```
POST /functions/v1/chat
    → Response: text/event-stream

Frontend liest:
    data: {"text": "Systemisches"}
    data: {"text": " Coaching"}
    data: [DONE]

useChat: Token für Token in setMessages() einbauen
    → UI aktualisiert sich nach jedem Token
    → [[DOC:uuid]]-Marker werden nach Stream-Ende extrahiert
```

---

## Freemium-Logik

Aktuell kein Freemium-Gating implementiert. Das System ist für Single-User-Betrieb ausgelegt (alle Daten gehören dem angemeldeten Nutzer). Die RLS-Architektur ist multi-user-fähig.

---

## KI-Modelle im Überblick

| Modell | Verwendung | Grund |
|---|---|---|
| `claude-haiku-4-5` | Seitenanalyse (`analyze-page`) | Schnell + günstig für repetitive Seiten-Extraktion |
| `claude-sonnet-4-6` | Merge-Entscheidung, Dokument-Erstellung, Chat | Hohe Qualität für komplexe Reasoning-Aufgaben |
| `text-embedding-3-small` (OpenAI) | Alle Embeddings (Seiten, Dokumente, Chunks, Queries) | 1536 dim, pgvector-kompatibel |
| Google Cloud Vision | OCR aller Scan-Seiten | Beste Erkennungsqualität für deutsche Texte |

---

## Design System

**Farb-Tokens (CSS Custom Properties):**

| Token | Wert | Verwendung |
|---|---|---|
| `--color-bg` | `#F5F3EF` | Haupthintergrund |
| `--color-surface` | `#FFFFFF` | Cards, Modals |
| `--color-accent` | `#2D5A4E` | Brand-Grün, primäre Buttons |
| `--color-accent-2` | `#4A8C7A` | Hover-Zustand |
| `--color-accent-light` | `#E8F0EE` | Hintergrund-Tints |
| `--color-ink` | `#1A1916` | Haupttext |
| `--color-ink-2` | `#5C5A54` | Sekundärtext |
| `--color-ink-3` | `#9A9890` | Tertiärtext, Platzhalter |

**Spacing & Sizing:**

| Token | Wert |
|---|---|
| `--nav-height` | `72px` |
| `--header-height` | `60px` |
| `--max-width` | `640px` |
| `--radius-sm / md / lg / xl` | `8px / 12px / 16px / 24px` |

**Typografie:** DM Serif Display (Headlines) · DM Sans (Body)
**Viewport:** Mobile-first, optimiert für 390px, max-width 640px.

---

## Umgebungsvariablen

```bash
# .env.local (Frontend, Vite)
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...

# Supabase Edge Functions (Secrets, nur serverseitig)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...                  # für pgvector Embeddings + semantische Suche
GOOGLE_CLIENT_EMAIL=...@....iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----...
SUPABASE_URL=                          # automatisch verfügbar
SUPABASE_SERVICE_ROLE_KEY=             # automatisch verfügbar
```

---

## Deployment

**Frontend:**
- Build: `npx vite build`
- Hosting: Vercel
- SPA-Rewrite: alle Routen → `index.html` (via `vercel.json`)

**Backend:**
- Edge Functions: `supabase functions deploy`
- Datenbank: `supabase db push`
- Storage: `raw-scans` Bucket (manuell in Supabase Dashboard anlegen)
