import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = args[0];
if (mode === 'auth') console.log(JSON.stringify({ token: process.env.AMBI_API_TOKEN, url: process.env.AMBI_API_URL, home: process.env.HOME }));
else if (mode === 'fail') { console.error(`Bearer ${process.env.AMBI_API_TOKEN}`); process.exitCode = 2; }
else if (mode === 'invalid') console.log('not JSON');
else if (mode === 'catalog') console.log('tasks create --title <title>');
else if (mode === 'unicode') {
  const bytes = Buffer.from('{"summary":"caf\u00e9"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
} else if (mode === 'hang') {
  if (args[1]) fs.writeFileSync(args[1], String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'partial') process.stdout.write('{"unfinished":');
else if (mode === 'api') console.log(JSON.stringify({ id: 'user-test', workspace_id: 'workspace-test' }));
else if (mode === 'notifications' && args[1] === 'poll') console.log(JSON.stringify({ events: [], has_more: false }));
else if (mode === 'notifications' && args[1] === 'watch') setInterval(() => {}, 1000);
else throw new Error('Unexpected fixture command');
