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

function stateFor(id = DEVICE_ID) {
  return deviceStates.get(id) || { device_id:id, online:false, updated_at:null, current_week_count:0, today_count:0, current_week_entries:[], today_streets:[], lexicon:[] };
}

function tools() {
  return [
    {
      name: 'plan_mark_streets',
      description: "Marque une ou plusieurs rues d'Orsay. Compatibilité ancien connecteur : une valeur commençant par LEXIQUE: ajoute le texte suivant au lexique Android au lieu de marquer une rue.",
      inputSchema: { type:'object', properties:{ streets:{type:'array',items:{type:'string'},minItems:1}, date:{type:'string',description:'Date YYYY-MM-DD, aujourd’hui si absente.'}}, required:['streets'], additionalProperties:false }
    },
    { name:'plan_delete_street', description:"Supprime le traçage d'une rue de la semaine en cours dans l'application et attend la confirmation Android.", inputSchema:{type:'object',properties:{street:{type:'string'}},required:['street'],additionalProperties:false} },
    { name:'plan_add_lexicon', description:"Ajoute une entrée structurée au lexique de l'application et attend la confirmation Android.", inputSchema:{type:'object',properties:{title:{type:'string'},details:{type:'string'}},required:['title','details'],additionalProperties:false} },
    { name:'plan_add_lexicon_note', description:"Ajoute directement une note libre au lexique de l'application.", inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false} },
    { name:'plan_virtual_keyboard', description:"Clavier virtuel interne de Plan Travail. target=lexicon ajoute le texte au lexique; target=street marque la rue saisie. Attend la confirmation Android.", inputSchema:{type:'object',properties:{target:{type:'string',enum:['lexicon','street']},text:{type:'string'},details:{type:'string'},date:{type:'string'}},required:['target','text'],additionalProperties:false} },
    { name:'plan_reset_week', description:"Remet à zéro les traçages de la semaine en cours sans supprimer le lexique.", inputSchema:{type:'object',properties:{},additionalProperties:false} },
    { name:'plan_get_app_state', description:"Lit l'état réellement renvoyé par Android, y compris le lexique.", inputSchema:{type:'object',properties:{},additionalProperties:false} },
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

async function waitForResult(commandId, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (commandResults.has(commandId)) return commandResults.get(commandId);
    await sleep(350);
  }
  return null;
}

async function queuedWrite(action, payload, successText) {
  const command = enqueue(action, payload);
  const ack = await waitForResult(command.id);
  if (!ack) return { isError:true, content:[{type:'text',text:`Commande envoyée mais Android n'a pas encore confirmé. ID ${command.id}.`}], structuredContent:{queued:true,confirmed:false,device_id:DEVICE_ID,command} };
  const state = stateFor(DEVICE_ID);
  return { isError:!ack.success, content:[{type:'text',text:ack.success?successText:`Échec Android : ${ack.error || 'erreur inconnue'}`}], structuredContent:{queued:true,confirmed:!!ack.success,command_id:command.id,android_result:ack,app_state:state} };
}

