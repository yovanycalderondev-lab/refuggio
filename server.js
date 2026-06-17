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
// OPENROUTER (IA GRATIS)
// ─────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct:free'

// ─────────────────────────────
// CORS
// ─────────────────────────────
app.use(cors({
  origin: '*',
  credentials: true
}))

app.use(express.json({ limit: '20kb' }))

// ─────────────────────────────
// FRONTEND (RAÍZ)
// ─────────────────────────────
app.use(express.static(__dirname))

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// ─────────────────────────────
// AUTH
// ─────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'Token inválido' })
  }

  req.user = user
  next()
}

// ─────────────────────────────
// PROFILE SAFE
// ─────────────────────────────
async function getProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  return data || { is_premium: false }
}

// ─────────────────────────────
// CHAT (OPENROUTER)
// ─────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages } = req.body

  if (!messages?.length) {
    return res.status(400).json({ error: 'messages requerido' })
  }

  const last = messages[messages.length - 1]

  if (last?.role === 'user') {
    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role: 'user',
      content: last.content
    })
  }

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://refugio-app',
        'X-Title': 'Refugio v3'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages
      })
    })

    const data = await r.json()

    const text = data?.choices?.[0]?.message?.content || 'Sin respuesta'

    await supabase.from('conversations').insert({
      user_id: req.user.id,
      role: 'assistant',
      content: text
    })

    res.json({ text })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error IA' })
  }
})

// ─────────────────────────────
// HISTORY
// ─────────────────────────────
app.get('/api/chat/history', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('conversations')
    .select('role, content, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true })

  res.json({ history: data || [] })
})

// ─────────────────────────────
// PROFILE
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

// ─────────────────────────────
// HEALTH
// ─────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({ ok: true })
})

// ─────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`)
})