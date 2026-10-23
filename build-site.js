const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.join(root, 'site');
const htmlFile = 'employee_attendance_location_verification_system (2).html';

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, htmlFile), path.join(output, 'index.html'));
fs.copyFileSync(path.join(root, 'cloud.js'), path.join(output, 'cloud.js'));
fs.copyFileSync(path.join(root, 'supabase-config.js'), path.join(output, 'supabase-config.js'));

console.log(`Static site created at ${output}`);