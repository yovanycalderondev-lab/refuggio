-- ════════════════════════════════════════════════════════════════
-- REFUGIO — Schema de base de datos (Supabase / PostgreSQL)
-- Ejecuta este archivo en el SQL Editor de Supabase
-- ════════════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";

-- profiles
create table public.profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  username    text,
  ai_name     text not null default 'Luna',
  personality text not null default 'tranquila',
  is_premium  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- conversations (historial de chat persistente)
create table public.conversations (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users(id) on delete cascade not null,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

-- diary_entries
create table public.diary_entries (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users(id) on delete cascade not null,
  content    text not null,
  created_at timestamptz not null default now()
);

-- activation_codes (premium)
create table public.activation_codes (
  id         uuid default gen_random_uuid() primary key,
  code       text unique not null,
  used_by    uuid references auth.users(id),
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- índices
create index idx_conv_user   on public.conversations(user_id, created_at desc);
create index idx_diary_user  on public.diary_entries(user_id, created_at desc);

-- RLS
alter table public.profiles         enable row level security;
alter table public.conversations    enable row level security;
alter table public.diary_entries    enable row level security;
alter table public.activation_codes enable row level security;

-- profiles policies
create policy "select_own_profile" on public.profiles for select using (auth.uid() = id);
create policy "update_own_profile" on public.profiles for update using (auth.uid() = id);
create policy "insert_own_profile" on public.profiles for insert with check (auth.uid() = id);

-- conversations policies
create policy "select_own_conv" on public.conversations for select using (auth.uid() = user_id);
create policy "insert_own_conv" on public.conversations for insert with check (auth.uid() = user_id);
create policy "delete_own_conv" on public.conversations for delete using (auth.uid() = user_id);

-- diary policies
create policy "select_own_diary" on public.diary_entries for select using (auth.uid() = user_id);
create policy "insert_own_diary" on public.diary_entries for insert with check (auth.uid() = user_id);
create policy "delete_own_diary" on public.diary_entries for delete using (auth.uid() = user_id);

-- activation_codes: lectura autenticada; escritura solo por service_role (backend)
create policy "read_codes" on public.activation_codes for select to authenticated using (true);

-- trigger: crear perfil automáticamente al registrarse con Google
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Amig@'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Códigos de activación pre-generados
-- ⚠️ Cámbialos antes de lanzar en producción
insert into public.activation_codes (code) values
  ('REFUGIO-PREMIUM-A1B2'),
  ('CALM-UNLOCK-C3D4'),
  ('ZEN-ACCESS-E5F6'),
  ('PEACE-CODE-G7H8'),
  ('SERENITY-KEY-I9J0'),
  ('REFUGE-VIP-K1L2'),
  ('MINDFUL-PRO-M3N4'),
  ('BREATH-PLUS-O5P6'),
  ('DIARY-FULL-Q7R8'),
  ('INNER-ACCESS-S9T0');
