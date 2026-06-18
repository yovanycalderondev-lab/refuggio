require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const app = express()
const PORT = process.env.PORT || 3000

// ─────────────────────────────
// SUPABASE
// ─────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ─────────────────────────────
// OLLAMA CLOUD (IA)
// ─────────────────────────────
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY
const OLLAMA_BASE_URL = 'https://ollama.com/v1'
const OLLAMA_CHAT_URL = `${OLLAMA_BASE_URL}/chat/completions`
const OLLAMA_MODELS_URL = `${OLLAMA_BASE_URL}/models`
const DEFAULT_MODEL = 'gpt-oss:20b-cloud'

// Modelos de respaldo si no se puede consultar el catálogo en vivo de Ollama
const FALLBACK_MODELS = [
  { name: 'gpt-oss:20b-cloud',       size: 'rápido' },
  { name: 'gpt-oss:120b-cloud',      size: 'potente' },
  { name: 'qwen3-coder:480b-cloud',  size: 'potente' },
  { name: 'deepseek-v3.1:671-cloud', size: 'muy potente' },
]

function sizeHint(name) {
  const m = name.match(/(\d+)b/i)
  if (!m) return ''
  const n = parseInt(m[1], 10)
  if (n >= 200) return 'muy potente'
  if (n >= 60) return 'potente'
  if (n >= 20) return 'equilibrado'
  return 'rápido'
}

if (!OLLAMA_API_KEY) console.warn('⚠️  OLLAMA_API_KEY no configurada')
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) console.warn('⚠️  Supabase no configurado')

// ─────────────────────────────
// MIDDLEWARES
// ─────────────────────────────
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '20kb' }))
app.use(express.static(__dirname))

// ─────────────────────────────
// AUTH
// ─────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Token inválido' })

  req.user = user
  next()
}

async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  return data || { is_premium: false }
}

// Auth opcional: identifica al usuario si manda token, pero deja pasar
// a los invitados (sin token) en vez de bloquearlos con 401.
async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim()
  if (!token) { req.user = null; return next() }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  req.user = (!error && user) ? user : null
  next()
}

// ════════════════════════════════════════════════════════════════
// CHAT — Ollama Cloud, con system prompt y modelo seleccionable
// ════════════════════════════════════════════════════════════════
app.post('/api/chat', optionalAuth, async (req, res) => {
  const { messages, systemPrompt, model } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'messages requerido' })

  const last = messages[messages.length - 1]
  if (req.user && last?.role === 'user') {
    await supabase.from('conversations').insert({ user_id: req.user.id, role: 'user', content: last.content })
  }

  const modelToUse = model || DEFAULT_MODEL

  const orMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)

    const r = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({ model: modelToUse, messages: orMessages }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    const data = await r.json()

    if (!r.ok) {
      console.error('[Ollama] Error', r.status, data?.error?.message)
      const code = r.status === 401 ? 'INVALID_API_KEY' : r.status === 429 ? 'RATE_LIMIT' : 'OLLAMA_ERROR'
      return res.status(r.status).json({ error: data?.error?.message || 'Error de Ollama', code })
    }

    const text = data?.choices?.[0]?.message?.content
    if (!text) return res.status(500).json({ error: 'Respuesta vacía', code: 'EMPTY_RESPONSE' })

    if (req.user) {
      await supabase.from('conversations').insert({ user_id: req.user.id, role: 'assistant', content: text })
    }
    res.json({ text, model: modelToUse })

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Tardó demasiado', code: 'TIMEOUT' })
    console.error(err)
    res.status(500).json({ error: 'Error de IA', code: 'INTERNAL_ERROR' })
  }
})

// ─────────────────────────────
// HISTORIAL
// ─────────────────────────────
app.get('/api/chat/history', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  const limit = profile.is_premium ? 100 : 20

  const { data } = await supabase
    .from('conversations')
    .select('role, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true })
    .limit(limit)

  res.json({ history: data || [], isPremium: profile.is_premium || false })
})

app.delete('/api/chat/history', requireAuth, async (req, res) => {
  await supabase.from('conversations').delete().eq('user_id', req.user.id)
  res.json({ ok: true })
})

// ─────────────────────────────
// PERFIL
// ─────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  res.json({
    profile,
    user: {
      email: req.user.email,
      name: req.user.user_metadata?.full_name || '',
      avatar: req.user.user_metadata?.avatar_url || ''
    }
  })
})

