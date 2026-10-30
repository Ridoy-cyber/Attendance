create table if not exists public.employees (
    id text primary key,
    name text not null,
    dept text not null default 'General',
    type text not null default 'Full-Time',
    shift text not null default 'Night' check (shift in ('Morning', 'Noon', 'Night')),
    status text not null default 'Active' check (status in ('Active', 'Inactive')),
    location_lat double precision check (location_lat between -90 and 90),
    location_lng double precision check (location_lng between -180 and 180),
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
    max_location_accuracy_meters integer not null default 200 check (max_location_accuracy_meters > 0),
    ip_whitelist text[] not null default array['192.168.1.1', '127.0.0.1', '10.0.0.15', '203.0.113.42'],
    bypass_ip_restriction boolean not null default false,
    updated_at timestamptz not null default now()
);

create table if not exists public.attendance_logs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id),
    -- Keep employee ID as an attendance-time snapshot so employee records can be deleted without erasing history.
    emp_id text not null,
    emp_name text not null,
    emp_dept text not null,
    shift text not null default 'Night' check (shift in ('Morning', 'Noon', 'Night')),
    type text not null check (type in ('Clock In', 'Clock Out')),
    ip text not null,
    is_ip_valid boolean not null,
    lat double precision,
    lng double precision,
    accuracy_meters double precision,
    distance integer,
    is_gps_valid boolean not null,
    face_photo_data text,
    face_photo_expires_at timestamptz,
    note text not null default 'N/A',
    created_at timestamptz not null default now()
);

create table if not exists public.location_rules (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    lat double precision not null check (lat between -90 and 90),
    lng double precision not null check (lng between -180 and 180),
    radius_meters integer not null check (radius_meters > 0),
    decision text not null check (decision in ('approve', 'block')),
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.allowed_ips (
    id uuid primary key default gen_random_uuid(),
    ip_address text not null unique,
    description text not null default '',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint allowed_ips_address_not_blank check (length(trim(ip_address)) > 0)
);

alter table public.app_settings
    add column if not exists max_location_accuracy_meters integer not null default 200;
alter table public.app_settings
    alter column max_location_accuracy_meters set default 200;
alter table public.employees
    add column if not exists location_lat double precision,
    add column if not exists location_lng double precision;
alter table public.employees
    drop constraint if exists employees_location_coordinates_valid;
alter table public.employees
    add constraint employees_location_coordinates_valid check (
        (location_lat is null and location_lng is null)
        or (location_lat between -90 and 90 and location_lng between -180 and 180)
    );
alter table public.attendance_logs
    add column if not exists accuracy_meters double precision;
alter table public.attendance_logs
    alter column accuracy_meters drop not null,
    alter column accuracy_meters drop default;
alter table public.attendance_logs
    add column if not exists face_photo_data text,
    add column if not exists face_photo_expires_at timestamptz;
create index if not exists attendance_logs_photo_expiry_idx
    on public.attendance_logs (face_photo_expires_at)
    where face_photo_data is not null;

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
    select name, dept, shift
    into new.emp_name, new.emp_dept, new.shift
    from public.employees
    where id = new.emp_id and status = 'Active';

    if not found then
        raise exception 'Attendance can only be recorded for an active employee';
    end if;

    -- Service-role writes are issued only by the authenticated Edge Function,
    -- which verifies the user's profile and employee assignment before insert.
    if coalesce(auth.role(), '') <> 'service_role' and not (select public.is_admin()) then
        if new.user_id is distinct from (select auth.uid()) then
            raise exception 'Attendance user must match the signed-in account';
        end if;

        if (select public.current_employee_id()) is null
            or new.emp_id is distinct from (select public.current_employee_id()) then
            raise exception 'Employees can only record attendance for their assigned account';
        end if;
    end if;

    if new.face_photo_data is null
        or new.face_photo_data not like 'data:image/jpeg;base64,%'
        or length(new.face_photo_data) > 600000 then
        raise exception 'A valid attendance photo is required (JPEG under 450 KB)';
    end if;

    -- Keep legacy location columns nullable for old records, but do not collect
    -- or validate location for new attendance entries.
    new.lat := null;
    new.lng := null;
    new.accuracy_meters := null;
    new.distance := null;
    new.is_gps_valid := true;
    new.face_photo_expires_at := now() + interval '20 days';
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

-- Keep the configured administrator account in the admin role when this schema is applied.
update public.profiles p
set role = 'admin', employee_id = null
from auth.users u
where p.id = u.id
  and lower(u.email) = lower('ridoy@innovatesolution.com');

drop trigger if exists before_attendance_log_set_employee on public.attendance_logs;
create trigger before_attendance_log_set_employee
    before insert on public.attendance_logs
    for each row execute procedure public.set_attendance_employee_details();

insert into public.app_settings (id) values (1) on conflict (id) do nothing;
update public.app_settings
set max_location_accuracy_meters = 200
where id = 1 and max_location_accuracy_meters = 100;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
    'expire-attendance-photos',
    '* * * * *',
    $$update public.attendance_logs
      set face_photo_data = null
      where face_photo_data is not null
        and face_photo_expires_at <= now()$$
);

alter table public.employees enable row level security;
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.attendance_logs enable row level security;
alter table public.location_rules enable row level security;
alter table public.allowed_ips enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.employees to authenticated;
grant select on public.profiles to authenticated;
grant select, update on public.app_settings to authenticated;
grant select, insert, delete on public.attendance_logs to authenticated;
grant select, insert, update, delete on public.location_rules to authenticated;
grant select, insert, update, delete on public.allowed_ips to authenticated;
revoke insert on public.attendance_logs from anon, authenticated;
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

drop policy if exists "Authenticated users view active location rules" on public.location_rules;
create policy "Authenticated users view active location rules"
    on public.location_rules for select to authenticated
    using (is_active or (select public.is_admin()));

drop policy if exists "Admins manage location rules" on public.location_rules;
create policy "Admins manage location rules"
    on public.location_rules for all to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

drop policy if exists "Admins read attendance logs" on public.attendance_logs;
create policy "Admins read attendance logs"
    on public.attendance_logs for select to authenticated
    using ((select public.is_admin()));

drop policy if exists "Employees read their own attendance logs" on public.attendance_logs;
create policy "Employees read their own attendance logs"
    on public.attendance_logs for select to authenticated
    using (
        user_id = (select auth.uid())
        and emp_id = (select public.current_employee_id())
    );

drop policy if exists "Employees submit their own attendance" on public.attendance_logs;

drop policy if exists "Admins delete attendance logs" on public.attendance_logs;
create policy "Admins delete attendance logs"
    on public.attendance_logs for delete to authenticated
    using ((select public.is_admin()));

drop policy if exists "Admins manage allowed IPs" on public.allowed_ips;
create policy "Admins manage allowed IPs"
    on public.allowed_ips for all to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));
