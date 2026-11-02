-- Run this migration in Supabase SQL Editor.
-- Do not put the service-role key in browser code.
create extension if not exists pgcrypto;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null,
  status text not null default 'pending' check (status in ('active','expired','cancelled','pending')),
  plan_name text not null default 'Monthly subscription',
  amount_inr numeric(10,2) not null default 99,
  started_at timestamptz,
  expires_at timestamptz,
  provider_subscription_id text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists subscriptions_uid_idx on public.subscriptions(firebase_uid);
create index if not exists subscriptions_expiry_idx on public.subscriptions(expires_at);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text,
  student_name text,
  student_email text,
  provider text not null default 'manual',
  provider_payment_id text unique,
  amount_inr numeric(10,2) not null default 99,
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('created','pending','paid','failed','refunded')),
  invoice_number text unique,
  invoice_sent_at timestamptz,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  raw_event jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payments_uid_idx on public.payments(firebase_uid);
create index if not exists payments_created_idx on public.payments(created_at desc);

create table if not exists public.pdf_view_events (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null,
  student_name text,
  student_email text,
  material_id text not null,
  material_title text not null,
  viewed_at timestamptz not null default now()
);
create index if not exists pdf_view_events_viewed_idx on public.pdf_view_events(viewed_at desc);
create index if not exists pdf_view_events_uid_idx on public.pdf_view_events(firebase_uid);

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  topic text not null default 'General enquiry',
  message text not null,
  status text not null default 'new' check (status in ('new','in_progress','resolved')),
  created_at timestamptz not null default now()
);

-- Server uses the Supabase service-role key, which bypasses RLS.
-- Browser clients should not read or write these admin-only tables.
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.pdf_view_events enable row level security;
alter table public.enquiries enable row level security;

drop policy if exists "No direct client access subscriptions" on public.subscriptions;
create policy "No direct client access subscriptions" on public.subscriptions for all using (false) with check (false);
drop policy if exists "No direct client access payments" on public.payments;
create policy "No direct client access payments" on public.payments for all using (false) with check (false);
drop policy if exists "No direct client access PDF views" on public.pdf_view_events;
create policy "No direct client access PDF views" on public.pdf_view_events for all using (false) with check (false);
drop policy if exists "No direct client access enquiries" on public.enquiries;
create policy "No direct client access enquiries" on public.enquiries for all using (false) with check (false);
