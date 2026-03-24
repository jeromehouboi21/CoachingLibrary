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
    const { pages, scanId, fileName } = await req.json() as {
      pages: Array<{ page: number; content_html: string; topic_label: string }>
      scanId: string
      fileName: string
    }

    const sectionsText = pages
      .map((p, i) => `ABSCHNITT ${i + 1} (Seite ${p.page}):\n${p.content_html}`)
      .join('\n\n')

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `Du erstellst ein Wissensdokument für eine persönliche Coaching-Wissensbibliothek.
Der Inhalt stammt aus Seminarunterlagen einer Systemisches-Coaching-Ausbildung.
Fasse NICHTS zusammen oder kürze NICHTS – integriere den vollständigen Inhalt aller Abschnitte in ein kohärentes, gut strukturiertes Dokument.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`,
      messages: [{
        role: 'user',
        content: `${sectionsText}

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
      }]
    })

    const rawText = (response.content[0] as { type: string; text: string }).text
    const match = rawText.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in Sonnet response')

    const doc = JSON.parse(match[0])
    const contentText = doc.content_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || ''

    // Generate summary embedding
    let summaryEmbedding = null
    if (Deno.env.get('OPENAI_API_KEY') && doc.summary) {
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
        },
        body: JSON.stringify({ input: doc.summary, model: 'text-embedding-3-small' }),
      })
      if (embRes.ok) {
        const embData = await embRes.json()
        summaryEmbedding = embData.data?.[0]?.embedding
      }
    }

    // Save knowledge doc
    const { data: savedDoc, error: docError } = await supabase
      .from('knowledge_docs')
      .insert({
        title: doc.title,
        summary: doc.summary,
        summary_embedding: summaryEmbedding,
        category: doc.category,
        subcategory: doc.subcategory,
        tags: doc.tags,
        difficulty: doc.difficulty,
        content_html: doc.content_html,
        content_text: contentText,
      })
      .select()
      .single()

    if (docError) throw docError

    // Save source link
    await supabase.from('doc_sources').insert({
      doc_id: savedDoc.id,
      scan_id: scanId,
      filename: fileName,
      pages: pages.map(p => p.page),
    })

    // Generate and save chunk embeddings
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
              doc_id: savedDoc.id, chunk_index: i, content: chunks[i], embedding,
            })
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, docId: savedDoc.id, title: savedDoc.title }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '))
  }
  return chunks.length > 0 ? chunks : [text.slice(0, 2000)]
}
