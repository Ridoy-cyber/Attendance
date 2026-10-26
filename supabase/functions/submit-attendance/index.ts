import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.includes('%')) ip = ip.split('%')[0];

  const octets = ip.split('.');
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return octets.map(part => String(Number(part))).join('.');
  }

  if (ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip)) {
    const halves = ip.toLowerCase().split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const validGroups = [...left, ...right].every(group => /^[0-9a-f]{1,4}$/.test(group));
    if (validGroups && (halves.length === 1 ? left.length === 8 : left.length + right.length < 8)) return ip;
  }
  return null;
}

function clientIp(req: Request): string | null {
  // Supabase's edge gateway supplies these proxy headers. Prefer the single
  // gateway address; use the first X-Forwarded-For entry when it is absent.
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return normalizeIp(req.headers.get('cf-connecting-ip'))
    ?? normalizeIp(req.headers.get('x-real-ip'))
    ?? normalizeIp(forwarded ?? null);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return response({ error: 'Attendance service is not configured.' }, 500);

  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return response({ error: 'Sign in to submit attendance.' }, 401);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return response({ error: 'Sign in to submit attendance.' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return response({ error: 'Invalid attendance request.' }, 400);
  }

  const ip = clientIp(req);
  if (!ip) return response({ error: 'Attendance failed: Unregistered IP network.' }, 403);
  if (body.action === 'get-ip') {
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role !== 'admin') return response({ error: 'Only an administrator can use this action.' }, 403);
    return response({ ip });
  }
  const { data: allowed, error: ipError } = await adminClient.from('allowed_ips')
    .select('id').eq('ip_address', ip).eq('is_active', true).maybeSingle();
  if (ipError) return response({ error: 'Could not verify the attendance network.' }, 503);
  if (!allowed) return response({ error: 'Attendance failed: Unregistered IP network.' }, 403);

  const { data: profile, error: profileError } = await adminClient.from('profiles')
    .select('role, employee_id').eq('id', user.id).maybeSingle();
  if (profileError || !profile) return response({ error: 'Attendance account is not configured.' }, 403);

  const empId = typeof body.emp_id === 'string' ? body.emp_id : '';
  const type = body.type;
  const photo = body.face_photo_data;
  const note = typeof body.note === 'string' ? body.note : 'N/A';
  if (!empId || !['Clock In', 'Clock Out'].includes(String(type))) {
    return response({ error: 'Choose a valid employee and clock action.' }, 400);
  }
  if (profile.role !== 'admin' && (profile.role !== 'employee' || profile.employee_id !== empId)) {
    return response({ error: 'Employees can only record attendance for their assigned account.' }, 403);
  }
  if (typeof photo !== 'string' || !photo.startsWith('data:image/jpeg;base64,') || photo.length > 600000) {
    return response({ error: 'A valid attendance photo is required (JPEG under 450 KB).' }, 400);
  }
  const { data: employee, error: employeeError } = await adminClient.from('employees')
    .select('id').eq('id', empId).eq('status', 'Active').maybeSingle();
  if (employeeError || !employee) return response({ error: 'Attendance can only be recorded for an active employee.' }, 400);

  const { data, error } = await adminClient.from('attendance_logs').insert({
    user_id: user.id,
    emp_id: empId,
    type,
    ip,
    is_ip_valid: true,
    is_gps_valid: true,
    face_photo_data: photo,
    note: note.trim() || 'N/A',
  }).select('id').single();

  if (error) return response({ error: error.message }, 400);
  return response({ success: true, id: data.id });
});
