// Usage: npm run staff:add -- --email you@example.com --name "Sam" --role staff
// The password is read from the STAFF_PASSWORD environment variable so it never lands in shell history.
import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { createAuth } from '../src/auth.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'staff' } } });
const password = process.env.STAFF_PASSWORD;
if (!values.email || !values.name || !password) {
  console.error('Need --email, --name and STAFF_PASSWORD (12+ characters) in the environment.');
  process.exit(1);
}
if (!['staff', 'owner'].includes(values.role)) { console.error('--role must be staff or owner'); process.exit(1); }
const db = openDb(process.env.DB_PATH || 'data/kerbside.db');
createAuth({ db, sessionHours: 12 }).addStaff({ email: values.email, name: values.name, role: values.role, password });
console.log(`Added ${values.role} ${values.email}`);
