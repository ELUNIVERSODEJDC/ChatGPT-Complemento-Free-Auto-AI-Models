import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { translateRequest, generate, createGateway, MODEL, SUPER_MODEL, MINIMAX_MODEL, DEEPSEEK_MODEL, GLM_MODEL, KILO_MODEL, PLUGIN_MODELS, MODEL_SETTINGS, mergeCatalog, nemotronCatalogEntry } from '../plugins/minimax-jdc/runtime/gateway.mjs';
import { setProvider, topLevel, visionFixture } from '../plugins/minimax-jdc/runtime/configurar.mjs';
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const tool = { type: 'function', name: 'echo_marker', parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } };
function upstream(chunks) {
  return new Response(chunks.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
function textChunk(text, finish = null) { return { choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }; }

const searchTool = { type: 'tool_search', execution: 'client', description: 'Search the actual Codex deferred tool inventory.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } };
const execTool = { type: 'custom', name: 'exec', description: 'Run JavaScript with client-provided tools.' };

test('Kilo Auto Free uses its anonymous route, preserves tools and never forwards credentials or NVIDIA parameters', async () => {
  let sent;
  const result=await generate({model:KILO_MODEL,input:[{type:'additional_tools',role:'developer',tools:[
    {type:'namespace',name:'functions',tools:[execTool]}]},{role:'user',content:'Call the tool.'}],parallel_tool_calls:true},()=>{},
    {key:'must-not-leave-client',fetcher:async(url,init)=>{
      assert.equal(url,'https://ai-gateway.kilo.ai/api/v1/chat/completions');
      assert.deepEqual(init.headers,{'Content-Type':'application/json'});
      sent=JSON.parse(init.body);
      return upstream([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'kilo-call',function:{name:'functions__exec',arguments:'{"input":"text(42);"}'}}]},finish_reason:'tool_calls'}]},'[DONE]']);
    }});
  assert.equal(sent.model,'kilo-auto/free');assert.equal(sent.chat_template_kwargs,undefined);
  assert.equal(sent.reasoning_effort,undefined);assert.equal(sent.parallel_tool_calls,undefined);
  assert.equal(result.output[0].namespace,'functions');assert.equal(result.output[0].input,'text(42);');
  assert.equal(result.end_turn,false);
  const m=MODEL_SETTINGS.get(KILO_MODEL).catalog;
  assert.deepEqual(m.input_modalities,['text']);assert.equal(m.context_window,256000);
  assert.throws(()=>translateRequest({model:KILO_MODEL,input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,x'}]}]}));
});

test('Kilo HTTP route needs no stored key and rejects retired NVIDIA and paid aliases without external inference', async () => {
  let calls=0;
  const server=createGateway({allowedModels:[KILO_MODEL],keyProvider:async()=>{throw new Error('credential read forbidden');},
    fetcher:async(url,init)=>{
      if(url.includes('/models?'))return Response.json({models:[]});
      calls++;assert.ok(url.startsWith('https://ai-gateway.kilo.ai/'));
      assert.equal(init.headers.Authorization,undefined);
      return upstream([textChunk('KILO_OK','stop'),'[DONE]']);
    }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal((await (await fetch(base+'/health')).json()).authenticationRequired,false);
    for(const model of [MINIMAX_MODEL,DEEPSEEK_MODEL,GLM_MODEL,'kilo-auto/frontier']){
      const response=await fetch(base+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer openai-only','Content-Type':'application/json'},body:JSON.stringify({model,input:'hi',stream:false})});
      assert.equal(response.status,404);await response.body.cancel();
    }
    const response=await fetch(base+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer openai-only','Content-Type':'application/json'},body:JSON.stringify({model:KILO_MODEL,input:'hi',stream:false})});
    assert.equal(response.status,200);assert.equal((await response.json()).output[0].content[0].text,'KILO_OK');assert.equal(calls,1);
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

test('Kilo quota errors preserve the provider and status without credentials or a paid fallback', async()=>{
  let calls=0;
  await assert.rejects(generate({model:KILO_MODEL,input:'hi'},()=>{}, {fetcher:async()=>{
    calls++;return Response.json({error:{message:'Free quota reached'}},{status:429});
  }}),error=>error.status===429&&error.code==='kilo_http_429'&&/Free quota/.test(error.message));
  assert.equal(calls,1);
});
const litePrefix = () => ({ type: 'additional_tools', role: 'developer', tools: [
  { type: 'namespace', name: 'functions', tools: [execTool] }, searchTool ] });
const searchCall = () => ({ type: 'tool_search_call', execution: 'client', call_id: 'discovery_1', status: 'completed', arguments: { query: 'echo marker' } });
const searchOutput = () => ({ type: 'tool_search_output', execution: 'client', call_id: 'discovery_1', status: 'completed',
  tools: [{ type: 'namespace', name: 'mcp_fixture', tools: [{ ...tool, defer_loading: true }] }] });

test('DeepSeek and GLM preserve their own reasoning contracts and native client tool presentation', () => {
  for (const model of [DEEPSEEK_MODEL, GLM_MODEL]) {
    const metadata=MODEL_SETTINGS.get(model).catalog;
    assert.equal(metadata.context_window,1048576);
    assert.equal(metadata.tool_mode,'code_mode_only');
    assert.equal(metadata.use_responses_lite,true);
    assert.equal(metadata.supports_search_tool,true);
    assert.deepEqual(metadata.input_modalities,['text','image']);
    assert.throws(()=>translateRequest({model,input:'hi',reasoning:{effort:'medium'}}),{code:'unsupported_effort'});
  }
  for(const [effort,value] of Object.entries({low:25,high:50,xhigh:75,max:100})) {
    const {body}=translateRequest({model:DEEPSEEK_MODEL,input:'hi',reasoning:{effort}});
    assert.deepEqual(body.chat_template_kwargs,{thinking:true,reasoning_effort:value});
    assert.equal(body.model,DEEPSEEK_MODEL);
  }
  for(const effort of ['low','high','max']) {
    const {body}=translateRequest({model:GLM_MODEL,input:'hi',reasoning:{effort}});
    assert.equal(body.reasoning_effort,effort);
    assert.deepEqual(body.chat_template_kwargs,{clear_thinking:true});
  }
});

test('GLM image limit covers direct images and replayed tool attachments without dropping them', () => {
  const image={type:'input_image',image_url:'data:image/png;base64,fixture'};
  const images=count=>Array.from({length:count},()=>image);
  const valid=translateRequest({model:GLM_MODEL,input:[{role:'user',content:images(8)}]});
  assert.equal(valid.body.messages[0].content.length,8);
  assert.throws(()=>translateRequest({model:GLM_MODEL,input:[{role:'user',content:images(9)}]}),{code:'too_many_images'});
  assert.throws(()=>translateRequest({model:GLM_MODEL,tools:[tool],input:[{role:'user',content:images(8)},
    {type:'function_call',name:tool.name,call_id:'image-limit',arguments:'{}'},
    {type:'function_call_output',call_id:'image-limit',output:[image]}]}),{code:'too_many_images'});
});

test('both added models complete namespaced Code Mode calls and matching image tool replay', async () => {
  for(const model of [DEEPSEEK_MODEL,GLM_MODEL]) {
    const action=await generate({model,input:[litePrefix(),{role:'user',content:'Use the fixture tool.'}]},()=>{},
      {key:'test-only',fetcher:async()=>upstream([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'new-model-call',type:'function',
        function:{name:'functions__exec',arguments:JSON.stringify({input:'text("fixture");'})}}]},finish_reason:'tool_calls'}]},'[DONE]'])});
    assert.equal(action.end_turn,false);assert.equal(action.output[0].namespace,'functions');
    assert.equal(action.output[0].input,'text("fixture");');
    let sent;
    const final=await generate({model,input:[litePrefix(),{role:'user',content:'Describe the image.'},...action.output,
      {type:'custom_tool_call_output',call_id:'new-model-call',output:[{type:'input_text',text:'marker'},
        {type:'input_image',image_url:'data:image/png;base64,fixture'}]}]},()=>{},
      {key:'test-only',fetcher:async(_,options)=>{sent=JSON.parse(options.body);return upstream([textChunk('red marker','stop'),'[DONE]']);}});
    assert.equal(final.end_turn,true);
    assert.equal(sent.messages.at(-1).content[1].image_url.url,'data:image/png;base64,fixture');
    assert.match(sent.messages.at(-1).content[0].text,/marker/);
  }
});

test('DeepSeek and GLM strict JSON uses a complete upstream response while emitting valid Responses events', async () => {
  for(const model of [DEEPSEEK_MODEL,GLM_MODEL]) {
    let sent;const events=[];
    const result=await generate({model,input:'Return ok.',text:{format:{type:'json_schema',name:'check',strict:true,
      schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}},event=>events.push(event),
      {key:'test-only',fetcher:async(_,options)=>{sent=JSON.parse(options.body);return Response.json({choices:[{index:0,message:{content:'{"ok":true}'},finish_reason:'stop'}]});}});
    assert.equal(sent.stream,false);assert.equal(sent.stream_options,undefined);
    assert.equal(result.status,'completed');assert.equal(events.at(-1).type,'response.completed');
    assert.deepEqual(JSON.parse(result.output[0].content[0].text),{ok:true});
  }
});

test('MiniMax uses Terra and Luna client tool presentation without claiming OpenAI hosted search', () => {
  const metadata = MODEL_SETTINGS.get(MINIMAX_MODEL).catalog;
  assert.equal(metadata.tool_mode, 'code_mode_only');
  assert.equal(metadata.supports_search_tool, true);
  assert.equal(metadata.use_responses_lite, true);
  assert.equal(metadata.node_repl_disabled, false);
  assert.equal(metadata.include_apps_usage_instructions, false);
  assert.equal(metadata.include_skills_usage_instructions, false);
  assert.equal(metadata.include_plugin_usage_instructions, false);
  assert.equal(metadata.default_reasoning_level, 'medium');
  assert.deepEqual(metadata.supported_reasoning_levels.map(x=>x.effort), ['low','medium','high','xhigh','max']);
});

test('RLite declarations and namespaced code-mode replay preserve exact JavaScript', () => {
  const code = 'const r = await tools.echo_marker({marker:"x"}); text(r);';
  const request = { model: MINIMAX_MODEL, reasoning: { effort: 'high' }, parallel_tool_calls: false, input: [
    litePrefix(), { role: 'developer', content: 'Follow the user and project instructions.' }, { role: 'user', content: 'Echo x.' },
    { type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'js1', input: code },
    { type: 'custom_tool_call_output', call_id: 'js1', output: 'x' }] };
  const before = structuredClone(request);
  const { body } = translateRequest(request);
  assert.deepEqual(request, before);
  assert.deepEqual(body.tools.map(x=>x.function.name), ['functions__exec','tool_search']);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.chat_template_kwargs.reasoning_effort, 'high');
  assert.equal(body.messages[0].content, request.input[1].content);
  assert.equal(body.messages[2].tool_calls[0].function.name, 'functions__exec');
  assert.equal(JSON.parse(body.messages[2].tool_calls[0].function.arguments).input, code);
  assert.equal(body.messages[3].tool_call_id, 'js1');
});

test('native client tool search loads a tool, executes its exact schema and finishes the turn', async () => {
  const prefix = litePrefix();
  const first = await generate({ model: MINIMAX_MODEL, input: [prefix,{role:'user',content:'Find echo marker.'}],
    tool_choice: {type:'tool_search'} }, () => {}, {key:'test-only', fetcher:async()=>upstream([
      {choices:[{index:0,delta:{tool_calls:[{index:0,id:'discovery_1',function:{name:'tool_search',arguments:'{"query":"echo marker"}'}}]},finish_reason:'tool_calls'}]}, '[DONE]'])});
  assert.equal(first.end_turn, false);
  assert.deepEqual(first.output[0], {...searchCall(), id:first.output[0].id});
  const nextInput=[prefix,{role:'user',content:'Find echo marker.'},first.output[0],searchOutput()];
  let secondBody;
  const second = await generate({model:MINIMAX_MODEL,input:nextInput},()=>{}, {key:'test-only',fetcher:async(_,o)=>{
    secondBody=JSON.parse(o.body);
    return upstream([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'marker_1',function:{name:'mcp_fixture__echo_marker',arguments:'{"marker":"x"}'}}]},finish_reason:'tool_calls'}]},'[DONE]']);
  }});
  assert.equal(second.output[0].name,'echo_marker');
  assert.equal(second.output[0].namespace,'mcp_fixture');
  assert.deepEqual(secondBody.tools.find(t=>t.function.name==='mcp_fixture__echo_marker').function.parameters,tool.parameters);
  assert.equal(secondBody.messages[2].tool_call_id,'discovery_1');
  const final = await generate({model:MINIMAX_MODEL,input:[...nextInput,second.output[0],{type:'function_call_output',call_id:'marker_1',output:'x'}]},()=>{},
    {key:'test-only',fetcher:async()=>upstream([textChunk('x','stop'),'[DONE]'])});
  assert.equal(final.end_turn,true);
  assert.equal(final.output[0].content[0].text,'x');
});

