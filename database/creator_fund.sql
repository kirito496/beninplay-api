-- ── Fonds créateur : gains fractionnaires (ex: 0,75 FCFA / like) ────────────
-- À exécuter une fois dans Supabase (SQL editor). Idempotent.

-- Solde "en attente" : accumule les centimes (< 1 FCFA) tant qu'on n'a pas de
-- quoi verser un FCFA entier au portefeuille.
alter table users add column if not exists pending_earnings numeric not null default 0;

-- Ajoute un gain fractionnaire et verse au portefeuille les FCFA ENTIERS
-- disponibles (atomique). Renvoie le nombre de FCFA versés (0 si rien).
create or replace function add_creator_earning(p_user uuid, p_amount numeric)
returns integer
language plpgsql
as $$
declare
  whole integer;
begin
  update users
     set pending_earnings = coalesce(pending_earnings, 0) + p_amount
   where id = p_user;

  select floor(coalesce(pending_earnings, 0))::int into whole
    from users where id = p_user;

  if whole is null then
    return 0;
  end if;

  if whole >= 1 then
    update users
       set wallet_balance   = coalesce(wallet_balance, 0) + whole,
           pending_earnings = coalesce(pending_earnings, 0) - whole
     where id = p_user;
    return whole;
  end if;

  return 0;
end;
$$;
