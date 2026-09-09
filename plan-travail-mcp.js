const queues = new Map();
const DEVICE_ID = 'orsay-main';

function queueFor(id = DEVICE_ID) {
  if (!queues.has(id)) queues.set(id, []);
  return queues.get(id);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function tools() {
  return [
    {
      name: 'plan_mark_streets',
      description: "Marque une ou plusieurs rues d'Orsay comme effectuées. L'application Android applique ensuite la couleur correspondant au jour.",
      inputSchema: {
        type: 'object',
        properties: {
          streets: { type: 'array', items: { type: 'string' }, minItems: 1 },
          date: { type: 'string', description: 'Date YYYY-MM-DD, aujourd’hui si absente.' }
        },
        required: ['streets'],
        additionalProperties: false
      }
    },
    {
      name: 'plan_get_status',
      description: 'Retourne le nombre de commandes Plan Travail Orsay en attente pour le téléphone.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'plan_clear_pending',
      description: 'Supprime les commandes Plan Travail Orsay encore en attente.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ];
}

function executeTool(name, args = {}) {
  if (name === 'plan_mark_streets') {
    const streets = Array.isArray(args.streets) ? args.streets.map(v => String(v).trim()).filter(Boolean) : [];
    if (!streets.length) throw new Error('Aucune rue fournie');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : new Date().toISOString().slice(0, 10);
    const command = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, streets, date, created_at: new Date().toISOString() };
    queueFor().push(command);
    return {
      content: [{ type: 'text', text: `${streets.length} rue(s) envoyée(s) à Plan Travail Orsay pour le ${date}.` }],
      structuredContent: { queued: true, device_id: DEVICE_ID, command }
    };
  }
  if (name === 'plan_get_status') {
    const q = queueFor();
    return { content: [{ type: 'text', text: `${q.length} commande(s) en attente pour Plan Travail Orsay.` }], structuredContent: { ok: true, pending_count: q.length, device_id: DEVICE_ID } };
  }
  if (name === 'plan_clear_pending') {
    queues.set(DEVICE_ID, []);
    return { content: [{ type: 'text', text: 'Commandes Plan Travail Orsay supprimées.' }], structuredContent: { cleared: true } };
  }
  throw new Error(`Outil inconnu: ${name}`);
}

function handleRpc(body) {
  const id = body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
  const method = body?.method;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'Plan Travail Orsay', version: '1.0.0' }
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: tools() });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, executeTool(body?.params?.name, body?.params?.arguments || {}));
    } catch (e) {
      return rpcResult(id, { isError: true, content: [{ type: 'text', text: e.message || 'Erreur outil' }] });
    }
  }
  if (method && method.startsWith('notifications/')) return null;
  return rpcError(id, -32601, `Méthode non supportée: ${method || 'vide'}`);
}

export function installPlanTravailMcp(app) {
  app.get('/plan-travail/health', (_req, res) => res.json({ ok: true, service: 'plan-travail-orsay-mcp' }));

  app.post('/plan-travail/mcp', (req, res) => {
    const answer = handleRpc(req.body);
    if (answer === null) return res.status(202).end();
    res.setHeader('Cache-Control', 'no-store');
    return res.json(answer);
  });

  app.get('/plan-travail/commands', (req, res) => {
    const deviceId = String(req.query.device_id || DEVICE_ID);
    const q = queueFor(deviceId);
    const commands = q.splice(0, q.length);
    return res.json({ device_id: deviceId, commands });
  });

  app.get('/plan-travail/status', (_req, res) => {
    const q = queueFor();
    return res.json({ ok: true, device_id: DEVICE_ID, pending_count: q.length });
  });
}
