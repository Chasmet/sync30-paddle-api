const queues = new Map();
const commandResults = new Map();
const deviceStates = new Map();
const DEVICE_ID = 'orsay-main';

function queueFor(id = DEVICE_ID) {
  if (!queues.has(id)) queues.set(id, []);
  return queues.get(id);
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function newId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function normalizeProgress(value) {
  const n = Number(value || 100);
  if (n <= 25) return 25;
  if (n <= 50) return 50;
  if (n <= 75) return 75;
  return 100;
}

function stateFor(id = DEVICE_ID) {
  return deviceStates.get(id) || { device_id:id, online:false, updated_at:null, current_week_count:0, today_count:0, current_week_entries:[], today_streets:[], lexicon:[] };
}

function parseProgressToken(token) {
  const t = String(token || '').trim().toLowerCase();
  if (t === '1/4' || t === 'quart' || t === 'un quart') return 25;
  if (t === '1/2' || t === 'moitié' || t === 'moitie' || t === 'demi') return 50;
  if (t === '3/4' || t === 'trois quarts' || t === 'trois-quarts') return 75;
  if (t === 'complet' || t === 'complète' || t === 'complete' || t === 'terminé' || t === 'termine') return 100;
  const m = t.match(/^(25|50|75|100)\s*%?$/);
  return m ? Number(m[1]) : null;
}

function parseStreetSpec(raw, fallbackProgress = 100) {
  let text = String(raw || '').trim();
  let progress = normalizeProgress(fallbackProgress);
  if (!text) return { street:'', progress };

  let m = text.match(/^\s*(25|50|75|100)\s*%\s*[:\-–—|]?\s*(.+)$/i);
  if (m) return { street:m[2].trim(), progress:Number(m[1]) };
  m = text.match(/^\s*(1\/4|1\/2|3\/4|quart|un quart|moiti[eé]|demi|trois[ -]quarts|complet(?:e|ète)?|termin[eé])\s*[:\-–—|]?\s*(.+)$/i);
  if (m) return { street:m[2].trim(), progress:parseProgressToken(m[1]) || progress };
  m = text.match(/^(.+?)\s*[:\-–—|]\s*(25|50|75|100)\s*%\s*$/i);
  if (m) return { street:m[1].trim(), progress:Number(m[2]) };
  m = text.match(/^(.+?)\s+(1\/4|1\/2|3\/4|quart|un quart|moiti[eé]|demi|trois[ -]quarts|complet(?:e|ète)?|termin[eé])\s*$/i);
  if (m) return { street:m[1].trim(), progress:parseProgressToken(m[2]) || progress };
  m = text.match(/^(.+?)\s+(25|50|75|100)\s*%\s*$/i);
  if (m) return { street:m[1].trim(), progress:Number(m[2]) };
  return { street:text, progress };
}

function tools() {
  const finalRule = ' Ne réponds jamais succès avant l’accusé Android ET la relecture de l’état final réel.';
  return [
    {
      name: 'plan_mark_streets',
      description: "Marque une ou plusieurs rues d'Orsay. progress permet 25 %, 50 %, 75 % ou 100 %. Compatibilité totale ancien connecteur : on peut aussi écrire le pourcentage directement dans le texte, ex. 'Rue de Lattre de Tassigny 75 %' ou '3/4: Rue de Lattre de Tassigny'. Toute valeur 'LEXIQUE: ...' est écrite dans le lexique, même si elle est envoyée avec des rues." + finalRule,
      inputSchema: { type:'object', properties:{ streets:{type:'array',items:{type:'string'},minItems:1}, date:{type:'string',description:'Date YYYY-MM-DD, aujourd’hui si absente.'}, progress:{type:'integer',enum:[25,50,75,100],description:'Avancement cumulé commun si le texte de rue ne contient pas son propre pourcentage.'}}, required:['streets'], additionalProperties:false }
    },
    {
      name:'plan_mark_street_progress',
      description:"Règle précisément l'avancement cumulé d'une rue à 25 %, 50 %, 75 % ou 100 %. Android trace seulement la portion correspondante et conserve la couleur du jour pour la nouvelle portion."+finalRule,
      inputSchema:{type:'object',properties:{street:{type:'string'},progress:{type:'integer',enum:[25,50,75,100]},date:{type:'string',description:'Date YYYY-MM-DD, aujourd’hui si absente.'}},required:['street','progress'],additionalProperties:false}
    },
    { name:'plan_delete_street', description:"Supprime le traçage d'une rue de la semaine en cours."+finalRule, inputSchema:{type:'object',properties:{street:{type:'string'}},required:['street'],additionalProperties:false} },
    { name:'plan_add_lexicon', description:"Ajoute une entrée structurée au lexique de l'application."+finalRule, inputSchema:{type:'object',properties:{title:{type:'string'},details:{type:'string'}},required:['title','details'],additionalProperties:false} },
    { name:'plan_add_lexicon_note', description:"Ajoute directement une note libre au lexique de l'application."+finalRule, inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false} },
    { name:'plan_virtual_keyboard', description:"Clavier virtuel interne de Plan Travail. target=lexicon ajoute le texte au lexique; target=street marque la rue saisie. progress accepte 25, 50, 75 ou 100 %."+finalRule, inputSchema:{type:'object',properties:{target:{type:'string',enum:['lexicon','street']},text:{type:'string'},details:{type:'string'},date:{type:'string'},progress:{type:'integer',enum:[25,50,75,100]}},required:['target','text'],additionalProperties:false} },
    { name:'plan_reset_week', description:"Remet à zéro les traçages de la semaine en cours sans supprimer le lexique."+finalRule, inputSchema:{type:'object',properties:{},additionalProperties:false} },
    { name:'plan_get_app_state', description:"Lit l'état réellement renvoyé par Android, y compris progress pour chaque rue et le lexique.", inputSchema:{type:'object',properties:{},additionalProperties:false} },
    { name:'plan_get_status', description:'Retourne les commandes en attente, la dernière synchronisation Android et les compteurs réellement confirmés.', inputSchema:{type:'object',properties:{},additionalProperties:false} },
    { name:'plan_get_lexicon', description:"Retourne le lexique réellement synchronisé depuis l'application Android.", inputSchema:{type:'object',properties:{},additionalProperties:false} },
    { name:'plan_clear_pending', description:'Supprime uniquement les commandes encore en attente.', inputSchema:{type:'object',properties:{},additionalProperties:false} }
  ];
}

