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
// OPENROUTER (IA)
// ─────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct:free'

// Modelos gratuitos disponibles (se muestran en Ajustes → Modelo)
const FREE_MODELS = [
  { name: 'meta-llama/llama-3.1-8b-instruct:free', size: 'rápido' },
  { name: 'meta-llama/llama-3.2-3b-instruct:free',  size: 'ligero' },
  { name: 'google/gemma-2-9b-it:free',              size: 'equilibrado' },
  { name: 'mistralai/mistral-7b-instruct:free',      size: 'rápido' },
  { name: 'qwen/qwen-2.5-7b-instruct:free',          size: 'ligero' },
]
const FREE_MODEL_NAMES = FREE_MODELS.map(m => m.name)

if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY no configurada')
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

// ════════════════════════════════════════════════════════════════
// CHAT — OpenRouter, con system prompt y modelo seleccionable
// ════════════════════════════════════════════════════════════════
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, systemPrompt, model } = req.body
  if (!messages?.length) return res.status(400).json({ error: 'messages requerido' })

  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    await supabase.from('conversations').insert({ user_id: req.user.id, role: 'user', content: last.content })
  }

  // Usar el modelo pedido solo si es uno de los permitidos; si no, el default
  const modelToUse = FREE_MODEL_NAMES.includes(model) ? model : DEFAULT_MODEL

  const orMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://refuggio.onrender.com',
        'X-Title': 'Refugio'
      },
      body: JSON.stringify({ model: modelToUse, messages: orMessages }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    const data = await r.json()

    if (!r.ok) {
      console.error('[OpenRouter] Error', r.status, data?.error?.message)
      const code = r.status === 401 ? 'INVALID_API_KEY' : r.status === 429 ? 'RATE_LIMIT' : 'OPENROUTER_ERROR'
      return res.status(r.status).json({ error: data?.error?.message || 'Error de OpenRouter', code })
    }

    const text = data?.choices?.[0]?.message?.content
    if (!text) return res.status(500).json({ error: 'Respuesta vacía', code: 'EMPTY_RESPONSE' })

    await supabase.from('conversations').insert({ user_id: req.user.id, role: 'assistant', content: text })
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
app.get('/api/ollama/status', (_, res) => {
  res.json({ online: !!OPENROUTER_API_KEY, version: 'OpenRouter' })
})

app.get('/api/ollama/models', (_, res) => {
  res.json({ models: FREE_MODELS, default: DEFAULT_MODEL })
})

// ─────────────────────────────
// HEALTH
// ─────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({ ok: true, engine: 'openrouter', db: !!process.env.SUPABASE_URL })
})

// ─────────────────────────────
// FRONTEND (catch-all, debe ir al final)
// ─────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🌿 Refugio en http://localhost:${PORT}`)
  console.log(`🤖 Motor: OpenRouter | Key: ${OPENROUTER_API_KEY ? '✓' : '✗ FALTA'}`)
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? '✓' : '✗ FALTA'}`)
})
