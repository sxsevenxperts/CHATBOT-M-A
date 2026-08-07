import './env.js';
import { str, num } from './env.js';
import { sendText, sendPresence } from './evolution.js';
import { getSession, saveSession, saveTriage, logMessage } from './database.js';

/**
 * Triagem em 2 perguntas:
 *   boas-vindas → "sobre o que deseja falar?" → "qual é o seu veículo?" → atendimento humano
 *
 * No handoff acontecem 3 coisas juntas:
 *   1. grava a triagem  → é ela que acende a notificação no dashboard
 *   2. handed_off = true → o bot NUNCA mais responde esse número
 *   3. pede ao cliente que aguarde o atendimento humano
 *
 * O nome não é perguntado: o WhatsApp entrega o pushName do perfil.
 *
 * Tom: público de alto padrão. Frases curtas, cordiais e contidas.
 * Emoji é exceção, não pontuação.
 */

export const SUBJECTS = [
  'Agendar serviço',
  'Valores e pacotes',
  'Outro assunto'
];

const BUSINESS = {
  0: null,                    // domingo fechado
  1: { open: 7, close: 18 },
  2: { open: 7, close: 18 },
  3: { open: 7, close: 18 },
  4: { open: 7, close: 18 },
  5: { open: 7, close: 18 },
  6: { open: 7, close: 14 }   // sábado
};

const TZ = () => str('TIMEZONE', 'America/Fortaleza');

/**
 * O bot só volta a fazer triagem 24h depois do ÚLTIMO contato.
 * A janela conta do último contato (não do handoff): enquanto o cliente
 * escreve, ela é empurrada para frente e o bot não atropela o atendente.
 */
const REARM_HOURS = () => num('REARM_HOURS', 24);

const ASSINATURA =
  '*M & A Lava a Jato*\n' +
  'Campo dos Velhos · Sobral/CE\n' +
  'Seg a Sex, 7h às 18h · Sáb, 7h às 14h';

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Hora local de Sobral. O container roda em UTC, então o fuso é explícito. */
function localNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ(), weekday: 'short', hour: 'numeric', hour12: false
  }).formatToParts(new Date());

  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: map[parts.find(p => p.type === 'weekday').value],
    hour: Number(parts.find(p => p.type === 'hour').value)
  };
}

export function isOpenNow() {
  const { day, hour } = localNow();
  const h = BUSINESS[day];
  return !!h && hour >= h.open && hour < h.close;
}

/** Próxima abertura em texto, para quem chega fora do horário. */
function nextOpening() {
  const { day, hour } = localNow();
  const nomes = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  const hoje = BUSINESS[day];
  if (hoje && hour < hoje.open) return `hoje, a partir das ${hoje.open}h`;

  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (BUSINESS[d]) {
      return i === 1
        ? `amanhã, a partir das ${BUSINESS[d].open}h`
        : `na ${nomes[d]}, a partir das ${BUSINESS[d].open}h`;
    }
  }
  return 'no próximo dia útil';
}

function subjectsMenu() {
  return SUBJECTS.map((s, i) => `*${i + 1}* · ${s}`).join('\n');
}

/** Aceita "1", o rótulo, ou texto livre — a pergunta é aberta por natureza. */
function matchSubject(input) {
  const t = norm(input);

  const byNumber = t.match(/^([1-9])[\s).:·-]*$/);
  if (byNumber) {
    const idx = Number(byNumber[1]) - 1;
    if (idx >= 0 && idx < SUBJECTS.length) return SUBJECTS[idx];
  }

  const exact = SUBJECTS.find(s => norm(s) === t);
  if (exact) return exact;

  return input.trim().length >= 2 ? input.trim().slice(0, 200) : null;
}

