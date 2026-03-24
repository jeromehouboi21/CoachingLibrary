import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    const { query, filters } = await req.json()

    if (!query || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate embedding
    const openAiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openAiKey) {
      // Fallback to full-text search if no OpenAI key
      const { data: docs } = await supabase
        .from('knowledge_docs')
        .select('id, title, summary, category, tags')
        .or(`title.ilike.%${query}%,summary.ilike.%${query}%`)
        .limit(10)

      return new Response(
        JSON.stringify({ results: (docs || []).map(d => ({ ...d, similarity: 0.5, excerpt: d.summary?.slice(0, 200) })) }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAiKey}`
      },
      body: JSON.stringify({ input: query, model: 'text-embedding-3-small' })
    })

    if (!embeddingRes.ok) {
      throw new Error(`OpenAI API error: ${embeddingRes.status}`)
    }

    const embeddingData = await embeddingRes.json()
    const queryEmbedding = embeddingData.data?.[0]?.embedding

    if (!queryEmbedding) {
      throw new Error('Failed to generate embedding')
    }

    // Vector search via RPC
    const { data: chunks, error: rpcError } = await supabase.rpc('match_doc_chunks', {
      query_embedding: queryEmbedding,
      match_count: 10
    })

    if (rpcError) throw rpcError

    if (!chunks || chunks.length === 0) {
      return new Response(
        JSON.stringify({ results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Group by document and fetch doc details
    const docIds = [...new Set(chunks.map((c: { doc_id: string }) => c.doc_id))]

    let docsQuery = supabase
      .from('knowledge_docs')
      .select('id, title, summary, category, tags')
      .in('id', docIds)

    // Apply optional filters
    if (filters?.category) {
      docsQuery = docsQuery.eq('category', filters.category)
    }

    const { data: docs, error: docsError } = await docsQuery
    if (docsError) throw docsError

    // Merge similarity scores and excerpts
    const results = (docs || []).map(doc => {
      const matchingChunk = chunks.find((c: { doc_id: string; similarity: number; content: string }) => c.doc_id === doc.id)
      return {
        ...doc,
        similarity: matchingChunk?.similarity || 0,
        excerpt: matchingChunk?.content?.slice(0, 200) || doc.summary?.slice(0, 200)
      }
    }).sort((a, b) => b.similarity - a.similarity)

    return new Response(
      JSON.stringify({ results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('semantic-search error:', error)
    return new Response(
      JSON.stringify({ error: (error as Error).message, results: [] }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