function enqueue(action, payload) {
  const command = { id:newId(), action, ...payload, created_at:new Date().toISOString(), delivered_at:null };
  queueFor().push(command);
  return command;
}

async function waitForResult(commandId, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (commandResults.has(commandId)) return commandResults.get(commandId);
    await sleep(350);
  }
  return null;
}

async function waitForFreshState(afterIso, timeoutMs = 12000) {
  const after = Date.parse(afterIso || '') || 0;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = stateFor(DEVICE_ID);
    const updated = Date.parse(state.updated_at || '') || 0;
    if (updated >= after) return state;
    await sleep(300);
  }
  return null;
}

async function queuedWrite(action, payload, successText, verify) {
  const command = enqueue(action, payload);
  const ack = await waitForResult(command.id);
  if (!ack) {
    return { isError:true, content:[{type:'text',text:`Android n'a pas confirmé le résultat final dans le délai. Commande toujours suivie : ${command.id}.`}], structuredContent:{queued:true,confirmed:false,final_verified:false,device_id:DEVICE_ID,command} };
  }
  if (!ack.success) {
    return { isError:true, content:[{type:'text',text:`Échec Android : ${ack.error || 'erreur inconnue'}`}], structuredContent:{queued:true,confirmed:false,final_verified:false,command_id:command.id,android_result:ack,app_state:stateFor(DEVICE_ID)} };
  }
  const state = await waitForFreshState(command.created_at);
  if (!state) {
    return { isError:true, content:[{type:'text',text:'Android a accusé réception mais l’état final n’a pas pu être relu. Ne pas considérer l’action comme terminée.'}], structuredContent:{queued:false,confirmed:true,final_verified:false,command_id:command.id,android_result:ack,app_state:stateFor(DEVICE_ID)} };
  }
  const verified = typeof verify === 'function' ? !!verify(state) : true;
  if (!verified) {
    return { isError:true, content:[{type:'text',text:'Android a répondu, mais la donnée demandée n’apparaît pas dans l’état final relu. Action non validée.'}], structuredContent:{queued:false,confirmed:true,final_verified:false,command_id:command.id,android_result:ack,app_state:state} };
  }
  return { isError:false, content:[{type:'text',text:successText+' Résultat final relu et vérifié dans Android.'}], structuredContent:{queued:false,confirmed:true,final_verified:true,command_id:command.id,android_result:ack,app_state:state} };
}

