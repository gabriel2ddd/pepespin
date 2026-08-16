// Guarda a contagem de indicações num banco de dados real do lado do
// servidor (Cloudflare KV), compartilhado entre todos os visitantes.

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const KV = env.PEPESPIN_KV;

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { success: false, error: 'Corpo da requisição inválido' });
  }

  const { action, ref, visitorId } = payload;
  if (!ref || typeof ref !== 'string' || ref.length > 32) {
    return json(400, { success: false, error: 'Código de indicação inválido' });
  }

  try {
    if (action === 'count') {
      const raw = await KV.get(`ref:count:${ref}`);
      const count = raw ? parseInt(raw, 10) || 0 : 0;
      return json(200, { success: true, count });
    }

    // Associa o código de indicação de alguém à conta FaucetPay que deve
    // receber a comissão. Chamado quando a pessoa salva a própria conta.
    if (action === 'set-account') {
      const { account } = payload;
      if (!account || typeof account !== 'string' || account.length > 128) {
        return json(400, { success: false, error: 'account inválida' });
      }
      await KV.put(`ref:account:${ref}`, account);
      return json(200, { success: true });
    }

    // Usado pela function de pagamento (claim.js) pra descobrir pra qual
    // conta mandar a comissão de indicação de 5%.
    if (action === 'get-account') {
      const account = await KV.get(`ref:account:${ref}`);
      return json(200, { success: true, account: account || null });
    }

    if (action === 'register') {
      if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
        return json(400, { success: false, error: 'visitorId inválido' });
      }
      const dedupeKey = `ref:visitor:${ref}:${visitorId}`;
      const already = await KV.get(dedupeKey);
      if (already) {
        const raw = await KV.get(`ref:count:${ref}`);
        const count = raw ? parseInt(raw, 10) || 0 : 0;
        return json(200, { success: true, count, alreadyCounted: true });
      }

      await KV.put(dedupeKey, '1');
      const raw = await KV.get(`ref:count:${ref}`);
      const newCount = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
      await KV.put(`ref:count:${ref}`, String(newCount));

      return json(200, { success: true, count: newCount });
    }

    return json(400, { success: false, error: 'Ação desconhecida' });
  } catch (err) {
    return json(502, { success: false, error: 'Falha ao acessar o armazenamento' });
  }
}
