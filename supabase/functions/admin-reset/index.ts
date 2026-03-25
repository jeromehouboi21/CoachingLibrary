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
    const { password } = await req.json()

    // ── Passwort prüfen ───────────────────────────────────────────────────────
    const adminPassword = Deno.env.get('ADMIN_RESET_PASSWORD')
    if (!adminPassword) throw new Error('ADMIN_RESET_PASSWORD Secret nicht konfiguriert')
    if (password !== adminPassword) {
      return new Response(
        JSON.stringify({ error: 'Falsches Passwort' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('[admin-reset] Passwort korrekt — Reset startet')
    const log: string[] = []

    // ── Schritt 1: Chat-Nachrichten ───────────────────────────────────────────
    const { error: msgError, count: msgCount } = await supabase
      .from('chat_messages').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (msgError) throw new Error(`chat_messages: ${msgError.message}`)
    log.push(`chat_messages: ${msgCount ?? '?'} gelöscht`)

    // ── Schritt 2: Chat-Sessions ──────────────────────────────────────────────
    const { error: sessError, count: sessCount } = await supabase
      .from('chat_sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (sessError) throw new Error(`chat_sessions: ${sessError.message}`)
    log.push(`chat_sessions: ${sessCount ?? '?'} gelöscht`)

    // ── Schritt 3: page_hashes ────────────────────────────────────────────────
    const { error: hashError, count: hashCount } = await supabase
      .from('page_hashes').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (hashError) throw new Error(`page_hashes: ${hashError.message}`)
    log.push(`page_hashes: ${hashCount ?? '?'} gelöscht`)

    // ── Schritt 4: knowledge_docs (cascaded: chunks, sources, notes) ──────────
    const { error: docError, count: docCount } = await supabase
      .from('knowledge_docs').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (docError) throw new Error(`knowledge_docs: ${docError.message}`)
    log.push(`knowledge_docs: ${docCount ?? '?'} gelöscht (inkl. chunks, sources, notes via CASCADE)`)

    // ── Schritt 5: raw_scans ──────────────────────────────────────────────────
    const { error: scanError, count: scanCount } = await supabase
      .from('raw_scans').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (scanError) throw new Error(`raw_scans: ${scanError.message}`)
    log.push(`raw_scans: ${scanCount ?? '?'} gelöscht`)

    // ── Schritt 6: Storage — alle Objekte im Bucket 'raw-scans' löschen ───────
    let storageDeletedCount = 0

    const { data: folders, error: folderListError } = await supabase.storage
      .from('raw-scans')
      .list('', { limit: 1000 })

    if (folderListError) throw new Error(`Storage list: ${folderListError.message}`)

    if (folders && folders.length > 0) {
      for (const folder of folders) {
        // Each top-level entry is a folder (scan UUID)
        const { data: files } = await supabase.storage
          .from('raw-scans')
          .list(folder.name, { limit: 1000 })

        if (files && files.length > 0) {
          const paths = files.map(f => `${folder.name}/${f.name}`)
          const { error: removeError } = await supabase.storage
            .from('raw-scans')
            .remove(paths)
          if (removeError) console.warn(`Storage remove warning: ${removeError.message}`)
          storageDeletedCount += paths.length
        }
      }
    }

    log.push(`Storage raw-scans: ~${storageDeletedCount} Objekte gelöscht`)

    console.log('[admin-reset] abgeschlossen:', log)

    return new Response(
      JSON.stringify({ success: true, log }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[admin-reset] FEHLER:', (error as Error).message)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
