-- Add metadata fields to recipes
alter table public.recipes
  add column source        text,
  add column tested        boolean not null default false,
  add column variant_of    uuid references public.recipes(id) on delete set null,
  add column variant_label text;

-- ---------------------------------------------------------------------------
-- recipe_lists: user-defined named collections of recipes
-- ---------------------------------------------------------------------------

create table public.recipe_lists (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.recipe_lists enable row level security;

create policy "Users can read own lists"
  on public.recipe_lists for select
  using (auth.uid() = user_id);

create policy "Users can create own lists"
  on public.recipe_lists for insert
  with check (auth.uid() = user_id);

create policy "Users can update own lists"
  on public.recipe_lists for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own lists"
  on public.recipe_lists for delete
  using (auth.uid() = user_id);

create trigger recipe_lists_updated_at
  before update on public.recipe_lists
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- recipe_list_items: many-to-many join between recipes and lists
-- ---------------------------------------------------------------------------

create table public.recipe_list_items (
  list_id    uuid        not null references public.recipe_lists(id) on delete cascade,
  recipe_id  uuid        not null references public.recipes(id) on delete cascade,
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (list_id, recipe_id)
);

alter table public.recipe_list_items enable row level security;

create policy "Users can read own list items"
  on public.recipe_list_items for select
  using (auth.uid() = user_id);

create policy "Users can create own list items"
  on public.recipe_list_items for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own list items"
  on public.recipe_list_items for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- recipe_notes: time-stamped observations attached to a recipe
-- ---------------------------------------------------------------------------

create table public.recipe_notes (
  id         uuid        primary key default gen_random_uuid(),
  recipe_id  uuid        not null references public.recipes(id) on delete cascade,
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  content    text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recipe_notes enable row level security;

create policy "Users can read own notes"
  on public.recipe_notes for select
  using (auth.uid() = user_id);

create policy "Users can create own notes"
  on public.recipe_notes for insert
  with check (auth.uid() = user_id);

create policy "Users can update own notes"
  on public.recipe_notes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own notes"
  on public.recipe_notes for delete
  using (auth.uid() = user_id);

create trigger recipe_notes_updated_at
  before update on public.recipe_notes
  for each row execute function public.handle_updated_at();
