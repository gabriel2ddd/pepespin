// Sistema de PTC (Paid To Click): anunciantes cadastram um link e pagam pra
// que visitantes vejam por um tempo mínimo em troca de PEPE. Toda a parte de
// aprovação de pagamento é MANUAL (o admin confere no histórico da própria
// FaucetPay e libera aqui) — não depende da Merchant API da FaucetPay, que
// exige aprovação prévia deles.
//
// Guardado no mesmo Netlify Blobs (banco do lado do servidor), num store
// separado do de indicações, pra não misturar dado de coisas diferentes.

const { getStore } = require('@netlify/blobs');

function store() {
  return getStore('pepespin-ptc');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

// Mesma lógica de pagamento da claim.js, só que sem a checagem de cooldown
// de 5 minutos — essa é uma recompensa de natureza diferente (visualização
// de anúncio, não giro da roleta), então tem sua própria proteção contra
// abuso: dedupe de 1 visualização por dia por navegador, mais o tempo
// mínimo obrigatório validado no servidor (ver 'complete-view' abaixo).
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

function getClientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    '0.0.0.0'
  );
}

// Só o admin pode ver a lista completa (com a conta do anunciante) e
// aprovar/rejeitar/pausar campanhas. A chave é definida como variável de
// ambiente PTC_ADMIN_KEY no painel do Netlify — sem isso configurado, o
// painel de admin fica bloqueado pra todo mundo (comportamento seguro).
function checkAdmin(payload) {
  const expected = process.env.PTC_ADMIN_KEY;
  return !!expected && payload.adminKey === expected;
}

