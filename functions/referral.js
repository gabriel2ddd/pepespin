// Guarda a contagem de indicações, a conta FaucetPay de cada indicador, e um
// registro de usuários — tudo num banco de dados real do lado do servidor
// (Cloudflare KV), compartilhado entre todos os visitantes e dispositivos.
//
// O código de indicação (refCode) agora é derivado da conta FaucetPay da
// pessoa, não mais de um número aleatório salvo só no navegador. Isso
// resolve o problema de o link mudar entre celular e computador: contanto
// que a pessoa salve a mesma conta FaucetPay em qualquer aparelho, ela
// recebe sempre o mesmo código de volta.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function randomCode() {
  return Math.random().toString(36).slice(2, 9);
}

function checkAdmin(payload, env) {
  const expected = env.PTC_ADMIN_KEY;
  return !!expected && payload.adminKey === expected;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.PEPESPIN_KV;

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { success: false, error: 'Corpo da requisição inválido' });
  }

  const { action } = payload;

  try {
    // ── Dado uma conta FaucetPay, devolve o código fixo dela (cria um novo
    // só na primeira vez que essa conta aparece). Chamado sempre que a
    // pessoa salva a própria conta, de qualquer aparelho. ──
    if (action === 'code-for-account') {
      const { account } = payload;
      if (!account || typeof account !== 'string' || account.length > 128) {
        return json(400, { success: false, error: 'account inválida' });
      }
      const accountKey = `ref:code-of-account:${account}`;
      let code = await kv.get(accountKey);
      const now = Date.now();

      if (!code) {
        code = randomCode();
        await kv.put(accountKey, code);
        await kv.put(`ref:account:${code}`, account);
      }

      // Atualiza o registro de usuários (visível no painel Admin).
      const userKey = `users:${account}`;
      const existingRaw = await kv.get(userKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : null;
      const user = {
        account,
        refCode: code,
        firstSeen: existing ? existing.firstSeen : now,
        lastSeen: now
      };
      await kv.put(userKey, JSON.stringify(user));

      const countRaw = await kv.get(`ref:count:${code}`);
      const count = countRaw ? parseInt(countRaw, 10) || 0 : 0;

      return json(200, { success: true, code, count });
    }

    const { ref, visitorId } = payload;

    if (action === 'count') {
      if (!ref) return json(400, { success: false, error: 'Código de indicação inválido' });
      const raw = await kv.get(`ref:count:${ref}`);
      const count = raw ? parseInt(raw, 10) || 0 : 0;
      return json(200, { success: true, count });
    }

    // Usado pela function de pagamento (claim.js) pra descobrir pra qual
    // conta mandar a comissão de indicação de 5%.
    if (action === 'get-account') {
      if (!ref) return json(400, { success: false, error: 'Código de indicação inválido' });
      const account = await kv.get(`ref:account:${ref}`);
      return json(200, { success: true, account: account || null });
    }

    if (action === 'register') {
      if (!ref) return json(400, { success: false, error: 'Código de indicação inválido' });
      if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
        return json(400, { success: false, error: 'visitorId inválido' });
      }
      const dedupeKey = `ref:visitor:${ref}:${visitorId}`;
      const already = await kv.get(dedupeKey);
      if (already) {
        const raw = await kv.get(`ref:count:${ref}`);
        const count = raw ? parseInt(raw, 10) || 0 : 0;
        return json(200, { success: true, count, alreadyCounted: true });
      }

      await kv.put(dedupeKey, '1');
      const raw = await kv.get(`ref:count:${ref}`);
      const newCount = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
      await kv.put(`ref:count:${ref}`, String(newCount));

      return json(200, { success: true, count: newCount });
    }

    // ── Admin: lista todo mundo que já salvou uma conta no site ──
    if (action === 'admin-list-users') {
      if (!checkAdmin(payload, env)) {
        return json(403, { success: false, error: 'Chave de administrador inválida ou não configurada' });
      }
      const list = await kv.list({ prefix: 'users:' });
      const users = [];
      for (const entry of list.keys || []) {
        const raw = await kv.get(entry.name);
        if (!raw) continue;
        const user = JSON.parse(raw);
        const countRaw = await kv.get(`ref:count:${user.refCode}`);
        user.referredCount = countRaw ? parseInt(countRaw, 10) || 0 : 0;
        users.push(user);
      }
      users.sort((a, b) => b.lastSeen - a.lastSeen);
      return json(200, { success: true, users });
    }

    return json(400, { success: false, error: 'Ação desconhecida' });
  } catch (err) {
    return json(502, { success: false, error: 'Falha ao acessar o armazenamento' });
  }
}
