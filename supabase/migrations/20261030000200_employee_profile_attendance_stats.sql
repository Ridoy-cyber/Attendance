-- Let employees read only their own attendance rows for the profile summary.
drop policy if exists "Employees read their own attendance logs" on public.attendance_logs;
create policy "Employees read their own attendance logs"
    on public.attendance_logs for select to authenticated
    using (
        user_id = (select auth.uid())
        and emp_id = (select public.current_employee_id())
    );