/** Primeiro nome, capitalizado — evita tratar o cliente por um nome de perfil inteiro. */
function primeiroNome(pushName) {
  const raw = String(pushName || '').trim().split(/\s+/)[0] || '';
  if (raw.length < 2) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Pausa antes de responder, para o atendimento não parecer robótico.
 * Configurável para que os testes rodem sem esperar.
 */
const DELAY_MIN = () => num('REPLY_DELAY_MIN_MS', 3000);
const DELAY_MAX = () => num('REPLY_DELAY_MAX_MS', 5000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reply(phone, text) {
  const min = DELAY_MIN(), max = DELAY_MAX();
  const wait = min + Math.random() * Math.max(0, max - min);

  if (wait > 0) {
    await sendPresence(phone, 'composing');   // "digitando…" durante a espera
    await sleep(wait);
  }

  await sendText(phone, text);
  await logMessage(phone, 'out', text);
}

export async function handleMessage({ phone, text, pushName }) {
  await logMessage(phone, 'in', text);

  let session = await getSession(phone);

  // 24h desde o último contato: bot rearmado, atende como contato novo.
  // Esta checagem vem ANTES do handed_off — é ela que reabre a triagem.
  if (session) {
    const horas = (Date.now() - new Date(session.updated_at).getTime()) / 3600_000;
    if (horas >= REARM_HOURS()) {
      console.log(`[flow] ${phone}: ${horas.toFixed(1)}h sem contato — bot rearmado`);
      session = null;
    }
  }

  // Dentro da janela de 24h e já entregue ao humano: bot em silêncio.
  // Só registra a mensagem e empurra a janela (o atendente segue no comando).
  if (session?.handed_off) {
    await saveSession(phone, {});   // toca updated_at
    console.log(`[flow] ${phone} em atendimento humano — bot silenciado`);
    return { action: 'silenced' };
  }

  /* ---------- Etapa 1 · boas-vindas + assunto ---------- */
  if (!session) {
    const nome = primeiroNome(pushName);
    const saudacao = nome ? `Olá, ${nome}.` : 'Olá.';

    await saveSession(phone, {
      step: 'ask_subject',
      data: { phone, name: nome || 'Cliente' },
      handed_off: false
    });

    await reply(phone,
      `${saudacao} Seja bem-vindo à *M & A Lava a Jato*.\n\n` +
      `Para direcioná-lo ao atendimento adequado, preciso de apenas duas informações.\n\n` +
      `*Sobre o que deseja falar?*\n\n${subjectsMenu()}\n\n` +
      `_Responda com o número ou escreva como preferir._`
    );
    return { action: 'started' };
  }

  const data = { ...session.data, phone };
  const nomeAtual = primeiroNome(pushName);
  if (nomeAtual && (!data.name || data.name === 'Cliente')) data.name = nomeAtual;

  switch (session.step) {
    /* ---------- Etapa 2 · assunto ---------- */
    case 'ask_subject': {
      const subject = matchSubject(text);
      if (!subject) {
        await reply(phone, `Desculpe, não compreendi.\n\n*Sobre o que deseja falar?*\n\n${subjectsMenu()}`);
        return { action: 'retry' };
      }
      data.subject = subject;
      await saveSession(phone, { step: 'ask_vehicle', data });
      await reply(phone, 'Obrigado. E qual é o seu veículo?\n\n_Marca e modelo já são suficientes._');
      return { action: 'ok' };
    }

    /* ---------- Etapa 3 · veículo → handoff + notificação ---------- */
    case 'ask_vehicle': {
      const vehicle = text.trim().slice(0, 120);
      if (vehicle.length < 2) {
        await reply(phone, 'Desculpe, não compreendi. Qual é o seu veículo?');
        return { action: 'retry' };
      }
      data.vehicle = vehicle;

      // 1. Grava — acende a notificação no dashboard.
      const triage = await saveTriage(data);

      // 2. Bot sai de cena. Deste ponto em diante, apenas humano.
      await saveSession(phone, { step: 'done', data, handed_off: true });

      // 3. Fecha pedindo que aguarde, ajustando pelo horário.
      const aberto = isOpenNow();
      const fecho = aberto
        ? 'Nossa equipe já foi notificada.\n\n' +
          '*Por favor, aguarde um momento neste chat* — um de nossos atendentes dará continuidade ao seu atendimento.'
        : 'Nossa equipe já foi notificada.\n\n' +
          `*Por favor, aguarde nosso atendimento*: estamos fechados neste momento e retornamos aqui mesmo ${nextOpening()}.`;

      await reply(phone,
        `Perfeito${data.name && data.name !== 'Cliente' ? `, ${data.name}` : ''}. Registrei o seguinte:\n\n` +
        `Assunto · ${data.subject}\n` +
        `Veículo · ${data.vehicle}\n\n` +
        `${fecho}\n\n${ASSINATURA}`
      );

      console.log(
        `[flow] triagem #${triage.id} — ${data.name} (${phone}) · ` +
        `${data.subject} · ${data.vehicle} · ${aberto ? 'no horário' : 'fora do horário'} → humano`
      );
      return { action: 'handoff', triage, openNow: aberto };
    }

    default: {
      console.warn(`[flow] step desconhecido "${session.step}" para ${phone}, reiniciando`);
      await saveSession(phone, { step: 'ask_subject', data: { phone, name: data.name }, handed_off: false });
      await reply(phone, `*Sobre o que deseja falar?*\n\n${subjectsMenu()}`);
      return { action: 'reset' };
    }
  }
}