test('RLite custom-call outputs preserve the namespace expected by Codex', async () => {
  const response=await generate({model:MINIMAX_MODEL,input:[litePrefix(),{role:'user',content:'Use exec.'}]},()=>{},
    {key:'test-only',fetcher:async()=>upstream([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'js_1',function:{name:'functions__exec',arguments:'{"input":"text(42)"}'}}]},finish_reason:'tool_calls'}]},'[DONE]'])});
  assert.equal(response.output[0].type,'custom_tool_call');
  assert.equal(response.output[0].namespace,'functions');
  assert.equal(response.output[0].name,'exec');
  assert.equal(response.output[0].input,'text(42)');
});

test('deferred schemas are only advertised after the actual client loads them', () => {
  const request={model:MINIMAX_MODEL,tools:[searchTool,{...tool,defer_loading:true}],input:'Hello'};
  const {body}=translateRequest(request);
  assert.deepEqual(body.tools.map(x=>x.function.name),['tool_search']);
  assert.equal(JSON.stringify(body).includes('"marker"'),false);
});

test('local compaction replays tool search without re-enabling discovered functions', () => {
  const {body}=translateRequest({model:MINIMAX_MODEL,tools:[],input:[litePrefix(),{role:'user',content:'Summarize'},searchCall(),searchOutput()]});
  assert.equal(body.tools,undefined);
  assert.equal(body.messages[2].tool_call_id,'discovery_1');
});

