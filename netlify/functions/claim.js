// Essa função roda no servidor da Netlify, nunca no navegador do visitante.
// Por isso a API key fica segura aqui (lida de uma variável de ambiente),
// em vez de ficar exposta no código do site.

const { getStore } = require('@netlify/blobs');

// Precisa bater com os textos exibidos na aba "Indicação" do index.html:
// 10% de bônus pra quem foi indicado, 5% de comissão pra quem indicou.
const REFERRED_BONUS_RATE = 0.10;
const REFERRER_COMMISSION_RATE = 0.05;

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

// A FaucetPay espera o valor na MENOR unidade da moeda (tipo satoshi), não no
// valor "inteiro". Para PEPE, 1 PEPE inteiro = 100.000.000 dessa unidade.
const SMALLEST_UNIT_FACTOR = 100000000;

async function sendPayment(apiKey, to, amountPepe, ip) {
  const form = new URLSearchParams();
  form.set('api_key', apiKey);
  form.set('to', String(to));
  form.set('amount', String(Math.round(amountPepe * SMALLEST_UNIT_FACTOR)));
  form.set('currency', 'PEPE');
  form.set('ip_address', ip);

  const resp = await fetch('https://faucetpay.io/api/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  return resp.json();
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

  const { to, amount, referredBy } = payload;
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

  const baseAmount = Number(amount);
  // Se essa pessoa entrou pelo link de alguém, ela ganha 10% a mais no
  // próprio resgate. O valor total pago pra ela já sai correto de uma vez.
  const referredBonus = referredBy ? baseAmount * REFERRED_BONUS_RATE : 0;
  const totalToUser = baseAmount + referredBonus;

  const ip = getClientIp(event);

  try {
    const data = await sendPayment(API_KEY, to, totalToUser, ip);

    if (data.status !== 200) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, code: data.status, message: data.message || 'Pagamento recusado pela FaucetPay' })
      };
    }

    // Pagamento principal feito. Agora, se essa pessoa foi indicada por
    // alguém, tenta pagar os 5% de comissão pra quem indicou. Isso roda
    // depois do pagamento principal e uma falha aqui não desfaz nem
    // reporta erro pro usuário — ele já recebeu o resgate dele normalmente.
    let referrerPaid = false;
    if (referredBy) {
      try {
        const store = getStore('pepespin-referrals');
        const referrerAccount = await store.get(`account:${referredBy}`);
        if (referrerAccount && referrerAccount !== to) {
          const commission = baseAmount * REFERRER_COMMISSION_RATE;
          const commissionResult = await sendPayment(API_KEY, referrerAccount, commission, ip);
          referrerPaid = commissionResult.status === 200;
        }
      } catch (e) {
        // Falha silenciosa: não afeta o pagamento principal do usuário.
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        payout_id: data.payout_id || null,
        totalPaid: totalToUser,
        referredBonusApplied: referredBonus > 0,
        referrerPaid
      })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, error: 'Não foi possível contatar a FaucetPay' })
    };
  }
};
