-- ---------------------------------------------------------------------------
-- Email → UUID lookup function
--
-- SECURITY DEFINER lets it read auth.users (which the authenticated role
-- cannot access directly). Hardened with:
--   • set search_path = '' — fully-qualified names only; prevents schema-
--     injection attacks where a shadowing public.users table could intercept
--     the query.
--   • revoke/grant — only the authenticated role may call this; anonymous
--     callers and direct service-role access are excluded.
--   • bind parameter (p_email) — input never enters query string construction
--     so SQL injection is structurally impossible.
--   • lower() + limit 1 — normalises input and caps result set.
--
-- Note: set role = 'email_lookup' would be tighter but requires superuser
-- membership in the target role, which Supabase's hosted postgres role does
-- not have. search_path hardening is the Supabase-recommended alternative.
-- ---------------------------------------------------------------------------

create or replace function public.lookup_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select id from auth.users where email = lower(p_email) limit 1;
$$;

revoke execute on function public.lookup_user_id_by_email(text) from public;
grant  execute on function public.lookup_user_id_by_email(text) to authenticated;

-- ---------------------------------------------------------------------------
-- shopping_lists: owned by one user, visible to owner + shared members
-- ---------------------------------------------------------------------------

create table public.shopping_lists (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopping_lists enable row level security;

create trigger shopping_lists_updated_at
  before update on public.shopping_lists
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- shopping_list_shares: records which users a list has been shared with.
-- Only the owner may read or manage shares for their lists.
-- ---------------------------------------------------------------------------

create table public.shopping_list_shares (
  list_id   uuid        not null references public.shopping_lists(id) on delete cascade,
  user_id   uuid        not null references auth.users(id) on delete cascade,
  shared_at timestamptz not null default now(),
  primary key (list_id, user_id)
);

alter table public.shopping_list_shares enable row level security;

-- ---------------------------------------------------------------------------
-- Helper: returns true if the calling user owns the list OR is a shared member.
-- Used by RLS policies on shopping_lists and shopping_list_items.
-- Marked STABLE so Postgres can inline/cache it within a single query.
-- ---------------------------------------------------------------------------

create or replace function public.is_shopping_list_member(p_list_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.shopping_lists
    where id = p_list_id and owner_id = auth.uid()
  )
  or exists (
    select 1 from public.shopping_list_shares
    where list_id = p_list_id and user_id = auth.uid()
  );
$$;

-- shopping_lists RLS policies
create policy "Members can read shopping lists"
  on public.shopping_lists for select
  using (public.is_shopping_list_member(id));

create policy "Users can create own shopping lists"
  on public.shopping_lists for insert
  with check (auth.uid() = owner_id);

create policy "Owner can update shopping list"
  on public.shopping_lists for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Owner can delete shopping list"
  on public.shopping_lists for delete
  using (auth.uid() = owner_id);

-- shopping_list_shares RLS policies (owner-only)
create policy "Owner can read shares"
  on public.shopping_list_shares for select
  using (
    exists (
      select 1 from public.shopping_lists
      where id = list_id and owner_id = auth.uid()
    )
  );

create policy "Owner can add shares"
  on public.shopping_list_shares for insert
  with check (
    exists (
      select 1 from public.shopping_lists
      where id = list_id and owner_id = auth.uid()
    )
  );

create policy "Owner can remove shares"
  on public.shopping_list_shares for delete
  using (
    exists (
      select 1 from public.shopping_lists
      where id = list_id and owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- shopping_list_items: free-form text items belonging to a shopping list.
-- Owner and shared members may all read/write/delete items.
-- ---------------------------------------------------------------------------

create table public.shopping_list_items (
  id         uuid        primary key default gen_random_uuid(),
  list_id    uuid        not null references public.shopping_lists(id) on delete cascade,
  name       text        not null,
  acquired   boolean     not null default false,
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopping_list_items enable row level security;

create trigger shopping_list_items_updated_at
  before update on public.shopping_list_items
  for each row execute function public.handle_updated_at();

create policy "Members can read shopping list items"
  on public.shopping_list_items for select
  using (public.is_shopping_list_member(list_id));

create policy "Members can add shopping list items"
  on public.shopping_list_items for insert
  with check (public.is_shopping_list_member(list_id));

create policy "Members can update shopping list items"
  on public.shopping_list_items for update
  using  (public.is_shopping_list_member(list_id))
  with check (public.is_shopping_list_member(list_id));

create policy "Members can delete shopping list items"
  on public.shopping_list_items for delete
  using (public.is_shopping_list_member(list_id));
