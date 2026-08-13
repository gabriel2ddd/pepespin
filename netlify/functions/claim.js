// Essa função roda no servidor da Netlify, nunca no navegador do visitante.
// Por isso a API key fica segura aqui (lida de uma variável de ambiente),
// em vez de ficar exposta no código do site.

// Precisa bater com o COOLDOWN_MS do index.html (lá em segundos: 300 = 5 min).
// Isso é a segunda camada de proteção: mesmo que alguém limpe o localStorage
// do navegador ou use aba anônima pra tentar burlar o tempo de espera do lado
// do cliente, essa checagem no servidor consulta o histórico real de
// pagamentos da FaucetPay e bloqueia o resgate se o mesmo destinatário já
// recebeu um pagamento nosso há menos de COOLDOWN_SECONDS.
const COOLDOWN_SECONDS = 300;

function getClientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    '0.0.0.0'
  );
}

async function secondsSinceLastPayout(apiKey, to) {
  try {
    const form = new URLSearchParams();
    form.set('api_key', apiKey);
    form.set('count', '50');
    form.set('currency', 'PEPE');

    const resp = await fetch('https://faucetpay.io/api/v1/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await resp.json();
    if (data.status !== 200 || !Array.isArray(data.rewards)) return null;

    const match = data.rewards.find(r => r.to === to);
    if (!match || !match.date) return null;

    // Formato esperado: "DD-MM-YY HH:MM:SS GMT"
    const parsed = Date.parse(match.date.replace(' GMT', ' UTC'));
    if (isNaN(parsed)) return null;

    return (Date.now() - parsed) / 1000;
  } catch (e) {
    // Se a consulta ao histórico falhar por qualquer motivo, não bloqueia o
    // usuário por causa disso — só não aplica essa camada extra de proteção
    // nessa tentativa específica.
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success:false, error: 'Método não permitido' }) };
  }

  const API_KEY = process.env.FAUCETPAY_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ success:false, error: 'FAUCETPAY_API_KEY não configurada nas variáveis de ambiente do site' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success:false, error: 'Corpo da requisição inválido' }) };
  }

  const { to, amount } = payload;
  if (!to || !amount || Number(amount) <= 0) {
    return { statusCode: 400, body: JSON.stringify({ success:false, error: 'Dados de resgate incompletos' }) };
  }

  const elapsed = await secondsSinceLastPayout(API_KEY, String(to));
  if (elapsed !== null && elapsed < COOLDOWN_SECONDS) {
    const wait = Math.ceil(COOLDOWN_SECONDS - elapsed);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, message: `Aguarde mais ${wait}s antes do próximo resgate (verificado no servidor)` })
    };
  }

  // A FaucetPay espera o valor na MENOR unidade da moeda (tipo satoshi),
  // não no valor "inteiro". Para PEPE, 1 PEPE inteiro = 100.000.000 dessa unidade.
  // Sem essa conversão, o valor pago fica 100 milhões de vezes menor do que deveria.
  const SMALLEST_UNIT_FACTOR = 100000000;
  const amountSmallestUnit = Math.round(Number(amount) * SMALLEST_UNIT_FACTOR);

  const form = new URLSearchParams();
  form.set('api_key', API_KEY);
  form.set('to', String(to));
  form.set('amount', String(amountSmallestUnit));
  form.set('currency', 'PEPE');
  form.set('ip_address', getClientIp(event));

  try {
    const resp = await fetch('https://faucetpay.io/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await resp.json();

    if (data.status === 200) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, payout_id: data.payout_id || null })
      };
    }

    // A FaucetPay respondeu, mas recusou o pagamento (saldo insuficiente, conta inválida, etc.)
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, code: data.status, message: data.message || 'Pagamento recusado pela FaucetPay' })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, error: 'Não foi possível contatar a FaucetPay' })
    };
  }
};
