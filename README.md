# 🌿 Refugio v3

**Tu espacio seguro digital** — Chat con IA empática, juegos anti-estrés, diario personal y música relajante.

---

## Stack completo

| Parte | Servicio | Coste |
|-------|---------|-------|
| Frontend | **Vercel** | Gratis |
| Backend  | **Railway** | Gratis (500h/mes) |
| Base de datos + Auth | **Supabase** | Gratis |
| IA | **Ollama Cloud** | Según uso |

---

## Guía de despliegue completa

### PASO 1 — Supabase (Base de datos y Google Auth)

#### 1.1 Crear proyecto
1. Ve a [supabase.com](https://supabase.com) → **New project**
2. Elige nombre (`refugio`), contraseña de base de datos y región
3. Espera ~2 minutos a que el proyecto esté listo

#### 1.2 Crear tablas
1. En el panel lateral: **SQL Editor** → **New query**
2. Copia y pega el contenido de `supabase/schema.sql`
3. Clic en **Run** — verás las tablas creadas en **Table Editor**

#### 1.3 Activar Google Auth
1. Panel lateral → **Authentication** → **Providers** → **Google**
2. Activa el toggle
3. Ve a [console.cloud.google.com](https://console.cloud.google.com)
4. Crea un proyecto → **APIs & Services** → **Credentials** → **OAuth 2.0 Client**
5. Tipo: **Web application**
6. Authorized redirect URIs: `https://XXXXXXXX.supabase.co/auth/v1/callback`
   (la URL de tu proyecto Supabase, la encuentras en Settings → API)
7. Copia el **Client ID** y **Client Secret** de vuelta en Supabase

#### 1.4 Anotar credenciales
En Supabase: **Settings** → **API**, anota:
- `Project URL` → será tu `SUPABASE_URL`
- `anon public` key → para el frontend (`SUPABASE_ANON_KEY`)
- `service_role` key → para el backend (`SUPABASE_SERVICE_KEY`) ⚠️ nunca en frontend

---

### PASO 2 — Backend en Railway

#### 2.1 Crear cuenta y proyecto
1. Ve a [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** (sube el código a GitHub primero)
   - O usa **Deploy from local** con el CLI de Railway

#### 2.2 Subir código a GitHub
```bash
cd refugio-v3
git init
git add .
git commit -m "Refugio v3 inicial"
# Crea un repo en github.com y conecta:
git remote add origin https://github.com/TU-USUARIO/refugio.git
git push -u origin main
```

#### 2.3 Conectar Railway con GitHub
1. Railway → **New Project** → **Deploy from GitHub repo**
2. Selecciona tu repositorio `refugio`
3. Railway detectará automáticamente Node.js

#### 2.4 Variables de entorno en Railway
En Railway: proyecto → **Variables** → añade una por una:

```
SUPABASE_URL          = https://XXXXXXXX.supabase.co
SUPABASE_SERVICE_KEY  = eyJ...tu-service-key...
OLLAMA_URL            = https://api.ollama.com
OLLAMA_API_KEY        = tu-api-key-de-ollama
OLLAMA_MODEL          = llama3.2
ALLOWED_ORIGINS       = https://refugio.vercel.app   ← ponlo después del paso 3
PORT                  = 3000
```

#### 2.5 Obtener URL del backend
Una vez desplegado, Railway te da una URL como:
`https://refugio-production-xxxx.railway.app`

Anótala para el siguiente paso.

---

### PASO 3 — Frontend en Vercel

#### 3.1 Editar CONFIG en index.html
Abre `frontend/index.html` y busca el bloque `CONFIG` al inicio del script:

```javascript
const CONFIG = {
  BACKEND_URL:      'https://TU-APP.railway.app',    // ← URL de Railway del paso 2.5
  SUPABASE_URL:     'https://XXXXXXXX.supabase.co',  // ← del paso 1.4
  SUPABASE_ANON_KEY:'eyJ...tu-clave-anonima...',     // ← anon key del paso 1.4
}
```

**Guarda el archivo** y haz commit + push a GitHub.

#### 3.2 Deploy en Vercel
1. Ve a [vercel.com](https://vercel.com) → **New Project**
2. Importa tu repositorio de GitHub
3. En **Root Directory**: deja el directorio raíz (el `vercel.json` lo configura todo)
4. Clic en **Deploy**

#### 3.3 Configurar dominio personalizado (opcional)
En Vercel → tu proyecto → **Domains** → añade tu dominio

#### 3.4 Actualizar CORS en Railway
Ahora que tienes la URL de Vercel, actualiza en Railway:
```
ALLOWED_ORIGINS = https://refugio.vercel.app
```

#### 3.5 Actualizar URL de redirección en Supabase
En Supabase → **Authentication** → **URL Configuration**:
- **Site URL**: `https://refugio.vercel.app`
- **Redirect URLs**: añade `https://refugio.vercel.app`

---

### PASO 4 — Verificación final

Abre `https://refugio.vercel.app` y comprueba:

- [ ] Aparece la pantalla de login
- [ ] "Continuar con Google" abre el flujo OAuth
- [ ] Tras login, aparece el onboarding
- [ ] El chat responde (Ollama conectado)
- [ ] La música suena al hacer clic en una tarjeta
- [ ] Los juegos se abren
- [ ] El diario guarda entradas
- [ ] El código de activación funciona (usa uno de los de `schema.sql`)

---

## Estructura del proyecto

```
refugio-v3/
├── frontend/
│   └── index.html          # App completa autocontenida
├── backend/
│   └── server.js           # API Express + Supabase + Ollama
├── supabase/
│   └── schema.sql          # Tablas, RLS, trigger, códigos de activación
├── package.json
├── .env.example            # Plantilla de variables de entorno
├── .gitignore
├── railway.toml            # Config de deploy en Railway
├── vercel.json             # Config de deploy en Vercel
└── README.md
```

---

## Funciones premium (activación por código)

Los códigos están en `supabase/schema.sql`. Los 10 códigos pre-generados son:

```
REFUGIO-PREMIUM-A1B2    CALM-UNLOCK-C3D4
ZEN-ACCESS-E5F6         PEACE-CODE-G7H8
SERENITY-KEY-I9J0       REFUGE-VIP-K1L2
MINDFUL-PRO-M3N4        BREATH-PLUS-O5P6
DIARY-FULL-Q7R8         INNER-ACCESS-S9T0
```

**Cambia estos códigos antes de lanzar en producción** editando el `INSERT` en `schema.sql` y re-ejecutándolo.

Con código activado el usuario obtiene:
- **Historial ilimitado** de conversaciones (la IA recuerda todo)
- **Exportar el diario** como archivo `.txt`

Sin código: historial de los últimos 20 mensajes y sin exportación.

---

## Desarrollo local

```bash
# Instalar dependencias
cd refugio-v3
npm install

# Configurar entorno
cp .env.example .env
# Edita .env con tus credenciales reales

# Arrancar backend
npm run dev    # http://localhost:3000

# El frontend se sirve automáticamente desde /frontend/index.html
# Abre http://localhost:3000 en el navegador
```

Para desarrollo local con Google Auth, añade `http://localhost:3000` en:
- Supabase → Authentication → URL Configuration → Redirect URLs
- Google Cloud Console → OAuth Client → Authorized redirect URIs:
  `https://XXXXXXXX.supabase.co/auth/v1/callback` (solo el de Supabase, no localhost)

---

## Gestión de códigos de activación

Para añadir más códigos desde el SQL Editor de Supabase:

```sql
INSERT INTO public.activation_codes (code) VALUES
  ('MI-NUEVO-CODIGO-2025'),
  ('OTRO-CODIGO-AQUI');
```

Para ver qué códigos han sido usados:
```sql
SELECT code, used_by, used_at FROM activation_codes ORDER BY created_at;
```

---

## Seguridad

- La `SUPABASE_SERVICE_KEY` **nunca** va al frontend
- Los tokens JWT de Supabase se verifican en cada petición al backend
- Row Level Security (RLS) activo: cada usuario solo ve sus propios datos
- Las claves de Ollama y Supabase del backend viajan solo servidor↔servidor
- El frontend solo conoce la `anon key` pública de Supabase (es seguro)
