# Publish with GitHub Pages and Supabase

GitHub Pages hosts the app; Supabase Auth and Postgres share employee accounts, settings, and attendance records.

## Supabase Setup

1. Run `supabase/schema.sql` in the Supabase SQL Editor if it has not already been applied.
2. `supabase-config.js` contains the project URL and public publishable key. Only the public key belongs in the app; never add a `service_role` key.
3. Disable public sign-ups in Supabase Authentication settings. Create the first account in Authentication > Users, then promote it in the SQL Editor, replacing the email:

	```sql
	update public.profiles
	set role = 'admin'
	where id = (select id from auth.users where email = 'admin@example.com');
	```

4. After the site is deployed, add its full GitHub Pages URL to Supabase Authentication > URL Configuration > Redirect URLs.
5. Sign in as admin, add employee directory records, create employee Auth accounts, then assign each profile its employee ID in the SQL Editor:

	```sql
	update public.profiles p
	set employee_id = e.id
	from auth.users u, public.employees e
	where p.id = u.id
	  and u.email = 'employee@example.com'
	  and e.id = 'EMP-1001';
	```

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

Attendance data is shared through the configured Supabase project. Browser-reported GPS and IP can be spoofed, so do not rely on them alone for payroll or security decisions.