async function executeTool(name, args = {}) {
  if (name === 'plan_mark_streets') {
    const streets = Array.isArray(args.streets) ? args.streets.map(v=>String(v).trim()).filter(Boolean) : [];
    if (!streets.length) throw new Error('Aucune rue fournie');

    // PASSERELLE DE COMPATIBILITÉ : les anciens connecteurs ChatGPT qui ne voient
    // que plan_mark_streets peuvent quand même écrire dans le lexique.
    if (streets.length === 1 && /^LEXIQUE\s*:/i.test(streets[0])) {
      const text = streets[0].replace(/^LEXIQUE\s*:/i, '').trim();
      if (!text) throw new Error('Texte lexique manquant après LEXIQUE:');
      return queuedWrite('add_lexicon', { title:text, details:text }, `Compatibilité MCP : « ${text} » ajouté et confirmé dans le lexique Android.`);
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date||'')) ? String(args.date) : new Date().toISOString().slice(0,10);
    return queuedWrite('mark_streets', { streets, date }, `${streets.length} rue(s) confirmée(s) comme appliquée(s) dans Plan Travail Orsay.`);
  }
  if (name === 'plan_delete_street') {
    const street = String(args.street||'').trim();
    if (!street) throw new Error('Rue manquante');
    return queuedWrite('delete_street', { street }, `Suppression de ${street} confirmée par Android.`);
  }
  if (name === 'plan_add_lexicon') {
    const title=String(args.title||'').trim(), details=String(args.details||'').trim();
    if (!title || !details) throw new Error('Titre et détails obligatoires');
    return queuedWrite('add_lexicon',{title,details},`Entrée « ${title} » ajoutée et confirmée dans le lexique Android.`);
  }
  if (name === 'plan_add_lexicon_note') {
    const text=String(args.text||'').trim(); if(!text) throw new Error('Texte du lexique manquant');
    return queuedWrite('add_lexicon',{title:text,details:text},`Note « ${text} » ajoutée et confirmée dans le lexique Android.`);
  }
  if (name === 'plan_virtual_keyboard') {
    const target=String(args.target||'').trim(), text=String(args.text||'').trim(); if(!text) throw new Error('Texte à saisir manquant');
    if(target==='lexicon') return queuedWrite('add_lexicon',{title:text,details:String(args.details||text).trim()||text},`Clavier MCP : « ${text} » écrit et confirmé dans le lexique Android.`);
    if(target==='street'){const date=/^\d{4}-\d{2}-\d{2}$/.test(String(args.date||''))?String(args.date):new Date().toISOString().slice(0,10);return queuedWrite('mark_streets',{streets:[text],date},`Clavier MCP : rue « ${text} » marquée et confirmée dans Android.`);}
    throw new Error('Destination clavier non supportée');
  }
  if (name === 'plan_reset_week') return queuedWrite('reset_week',{},'Remise à zéro de la semaine confirmée par Android. Le lexique est conservé.');
  if (name === 'plan_get_app_state') {
    const state=stateFor(), age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity, online=age<20000, out={...state,online};
    return {content:[{type:'text',text:online?`Application synchronisée : ${out.current_week_count||0} rue(s) cette semaine, ${out.today_count||0} aujourd'hui.`:"Aucun état Android récent : l'application n'est pas actuellement synchronisée."}],structuredContent:out};
  }
  if (name === 'plan_get_status') {
    const q=queueFor(), state=stateFor(), age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity;
    const out={ok:true,pending_count:q.length,device_id:DEVICE_ID,android_online:age<20000,last_android_sync:state.updated_at,current_week_count:state.current_week_count||0,today_count:state.today_count||0,lexicon_count:Array.isArray(state.lexicon)?state.lexicon.length:0};
    return {content:[{type:'text',text:`${q.length} commande(s) en attente. Android ${out.android_online?'connecté':'non connecté'}. Lexique synchronisé : ${out.lexicon_count} entrée(s).`}],structuredContent:out};
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
  if(method==='initialize') return rpcResult(id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:true}},serverInfo:{name:'Plan Travail Orsay',version:'1.4.0'}});
  if(method==='ping') return rpcResult(id,{});
  if(method==='tools/list') return rpcResult(id,{tools:tools()});
  if(method==='tools/call'){try{return rpcResult(id,await executeTool(body?.params?.name,body?.params?.arguments||{}));}catch(e){return rpcResult(id,{isError:true,content:[{type:'text',text:e.message||'Erreur outil'}]});}}
  if(method&&method.startsWith('notifications/')) return null;
  return rpcError(id,-32601,`Méthode non supportée: ${method||'vide'}`);
}

export function installPlanTravailMcp(app) {
  app.get('/plan-travail/health',(_req,res)=>res.json({ok:true,service:'plan-travail-orsay-mcp',version:'1.4.0',legacy_lexicon_bridge:true}));
  app.post('/plan-travail/mcp',async(req,res)=>{const answer=await handleRpc(req.body);if(answer===null)return res.status(202).end();res.setHeader('Cache-Control','no-store');return res.json(answer);});
  app.get('/plan-travail/commands',(req,res)=>{const deviceId=String(req.query.device_id||DEVICE_ID),now=Date.now(),q=queueFor(deviceId),commands=q.filter(c=>!c.delivered_at||now-Date.parse(c.delivered_at)>10000);for(const c of commands)c.delivered_at=new Date().toISOString();return res.json({device_id:deviceId,commands});});
  app.post('/plan-travail/command-result',(req,res)=>{const body=req.body||{},deviceId=String(body.device_id||DEVICE_ID),id=String(body.command_id||'');if(!id)return res.status(400).json({ok:false,error:'command_id manquant'});const result={...body,device_id:deviceId,received_at:new Date().toISOString()};commandResults.set(id,result);const q=queueFor(deviceId),idx=q.findIndex(c=>c.id===id);if(idx>=0)q.splice(idx,1);return res.json({ok:true,command_id:id});});
  app.post('/plan-travail/device-state',(req,res)=>{const body=req.body||{},deviceId=String(body.device_id||DEVICE_ID);deviceStates.set(deviceId,{...body,device_id:deviceId,updated_at:new Date().toISOString()});return res.json({ok:true,device_id:deviceId});});
  app.get('/plan-travail/status',(_req,res)=>{const q=queueFor(),state=stateFor(),age=state.updated_at?Date.now()-Date.parse(state.updated_at):Infinity;return res.json({ok:true,device_id:DEVICE_ID,pending_count:q.length,android_online:age<20000,last_android_sync:state.updated_at,current_week_count:state.current_week_count||0,today_count:state.today_count||0,lexicon_count:Array.isArray(state.lexicon)?state.lexicon.length:0,legacy_lexicon_bridge:true});});
}
