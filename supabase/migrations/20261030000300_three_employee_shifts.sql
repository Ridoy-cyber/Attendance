-- Assign employees to one of the supported eight-hour shifts and keep a shift snapshot on each attendance event.
alter table public.employees
    add column if not exists shift text not null default 'Night';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.employees'::regclass
          and conname = 'employees_shift_check'
    ) then
        alter table public.employees
            add constraint employees_shift_check check (shift in ('Morning', 'Noon', 'Night'));
    end if;
end;
$$;

alter table public.attendance_logs
    add column if not exists shift text not null default 'Night';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.attendance_logs'::regclass
          and conname = 'attendance_logs_shift_check'
    ) then
        alter table public.attendance_logs
            add constraint attendance_logs_shift_check check (shift in ('Morning', 'Noon', 'Night'));
    end if;
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

    new.lat := null;
    new.lng := null;
    new.accuracy_meters := null;
    new.distance := null;
    new.is_gps_valid := true;
    new.face_photo_expires_at := now() + interval '20 days';
    return new;
end;
$$;
