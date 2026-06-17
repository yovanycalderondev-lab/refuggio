// ══════════════════════════════════════════════════════════════
// Refugio v3 — Backend
// Stack: Express + Supabase (DB+Auth) + Ollama (IA)
// Deploy: Railway
// ══════════════════════════════════════════════════════════════

require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const { createClient } = require('@supabase/supabase-js')

const app  = express()
const PORT = process.env.PORT || 3000

// ── Supabase (service role = acceso total, sin RLS) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ── Ollama ──
const OLLAMA_URL    = process.env.OLLAMA_URL    || 'http://localhost:11434'
const DEFAULT_MODEL = process.env.OLLAMA_MODEL  || 'llama3.2'
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '11907ebfb20f46288a8ca63141d5e155.YPsXtNiGhzajx_g3QZKOnhFo'

// ── CORS ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',')
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(new Error('CORS bloqueado'))
  },
  credentials: true
}))

app.use(express.json({ limit: '20kb' }))
app.use(express.static(path.join(__dirname, '../frontend')))

// ════════════════════════════════════════════════════════════════
// MIDDLEWARE: verificar token de Supabase
// ════════════════════════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')?.trim()
  if (!token) return res.status(401).json({ error: 'No autorizado', code: 'NO_TOKEN' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' })
    req.user  = user
    req.token = token
    next()
  } catch (_) {
    res.status(401).json({ error: 'Error de autenticación', code: 'AUTH_ERROR' })
  }
}

// ── Helper: obtener o crear perfil ──
async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (data) return data
  const { data: created } = await supabase.from('profiles').insert({ id: userId }).select().single()
  return created
}

// ════════════════════════════════════════════════════════════════
// RUTAS: PERFIL
// ════════════════════════════════════════════════════════════════

// GET /api/profile — obtener perfil + info de usuario
app.get('/api/profile', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  res.json({
    profile,
    user: {
      email:  req.user.email,
      name:   req.user.user_metadata?.full_name || req.user.user_metadata?.name || '',
      avatar: req.user.user_metadata?.avatar_url || req.user.user_metadata?.picture || ''
    }
  })
})

// PATCH /api/profile — actualizar nombre, IA, personalidad
app.patch('/api/profile', requireAuth, async (req, res) => {
  const { aiName, personality, userName } = req.body
  const updates = { updated_at: new Date().toISOString() }
  if (aiName)      updates.ai_name     = aiName
  if (personality) updates.personality = personality
  if (userName !== undefined) updates.username = userName

  const { data, error } = await supabase
    .from('profiles').update(updates).eq('id', req.user.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ profile: data })
})

// ════════════════════════════════════════════════════════════════
// RUTAS: CHAT + MEMORIA DE IA
// ════════════════════════════════════════════════════════════════

// GET /api/chat/history — cargar historial para la sesión
app.get('/api/chat/history', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  // Premium: últimos 100 mensajes | Gratis: últimos 20
  const limit = profile?.is_premium ? 100 : 20

  const { data, error } = await supabase
    .from('conversations')
    .select('role, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ history: data || [], isPremium: profile?.is_premium || false, limit })
})

// POST /api/chat — enviar mensaje, guardar en DB, llamar a Ollama
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, systemPrompt, model, ollamaUrl } = req.body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages es requerido' })
  }

  const profile = await getProfile(req.user.id)

  // Guardar mensaje del usuario en DB
  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role === 'user') {
    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role:    'user',
      content: lastMsg.content
    })
  }

  // ── Llamada a Ollama ──
  const baseUrl    = (ollamaUrl || OLLAMA_URL).replace(/\/$/, '')
  const modelToUse = model || DEFAULT_MODEL
  const ollamaMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  // Headers de Ollama (cloud o local)
  const ollamaHeaders = { 'Content-Type': 'application/json' }
  if (OLLAMA_API_KEY) ollamaHeaders['Authorization'] = `Bearer ${OLLAMA_API_KEY}`

  try {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 90000)

    const ollamaRes = await fetch(`${baseUrl}/api/chat`, {
      method:  'POST',
      headers: ollamaHeaders,
      body:    JSON.stringify({
        model:   modelToUse,
        messages: ollamaMessages,
        stream:  false,
        options: { temperature: 0.75, num_predict: 300, repeat_penalty: 1.1 }
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '')
      console.error(`[Ollama] ${ollamaRes.status}:`, errText.slice(0,200))
      if (ollamaRes.status === 401) return res.status(401).json({ error: 'API key inválida', code: 'INVALID_API_KEY' })
      if (ollamaRes.status === 404) return res.status(404).json({ error: `Modelo "${modelToUse}" no encontrado`, code: 'MODEL_NOT_FOUND' })
      return res.status(ollamaRes.status).json({ error: 'Error de Ollama', code: 'OLLAMA_ERROR' })
    }

    const data = await ollamaRes.json()
    const text = data?.message?.content || ''
    if (!text) return res.status(500).json({ error: 'Respuesta vacía de Ollama', code: 'EMPTY_RESPONSE' })

    // Guardar respuesta de IA en DB
    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role:    'assistant',
      content: text
    })

    // Para usuarios gratuitos: mantener solo los últimos 100 mensajes en DB
    if (!profile?.is_premium) {
      const { count } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.user.id)

      if (count > 100) {
        const { data: oldest } = await supabase
          .from('conversations').select('id')
          .eq('user_id', req.user.id)
          .order('created_at', { ascending: true })
          .limit(count - 100)
        if (oldest?.length) {
          await supabase.from('conversations').delete().in('id', oldest.map(r => r.id))
        }
      }
    }

    console.log(`[Chat] OK usuario=${req.user.id.slice(0,8)} modelo=${data.model||modelToUse}`)
    res.json({ text, model: data.model || modelToUse })

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Ollama tardó demasiado', code: 'TIMEOUT' })
    const refused = err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED'
    console.error('[Chat] Error:', err.message)
    res.status(503).json({ error: refused ? 'Ollama no disponible' : 'Error del servidor', code: refused ? 'CONNECTION_REFUSED' : 'INTERNAL_ERROR' })
  }
})

