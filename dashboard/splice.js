const fs = require('fs');
const dir = 'C:/Users/divith.k/AppData/Local/Temp/claude/C--Users-divith-k-AppData-Roaming-Claude-scratch-workspaces-6f993b79-92f4-41a9-ba48-4725678e13dc-48cb24ba-fef6-4216-bc11-42d669888291-scratch-2026-09-07-f7f6c1/7a4f8234-0923-4498-8a09-edb6909d0b8d/scratchpad';
const tpl = fs.readFileSync(dir + '/dashboard_template.html', 'utf-8');
const payload = fs.readFileSync(dir + '/payload.json', 'utf-8');
const safePayload = payload.split('</script>').join('<\\/script>');
const out = tpl.replace('__PAYLOAD__', safePayload);
fs.writeFileSync(dir + '/dashboard_final.html', out);
console.log('wrote', out.length, 'chars');

// Extract the app <script> (not the payload script) and check its syntax.
const scriptStart = out.indexOf('<script>\n(function(){');
const scriptOpenEnd = out.indexOf('>', scriptStart) + 1;
const scriptClose = out.indexOf('</script>', scriptOpenEnd);
const js = out.substring(scriptOpenEnd, scriptClose);
fs.writeFileSync(dir + '/extracted_app.js', js);
console.log('extracted js', js.length, 'chars');
new Function(js); // throws on syntax error
console.log('JS SYNTAX OK');
