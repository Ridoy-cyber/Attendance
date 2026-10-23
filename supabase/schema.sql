create table if not exists public.employees (
    id text primary key,
    name text not null,
    dept text not null default 'General',
    type text not null default 'Full-Time',
    status text not null default 'Active' check (status in ('Active', 'Inactive')),
    created_at timestamptz not null default now()
);

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'employee' check (role in ('admin', 'employee')),
    employee_id text references public.employees(id) on delete set null,
    created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
    id integer primary key default 1 check (id = 1),
    hq_lat double precision not null default 23.8103,
    hq_lng double precision not null default 90.4125,
    allowed_radius_meters integer not null default 500 check (allowed_radius_meters > 0),
    ip_whitelist text[] not null default array['192.168.1.1', '127.0.0.1', '10.0.0.15', '203.0.113.42'],
    bypass_ip_restriction boolean not null default false,
    updated_at timestamptz not null default now()
);

create table if not exists public.attendance_logs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id),
    emp_id text not null references public.employees(id),
    emp_name text not null,
    emp_dept text not null,
    type text not null check (type in ('Clock In', 'Clock Out')),
    ip text not null,
    is_ip_valid boolean not null,
    lat double precision,
    lng double precision,
    distance integer,
    is_gps_valid boolean not null,
    note text not null default 'N/A',
    created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'admin'
    );
$$;

create or replace function public.current_employee_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select employee_id from public.profiles
    where id = (select auth.uid()) and role = 'employee'
    limit 1;
$$;

create or replace function public.create_employee_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id) values (new.id)
    on conflict (id) do nothing;
    return new;
end;
$$;

create or replace function public.set_attendance_employee_details()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    select name, dept into new.emp_name, new.emp_dept
    from public.employees
    where id = new.emp_id and status = 'Active';

    if not found then
        raise exception 'Attendance can only be recorded for an active employee';
    end if;

    if not (select public.is_admin())
        and new.emp_id <> (select public.current_employee_id()) then
        raise exception 'Employees can only record attendance for their assigned account';
    end if;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
    after insert on auth.users
    for each row execute procedure public.create_employee_profile();

insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

drop trigger if exists before_attendance_log_set_employee on public.attendance_logs;
create trigger before_attendance_log_set_employee
    before insert on public.attendance_logs
    for each row execute procedure public.set_attendance_employee_details();

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

alter table public.employees enable row level security;
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.attendance_logs enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.employees to authenticated;
grant select on public.profiles to authenticated;
grant select, update on public.app_settings to authenticated;
grant select, insert, delete on public.attendance_logs to authenticated;
revoke all on function public.is_admin() from public;
revoke all on function public.current_employee_id() from public;
revoke all on function public.create_employee_profile() from public;
revoke all on function public.set_attendance_employee_details() from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_employee_id() to authenticated;

drop policy if exists "Employees can view their own active record" on public.employees;
create policy "Employees can view their own active record"
    on public.employees for select to authenticated
    using ((status = 'Active' and id = (select public.current_employee_id())) or (select public.is_admin()));

drop policy if exists "Admins manage employees" on public.employees;
create policy "Admins manage employees"
    on public.employees for all to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

drop policy if exists "Users view their own profile and admins view all" on public.profiles;
create policy "Users view their own profile and admins view all"
    on public.profiles for select to authenticated
    using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Authenticated users read settings" on public.app_settings;
create policy "Authenticated users read settings"
    on public.app_settings for select to authenticated
    using (true);

drop policy if exists "Admins update settings" on public.app_settings;
create policy "Admins update settings"
    on public.app_settings for update to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

drop policy if exists "Admins read attendance logs" on public.attendance_logs;
create policy "Admins read attendance logs"
    on public.attendance_logs for select to authenticated
    using ((select public.is_admin()));

drop policy if exists "Employees submit their own attendance" on public.attendance_logs;
create policy "Employees submit their own attendance"
    on public.attendance_logs for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and (
            emp_id = (select public.current_employee_id())
            or (select public.is_admin())
        )
    );

drop policy if exists "Admins delete attendance logs" on public.attendance_logs;
create policy "Admins delete attendance logs"
    on public.attendance_logs for delete to authenticated
    using ((select public.is_admin()));