create table if not exists public.allowed_ips (
    id uuid primary key default gen_random_uuid(),
    ip_address text not null unique,
    description text not null default '',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint allowed_ips_address_not_blank check (length(trim(ip_address)) > 0)
);

alter table public.allowed_ips enable row level security;
grant select, insert, update, delete on public.allowed_ips to authenticated;

drop policy if exists "Admins manage allowed IPs" on public.allowed_ips;
create policy "Admins manage allowed IPs"
    on public.allowed_ips for all to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

-- All attendance writes must pass through the Edge Function, which checks
-- the gateway supplied client IP before using its service role credential.
revoke insert on public.attendance_logs from anon, authenticated;
drop policy if exists "Employees submit their own attendance" on public.attendance_logs;

create or replace function public.set_attendance_employee_details()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    select name, dept
    into new.emp_name, new.emp_dept
    from public.employees
    where id = new.emp_id and status = 'Active';

    if not found then
        raise exception 'Attendance can only be recorded for an active employee';
    end if;

    -- The Edge Function verifies the signed-in profile and assignment before
    -- writing with service_role. Every other write remains user-bound.
    if auth.role() <> 'service_role' and not (select public.is_admin()) then
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

    new.lat := null;
    new.lng := null;
    new.accuracy_meters := null;
    new.distance := null;
    new.is_gps_valid := true;
    new.face_photo_expires_at := now() + interval '20 days';
    return new;
end;
$$;
