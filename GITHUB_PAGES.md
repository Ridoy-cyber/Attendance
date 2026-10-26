# Publish with GitHub Pages and Supabase

GitHub Pages hosts the app; Supabase Auth and Postgres share employee accounts, settings, and attendance records.

## Supabase Setup

1. Run or rerun the current `supabase/schema.sql` in the Supabase SQL Editor to install or update the tables, triggers, and row-level security policies. This schema also creates the location rules table required for admin-approved and blocked areas.
2. Run `supabase/migrations/20261026000100_ip_restricted_attendance.sql` in the SQL Editor, then deploy `supabase/functions/submit-attendance` as a Supabase Edge Function. Supabase supplies the `SUPABASE_SERVICE_ROLE_KEY` secret to the function; never add that key to the app.
3. Sign in as admin and open **Admin Portal > Allowed IPs**. Use **Use This Network's IP** to fill the current network's public IP, then add it. Attendance submissions are blocked until an active address matches.
4. Disable public sign-ups in Supabase Authentication settings. Create the first account in Authentication > Users, then promote it in the SQL Editor, replacing the email:

	```sql
	update public.profiles
	set role = 'admin'
	where id = (select id from auth.users where email = 'admin@example.com');
	```

5. After the site is deployed, add its full GitHub Pages URL to Supabase Authentication > URL Configuration > Redirect URLs.
6. Sign in as admin, add employee directory records, create employee Auth accounts, then assign each profile its employee ID in the SQL Editor:

	```sql
	update public.profiles p
	set employee_id = e.id
	from auth.users u, public.employees e
	where p.id = u.id
	  and u.email = 'employee@example.com'
	  and e.id = 'EMP-1001';
	```

7. In **Admin Portal > Location Rules**, add a named coordinate and radius, then choose **Approve** or **Block**. Approved areas allow check-ins outside HQ; a block rule overrides HQ and all approved areas. Paused rules are ignored. Rules apply to all employees.
8. In **Employee Directory**, admins can set optional latitude and longitude for an employee, including filling them from the current device. That employee's coordinates become their geofence center and use the configured geofence radius; leave both blank to use the shared HQ center.

`supabase-config.js` contains the project URL and public publishable key. Only the public key belongs in the app; never add a `service_role` key.

## GitHub Pages

This repository includes a GitHub Actions workflow that builds and publishes the app whenever a commit is pushed to `main`.

1. The empty repository is `Ridoy-cyber/Attendance`. For free GitHub Pages hosting, it must be public unless your GitHub plan supports Pages for private repositories.
2. From this project folder, initialize and push the code:

	```powershell
	git init -b main
	git add .
	git commit -m "Publish attendance page"
	git remote add origin https://github.com/Ridoy-cyber/Attendance.git
	git push -u origin main
	```

	Keep `node_modules`, `dist`, and `release` out of Git; `.gitignore` already excludes them. If Git asks who you are, set `git config --global user.name` and `git config --global user.email` first.
3. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
4. Open **Actions** and wait for the **Deploy attendance page** workflow to finish. GitHub will show the public URL, usually `https://Ridoy-cyber.github.io/Attendance/`.

Attendance data is shared through the configured Supabase project. Browser-reported GPS can be spoofed, so do not rely on it alone for payroll or security decisions.
