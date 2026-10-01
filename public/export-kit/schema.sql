-- ============================================================
-- Base de données de VOTRE application (Supabase / PostgreSQL)
-- À exécuter une fois dans Supabase : SQL Editor -> coller -> Run.
-- (Nécessaire seulement si vous voulez une base partagée et permanente.
--  Sans Supabase, l'application utilise un simple fichier local data.json.)
-- ============================================================

-- Données partagées (ce que Batisseur.save / Batisseur.list utilisent)
create table if not exists submissions (
  id text primary key,
  collection text,
  data jsonb,
  created_at timestamptz default now()
);
create index if not exists submissions_coll_idx on submissions (collection, created_at desc);

-- Comptes membres de l'application
create table if not exists app_users (
  id text primary key,
  email text unique,
  name text,
  pass text,
  created_at timestamptz default now()
);

-- Sessions de connexion des membres
create table if not exists app_sessions (
  token text primary key,
  user_id text,
  created_at timestamptz default now()
);
