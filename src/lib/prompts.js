// ─── Prompt 1: Einzelne Seite analysieren (Claude Haiku) ────────────────────
// Verwendet in: Edge Function analyze-page
export const ANALYZE_PAGE_SYSTEM = `Du verarbeitest eine Seite aus Coaching-Seminarmaterialien (OCR-extrahiert).
Deine Aufgabe: Thema identifizieren und Inhalt vollständig strukturieren.
Kürze nichts. Behalte alle Details, Übungen, Beispiele und Definitionen.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`

export function buildAnalyzePagePrompt(page, text, fileName) {
  return `=== SEITE ${page} (aus: ${fileName}) ===
${text}

JSON-Format:
{
  "topic_key": "snake_case_schlüssel",
  "topic_label": "Lesbarer Titel der Seite",
  "topic_embedding_text": "2-3 präzise Sätze die das Thema beschreiben",
  "content_html": "<h3>...</h3><p>...</p>",
  "key_concepts": ["Begriff1", "Begriff2", "Begriff3"]
}`
}

// ─── Prompt 2: Merge-Entscheidung (Claude Sonnet) ───────────────────────────
// Verwendet in: Edge Function find-merge-candidate
export const FIND_MERGE_CANDIDATE_SYSTEM = `Du entscheidest ob ein neuer Inhalt zu einem bestehenden Wissensdokument gehört oder ein eigenständiges neues Dokument werden soll.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`

export function buildFindMergeCandidatePrompt(topicLabel, keyConcepts, topicEmbeddingText, candidates) {
  const candidateText = candidates
    .map((c, i) => `KANDIDAT ${i + 1} (Similarity: ${c.similarity.toFixed(2)}):\nID: ${c.id}\nTitel: ${c.title}\nZusammenfassung: ${c.summary || '–'}`)
    .join('\n\n')

  return `NEUER INHALT:
Thema: ${topicLabel}
Kernbegriffe: ${keyConcepts.join(', ')}
Beschreibung: ${topicEmbeddingText}

${candidateText}

Entscheide:
{
  "decision": "merge" oder "new",
  "merge_candidate_id": "uuid des gewählten Kandidaten oder null",
  "merge_type": "append" | "deepen" | "duplicate" | null,
  "reasoning": "1 Satz Begründung"
}

Regeln:
- "merge" nur wenn der neue Inhalt DENSELBEN Kernaspekt behandelt
- "append": neuer Inhalt ergänzt das Dokument (z.B. neue Übung zum bekannten Thema)
- "deepen": neuer Inhalt vertieft einen bestehenden Abschnitt
- "duplicate": Inhalt bereits vorhanden → ignorieren
- "new": eigenständiges Thema → neues Dokument`
}

// ─── Prompt 3: In bestehendes Dokument mergen (Claude Sonnet) ───────────────
// Verwendet in: Edge Function merge-into-document
export function buildMergeIntoDocumentSystem(mergeType) {
  return `Du integrierst neuen Inhalt in ein bestehendes Wissensdokument.
Merge-Typ: ${mergeType}

Für "append": Füge den neuen Inhalt als neuen Abschnitt am Ende ein.
Für "deepen": Finde den passenden bestehenden Abschnitt und integriere den neuen Inhalt dort – ohne bestehenden Inhalt zu entfernen.

Kürze und entferne NICHTS aus dem bestehenden Dokument.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`
}

export function buildMergeIntoDocumentPrompt(existingTitle, existingContentHtml, newContentHtml) {
  return `BESTEHENDES DOKUMENT:
Titel: ${existingTitle}
Inhalt: ${existingContentHtml}

NEUER INHALT:
${newContentHtml}

JSON-Format:
{
  "content_html": "vollständiger aktualisierter HTML-Inhalt",
  "tags": ["aktualisierte", "tag", "liste"],
  "summary": "aktualisierte Zusammenfassung (2-3 Sätze)"
}`
}

// ─── Prompt 4: Neues Dokument erstellen (Claude Sonnet) ─────────────────────
// Verwendet in: Edge Function create-document
export const CREATE_DOCUMENT_SYSTEM = `Du erstellst ein Wissensdokument für eine persönliche Coaching-Wissensbibliothek.
Der Inhalt stammt aus Seminarunterlagen einer Systemisches-Coaching-Ausbildung.
Fasse NICHTS zusammen oder kürze NICHTS – integriere den vollständigen Inhalt aller Abschnitte in ein kohärentes, gut strukturiertes Dokument.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`

export function buildCreateDocumentPrompt(pages) {
  const sectionsText = pages
    .map((p, i) => `ABSCHNITT ${i + 1} (Seite ${p.page}):\n${p.content_html}`)
    .join('\n\n')

  return `${sectionsText}

JSON-Format:
{
  "title": "Prägnanter Titel (max. 8 Wörter)",
  "summary": "2-3 Sätze Kerninhalt",
  "category": "EINE aus: [Grundlagen, Methoden, Theorie, Übungen, Kommunikation, Systemtheorie, Aufstellungsarbeit, Selbstreflexion]",
  "subcategory": "Spezifischere Untergruppe",
  "tags": ["tag1", "tag2", "tag3"],
  "difficulty": "EINES aus: [Grundlagen, Fortgeschritten, Experten]",
  "content_html": "vollständiger strukturierter HTML-Inhalt"
}`
}

// ─── Prompt 5: RAG-Chat-Assistent (Claude Sonnet, Streaming) ─────────────────
// Verwendet in: Edge Function chat
export const RAG_SYSTEM_PROMPT = `Du bist ein persönlicher Coaching-Assistent. Du antwortest AUSSCHLIESSLICH auf Basis der dir bereitgestellten Wissensdokumente aus einer systemischen Coaching-Ausbildung.

Regeln:
- Antworte nur basierend auf den bereitgestellten Dokumenten
- Wenn du ein Dokument als Quelle verwendest, markiere es mit [[DOC:uuid]]
- Wenn kein passendes Dokument vorhanden ist, sage das klar
- Sprache: Deutsch, professionell aber zugänglich
- Schlage konkrete Methoden vor, wenn nach Lösungen gefragt wird`
