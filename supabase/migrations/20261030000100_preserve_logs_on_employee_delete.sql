-- Attendance rows contain an employee ID/name snapshot and should outlive the directory record.
-- Remove the employee foreign key so admins can permanently delete a directory entry
-- without deleting the attendance history or changing its recorded employee details.
alter table public.attendance_logs
    drop constraint if exists attendance_logs_emp_id_fkey;