function rowMatchesStreet(e, street) {
  const a=String(e.street||'').trim().toLowerCase(), b=String(street||'').trim().toLowerCase();
  return a===b || a.includes(b) || b.includes(a);
}
function hasStreet(state, street, date, progress) {
  const rows = Array.isArray(state.current_week_entries) ? state.current_week_entries : [];
  return rows.some(e => rowMatchesStreet(e,street) && (!date || String(e.date||e.work_date||'') === date) && (!progress || Number(e.progress||100) >= Number(progress)));
}
function latestStreetProgress(state, street) {
  const rows=(Array.isArray(state.current_week_entries)?state.current_week_entries:[]).filter(e=>rowMatchesStreet(e,street));
  if(!rows.length)return 0;
  rows.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  return Number(rows[rows.length-1].progress||100);
}
function hasLexicon(state, text) {
  const rows = Array.isArray(state.lexicon) ? state.lexicon : [];
  const wanted = text.trim().toLowerCase();
  return rows.some(e => String(e.title||'').trim().toLowerCase() === wanted || String(e.details||'').toLowerCase().includes(wanted));
}
function todayIso(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}

async function executeTool(name, args = {}) {
  if (name === 'plan_mark_streets') {
    const raw = Array.isArray(args.streets) ? args.streets.map(v=>String(v).trim()).filter(Boolean) : [];
    if (!raw.length) throw new Error('Aucune rue fournie');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date||'')) ? String(args.date) : todayIso();
    const fallbackProgress = normalizeProgress(args.progress || 100);
    const lexiconNotes = raw.filter(v=>/^LEXIQUE\s*:/i.test(v)).map(v=>v.replace(/^LEXIQUE\s*:/i,'').trim()).filter(Boolean);
    const streetSpecs = raw.filter(v=>!/^LEXIQUE\s*:/i.test(v)).map(v=>parseStreetSpec(v,fallbackProgress)).filter(v=>v.street);
    const results = [];

    const groups = new Map();
    for (const spec of streetSpecs) {
      if (!groups.has(spec.progress)) groups.set(spec.progress, []);
      groups.get(spec.progress).push(spec.street);
    }
    for (const [progress, streets] of groups.entries()) {
      const r = await queuedWrite('mark_streets',{streets,date,progress},`${streets.length} rue(s) appliquée(s) à ${progress} % dans Plan Travail Orsay.`,state=>streets.every(s=>hasStreet(state,s,date,progress)));
      results.push(r);
      if (r.isError) return { ...r, structuredContent:{...(r.structuredContent||{}),batch_results:results} };
    }
    for (const text of lexiconNotes) {
      const r = await queuedWrite('add_lexicon',{title:text,details:text},`« ${text} » ajouté dans le lexique Android.`,state=>hasLexicon(state,text));
      results.push(r);
      if (r.isError) return { ...r, structuredContent:{...(r.structuredContent||{}),batch_results:results} };
    }
    if (!streetSpecs.length && !lexiconNotes.length) throw new Error('Aucune donnée exploitable');
    const state = stateFor(DEVICE_ID);
    return {isError:false,content:[{type:'text',text:`Action complète vérifiée dans Android : ${streetSpecs.length} rue(s), ${lexiconNotes.length} note(s) lexique.`}],structuredContent:{queued:false,confirmed:true,final_verified:true,street_specs:streetSpecs,lexicon_notes:lexiconNotes,batch_results:results,app_state:state}};
  }
  if(name==='plan_mark_street_progress'){
    const parsed=parseStreetSpec(String(args.street||'').trim(),args.progress);const street=parsed.street;if(!street)throw new Error('Rue manquante');
    const progress=normalizeProgress(args.progress || parsed.progress);const date=/^\d{4}-\d{2}-\d{2}$/.test(String(args.date||''))?String(args.date):todayIso();
    return queuedWrite('mark_street_progress',{street,progress,date},`${street} réglée à ${progress} % dans Android.`,state=>latestStreetProgress(state,street)>=progress);
  }
  if (name === 'plan_delete_street') {
    const street = String(args.street||'').trim();
    if (!street) throw new Error('Rue manquante');
    return queuedWrite('delete_street', { street }, `Suppression de ${street} confirmée par Android.`, state=>!hasStreet(state,street,null,null));
  }
  if (name === 'plan_add_lexicon') {
    const title=String(args.title||'').trim(), details=String(args.details||'').trim();
    if (!title || !details) throw new Error('Titre et détails obligatoires');
    return queuedWrite('add_lexicon',{title,details},`Entrée « ${title} » ajoutée dans le lexique Android.`,state=>hasLexicon(state,title));
  }
  if (name === 'plan_add_lexicon_note') {
    const text=String(args.text||'').trim(); if(!text) throw new Error('Texte du lexique manquant');
    return queuedWrite('add_lexicon',{title:text,details:text},`Note « ${text} » ajoutée dans le lexique Android.`,state=>hasLexicon(state,text));
  }
  if (name === 'plan_virtual_keyboard') {
    const target=String(args.target||'').trim(), text=String(args.text||'').trim(); if(!text) throw new Error('Texte à saisir manquant');
    if(target==='lexicon') return queuedWrite('add_lexicon',{title:text,details:String(args.details||text).trim()||text},`Clavier MCP : « ${text} » écrit dans le lexique Android.`,state=>hasLexicon(state,text));
    if(target==='street'){const date=/^\d{4}-\d{2}-\d{2}$/.test(String(args.date||''))?String(args.date):todayIso();const parsed=parseStreetSpec(text,args.progress||100);return queuedWrite('mark_streets',{streets:[parsed.street],date,progress:parsed.progress},`Clavier MCP : rue « ${parsed.street} » marquée à ${parsed.progress} % dans Android.`,state=>hasStreet(state,parsed.street,date,parsed.progress));}
    throw new Error('Destination clavier non supportée');
  }
  if (name === 'plan_reset_week') return queuedWrite('reset_week',{},'Remise à zéro de la semaine confirmée par Android. Le lexique est conservé.',state=>(state.current_week_count||0)===0);
  if (name === 'plan_get_app_state') {
    const state=stateFor(), age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity, online=age<20000, out={...state,online};
    return {content:[{type:'text',text:online?`Application synchronisée : ${out.current_week_count||0} rue(s) commencée(s) cette semaine, ${out.today_count||0} aujourd'hui.`:"Aucun état Android récent : l'application n'est pas actuellement synchronisée."}],structuredContent:out};
  }
  if (name === 'plan_get_status') {
    const q=queueFor(), state=stateFor(), age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity;
    const out={ok:true,pending_count:q.length,device_id:DEVICE_ID,android_online:age<20000,last_android_sync:state.updated_at,current_week_count:state.current_week_count||0,today_count:state.today_count||0,lexicon_count:Array.isArray(state.lexicon)?state.lexicon.length:0,partial_progress:true,legacy_progress_text:true,mixed_lexicon_bridge:true};
    return {content:[{type:'text',text:`${q.length} commande(s) en attente. Android ${out.android_online?'connecté':'non connecté'}. Lexique synchronisé : ${out.lexicon_count} entrée(s). Progression partielle active.`}],structuredContent:out};
  }
  if (name === 'plan_get_lexicon') {
    const state=stateFor(), lexicon=Array.isArray(state.lexicon)?state.lexicon:[];
    return {content:[{type:'text',text:`${lexicon.length} entrée(s) de lexique synchronisée(s) depuis Android.`}],structuredContent:{device_id:DEVICE_ID,updated_at:state.updated_at,lexicon}};
  }
  if (name === 'plan_clear_pending') { queues.set(DEVICE_ID,[]); return {content:[{type:'text',text:'Commandes en attente supprimées.'}],structuredContent:{cleared:true}}; }
  throw new Error(`Outil inconnu: ${name}`);
}