app.patch('/api/profile', requireAuth, async (req, res) => {
  const { aiName, personality, userName } = req.body
  const updates = { updated_at: new Date().toISOString() }
  if (aiName) updates.ai_name = aiName
  if (personality) updates.personality = personality
  if (userName !== undefined) updates.username = userName

  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: req.user.id, ...updates })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ profile: data })
})

// ─────────────────────────────
// DIARIO
// ─────────────────────────────
app.get('/api/diary', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('id, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ entries: data || [] })
})

app.post('/api/diary', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'Contenido requerido' })
  const { data, error } = await supabase
    .from('diary_entries')
    .insert({ user_id: req.user.id, content: content.trim() })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ entry: data })
})

app.delete('/api/diary/:id', requireAuth, async (req, res) => {
  await supabase.from('diary_entries').delete().eq('id', req.params.id).eq('user_id', req.user.id)
  res.json({ ok: true })
})

app.get('/api/diary/export', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  if (!profile.is_premium) {
    return res.status(403).json({ error: 'Función premium. Activa tu código.', code: 'PREMIUM_REQUIRED' })
  }
  const { data } = await supabase
    .from('diary_entries')
    .select('content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true })

  const entries = data || []
  const header = `MI DIARIO — Refugio\nExportado el ${new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})}\n${'═'.repeat(45)}\n\n`
  const body = entries.map(e => {
    const d = new Date(e.created_at).toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})
    return `── ${d} ──\n\n${e.content}`
  }).join('\n\n\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="mi-diario-refugio.txt"')
  res.send(header + (body || '(Sin entradas)'))
})

// ─────────────────────────────
// ACTIVACIÓN PREMIUM
// ─────────────────────────────
app.post('/api/activate', requireAuth, async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase()
  if (!code) return res.status(400).json({ error: 'Código requerido' })

  const { data: codeRow, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', code)
    .is('used_by', null)
    .single()

  if (error || !codeRow) {
    return res.status(400).json({ error: 'Código inválido o ya utilizado', code: 'INVALID_CODE' })
  }

  await Promise.all([
    supabase.from('activation_codes').update({ used_by: req.user.id, used_at: new Date().toISOString() }).eq('id', codeRow.id),
    supabase.from('profiles').upsert({ id: req.user.id, is_premium: true })
  ])

  res.json({ ok: true, message: '¡Acceso premium activado!' })
})

// ─────────────────────────────
// ESTADO / MODELOS (panel de Ajustes)
// ─────────────────────────────
app.get('/api/ollama/status', async (_, res) => {
  if (!OLLAMA_API_KEY) return res.json({ online: false, version: 'Ollama Cloud' })
  try {
    const r = await fetch(OLLAMA_MODELS_URL, { headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}` } })
    res.json({ online: r.ok, version: 'Ollama Cloud' })
  } catch (_) {
    res.json({ online: false, version: 'Ollama Cloud' })
  }
})

app.get('/api/ollama/models', async (_, res) => {
  if (!OLLAMA_API_KEY) return res.json({ models: FALLBACK_MODELS, default: DEFAULT_MODEL })
  try {
    const r = await fetch(OLLAMA_MODELS_URL, { headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}` } })
    const data = await r.json()
    const list = data?.data
    if (!r.ok || !Array.isArray(list) || !list.length) {
      return res.json({ models: FALLBACK_MODELS, default: DEFAULT_MODEL })
    }
    const models = list.map(m => ({ name: m.id, size: sizeHint(m.id) }))
    res.json({ models, default: DEFAULT_MODEL })
  } catch (_) {
    res.json({ models: FALLBACK_MODELS, default: DEFAULT_MODEL })
  }
})

// ─────────────────────────────
// HEALTH
// ─────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({ ok: true, engine: 'ollama-cloud', db: !!process.env.SUPABASE_URL })
})

// ─────────────────────────────
// FRONTEND (catch-all, debe ir al final)
// ─────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🌿 Refugio en http://localhost:${PORT}`)
  console.log(`🤖 Motor: Ollama Cloud | Key: ${OLLAMA_API_KEY ? '✓' : '✗ FALTA'}`)
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? '✓' : '✗ FALTA'}`)
})
