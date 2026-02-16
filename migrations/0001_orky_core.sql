create table if not exists orky_runs (
  id uuid primary key default gen_random_uuid(),
  jira_key text not null,
  cursor_state text not null,
  cursor_step text not null,
  cursor_attempt int not null default 0,
  locked_by text null,
  lock_expires_at timestamptz null,
  max_autofix_attempts int not null default 3,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_orky_runs_jira_key_active
on orky_runs (jira_key);

create table if not exists orky_idempotency_keys (
  id bigserial primary key,
  scope text not null,
  key text not null,
  run_id uuid null references orky_runs(id) on delete set null,
  status text not null default 'RESERVED',
  created_at timestamptz not null default now(),
  result_json jsonb null,
  unique (scope, key)
);

create table if not exists orky_audit_log (
  id bigserial primary key,
  timestamp timestamptz not null default now(),
  jira_key text not null,
  run_id uuid null references orky_runs(id) on delete set null,
  correlation_id uuid not null,
  phase text not null,
  tool text not null,
  action text not null,
  idempotency_scope text not null,
  idempotency_key text not null,
  result text null,
  details jsonb null,
  unique (correlation_id, phase),
  check (phase in ('INTENT','RESULT'))
);

create table if not exists orky_artifacts (
  id bigserial primary key,
  run_id uuid not null references orky_runs(id) on delete cascade,
  type text not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (run_id, type)
);

