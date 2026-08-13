// Guarda a contagem de indicações usando Netlify Blobs — um armazenamento de
// verdade no servidor da Netlify, e não localStorage (que existe só dentro do
// navegador de cada visitante e por isso nunca era realmente compartilhado).
const { getStore } = require('@netlify/blobs');

function store() {
  return getStore('pepespin-referrals');
}

exports.handler = async (event) => {
  const s = store();

  // GET /.netlify/functions/referral?ref=CODIGO
  // Consulta quantas pessoas esse código já indicou.
  if (event.httpMethod === 'GET') {
    const ref = (event.queryStringParameters || {}).ref;
    if (!ref) {
      return { statusCode: 400, body: JSON.stringify({ success:false, error:'parâmetro ref ausente' }) };
    }
    const raw = await s.get(ref);
    const count = raw ? (parseInt(raw, 10) || 0) : 0;
    return { statusCode: 200, body: JSON.stringify({ success:true, count }) };
  }

  // POST /.netlify/functions/referral  { "ref": "CODIGO" }
  // Registra uma nova indicação pra esse código (soma +1 de verdade, visível
  // pra qualquer visitante que depois consulte a contagem).
  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ success:false, error:'corpo da requisição inválido' }) };
    }

    const ref = payload.ref;
    if (!ref || typeof ref !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ success:false, error:'ref ausente ou inválido' }) };
    }

    const raw = await s.get(ref);
    const count = (raw ? (parseInt(raw, 10) || 0) : 0) + 1;
    await s.set(ref, String(count));
    return { statusCode: 200, body: JSON.stringify({ success:true, count }) };
  }

  return { statusCode: 405, body: JSON.stringify({ success:false, error:'Método não permitido' }) };
};
