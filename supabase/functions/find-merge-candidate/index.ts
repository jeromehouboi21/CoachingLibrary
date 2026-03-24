import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.20.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export interface MergeDecision {
  decision: 'merge' | 'new'
  merge_candidate_id: string | null
  merge_type: 'append' | 'deepen' | 'duplicate' | null
  reasoning: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const { groupEmbedding, topicLabel, topicEmbeddingText, keyConcepts } = await req.json() as {
      groupEmbedding: number[]
      topicLabel: string
      topicEmbeddingText: string
      keyConcepts: string[]
    }

    // Phase A: pgvector search for top-3 existing docs
    const { data: candidates, error: searchError } = await supabase.rpc('match_knowledge_docs', {
      query_embedding: groupEmbedding,
      match_count: 3,
    })

    if (searchError) throw searchError

    // No candidates or all below threshold → always create new
    const strongCandidates = (candidates || []).filter((c: { similarity: number }) => c.similarity > 0.75)

    if (strongCandidates.length === 0) {
      return new Response(
        JSON.stringify({ decision: 'new', merge_candidate_id: null, merge_type: null, reasoning: 'Kein ähnliches Dokument gefunden (Score < 0.75)' } satisfies MergeDecision),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Phase B: Claude Sonnet decides
    const candidateText = strongCandidates
      .map((c: { similarity: number; title: string; summary: string; id: string }, i: number) =>
        `KANDIDAT ${i + 1} (Similarity: ${c.similarity.toFixed(2)}):\nID: ${c.id}\nTitel: ${c.title}\nZusammenfassung: ${c.summary || '–'}`
      )
      .join('\n\n')

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: `Du entscheidest ob ein neuer Inhalt zu einem bestehenden Wissensdokument gehört oder ein eigenständiges neues Dokument werden soll.
Antworte ausschließlich als valides JSON, keine Einleitung, kein Markdown.`,
      messages: [{
        role: 'user',
        content: `NEUER INHALT:
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
- "append": neuer Inhalt ergänzt das bestehende Dokument (z.B. neue Übung zum bekannten Thema)
- "deepen": neuer Inhalt vertieft einen bereits vorhandenen Abschnitt
- "duplicate": Inhalt bereits vorhanden → ignorieren
- "new": eigenständiges Thema → neues Dokument erstellen`
      }]
    })

    const rawText = (response.content[0] as { type: string; text: string }).text
    const match = rawText.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in Sonnet response')

    const decision: MergeDecision = JSON.parse(match[0])

    return new Response(
      JSON.stringify(decision),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
