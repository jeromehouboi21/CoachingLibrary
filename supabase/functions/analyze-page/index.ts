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

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: `Du verarbeitest eine Seite aus Coaching-Seminarmaterialien (OCR-extrahiert).
Deine Aufgabe: Thema identifizieren und Inhalt vollständig strukturieren.
Kürze nichts. Behalte alle Details, Übungen, Beispiele und Definitionen.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`,
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
    })

    const rawText = (response.content[0] as { type: string; text: string }).text
    const match = rawText.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in Haiku response')

    const result: AnalyzedPage = { page, ...JSON.parse(match[0]) }

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