async function handleRpc(body) {
  const id=body&&Object.prototype.hasOwnProperty.call(body,'id')?body.id:null, method=body?.method;
  if(method==='initialize') return rpcResult(id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:true}},serverInfo:{name:'Plan Travail Orsay',version:'1.7.0'}});
  if(method==='ping') return rpcResult(id,{});
  if(method==='tools/list') return rpcResult(id,{tools:tools()});
  if(method==='tools/call'){try{return rpcResult(id,await executeTool(body?.params?.name,body?.params?.arguments||{}));}catch(e){return rpcResult(id,{isError:true,content:[{type:'text',text:e.message||'Erreur outil'}]});}}
  if(method&&method.startsWith('notifications/')) return null;
  return rpcError(id,-32601,`Méthode non supportée: ${method||'vide'}`);
}

export function installPlanTravailMcp(app) {
  app.get('/plan-travail/health',(_req,res)=>res.json({ok:true,service:'plan-travail-orsay-mcp',version:'1.7.0',legacy_lexicon_bridge:true,mixed_lexicon_bridge:true,legacy_progress_text:true,final_verification:true,partial_progress:true,progress_levels:[25,50,75,100]}));
  app.post('/plan-travail/mcp',async(req,res)=>{const answer=await handleRpc(req.body);if(answer===null)return res.status(202).end();res.setHeader('Cache-Control','no-store');return res.json(answer);});
  app.get('/plan-travail/commands',(req,res)=>{const deviceId=String(req.query.device_id||DEVICE_ID),now=Date.now(),q=queueFor(deviceId),commands=q.filter(c=>!c.delivered_at||now-Date.parse(c.delivered_at)>10000);for(const c of commands)c.delivered_at=new Date().toISOString();return res.json({device_id:deviceId,commands});});
  app.post('/plan-travail/command-result',(req,res)=>{const body=req.body||{},deviceId=String(body.device_id||DEVICE_ID),id=String(body.command_id||'');if(!id)return res.status(400).json({ok:false,error:'command_id manquant'});const result={...body,device_id:deviceId,received_at:new Date().toISOString()};commandResults.set(id,result);const q=queueFor(deviceId),idx=q.findIndex(c=>c.id===id);if(idx>=0)q.splice(idx,1);return res.json({ok:true,command_id:id});});
  app.post('/plan-travail/device-state',(req,res)=>{const body=req.body||{},deviceId=String(body.device_id||DEVICE_ID);deviceStates.set(deviceId,{...body,device_id:deviceId,updated_at:new Date().toISOString()});return res.json({ok:true,device_id:deviceId});});
  app.get('/plan-travail/status',(_req,res)=>{const q=queueFor(),state=stateFor(),age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity;return res.json({ok:true,device_id:DEVICE_ID,pending_count:q.length,android_online:age<20000,last_android_sync:state.updated_at,current_week_count:state.current_week_count||0,today_count:state.today_count||0,lexicon_count:Array.isArray(state.lexicon)?state.lexicon.length:0,legacy_lexicon_bridge:true,mixed_lexicon_bridge:true,legacy_progress_text:true,final_verification:true,partial_progress:true,progress_levels:[25,50,75,100]});});
}