// DELETE /api/chat/history — limpiar historial
app.delete('/api/chat/history', requireAuth, async (req, res) => {
  await supabase.from('conversations').delete().eq('user_id', req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════════════════════
// RUTAS: DIARIO
// ════════════════════════════════════════════════════════════════

app.get('/api/diary', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('diary_entries').select('id, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ entries: data || [] })
})

app.post('/api/diary', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'Contenido requerido' })
  const { data, error } = await supabase
    .from('diary_entries').insert({ user_id: req.user.id, content: content.trim() })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ entry: data })
})

app.delete('/api/diary/:id', requireAuth, async (req, res) => {
  await supabase.from('diary_entries').delete()
    .eq('id', req.params.id).eq('user_id', req.user.id)
  res.json({ ok: true })
})

// GET /api/diary/export — exportar como .txt (solo premium) ─────
app.get('/api/diary/export', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  if (!profile?.is_premium) {
    return res.status(403).json({ error: 'Función premium. Activa tu código de acceso.', code: 'PREMIUM_REQUIRED' })
  }

  const { data } = await supabase
    .from('diary_entries').select('content, created_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: true })

  const entries = data || []
  const dateStr = new Date().toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' })
  const header  = `MI DIARIO — Refugio\nExportado el ${dateStr}\n${'═'.repeat(45)}\n\n`
  const body    = entries.map(e => {
    const d = new Date(e.created_at).toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })
    return `── ${d} ──\n\n${e.content}`
  }).join('\n\n\n')

  res.setHeader('Content-Type',        'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="mi-diario-refugio.txt"')
  res.send(header + (body || '(Sin entradas)'))
})

// ════════════════════════════════════════════════════════════════
// RUTAS: ACTIVACIÓN PREMIUM
// ════════════════════════════════════════════════════════════════
app.post('/api/activate', requireAuth, async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase()
  if (!code) return res.status(400).json({ error: 'Código requerido' })

  // Verificar que el código existe y no ha sido usado
  const { data: codeRow, error } = await supabase
    .from('activation_codes').select('*')
    .eq('code', code).is('used_by', null).single()

  if (error || !codeRow) {
    return res.status(400).json({ error: 'Código inválido o ya utilizado', code: 'INVALID_CODE' })
  }

  // Marcar como usado + activar premium
  await Promise.all([
    supabase.from('activation_codes').update({
      used_by: req.user.id, used_at: new Date().toISOString()
    }).eq('id', codeRow.id),
    supabase.from('profiles').update({ is_premium: true }).eq('id', req.user.id)
  ])

  console.log(`[Premium] Activado para usuario=${req.user.id.slice(0,8)} con código=${code}`)
  res.json({ ok: true, message: '¡Acceso premium activado!' })
})

// ════════════════════════════════════════════════════════════════
// RUTAS: OLLAMA (status y modelos)
// ════════════════════════════════════════════════════════════════
app.get('/api/ollama/status', async (req, res) => {
  const baseUrl = (req.query.url || OLLAMA_URL).replace(/\/$/, '')
  const headers = OLLAMA_API_KEY ? { 'Authorization': `Bearer ${OLLAMA_API_KEY}` } : {}
  try {
    const r    = await fetch(`${baseUrl}/api/version`, { headers, signal: AbortSignal.timeout(5000) })
    const data = await r.json().catch(() => ({}))
    res.json({ online: true, version: data.version || '—', url: baseUrl })
  } catch (_) {
    res.json({ online: false, url: baseUrl })
  }
})

app.get('/api/ollama/models', async (req, res) => {
  const baseUrl = (req.query.url || OLLAMA_URL).replace(/\/$/, '')
  const headers = OLLAMA_API_KEY ? { 'Authorization': `Bearer ${OLLAMA_API_KEY}` } : {}
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { headers, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return res.json({ models: [], error: `Error ${r.status}` })
    const data   = await r.json()
    const models = (data.models || []).map(m => ({
      name: m.name, size: m.size ? formatBytes(m.size) : null
    }))
    res.json({ models, default: DEFAULT_MODEL })
  } catch (_) {
    res.json({ models: [], error: 'No se pudo conectar con Ollama' })
  }
})

// ── Health check ──
app.get('/api/health', (_, res) => res.json({
  status: 'ok', version: '3.0.0', engine: 'ollama',
  model: DEFAULT_MODEL, db: !!process.env.SUPABASE_URL
}))

// ── SPA fallback ──
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')))

function formatBytes(b) {
  return b < 1e9 ? (b/1e6).toFixed(0)+' MB' : (b/1e9).toFixed(1)+' GB'
}

app.listen(PORT, () => {
  console.log(`
🌿 Refugio v3 → http://localhost:${PORT}
🗄️  Supabase: ${process.env.SUPABASE_URL ? '✓ configurado' : '✗ no configurado'}
🤖 Ollama:   ${OLLAMA_URL}
📦 Modelo:   ${DEFAULT_MODEL}
  `)
})
