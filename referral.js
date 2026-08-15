// Essa função guarda a contagem de indicações num banco de dados real do
// lado do servidor (Netlify Blobs), compartilhado entre todos os visitantes.
// Antes, a contagem era salva só no navegador de cada pessoa (localStorage),
// então cada usuário só via a própria contagem local — nunca via indicações
// de verdade feitas por outras pessoas usando o link dele.

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Método não permitido' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Corpo da requisição inválido' }) };
  }

  const { action, ref, visitorId } = payload;
  if (!ref || typeof ref !== 'string' || ref.length > 32) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Código de indicação inválido' }) };
  }

  const store = getStore('pepespin-referrals');

  try {
    if (action === 'count') {
      const raw = await store.get(`count:${ref}`);
      const count = raw ? parseInt(raw, 10) || 0 : 0;
      return { statusCode: 200, body: JSON.stringify({ success: true, count }) };
    }

    // Associa o código de indicação de alguém à conta FaucetPay que deve
    // receber a comissão. Chamado quando a pessoa salva a própria conta.
    if (action === 'set-account') {
      const { account } = payload;
      if (!account || typeof account !== 'string' || account.length > 128) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: 'account inválida' }) };
      }
      await store.set(`account:${ref}`, account);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // Usado pela function de pagamento (claim.js) pra descobrir pra qual
    // conta mandar a comissão de indicação de 5%.
    if (action === 'get-account') {
      const account = await store.get(`account:${ref}`);
      return { statusCode: 200, body: JSON.stringify({ success: true, account: account || null }) };
    }

    if (action === 'register') {
      if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: 'visitorId inválido' }) };
      }
      // Não deixa a mesma pessoa (mesmo navegador) contar mais de uma vez
      // pro mesmo código, mesmo se recarregar a página várias vezes.
      const dedupeKey = `visitor:${ref}:${visitorId}`;
      const already = await store.get(dedupeKey);
      if (already) {
        const raw = await store.get(`count:${ref}`);
        const count = raw ? parseInt(raw, 10) || 0 : 0;
        return { statusCode: 200, body: JSON.stringify({ success: true, count, alreadyCounted: true }) };
      }

      await store.set(dedupeKey, '1');
      const raw = await store.get(`count:${ref}`);
      const newCount = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
      await store.set(`count:${ref}`, String(newCount));

      return { statusCode: 200, body: JSON.stringify({ success: true, count: newCount }) };
    }

    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Ação desconhecida' }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Falha ao acessar o armazenamento' }) };
  }
};