test('invalid deferred search and conflicting declarations fail explicitly', () => {
  assert.throws(()=>translateRequest({model:MINIMAX_MODEL,tools:[{type:'tool_search',execution:'server'}],input:'Hi'}),{code:'hosted_tool_search_unavailable'});
  assert.throws(()=>translateRequest({model:MINIMAX_MODEL,input:[searchOutput()]}),{code:'unmatched_tool_search'});
  assert.throws(()=>translateRequest({model:MINIMAX_MODEL,input:[{...litePrefix(),role:'user'}]}),{code:'invalid_tool_declaration_role'});
  assert.throws(()=>translateRequest({model:MINIMAX_MODEL,tools:[tool,{...tool,parameters:{type:'object'}}],input:'Hi'}),{code:'conflicting_tool_definition'});
});

test('Responses translation preserves namespace, freeform calls and matched results', () => {
  const request = { model: MODEL, instructions: 'Obey the user.', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'apply_patch', description: 'Apply an exact patch.' }, tool,
  ] }], input: [{ role: 'user', content: [{ type: 'input_text', text: 'Edit this.' }] },
    { type: 'custom_tool_call', name: 'functions.apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'applied' }] };
  const translated = translateRequest(request);
  assert.equal(translated.body.messages[2].tool_calls[0].function.name, 'functions__apply_patch');
  assert.equal(JSON.parse(translated.body.messages[2].tool_calls[0].function.arguments).input, request.input[1].input);
  assert.equal(translated.body.messages[3].tool_call_id, 'p1');
  assert.equal(translated.body.messages[3].content, 'applied');
  assert.equal(translated.body.messages[0].content, 'Obey the user.');
});

test('text events stream before successful terminal completion', async () => {
  const events = [];
  const response = await generate({ model: MODEL, input: 'Hello' }, e => events.push(e), {
    key: 'test-only', fetcher: async () => upstream([textChunk('O'), textChunk('K', 'stop'), '[DONE]']),
  });
  assert.equal(response.output[0].content[0].text, 'OK');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.filter(x => x.type === 'response.output_text.delta').length, 2);
  assert.ok(events.every((x, i) => x.sequence_number === i));
});

