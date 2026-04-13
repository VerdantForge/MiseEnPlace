-- Create recipes table. Users may only read and modify their own rows via RLS.

create table public.recipes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  title      text        not null,
  content    text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.recipes enable row level security;

create policy "Users can read own recipes"
  on public.recipes for select
  using (auth.uid() = user_id);

create policy "Users can create own recipes"
  on public.recipes for insert
  with check (auth.uid() = user_id);

create policy "Users can update own recipes"
  on public.recipes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own recipes"
  on public.recipes for delete
  using (auth.uid() = user_id);

-- Auto-update updated_at on every row modification
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger recipes_updated_at
  before update on public.recipes
  for each row execute function public.handle_updated_at();
