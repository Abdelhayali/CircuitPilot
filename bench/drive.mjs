// Answer one step of a PCB Bench run started with --provider driver, print what the model sees next.
//   node bench/drive.mjs intro                      (system prompt + tools, once)
//   node bench/drive.mjs next                       (the current observation)
//   node bench/drive.mjs reply '{"calls":[{"name":"run_erc","args":{}}]}'   (tool calls)
//   node bench/drive.mjs reply '{"text":"Done: …"}'                         (final answer, ends the task)
const [cmd, body] = process.argv.slice(2);
const url = 'http://localhost:8099/' + (cmd === 'intro' ? 'intro' : cmd === 'reply' ? 'reply' : 'next');
const r = await fetch(url, { method: cmd === 'reply' ? 'POST' : 'GET', body: cmd === 'reply' ? body : undefined });
const j = await r.json();
if (cmd === 'intro') { console.log(j.system); for (const t of j.tools) console.log(`\n## ${t.name}: ${t.description}\n${JSON.stringify(t.input_schema.properties || {})}${t.input_schema.required ? ' required ' + JSON.stringify(t.input_schema.required) : ''}`); }
else console.log(JSON.stringify(j, null, 1));
