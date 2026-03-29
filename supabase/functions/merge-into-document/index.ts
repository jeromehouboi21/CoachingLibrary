import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.20.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const { docId, newContentHtml, mergeType } = await req.json() as {
      docId: string
      newContentHtml: string
      mergeType: 'append' | 'deepen'
    }

    // Fetch existing document
    const { data: existing, error: fetchError } = await supabase
      .from('knowledge_docs')
      .select('id, title, content_html, tags, summary')
      .eq('id', docId)
      .single()

    if (fetchError) throw fetchError

    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `Du integrierst neuen Inhalt in ein bestehendes Wissensdokument.
Merge-Typ: ${mergeType}

Für "append": Füge den neuen Inhalt als neuen Abschnitt am Ende ein.
Für "deepen": Finde den passenden bestehenden Abschnitt und integriere den neuen Inhalt dort – ohne bestehenden Inhalt zu entfernen.

Kürze und entferne NICHTS aus dem bestehenden Dokument.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.

WICHTIG für die JSON-Ausgabe:
- Deutsche Anführungszeichen (« » „ " " ‚ ' ') als normale ASCII-Anführungszeichen schreiben: "
- Verwende in content_html nur einfache Anführungszeichen für HTML-Attribute: <p class='x'>
- Keine echten Zeilenumbrüche im JSON-String – Zeilenumbrüche als \\n schreiben
- Die gesamte Antwort muss valides JSON sein das JSON.parse() ohne Fehler besteht`,
      messages: [{
        role: 'user',
        content: `BESTEHENDES DOKUMENT:
Titel: ${existing.title}
Inhalt: ${existing.content_html}

NEUER INHALT:
${newContentHtml}

JSON-Format:
{
  "content_html": "vollständiger aktualisierter HTML-Inhalt",
  "tags": ["aktualisierte", "tag", "liste"],
  "summary": "aktualisierte Zusammenfassung (2-3 Sätze)"
}`
      }]
    }))

    const rawText = (response.content[0] as { type: string; text: string }).text
    const merged = parseClaudeJson(rawText)
    const contentText = merged.content_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || ''

    // Generate new summary embedding
    let summaryEmbedding = null
    if (Deno.env.get('OPENAI_API_KEY') && merged.summary) {
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
        },
        body: JSON.stringify({ input: merged.summary, model: 'text-embedding-3-small' }),
      })
      if (embRes.ok) {
        const embData = await embRes.json()
        summaryEmbedding = embData.data?.[0]?.embedding
      }
    }

    // Update document
    await supabase.from('knowledge_docs').update({
      content_html: merged.content_html,
      content_text: contentText,
      tags: merged.tags || existing.tags,
      summary: merged.summary || existing.summary,
      ...(summaryEmbedding ? { summary_embedding: summaryEmbedding } : {}),
    }).eq('id', docId)

    // Regenerate chunks + embeddings
    await supabase.from('doc_chunks').delete().eq('doc_id', docId)

    if (Deno.env.get('OPENAI_API_KEY') && contentText) {
      const chunks = splitIntoChunks(contentText, 500)
      for (let i = 0; i < chunks.length; i++) {
        const embRes = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
          },
          body: JSON.stringify({ input: chunks[i], model: 'text-embedding-3-small' }),
        })
        if (embRes.ok) {
          const embData = await embRes.json()
          const embedding = embData.data?.[0]?.embedding
          if (embedding) {
            await supabase.from('doc_chunks').insert({
              doc_id: docId, chunk_index: i, content: chunks[i], embedding,
            })
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, docId }),
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
      const isRateLimit =
        message.includes('429') ||
        message.includes('rate_limit') ||
        message.includes('529') ||
        message.includes('overloaded')

      if (isRateLimit && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(
          `[merge-into-document] Rate limit / Overloaded – warte ${delay / 1000}s ` +
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

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '))
  }
  return chunks.length > 0 ? chunks : [text.slice(0, 2000)]
}
