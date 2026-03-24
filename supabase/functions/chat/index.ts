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
    const { messages, query } = await req.json()

    if (!query) {
      throw new Error('Missing required parameter: query')
    }

    let context = ''

    // Semantic search for relevant chunks (only if OpenAI key available)
    if (Deno.env.get('OPENAI_API_KEY')) {
      try {
        const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`
          },
          body: JSON.stringify({ input: query, model: 'text-embedding-3-small' })
        })

        if (embeddingRes.ok) {
          const embeddingData = await embeddingRes.json()
          const queryEmbedding = embeddingData.data?.[0]?.embedding

          if (queryEmbedding) {
            // pgvector similarity search
            const { data: chunks } = await supabase.rpc('match_doc_chunks', {
              query_embedding: queryEmbedding,
              match_count: 5
            })

            if (chunks && chunks.length > 0) {
              context = chunks
                .map((c: { doc_id: string; content: string }) => `[DOC:${c.doc_id}]\n${c.content}`)
                .join('\n\n---\n\n')
            }
          }
        }
      } catch (embErr) {
        console.error('Embedding/search error:', embErr)
        // Continue without context
      }
    }

    // Fallback: full-text search if no semantic context found
    if (!context) {
      const { data: docs } = await supabase
        .from('knowledge_docs')
        .select('id, title, summary, content_text')
        .or(`title.ilike.%${query}%,summary.ilike.%${query}%,content_text.ilike.%${query}%`)
        .limit(3)

      if (docs && docs.length > 0) {
        context = docs
          .map((d: { id: string; title: string; content_text?: string; summary?: string }) =>
            `[DOC:${d.id}]\n${d.title}\n${(d.content_text || d.summary || '').slice(0, 500)}`
          )
          .join('\n\n---\n\n')
      }
    }

    const systemPrompt = `Du bist ein persönlicher Coaching-Assistent. Du antwortest AUSSCHLIESSLICH auf Basis der dir bereitgestellten Wissensdokumente aus einer systemischen Coaching-Ausbildung.

Regeln:
- Antworte nur basierend auf den bereitgestellten Dokumenten
- Wenn du ein Dokument als Quelle verwendest, markiere es mit [[DOC:uuid]]
- Wenn kein passendes Dokument vorhanden ist, sage das klar: "Zu diesem Thema habe ich keine passenden Dokumente in deiner Bibliothek."
- Sprache: Deutsch, professionell aber zugänglich
- Schlage konkrete Methoden vor, wenn nach Lösungen gefragt wird
- Antworte strukturiert und klar

${context ? `KONTEXT (relevante Dokumente aus der Bibliothek):\n${context}` : 'KONTEXT: Noch keine Dokumente in der Bibliothek vorhanden.'}`

    // Stream response
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: (messages || []).slice(-10).map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }))
    })

    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              const data = `data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`
              controller.enqueue(encoder.encode(data))
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } catch (streamErr) {
          const errData = `data: ${JSON.stringify({ error: (streamErr as Error).message })}\n\n`
          controller.enqueue(encoder.encode(errData))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      }
    })

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      }
    })
  } catch (error) {
    console.error('chat function error:', error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
