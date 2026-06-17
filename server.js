// ══════════════════════════════════════════════════════════════
// Refugio v3 — Backend
// Stack: Express + Supabase + Ollama
// Deploy: Railway / Render
// Estructura: TODO EN RAÍZ
// ══════════════════════════════════════════════════════════════

require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const { createClient } = require('@supabase/supabase-js')

const app  = express()
const PORT = process.env.PORT || 3000

// ── Supabase ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ── Ollama ──
const OLLAMA_URL     = process.env.OLLAMA_URL || 'http://localhost:11434'
const DEFAULT_MODEL  = process.env.OLLAMA_MODEL || 'llama3.2'
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || ''

// ── CORS ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',')

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true)
    }
    cb(new Error('CORS bloqueado'))
  },
  credentials: true
}))

app.use(express.json({ limit: '20kb' }))

// ════════════════════════════════════════════════════════════════
// 🔥 FRONTEND (CORRECTO: TODO EN RAÍZ)
// ════════════════════════════════════════════════════════════════

// archivos estáticos desde raíz
app.use(express.static(__dirname))

// SPA fallback (IMPORTANTE para React/Vue/vanilla router)
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// ════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════════

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')?.trim()
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Token inválido' })

    req.user = user
    next()
  } catch {
    res.status(401).json({ error: 'Error de autenticación' })
  }
}

// ════════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════════

async function getProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (data) return data

  const { data: created } = await supabase
    .from('profiles')
    .insert({ id: userId })
    .select()
    .single()

  return created
}

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

  const updates = {
    updated_at: new Date().toISOString()
  }

  if (aiName) updates.ai_name = aiName
  if (personality) updates.personality = personality
  if (userName !== undefined) updates.username = userName

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  res.json({ profile: data })
})

// ════════════════════════════════════════════════════════════════
// CHAT
// ════════════════════════════════════════════════════════════════

app.get('/api/chat/history', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user.id)
  const limit = profile?.is_premium ? 100 : 20

  const { data } = await supabase
    .from('conversations')
    .select('role, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true })
    .limit(limit)

  res.json({ history: data || [] })
})

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, systemPrompt, model } = req.body

  if (!messages?.length) {
    return res.status(400).json({ error: 'messages requerido' })
  }

  const profile = await getProfile(req.user.id)

  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role === 'user') {
    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role: 'user',
      content: lastMsg.content
    })
  }

  const baseUrl = OLLAMA_URL.replace(/\/$/, '')
  const modelToUse = model || DEFAULT_MODEL

  const ollamaMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  try {
    const r = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OLLAMA_API_KEY && { Authorization: `Bearer ${OLLAMA_API_KEY}` })
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: ollamaMessages,
        stream: false
      })
    })

    if (!r.ok) {
      const t = await r.text()
      return res.status(500).json({ error: t })
    }

    const data = await r.json()
    const text = data?.message?.content || ''

    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role: 'assistant',
      content: text
    })

    res.json({ text })

  } catch (err) {
    res.status(500).json({ error: 'Error con Ollama' })
  }
})

app.delete('/api/chat/history', requireAuth, async (req, res) => {
  await supabase.from('conversations').delete().eq('user_id', req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════════════════════
// DIARY
// ════════════════════════════════════════════════════════════════

app.get('/api/diary', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  res.json({ entries: data || [] })
})

app.post('/api/diary', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content) return res.status(400).json({ error: 'contenido requerido' })

  const { data } = await supabase
    .from('diary_entries')
    .insert({ user_id: req.user.id, content })
    .select()
    .single()

  res.json({ entry: data })
})

app.delete('/api/diary/:id', requireAuth, async (req, res) => {
  await supabase
    .from('diary_entries')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  res.json({ ok: true })
})

// ════════════════════════════════════════════════════════════════
// PREMIUM
// ════════════════════════════════════════════════════════════════

app.post('/api/activate', requireAuth, async (req, res) => {
  const code = (req.body.code || '').trim()

  const { data: codeRow } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', code)
    .is('used_by', null)
    .single()

  if (!codeRow) {
    return res.status(400).json({ error: 'Código inválido' })
  }

  await supabase.from('profiles')
    .update({ is_premium: true })
    .eq('id', req.user.id)

  res.json({ ok: true })
})

// ════════════════════════════════════════════════════════════════
// OLLAMA STATUS
// ════════════════════════════════════════════════════════════════

app.get('/api/ollama/status', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`)
    const d = await r.json()
    res.json({ online: true, version: d.version })
  } catch {
    res.json({ online: false })
  }
})

app.get('/api/ollama/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    const d = await r.json()

    res.json({
      models: (d.models || []).map(m => ({ name: m.name })),
      default: DEFAULT_MODEL
    })
  } catch {
    res.json({ models: [] })
  }
})

// ════════════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════════════

app.get('/api/health', (_, res) => {
  res.json({ ok: true })
})

// ════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
})