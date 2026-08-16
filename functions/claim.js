// Essa função roda no servidor da Cloudflare, nunca no navegador do visitante.
// Por isso a API key fica segura aqui (lida de uma variável de ambiente/secret),
// em vez de ficar exposta no código do site.
//
// Convertido do Netlify Functions + Netlify Blobs para Cloudflare Pages
// Functions + Cloudflare KV. A lógica é idêntica à versão anterior.

// Precisa bater com os textos exibidos na aba "Indicação" do index.html:
// 10% de bônus pra quem foi indicado, 5% de comissão pra quem indicou.
const REFERRED_BONUS_RATE = 0.10;
const REFERRER_COMMISSION_RATE = 0.05;

// Precisa bater com o COOLDOWN_MS do index.html (lá em segundos: 300 = 5 min).
// Segunda camada de proteção: mesmo que alguém limpe o localStorage do
// navegador ou use aba anônima, essa checagem no servidor consulta o
// histórico real de pagamentos da FaucetPay e bloqueia o resgate se o mesmo
// destinatário já recebeu um pagamento nosso há menos de COOLDOWN_SECONDS.
const COOLDOWN_SECONDS = 300;

const SMALLEST_UNIT_FACTOR = 100000000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

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

    const parsed = Date.parse(match.date.replace(' GMT', ' UTC'));
    if (isNaN(parsed)) return null;

    return (Date.now() - parsed) / 1000;
  } catch (e) {
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const API_KEY = env.FAUCETPAY_API_KEY;
  if (!API_KEY) {
    return json(500, { success: false, error: 'FAUCETPAY_API_KEY não configurada nas variáveis de ambiente do Cloudflare Pages' });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { success: false, error: 'Corpo da requisição inválido' });
  }

  const { to, amount, referredBy } = payload;
  if (!to || !amount || Number(amount) <= 0) {
    return json(400, { success: false, error: 'Dados de resgate incompletos' });
  }

  const elapsed = await secondsSinceLastPayout(API_KEY, String(to));
  if (elapsed !== null && elapsed < COOLDOWN_SECONDS) {
    const wait = Math.ceil(COOLDOWN_SECONDS - elapsed);
    return json(200, { success: false, message: `Aguarde mais ${wait}s antes do próximo resgate (verificado no servidor)` });
  }

  const baseAmount = Number(amount);
  const referredBonus = referredBy ? baseAmount * REFERRED_BONUS_RATE : 0;
  const totalToUser = baseAmount + referredBonus;

  const ip = getClientIp(request);

  try {
    const data = await sendPayment(API_KEY, to, totalToUser, ip);

    if (data.status !== 200) {
      return json(200, { success: false, code: data.status, message: data.message || 'Pagamento recusado pela FaucetPay' });
    }

    let referrerPaid = false;
    if (referredBy) {
      try {
        const referrerAccount = await env.PEPESPIN_KV.get(`ref:account:${referredBy}`);
        if (referrerAccount && referrerAccount !== to) {
          const commission = baseAmount * REFERRER_COMMISSION_RATE;
          const commissionResult = await sendPayment(API_KEY, referrerAccount, commission, ip);
          referrerPaid = commissionResult.status === 200;
        }
      } catch (e) {
        // Falha silenciosa: não afeta o pagamento principal do usuário.
      }
    }

    return json(200, {
      success: true,
      payout_id: data.payout_id || null,
      totalPaid: totalToUser,
      referredBonusApplied: referredBonus > 0,
      referrerPaid
    });
  } catch (err) {
    return json(502, { success: false, error: 'Não foi possível contatar a FaucetPay' });
  }
}
