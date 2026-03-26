import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.20.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export interface AnalyzedPage {
  page: number
  topic_key: string
  topic_label: string
  topic_embedding_text: string
  content_html: string
  key_concepts: string[]
  embedding?: number[]
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { page, text, fileName } = await req.json() as {
      page: number
      text: string
      fileName: string
    }

    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: `Du verarbeitest eine Seite aus Coaching-Seminarmaterialien (OCR-extrahiert).
Deine Aufgabe: Thema identifizieren und Inhalt vollständig strukturieren.
Kürze nichts. Behalte alle Details, Übungen, Beispiele und Definitionen.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.

WICHTIG für die JSON-Ausgabe:
- Deutsche Anführungszeichen (« » „ " " ‚ ' ') als normale ASCII-Anführungszeichen schreiben: "
- Verwende in content_html nur einfache Anführungszeichen für HTML-Attribute: <p class='x'>
- Keine echten Zeilenumbrüche im JSON-String – Zeilenumbrüche als \\n schreiben
- Die gesamte Antwort muss valides JSON sein das JSON.parse() ohne Fehler besteht`,
      messages: [{
        role: 'user',
        content: `=== SEITE ${page} (aus: ${fileName}) ===
${text}

JSON-Format:
{
  "topic_key": "snake_case_schlüssel",
  "topic_label": "Lesbarer Titel der Seite",
  "topic_embedding_text": "2-3 präzise Sätze die das Thema beschreiben",
  "content_html": "<h3>...</h3><p>...</p>",
  "key_concepts": ["Begriff1", "Begriff2", "Begriff3"]
}`
      }]
    }))

    const rawText = (response.content[0] as { type: string; text: string }).text
    const result: AnalyzedPage = { page, ...parseClaudeJson(rawText) }

    // Generate embedding for topic_embedding_text
    if (Deno.env.get('OPENAI_API_KEY') && result.topic_embedding_text) {
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
        },
        body: JSON.stringify({ input: result.topic_embedding_text, model: 'text-embedding-3-small' }),
      })
      if (embRes.ok) {
        const embData = await embRes.json()
        result.embedding = embData.data?.[0]?.embedding
      }
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 3000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const message = (error as Error).message ?? ''
      const isRateLimit = message.includes('429') || message.includes('rate_limit')

      if (isRateLimit && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(
          `[analyze-page] Rate limit – warte ${delay / 1000}s ` +
          `(Versuch ${attempt + 1}/${maxRetries})`
        )
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      throw error
    }
  }
  throw new Error('withRetry: maximale Versuche erreicht')
}

function parseClaudeJson(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) {
    throw new Error('Claude hat eine leere Antwort zurückgegeben')
  }

  let cleaned = raw
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim()

  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) {
    console.error(
      '[parseClaudeJson] Kein JSON gefunden.',
      `Antwortlänge: ${raw.length}`,
      `Anfang: "${raw.slice(0, 100)}"`
    )
    throw new Error(
      `Kein JSON in Claude-Antwort (Länge: ${raw.length}, Anfang: "${raw.slice(0, 50)}")`
    )
  }
  cleaned = match[0]

  // Versuch 1: Direktes Parsen
  try { return JSON.parse(cleaned) } catch (_) { /* weiter */ }

  // Versuch 2: Typografische Anführungszeichen ersetzen
  try {
    const step2 = cleaned
      .replace(/\u201E/g, '\\"')  // „  deutsches öffnendes Anführungszeichen
      .replace(/\u201C/g, '\\"')  // "  englisches öffnendes Anführungszeichen
      .replace(/\u201D/g, '\\"')  // "  englisches schließendes Anführungszeichen
      .replace(/\u201A/g, "\\'")  // ‚  einfaches öffnendes Anführungszeichen
      .replace(/\u2018/g, "\\'")  // '  einfaches öffnendes Anführungszeichen
      .replace(/\u2019/g, "\\'")  // '  einfaches schließendes Anführungszeichen
    return JSON.parse(step2)
  } catch (_) { /* weiter */ }

  // Versuch 3: Aggressivere Bereinigung
  try {
    const step3 = cleaned
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/\r?\n/g, '\\n')
      .replace(/\t/g, '\\t')
    return JSON.parse(step3)
  } catch (finalError) {
    console.error('[parseClaudeJson] Parse endgültig fehlgeschlagen:', (finalError as Error).message)
    console.error('[parseClaudeJson] Erste 300 Zeichen der Antwort:', raw.slice(0, 300))
    throw finalError
  }
}