test('function tool stream can be replayed with a matching result', async () => {
  const first = await generate({ model: MODEL, input: 'Call the function.', tools: [tool] }, () => {}, {
    key: 'test-only', fetcher: async () => upstream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'actual_call', function: { name: 'echo_marker', arguments: '{"marker":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"abc"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]),
  });
  const call = first.output[0];
  assert.equal(call.call_id, 'actual_call');
  assert.equal(JSON.parse(call.arguments).marker, 'abc');
  const followup = translateRequest({ model: MODEL, tools: [tool], input: [{ role: 'user', content: 'Call the function.' },
    call, { type: 'function_call_output', call_id: call.call_id, output: 'abc' }] });
  assert.equal(followup.body.messages[1].tool_calls[0].id, 'actual_call');
  assert.equal(followup.body.messages[2].content, 'abc');
});

test('custom tool output retains exact freeform input', async () => {
  const patch = '*** Begin Patch\n*** End Patch';
  const response = await generate({ model: MODEL, input: 'Patch.', tools: [{ type: 'custom', name: 'apply_patch' }] }, () => {}, {
    key: 'test-only', fetcher: async () => upstream([{ choices: [{ index: 0, delta: {
      tool_calls: [{ index: 0, id: 'patch1', function: { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } }],
    }, finish_reason: 'tool_calls' }] }, '[DONE]']),
  });
  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.equal(response.output[0].input, patch);
});

test('retired tool history survives local compaction without enabling retired tools', () => {
  for (const model of [SUPER_MODEL, MINIMAX_MODEL]) {
    const input = [{ role: 'user', content: 'Summarize the prior work.' },
      { type: 'function_call', name: 'exec_command', call_id: 'old_shell', arguments: '{"cmd":"read-only"}' },
      { type: 'function_call_output', call_id: 'old_shell', output: 'Exact historical evidence' },
      { type: 'custom_tool_call', name: 'functions.apply_patch', call_id: 'old_patch', input: 'exact old patch' },
      { type: 'custom_tool_call_output', call_id: 'old_patch', output: 'Exact historical result' }];
    const before = structuredClone(input);
    const { body, aliases } = translateRequest({ model, tools: [], input });
    assert.equal(body.tools, undefined);
    assert.equal(aliases.size, 0);
    assert.equal(body.messages[1].tool_calls[0].id, 'old_shell');
    assert.equal(body.messages[2].content, 'Exact historical evidence');
    assert.equal(JSON.parse(body.messages[3].tool_calls[0].function.arguments).input, 'exact old patch');
    assert.equal(body.messages[4].tool_call_id, 'old_patch');
    assert.deepEqual(input, before);
  }
});

test('changed tools keep historical aliases separate and reject fresh calls to retired tools', async () => {
  const historicalName = 'functions.' + 'x'.repeat(100);
  const input = [{ role: 'user', content: 'Continue.' },
    { type: 'function_call', name: historicalName, call_id: 'old', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old', output: 'prior result' }];
  const request = { model: MINIMAX_MODEL, tools: [tool], input };
  const { body, aliases } = translateRequest(request);
  const alias = body.messages[1].tool_calls[0].function.name;
  assert.ok(alias.length <= 64);
  assert.equal(aliases.has(alias), false);
  assert.deepEqual(body.tools.map(t => t.function.name), ['echo_marker']);
  assert.throws(() => translateRequest({ ...request, tool_choice: { type: 'function', name: historicalName } }),
    { code: 'unknown_tool_choice' });
  await assert.rejects(generate(request, () => {}, { key: 'test-only', fetcher: async () => upstream([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'new', function: { name: alias, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']) }),
    { code: 'unknown_returned_tool' });
});

test('MiniMax replays retired image tools and preserves parallel result ordering', () => {
  const { body } = translateRequest({ model: MINIMAX_MODEL, tools: [], input: [
    { role: 'user', content: 'Summarize both images.' }, imageCall('a'), imageCall('b'),
    imageResult('b', 'B result'), imageResult('a', 'A result')] });
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.equal(body.messages[2].content, 'B result');
  assert.equal(body.messages[3].content, 'A result');
  assert.equal(body.messages[4].content[1].image_url.url, visionFixture());
  assert.equal(body.tools, undefined);
});

for (const model of [SUPER_MODEL, MINIMAX_MODEL]) test('live replay and local compaction compatibility: ' + model, {
  skip: process.env.CODEX_NVIDIA_LIVE_HISTORY_REGRESSION !== '1', timeout: 145000,
}, async context => {
  const proof = { model, at: new Date().toISOString(), ok: false, checks: [],
    gatewaySHA256: createHash('sha256').update(readFileSync(new URL('../plugins/minimax-jdc/runtime/gateway.mjs', import.meta.url))).digest('hex') };
  const started = Date.now();
  const marker = 'history-proof-' + randomUUID();
  const oldTool = { type: 'function', name: 'exec_command', description: 'Protocol test fixture; return a supplied marker.',
    parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } };
  const prompt = 'Use exec_command with marker ' + marker + ', then report its result.';
  const invoke = (request, emit = () => {}) => generate({ model, max_output_tokens: 2048,
    reasoning: { effort: MODEL_SETTINGS.get(model).probeEffort }, ...request }, emit, { signal: AbortSignal.timeout(45000) });
  try {
    const first = await invoke({ tools: [oldTool], input: prompt, tool_choice: { type: 'function', name: 'exec_command' } });
    const call = first.output.find(item => item.type === 'function_call' && item.name === 'exec_command');
    assert.ok(call);
    // A protocol fixture, not a shell execution or a case-file read.
    const input = [{ role: 'user', content: prompt }, ...first.output,
      { type: 'function_call_output', call_id: call.call_id, output: marker },
      { role: 'user', content: 'Summarize the observed tool result. Repeat its marker verbatim. Do not call tools.' }];
    for (const [name, tools] of [['local-compaction-no-tools', []], ['changed-current-tools', [tool]]]) {
      const events = [];
      const result = await invoke({ input, tools, tool_choice: 'none' }, e => events.push(e));
      const answer = result.output.filter(i => i.type === 'message').flatMap(i => i.content).map(p => p.text || '').join('');
      assert.equal(result.status, 'completed'); assert.ok(answer.includes(marker));
      assert.equal(events.at(-1).type, 'response.completed');
      proof.checks.push({ name, ok: true, historicalResultPreserved: true });
    }
    const imageEvents = [];
    const image = await invoke({ input: [{ role: 'user', content: 'State the dominant color of the tool image and repeat its text marker.' },
      imageCall('old_image'), imageResult('old_image', marker)], tools: [], tool_choice: 'none' }, e => imageEvents.push(e));
    const imageText = image.output.filter(i => i.type === 'message').flatMap(i => i.content).map(p => p.text || '').join('');
    assert.match(imageText, /\b(red|rojo|roja)\b/i); assert.ok(imageText.includes(marker));
    assert.equal(imageEvents.at(-1).type, 'response.completed');
    proof.checks.push({ name: 'retired-tool-image', ok: true, markerPreserved: true, observedColor: 'red' });
    proof.ok = true;
    context.diagnostic(model + ': historial real, resumen sin herramientas, cambio de herramientas e imagen correctos.');
  } catch (error) {
    proof.code = error.code || error.name;
    proof.message = String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]');
    throw error;
  } finally {
    proof.durationMs = Date.now() - started;
    const evidencePath = new URL('./nvidia-verification.json', import.meta.url);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.historyCompatibility ||= {};
    evidence.historyCompatibility[model] = proof;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  }
});

test('missing completion and truncated output never pass as completed', async () => {
  await assert.rejects(generate({ model: MODEL, input: 'Hello' }, () => {}, {
    key: 'test-only', fetcher: async () => upstream([textChunk('half'), '[DONE]']),
  }), { code: 'incomplete_upstream_stream' });
  const truncated = await generate({ model: MODEL, input: 'Hello' }, () => {}, {
    key: 'test-only', fetcher: async () => upstream([textChunk('half', 'length'), '[DONE]']),
  });
  assert.equal(truncated.status, 'incomplete');
});

test('unsupported provider tools and image input fail explicitly', () => {
  assert.throws(() => translateRequest({ model: MODEL, input: 'Hi', tools: [{ type: 'image_generation' }] }), { code: 'unsupported_tool' });
  assert.throws(() => translateRequest({ model: MODEL, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] }), { code: 'unsupported_content' });
});

test('optional hosted web search never blocks greetings for any NVIDIA model', () => {
  for (const model of MODEL_SETTINGS.keys()) {
    for (const type of ['web_search', 'web_search_preview', 'web_search_preview_2025_03_11']) {
      const request = { model, input: 'hola', tools: [{ type }], tool_choice: 'auto' };
      const before = structuredClone(request);
      const { body } = translateRequest(request);
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.messages.at(-1).content, 'hola');
      assert.ok(body.messages.some(message => /no search has been executed/.test(message.content)));
      assert.deepEqual(request, before);
    }
  }
});

test('optional search filtering preserves function, custom and MCP tool contracts', () => {
  const tools = [{ type: 'web_search' }, { type: 'namespace', name: 'mcp', tools: [tool,
    { type: 'custom', name: 'apply_patch' }] }];
  const { body, aliases } = translateRequest({ model: MODEL, input: 'hola', tools,
    tool_choice: { type: 'function', name: 'mcp.echo_marker' } });
  assert.deepEqual(body.tools.map(item => item.function.name), ['mcp__echo_marker', 'mcp__apply_patch']);
  assert.equal(aliases.get('mcp__apply_patch').custom, true);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'mcp__echo_marker' } });
});

test('mandatory hosted search fails explicitly instead of silently answering without searching', () => {
  for (const model of MODEL_SETTINGS.keys()) {
    assert.throws(() => translateRequest({ model, input: 'Search now', tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' } }), { code: 'hosted_search_unavailable' });
    assert.throws(() => translateRequest({ model, input: 'Search now', tools: [{ type: 'web_search' }],
      tool_choice: 'required' }), { code: 'required_tool_unavailable' });
    const { body } = translateRequest({ model, input: 'Use a tool', tools: [{ type: 'web_search' }, tool], tool_choice: 'required' });
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.tools.length, 1);
  }
});

test('greeting with the native hosted-search declaration reaches completed Responses events', async () => {
  for (const model of MODEL_SETTINGS.keys()) {
    let sent;
    const events = [];
    const response = await generate({ model, input: 'hola', tools: [{ type: 'web_search' }], tool_choice: 'auto' },
      event => events.push(event), { key: 'test-only', fetcher: async (_url, options) => {
        sent = JSON.parse(options.body);
        return upstream([textChunk('Hola.', 'stop'), '[DONE]']);
      } });
    assert.equal(sent.tools, undefined);
    assert.equal(sent.tool_choice, undefined);
    assert.equal(response.output[0].content[0].text, 'Hola.');
    assert.equal(events.at(-1).type, 'response.completed');
    assert.ok(!response.output.some(item => item.type === 'web_search_call'));
  }
});

test('live NVIDIA greetings accept optional hosted web_search', {
  skip: process.env.CODEX_NVIDIA_LIVE_REGRESSION !== '1', timeout: 70000,
}, async context => {
  const checks = await Promise.all(Array.from(MODEL_SETTINGS, async ([model, settings]) => {
    const started = Date.now();
    try {
      const events = [];
      const result = await generate({ model, input: 'hola',
        instructions: 'Responde al saludo en español con una sola frase corta. No necesitas utilizar herramientas para saludar.',
        tools: [{ type: 'web_search' }, { type: 'namespace', name: 'functions', tools: [tool,
          { type: 'custom', name: 'apply_patch', description: 'Apply an exact patch when requested.' }] }],
        tool_choice: 'auto', max_output_tokens: 2048, reasoning: { effort: settings.probeEffort },
      }, event => events.push(event), { signal: AbortSignal.timeout(60000) });
      const text = result.output.flatMap(item => item.type === 'message' ? item.content || [] : [])
        .filter(part => part.type === 'output_text').map(part => part.text).join('');
      assert.equal(result.status, 'completed');
      assert.ok(text.trim().length > 0);
      assert.equal(events.at(-1).type, 'response.completed');
      assert.ok(!result.output.some(item => item.type === 'web_search_call'));
      context.diagnostic(model + ': saludo real completado (' + text.length + ' caracteres).');
      return { model, ok: true, durationMs: Date.now() - started, outputCharacters: text.length,
        optionalHostedSearch: true, functionAndCustomToolsPresent: true, completedEvent: true };
    } catch (error) {
      return { model, ok: false, durationMs: Date.now() - started, code: error.code || error.name,
        message: String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]') };
    }
  }));
  const evidencePath = new URL('./nvidia-verification.json', import.meta.url);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  evidence.greetingCompatibility = { at: new Date().toISOString(),
    gatewaySHA256: createHash('sha256').update(readFileSync(new URL('../plugins/minimax-jdc/runtime/gateway.mjs', import.meta.url))).digest('hex'),
    checks };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  assert.deepEqual(checks.filter(check => !check.ok), [], 'Todas las respuestas reales deben completarse.');
});

test('catalog preserves original OpenAI entries and adds only listed NVIDIA models once', async () => {
  let receivedHeaders;
  const original = { slug: 'existing-openai-model', display_name: 'Existing model', model_messages: { instructions_template: 'Keep exactly.' } };
  const server = createGateway({ fetcher: async (_url, init) => {
    receivedHeaders = init.headers;
    return Response.json({ models: [original] });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/models?client_version=0.162.1',
      { headers: { Authorization: 'Bearer fake-session', 'ChatGPT-Account-ID': 'fake-account' } });
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.models[0], original);
    assert.equal(catalog.models[1].slug, KILO_MODEL);
    assert.equal(catalog.models.length, 2);
    assert.equal(catalog.models.some(model => model.slug === MODEL), false);
    assert.equal(catalog.models.filter(model => model.slug === SUPER_MODEL).length, 0);
    assert.equal(catalog.models.filter(model => model.slug === MINIMAX_MODEL).length, 0);
    assert.equal(receivedHeaders['ChatGPT-Account-ID'], 'fake-account');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('removing Ultra from the picker preserves GPT entries, other models and old-chat compatibility', () => {
  const gpt = { slug: 'existing-openai-model', display_name: 'Keep exactly', visibility: 'list', context_window: 12345 };
  const upstream = { models: [gpt, { slug: MODEL, display_name: 'Stale Ultra' }] };
  const before = structuredClone(upstream);
  const catalog = mergeCatalog(upstream);
  assert.deepEqual(catalog.models.map(model => model.slug), [gpt.slug, ...PLUGIN_MODELS]);
  assert.deepEqual(catalog.models[0], gpt);
  assert.deepEqual(upstream, before);
  assert.equal(translateRequest({ model: MODEL, input: 'Existing chat' }).body.model, MODEL);
});

test('NVIDIA receives only its own credential, never OpenAI account headers', async () => {
  let actual;
  await generate({ model: MODEL, input: 'Hello' }, () => {}, { key: 'test-nvidia-only', fetcher: async (_url, init) => {
    actual = init.headers; return upstream([textChunk('OK', 'stop'), '[DONE]']);
  } });
  assert.deepEqual(actual, { Authorization: 'Bearer test-nvidia-only', 'Content-Type': 'application/json' });
});

test('catalog capability metadata does not invent vision or reasoning tiers', () => {
  assert.deepEqual(nemotronCatalogEntry.input_modalities, ['text']);
  assert.deepEqual(nemotronCatalogEntry.supported_reasoning_levels.map(x => x.effort), ['none', 'medium', 'high']);
  assert.equal(nemotronCatalogEntry.upgrade, null);
});

test('OpenAI proxy preserves request body, response SSE and continuation headers', async () => {
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  let seen;
  const server = createGateway({ fetcher: async (url, init) => {
    seen = { url, ...init };
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'turn-test' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const request = { model: 'existing-openai-model', input: 'Hi', tools: [{ type: 'web_search' }], stream: true };
    const result = await fetch('http://127.0.0.1:' + server.address().port + '/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer fake-session', 'Content-Type': 'application/json',
        'X-Codex-Turn-State': 'prior-turn', 'ChatGPT-Account-ID': 'fake-account' }, body: JSON.stringify(request),
    });
    assert.equal(await result.text(), stream);
    assert.equal(result.headers.get('x-codex-turn-state'), 'turn-test');
    assert.equal(seen.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.deepEqual(JSON.parse(seen.body), request);
    assert.equal(seen.headers['x-codex-turn-state'], 'prior-turn');
    assert.equal(seen.headers.authorization, 'Bearer fake-session');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('provider HTTP authentication and rate-limit failures retain their status', async () => {
  for (const status of [401, 429]) {
    await assert.rejects(generate({ model: MODEL, input: 'Hi' }, () => {}, {
      key: 'test-only', fetcher: async () => new Response('{}', { status }),
    }), error => error.status === status && error.code === 'nvidia_http_' + status);
  }
});

test('delta emission does not wait for the entire upstream response', async () => {
  const events = [];
  let emittedBeforeEnd = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: ' + JSON.stringify(textChunk('O')) + '\n\n'));
    setTimeout(() => {
      emittedBeforeEnd = events.some(e => e.type === 'response.output_text.delta');
      controller.enqueue(encoder.encode('data: ' + JSON.stringify(textChunk('K', 'stop')) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    }, 30);
  } });
  await generate({ model: MODEL, input: 'Hi' }, e => events.push(e), { key: 'test-only', fetcher: async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(emittedBeforeEnd, true);
});

test('provider activation is top-level and reversible without changing unrelated settings', () => {
  const config = 'model = "unchanged"\nmodel_reasoning_effort = "max"\n\n[features]\nflag = true\n';
  const activated = setProvider(config, 'nvidia_nemotron_bridge');
  assert.match(topLevel(activated), /model_provider = "nvidia_nemotron_bridge"/);
  assert.equal(setProvider(activated, null), config);
  assert.ok(activated.endsWith('[features]\nflag = true\n'));
});

test('each NVIDIA model uses its own route and documented reasoning settings', () => {
  const superLow = translateRequest({ model: SUPER_MODEL, input: 'Hi', reasoning: { effort: 'low' } });
  assert.equal(superLow.body.model, SUPER_MODEL);
  assert.deepEqual(superLow.body.chat_template_kwargs, { enable_thinking: true, low_effort: true });
  const miniMax = translateRequest({ model: MINIMAX_MODEL, input: 'Hi', reasoning: { effort: 'max' } });
  assert.equal(miniMax.body.model, MINIMAX_MODEL);
  assert.deepEqual(miniMax.body.chat_template_kwargs, { reasoning_effort: 'max' });
  assert.throws(() => translateRequest({ model: SUPER_MODEL, input: 'Hi', reasoning: { effort: 'max' } }), { code: 'unsupported_effort' });
});

test('strict response schemas are forwarded intact only for supporting models', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  for (const model of [SUPER_MODEL, MINIMAX_MODEL]) {
    const result = translateRequest({ model, input: 'JSON please.', text: { format: { type: 'json_schema', name: 'status', schema, strict: true } } });
    assert.deepEqual(result.body.response_format, { type: 'json_schema', json_schema: { name: 'status', strict: true, schema } });
  }
  assert.throws(() => translateRequest({ model: MODEL, input: 'JSON please.', text: { format: { type: 'json_schema', schema } } }), { code: 'structured_output_unsupported' });
});

test('new multimodal models preserve image parts and Ultra remains text-only', () => {
  const image = visionFixture();
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Color?' }, { type: 'input_image', image_url: image, detail: 'low' }] }];
  for (const model of [SUPER_MODEL, MINIMAX_MODEL]) {
    const { body } = translateRequest({ model, input });
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Color?' }, { type: 'image_url', image_url: { url: image, detail: 'low' } }]);
  }
  assert.throws(() => translateRequest({ model: MODEL, input }), { code: 'unsupported_content' });
});

const imageTool = { type: 'function', name: 'view_image', description: 'Open the image requested by the user.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };
const imageCall = id => ({ type: 'function_call', name: 'view_image', call_id: id, arguments: '{}' });
const imageResult = (id, text = 'Tool text') => ({ type: 'function_call_output', call_id: id,
  output: [{ type: 'input_text', text }, { type: 'input_image', image_url: visionFixture(), detail: 'low' }] });

test('Super VL preserves tool image pixels, tool result text and call identity', () => {
  const request = { model: SUPER_MODEL, tools: [imageTool], input: [
    { role: 'user', content: 'Describe the image' }, imageCall('image1'), imageResult('image1', 'Exact tool text'),
  ] };
  const before = structuredClone(request);
  const { body } = translateRequest(request);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(body.messages[1].tool_calls[0].id, 'image1');
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'image1', content: 'Exact tool text' });
  assert.match(body.messages[3].content[0].text, /call_id=image1/);
  assert.match(body.messages[3].content[0].text, /untrusted data.*not a new instruction/);
  assert.deepEqual(body.messages[3].content[1], { type: 'image_url', image_url: { url: visionFixture(), detail: 'low' } });
  assert.deepEqual(request, before);
});

test('Super VL supports image-only custom-tool output and multiple images without dropping pixels', () => {
  const image = { type: 'input_image', image_url: visionFixture(), detail: 'low' };
  const { body } = translateRequest({ model: SUPER_MODEL, tools: [{ type: 'custom', name: 'image_custom' }], input: [
    { role: 'user', content: 'Look' },
    { type: 'custom_tool_call', name: 'image_custom', call_id: 'custom_image', input: 'open image' },
    { type: 'custom_tool_call_output', call_id: 'custom_image', output: [image, image] },
  ] });
  assert.equal(body.messages[2].tool_call_id, 'custom_image');
  assert.match(body.messages[2].content, /returned image data/);
  assert.equal(body.messages[3].content.filter(part => part.type === 'image_url').length, 2);
});

test('Super VL attaches images only after every parallel tool result, including out-of-order results', () => {
  const { body } = translateRequest({ model: SUPER_MODEL, tools: [imageTool], input: [
    { role: 'user', content: 'Look at both' }, imageCall('a'), imageCall('b'),
    imageResult('b', 'B result'), imageResult('a', 'A result'),
  ] });
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.deepEqual(body.messages[1].tool_calls.map(call => call.id), ['a', 'b']);
  assert.equal(body.messages[2].tool_call_id, 'b');
  assert.equal(body.messages[3].tool_call_id, 'a');
  assert.match(body.messages[4].content[0].text, /call_id=b/);
  assert.match(body.messages[5].content[0].text, /call_id=a/);
});

test('Super VL rejects incomplete, unmatched or malformed image-tool histories explicitly', () => {
  const request = { model: SUPER_MODEL, tools: [imageTool], input: [
    { role: 'user', content: 'Look' }, imageCall('a'), imageCall('b'), imageResult('a'),
  ] };
  assert.throws(() => translateRequest(request), { code: 'incomplete_tool_image_history' });
  assert.throws(() => translateRequest({ ...request, input: [...request.input, { role: 'user', content: 'Continue' }] }),
    { code: 'incomplete_tool_image_history' });
  assert.throws(() => translateRequest({ model: SUPER_MODEL, tools: [imageTool], input: [imageResult('orphan')] }),
    { code: 'unmatched_tool_image' });
  assert.throws(() => translateRequest({ model: SUPER_MODEL, tools: [imageTool], input: [imageCall('a'),
    { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_image', file_id: 'not-a-public-image-url' }] }] }),
    { code: 'image_url_required' });
});

test('Super VL tool-image fix leaves MiniMax text, tools and direct-image translation unchanged', () => {
  const { body } = translateRequest({ model: MINIMAX_MODEL, tools: [imageTool], input: [
    { role: 'user', content: 'Read this result' }, imageCall('mini_text'),
    { type: 'function_call_output', call_id: 'mini_text', output: [{ type: 'input_text', text: 'Exact existing result' }] },
  ] });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Read this result' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'mini_text', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'mini_text', content: 'Exact existing result' }]);
  assert.equal(body.model, MINIMAX_MODEL);
  assert.deepEqual(body.chat_template_kwargs, { reasoning_effort: 'medium' });
});

test('Super VL tool-image follow-up reaches completed Responses events', async () => {
  let sent;
  const events = [];
  const result = await generate({ model: SUPER_MODEL, tools: [imageTool], input: [
    { role: 'user', content: 'Which color?' }, imageCall('visual_followup'), imageResult('visual_followup'),
  ] }, event => events.push(event), { key: 'test-only', fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return upstream([textChunk('Red.', 'stop'), '[DONE]']);
  } });
  assert.equal(sent.messages.at(-1).content[1].image_url.url, visionFixture());
  assert.equal(result.output[0].content[0].text, 'Red.');
  assert.equal(events.at(-1).type, 'response.completed');
});

test('live Super VL reads an image returned by its actual function call', {
  skip: process.env.CODEX_NVIDIA_LIVE_IMAGE_REGRESSION !== '1', timeout: 125000,
}, async context => {
  const proof = { model: SUPER_MODEL, at: new Date().toISOString(), ok: false,
    gatewaySHA256: createHash('sha256').update(readFileSync(new URL('../plugins/minimax-jdc/runtime/gateway.mjs', import.meta.url))).digest('hex') };
  const started = Date.now();
  try {
    const marker = 'image-proof-' + randomUUID();
    const prompt = 'Use view_image to inspect the image, then state its dominant color and repeat the marker returned by the tool.';
    const first = await generate({ model: SUPER_MODEL, input: prompt, tools: [imageTool],
      tool_choice: { type: 'function', name: 'view_image' }, reasoning: { effort: 'none' }, max_output_tokens: 2048,
    }, () => {}, { signal: AbortSignal.timeout(60000) });
    const call = first.output.find(item => item.type === 'function_call' && item.name === 'view_image');
    assert.ok(call, 'NVIDIA must generate the actual image-tool call.');
    const events = [];
    const result = await generate({ model: SUPER_MODEL, tools: [imageTool], tool_choice: 'none',
      input: [{ role: 'user', content: prompt }, ...first.output, imageResult(call.call_id, 'Verification marker: ' + marker)],
      reasoning: { effort: 'none' }, max_output_tokens: 2048,
    }, event => events.push(event), { signal: AbortSignal.timeout(60000) });
    const text = result.output.flatMap(item => item.type === 'message' ? item.content || [] : [])
      .filter(part => part.type === 'output_text').map(part => part.text).join('');
    assert.equal(result.status, 'completed');
    assert.match(text, /\b(red|rojo|roja)\b/i);
    assert.ok(text.includes(marker), 'The model must retain the actual tool-result text too.');
    assert.equal(events.at(-1).type, 'response.completed');
    Object.assign(proof, { ok: true, actualFunctionCall: true, imageFromTool: true, observedColor: 'red',
      toolResultMarkerPreserved: true, completedEvent: true, durationMs: Date.now() - started });
    context.diagnostic('Super VL: llamada real, imagen de herramienta reconocida y marcador conservado.');
  } catch (error) {
    Object.assign(proof, { code: error.code || error.name, durationMs: Date.now() - started,
      message: String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]') });
    throw error;
  } finally {
    const evidencePath = new URL('./nvidia-verification.json', import.meta.url);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.toolImageCompatibility = proof;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  }
});

test('catalog merge removes stale NVIDIA definitions without changing OpenAI metadata', () => {
  const upstream = { slug: 'unchanged', instructions: 'Keep this exact value.' };
  const result = mergeCatalog({ models: [upstream, { slug: MINIMAX_MODEL, display_name: 'stale' }] });
  assert.deepEqual(result.models[0], upstream);
  assert.equal(result.models.filter(model => model.slug === MINIMAX_MODEL).length, 0);
  assert.equal(result.models.find(model => model.slug === KILO_MODEL).display_name, 'Kilo Auto Free');
});

test('vision probe fixture is a valid RGB PNG containing only red pixels', () => {
  const png = Buffer.from(visionFixture().split(',')[1], 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 32);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  for (let row = 0; row < 32; row++) {
    assert.equal(raw[row * 97], 0);
    for (let col = 0; col < 32; col++) assert.deepEqual([...raw.subarray(row * 97 + 1 + col * 3, row * 97 + 4 + col * 3)], [255, 0, 0]);
  }
});

test('Super strict JSON uses the verified nonstream upstream route with completed Responses events', async () => {
  let sent;
  const events = [];
  const response = await generate({ model: SUPER_MODEL, input: 'JSON please.', text: { format: {
    type: 'json_schema', name: 'status', strict: true,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  } } }, event => events.push(event), { key: 'test-only', fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] });
  } });
  assert.equal(sent.stream, false);
  assert.equal(sent.stream_options, undefined);
  assert.equal(response.status, 'completed');
  assert.deepEqual(JSON.parse(response.output[0].content[0].text), { ok: true });
  assert.equal(events.at(-1).type, 'response.completed');
});

test('MiniMax strict JSON keeps its already-verified SSE route', async () => {
  let sent;
  await generate({ model: MINIMAX_MODEL, input: 'JSON please.', text: { format: {
    type: 'json_schema', name: 'status', schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  } } }, () => {}, { key: 'test-only', fetcher: async (_url, options) => {
    sent = JSON.parse(options.body);
    return upstream([textChunk('{"ok":true}', 'stop'), '[DONE]']);
  } });
  assert.equal(sent.stream, true);
});