async function loadAllCampaigns(s) {
  const list = await s.list({ prefix: 'campaign:' });
  const campaigns = [];
  for (const blob of list.blobs || []) {
    const raw = await s.get(blob.key);
    if (raw) {
      try { campaigns.push(JSON.parse(raw)); } catch (e) { /* ignora entrada corrompida */ }
    }
  }
  campaigns.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return campaigns;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Método não permitido' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { success: false, error: 'Corpo da requisição inválido' });
  }

  const s = store();
  const action = payload.action;

  try {
    // ── Anunciante envia uma campanha nova (fica pendente até o admin aprovar) ──
    if (action === 'submit') {
      const { url, title, description, rewardPerView, viewSeconds, totalViews, advertiserAccount } = payload;

      if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 300) {
        return json(400, { success: false, error: 'Link inválido (precisa começar com http:// ou https://)' });
      }
      if (typeof title !== 'string' || !title.trim() || title.length > 80) {
        return json(400, { success: false, error: 'Título inválido' });
      }
      const desc = typeof description === 'string' ? description.slice(0, 200) : '';
      const reward = parseInt(rewardPerView, 10);
      if (!reward || reward < 1 || reward > 240) {
        return json(400, { success: false, error: 'Recompensa deve ser entre 1 e 240 PEPE' });
      }
      const seconds = parseInt(viewSeconds, 10);
      if (!seconds || seconds < 10 || seconds > 60) {
        return json(400, { success: false, error: 'Tempo de visualização deve ser entre 10 e 60 segundos' });
      }
      const views = parseInt(totalViews, 10);
      if (!views || views < 1 || views > 1000000) {
        return json(400, { success: false, error: 'Quantidade de visualizações inválida' });
      }
      if (typeof advertiserAccount !== 'string' || !advertiserAccount.trim() || advertiserAccount.length > 128) {
        return json(400, { success: false, error: 'Informe uma conta FaucetPay válida' });
      }

      const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const campaign = {
        id,
        url: url.trim(),
        title: title.trim(),
        description: desc.trim(),
        rewardPerView: reward,
        viewSeconds: seconds,
        totalViews: views,
        approvedViews: 0,
        remainingViews: 0,
        status: 'pending',
        advertiserAccount: advertiserAccount.trim(),
        createdAt: Date.now()
      };
      await s.set('campaign:' + id, JSON.stringify(campaign));
      return json(200, { success: true, id });
    }

    // ── Lista pública: só campanhas ativas com saldo de visualização, sem dado sensível ──
    if (action === 'list') {
      const all = await loadAllCampaigns(s);
      const campaigns = all
        .filter(c => c.status === 'active' && c.remainingViews > 0)
        .map(c => ({
          id: c.id, url: c.url, title: c.title, description: c.description,
          rewardPerView: c.rewardPerView, viewSeconds: c.viewSeconds
        }));
      return json(200, { success: true, campaigns });
    }

    // ── Visitante clica em "Visitar": inicia a contagem no servidor ──
    if (action === 'start-view') {
      const { id, visitorId } = payload;
      if (!id || typeof id !== 'string') return json(400, { success: false, error: 'id inválido' });
      if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
        return json(400, { success: false, error: 'visitorId inválido' });
      }

      const raw = await s.get('campaign:' + id);
      if (!raw) return json(404, { success: false, error: 'Campanha não encontrada' });
      const campaign = JSON.parse(raw);
      if (campaign.status !== 'active' || campaign.remainingViews <= 0) {
        return json(200, { success: false, error: 'Campanha indisponível' });
      }

      const viewedKey = `viewed:${id}:${visitorId}:${today()}`;
      const already = await s.get(viewedKey);
      if (already) {
        return json(200, { success: false, error: 'já visto hoje' });
      }

      await s.set(`pending:${id}:${visitorId}`, String(Date.now()));
      return json(200, { success: true, viewSeconds: campaign.viewSeconds, reward: campaign.rewardPerView });
    }

    // ── Visitante terminou de esperar: valida no servidor e libera a recompensa ──
    if (action === 'complete-view') {
      const { id, visitorId, to } = payload;
      if (!id || typeof id !== 'string') return json(400, { success: false, error: 'id inválido' });
      if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
        return json(400, { success: false, error: 'visitorId inválido' });
      }

      const pendingKey = `pending:${id}:${visitorId}`;
      const startedAtRaw = await s.get(pendingKey);
      if (!startedAtRaw) {
        return json(200, { success: false, error: 'Visualização não iniciada. Clique em Visitar de novo.' });
      }

      const raw = await s.get('campaign:' + id);
      if (!raw) return json(404, { success: false, error: 'Campanha não encontrada' });
      const campaign = JSON.parse(raw);
      if (campaign.status !== 'active' || campaign.remainingViews <= 0) {
        return json(200, { success: false, error: 'Campanha indisponível' });
      }

      // Tolerância de 1.5s pra variação de rede/timer do navegador — o resto
      // do tempo precisa ter passado de verdade, checado com o relógio do
      // servidor (o cliente não pode simplesmente mentir o tempo esperado).
      const elapsedMs = Date.now() - parseInt(startedAtRaw, 10);
      if (elapsedMs < campaign.viewSeconds * 1000 - 1500) {
        return json(200, { success: false, error: 'Tempo de visualização ainda não completou' });
      }

      const viewedKey = `viewed:${id}:${visitorId}:${today()}`;
      const already = await s.get(viewedKey);
      if (already) {
        return json(200, { success: false, error: 'já visto hoje' });
      }

      await s.set(viewedKey, '1');
      await s.delete(pendingKey);

      campaign.remainingViews -= 1;
      if (campaign.remainingViews <= 0) campaign.status = 'exhausted';
      await s.set('campaign:' + id, JSON.stringify(campaign));

      // Se o visitante já tem conta FaucetPay salva, paga de verdade e na
      // hora. Sem conta salva, fica em modo demonstração (o front-end só
      // soma no saldo exibido), igual já acontece com a roleta.
      let paid = false;
      if (to && typeof to === 'string') {
        const API_KEY = process.env.FAUCETPAY_API_KEY;
        if (API_KEY) {
          try {
            const ip = getClientIp(event);
            const result = await sendPayment(API_KEY, to, campaign.rewardPerView, ip);
            paid = result.status === 200;
          } catch (e) { /* pagamento falhou, mas a visualização já foi contabilizada */ }
        }
      }

      return json(200, { success: true, reward: campaign.rewardPerView, paid });
    }

    // ── A partir daqui, todas as ações exigem a chave de administrador ──
    if (!checkAdmin(payload)) {
      return json(403, { success: false, error: 'Chave de administrador inválida ou não configurada' });
    }

    if (action === 'admin-list') {
      const campaigns = await loadAllCampaigns(s);
      return json(200, { success: true, campaigns });
    }

    if (action === 'admin-approve') {
      const { id, approvedViews } = payload;
      const views = parseInt(approvedViews, 10);
      if (!id || !views || views < 1 || views > 1000000) {
        return json(400, { success: false, error: 'Dados de aprovação inválidos' });
      }
      const raw = await s.get('campaign:' + id);
      if (!raw) return json(404, { success: false, error: 'Campanha não encontrada' });
      const campaign = JSON.parse(raw);
      campaign.approvedViews = views;
      campaign.remainingViews = views;
      campaign.status = 'active';
      campaign.approvedAt = Date.now();
      await s.set('campaign:' + id, JSON.stringify(campaign));
      return json(200, { success: true });
    }

    if (action === 'admin-reject') {
      const { id } = payload;
      const raw = await s.get('campaign:' + id);
      if (!raw) return json(404, { success: false, error: 'Campanha não encontrada' });
      const campaign = JSON.parse(raw);
      campaign.status = 'rejected';
      await s.set('campaign:' + id, JSON.stringify(campaign));
      return json(200, { success: true });
    }

    if (action === 'admin-toggle') {
      const { id } = payload;
      const raw = await s.get('campaign:' + id);
      if (!raw) return json(404, { success: false, error: 'Campanha não encontrada' });
      const campaign = JSON.parse(raw);
      if (campaign.status === 'active') campaign.status = 'paused';
      else if (campaign.status === 'paused') campaign.status = 'active';
      else return json(400, { success: false, error: 'Só dá pra pausar/reativar campanhas ativas ou pausadas' });
      await s.set('campaign:' + id, JSON.stringify(campaign));
      return json(200, { success: true, status: campaign.status });
    }

    return json(400, { success: false, error: 'Ação desconhecida' });
  } catch (err) {
    return json(502, { success: false, error: 'Falha ao acessar o armazenamento' });
  }
};
