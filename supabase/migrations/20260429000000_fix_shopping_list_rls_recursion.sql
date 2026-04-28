-- ---------------------------------------------------------------------------
-- Fix: mutual RLS recursion between shopping_lists and shopping_list_shares
--
-- Root cause:
--   The SELECT policy on shopping_lists called is_shopping_list_member(id),
--   which issued a subquery against shopping_lists itself. When PostgREST
--   evaluates the RETURNING clause of an INSERT, it applies the SELECT policy
--   to each returned row. That SELECT policy called is_shopping_list_member,
--   which queried shopping_lists (triggering the SELECT policy again), which
--   queried shopping_list_shares (whose SELECT policy queried shopping_lists)
--   → infinite mutual recursion → "violates row-level security policy" error.
--
-- Fix:
--   1. Add is_shared_shopping_list_member() — a SECURITY DEFINER function that
--      only queries shopping_list_shares (no recursion to shopping_lists).
--   2. Rewrite the shopping_lists SELECT policy to use a direct owner_id column
--      comparison (which references the current row, not a subquery) plus the
--      new shares-only helper.
--   3. Update is_shopping_list_member() to use the new helper instead of the
--      shopping_list_shares subquery, so shopping_list_items policies also
--      avoid the mutual recursion path.
-- ---------------------------------------------------------------------------

-- Step 1: SECURITY DEFINER helper that only touches shopping_list_shares.
-- SECURITY DEFINER bypasses RLS on shopping_list_shares, breaking the cycle.
-- search_path = '' ensures fully-qualified names only (schema-injection safe).
create or replace function public.is_shared_shopping_list_member(p_list_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.shopping_list_shares
    where list_id = p_list_id and user_id = auth.uid()
  );
$$;

-- Step 2: Rewrite shopping_lists SELECT policy.
-- owner_id = auth.uid() is a direct column reference on the row being evaluated
-- (no subquery, no recursion). The shares check uses the helper above.
drop policy "Members can read shopping lists" on public.shopping_lists;

create policy "Members can read shopping lists"
  on public.shopping_lists for select
  using (
    owner_id = auth.uid()
    or public.is_shared_shopping_list_member(id)
  );

-- Step 3: Update is_shopping_list_member so shopping_list_items RLS policies
-- (which call this function) also route through the non-recursive helper.
create or replace function public.is_shopping_list_member(p_list_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.shopping_lists
    where id = p_list_id and owner_id = auth.uid()
  )
  or public.is_shared_shopping_list_member(p_list_id);
$$;
