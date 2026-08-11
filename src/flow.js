import './env.js';
import { str, num } from './env.js';
import { sendText, sendPresence } from './evolution.js';
import {
  getSession, saveSession, saveTriage, logMessage,
  getSessoesInterrompidas, marcarRetomada, resumoDestinoEnvio
} from './database.js';
import {
  INTENTS, CATEGORIES, SERVICES, NEEDS, LEVELS, PERIODS, DATES,
  NEED_TO_SERVICE, SERVICE_TO_LEVEL
} from './catalog.js';
import {
  extractAll, matchOption, nameFromAnswer, extractVehicle,
  extractDate, extractPeriod, norm
} from './extract.js';
import { bloqueado as envioBloqueado, contarNaoEnviada } from './freio.js';
import { reconciliarFreioPersistido } from './canal.js';
import { info, warn } from './recorder.js';

/**
 * Atendimento em 6 etapas, com árvore de decisão dinâmica.
 *
 * A regra central de UX: nunca perguntar de novo o que o cliente já disse.
 * Cada mensagem passa pelo extrator; o que ele reconhecer preenche o contexto
 * e as perguntas correspondentes simplesmente não acontecem. Quem escreve
 * "meu nome é Sérgio, tenho uma Hilux e quero lavagem completa sábado" cai
 * direto na confirmação.
 *
 * Ao confirmar, o bot silencia: a atendente assume no mesmo chat e recebe o
 * contexto inteiro pronto no dashboard.
 */

const SEM_CERTEZA = 'Ainda não sei qual escolher';
const RECOMENDACAO = 'Quero uma recomendação';
const OUTRO_DIA = 'Quero escolher outro dia';
const OUTRA_DATA = 'Outra data';

const CONFIRM = [
  { emoji: '✅', label: 'Sim, pode encaminhar' },
  { emoji: '🔄', label: 'Quero alterar' },
  { emoji: '❓', label: 'Tenho uma dúvida antes' }
];

const LEVELS_MENU = [...LEVELS, { emoji: '👨‍💼', label: RECOMENDACAO }];
const PERIODS_MENU = [...PERIODS, { emoji: '📆', label: OUTRO_DIA }];

const BUSINESS = {
  0: null,
  1: { open: 7, close: 18 }, 2: { open: 7, close: 18 }, 3: { open: 7, close: 18 },
  4: { open: 7, close: 18 }, 5: { open: 7, close: 18 },
  6: { open: 7, close: 14 }
};

const TZ = () => str('TIMEZONE', 'America/Fortaleza');
const REARM_HOURS = () => num('REARM_HOURS', 24);
const DELAY_MIN = () => num('REPLY_DELAY_MIN_MS', 3000);
const DELAY_MAX = () => num('REPLY_DELAY_MAX_MS', 5000);

const ASSINATURA =
  '*M & A Lavagens e Estética*\n' +
  'Campo dos Velhos · Sobral/CE\n' +
  'Seg a Sex, 7h às 18h · Sáb, 7h às 14h';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Passos válidos desta versão do fluxo. */
const PASSOS = new Set([
  'ask_name', 'ask_intent', 'ask_category', 'ask_model',
  'ask_service', 'ask_need', 'ask_level', 'ask_period', 'ask_date', 'confirm'
]);

/** Rótulo de intenção de versões antigas → chave atual. */
const LEGADO_SUBJECT = {
  'agendar serviço': 'agendar', 'agendar servico': 'agendar',
  'valores e pacotes': 'valores', 'dúvida sobre preço': 'valores',
  'duvida sobre preco': 'valores', 'outro assunto': 'duvida'
};

/**
 * Traz dados gravados por versões anteriores para o formato atual, para que
 * quem estava no meio de uma conversa não recomece do zero.
 */
function normalizarLegado(d) {
  if (!d.intent && d.subject) {
    const k = LEGADO_SUBJECT[norm(d.subject)];
    if (k) d.intent = k;
    else if (!d.service) d.service = d.subject;   // era um serviço escrito à mão
  }
  return d;
}

/* ---------------- Horário ---------------- */

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

function nextOpening() {
  const { day, hour } = localNow();
  const nomes = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
                 'quinta-feira', 'sexta-feira', 'sábado'];
  const hoje = BUSINESS[day];
  if (hoje && hour < hoje.open) return `hoje, a partir das ${hoje.open}h`;
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    if (BUSINESS[d]) {
      return i === 1 ? `amanhã, a partir das ${BUSINESS[d].open}h`
                     : `na ${nomes[d]}, a partir das ${BUSINESS[d].open}h`;
    }
  }
  return 'no próximo dia útil';
}

/* ---------------- Apresentação ---------------- */

function menu(options) {
  return options
    .map((o, i) => `*${i + 1}* · ${o.emoji ? o.emoji + ' ' : ''}${o.label}${o.hint ? ` — ${o.hint}` : ''}`)
    .join('\n');
}

const RODAPE_MENU = '\n\n_Responda com o número ou escreva do seu jeito._';

/** Preposição correta de cada período dentro da frase de confirmação. */
const PERIODO_NA_FRASE = {
  'Manhã': 'pela manhã',
  'Tarde': 'pela tarde',
  'Final da tarde': 'no final da tarde'
};

/** "Jeep Compass" → "Compass", para a conversa soar natural. */
function apelidoVeiculo(v) {
  if (!v) return 'seu veículo';
  const partes = String(v).trim().split(/\s+/);
  return partes.length > 1 ? partes.slice(1).join(' ') : partes[0];
}

async function reply(phone, text) {
  const registrarBloqueio = async ({ destino = false, rejeicoesSeguidas = null } = {}) => {
    await logMessage(phone, 'out', text, null, destino ? 'BLOQUEADO_DESTINO' : 'BLOQUEADO');
    const n = contarNaoEnviada();
    if (destino) {
      warn('freio.destinoNaoEnviou', { phone, rejeicoesSeguidas, naoEnviadas: n });
    } else {
      warn('freio.naoEnviou', { phone, naoEnviadas: n });
    }
    return { enviado: false, destinoBloqueado: destino };
  };

  // Freio engatado: o WhatsApp está recusando. Enviar de novo só piora o
  // número e o cliente continua sem ver nada. Registra o que deixou de sair
  // (fica visível no dashboard) e devolve o caso para o atendimento humano.
  if (envioBloqueado()) {
    return registrarBloqueio();
  }

  // Um contato que recusou duas mensagens não pode silenciar todos os outros.
  // Isola somente ele; a sonda entregue para o mesmo número o libera porque
  // passa a ser o veredito definitivo mais novo desse destinatário.
  const destino = await resumoDestinoEnvio(phone, {
    limite: Math.max(1, num('FREIO_DESTINO_REJEICOES', 2)),
    incluirTestes: process.env.NODE_ENV === 'test'
  });
  if (destino.bloqueado) {
    return registrarBloqueio({ destino: true, rejeicoesSeguidas: destino.rejeicoesSeguidas });
  }

  const min = DELAY_MIN(), max = DELAY_MAX();
  const wait = min + Math.random() * Math.max(0, max - min);
  if (wait > 0) {
    await sendPresence(phone, 'composing');
    await sleep(wait);
  }

  // O ACK que engata o freio pode chegar enquanto esta resposta está no
  // delay humanizado. Revalida imediatamente antes do efeito externo para
  // nenhuma resposta que já estava "digitando" escapar em rajada.
  if (envioBloqueado()) return registrarBloqueio();
  await reconciliarFreioPersistido('pre-envio');
  if (envioBloqueado()) return registrarBloqueio();
  const destinoAgora = await resumoDestinoEnvio(phone, {
    limite: Math.max(1, num('FREIO_DESTINO_REJEICOES', 2)),
    incluirTestes: process.env.NODE_ENV === 'test'
  });
  if (destinoAgora.bloqueado) {
    return registrarBloqueio({
      destino: true,
      rejeicoesSeguidas: destinoAgora.rejeicoesSeguidas
    });
  }
  if (envioBloqueado()) return registrarBloqueio();

  // Guarda o id do WhatsApp: é por ele que o ACK de entrega volta.
  const r = await sendText(phone, text);
  try {
    let salvo = null;
    for (const espera of [0, 120, 500]) {
      if (espera) await sleep(espera);
      salvo = await logMessage(phone, 'out', text, r?.waId || null, r?.status || null);
      if (salvo?.ok) break;
    }
    if (!salvo?.ok) {
      warn('flow.saidaAceitaSemRegistro', {
        phone,
        waId: r?.waId || null,
        acao: 'ACK pode ficar órfão; verifique Supabase e a caixa preta'
      });
    }
    if (salvo?.reconciledAck) {
      await reconciliarFreioPersistido('ack-orfao');
    }
  } catch (e) {
    // O efeito externo já ocorreu. Repetir a entrada por uma falha apenas no
    // log duplicaria a resposta ao cliente; mantém o avanço e alarma a perda
    // de observabilidade para correção operacional.
    warn('flow.saidaAceitaLogFalhou', {
      phone,
      waId: r?.waId || null,
      erro: e.message
    });
  }
  return { enviado: true, waId: r?.waId || null };
}

/* ---------------- Árvore dinâmica ---------------- */

/**
 * Primeiro campo que ainda falta. É isto que faz o bot pular perguntas
 * quando o cliente já entregou a informação.
 */
export function proximoPasso(d) {
  if (!d.name) return 'ask_name';
  if (!d.intent) return 'ask_intent';

  // Dúvida solta não precisa de veículo nem agenda: vai direto ao humano.
  if (d.intent === 'duvida') return d.confirmed ? 'done' : 'confirm';

  if (!d.category) return 'ask_category';
  if (!d.vehicle) return 'ask_model';
  if (!d.service) return 'ask_service';
  if (d.service === SEM_CERTEZA && !d.need) return 'ask_need';
  if (!d.level) return 'ask_level';
  if (!d.period) return 'ask_period';
  if (!d.date_pref) return 'ask_date';
  if (!d.confirmed) return 'confirm';
  return 'done';
}

/** Pergunta correspondente ao passo. */
function pergunta(step, d) {
  const nome = d.name || '';
  const carro = apelidoVeiculo(d.vehicle);

  switch (step) {
    case 'ask_name':
      return 'Olá! 👋 Bem-vindo à *M & A Lavagens e Estética*.\n\n' +
             'Vou iniciar seu atendimento e depois nossa atendente dará continuidade ' +
             'para finalizar seu agendamento.\n\n' +
             'Antes de começarmos, qual é o seu nome?';

    case 'ask_intent':
      return `Prazer, *${nome}*! 😊\n\nComo podemos cuidar do seu veículo hoje?\n\n` +
             menu(INTENTS) + RODAPE_MENU;

    case 'ask_category':
      return `Perfeito, ${nome}. Para indicar o serviço correto, qual é o tipo do seu veículo?\n\n` +
             menu(CATEGORIES) + RODAPE_MENU;

    case 'ask_model':
      return 'Qual é o modelo do veículo?\n\n_Ex.: Jeep Compass, Hilux, Onix._';

    case 'ask_service':
      return `Certo, ${nome}. E o que você está buscando para o seu *${carro}*?\n\n` +
             menu(SERVICES) + RODAPE_MENU;

    case 'ask_need':
      return 'Sem problema. O que mais está incomodando você no veículo?\n\n' +
             menu(NEEDS) + RODAPE_MENU;

    case 'ask_level':
      return `Entendi. Para o seu *${carro}*, temos algumas possibilidades. ` +
             `Qual resultado você está buscando?\n\n` + menu(LEVELS_MENU) + RODAPE_MENU;

    case 'ask_period':
      return 'Ótimo! Qual período seria melhor para você?\n\n' + menu(PERIODS_MENU) + RODAPE_MENU;

    case 'ask_date':
      return d.date_open
        ? 'Para qual data você gostaria?\n\n_Ex.: sábado, dia 14, próxima terça._'
        : 'E para quando você gostaria?\n\n' + menu(DATES) + RODAPE_MENU;

    case 'confirm': {
      if (d.intent === 'duvida') {
        return 'Posso encaminhar você para nossa atendente responder essa dúvida?\n\n' +
               menu(CONFIRM) + RODAPE_MENU;
      }
      // norm() serve para COMPARAR, nunca para exibir: ele tira os acentos e
      // a frase saía "Sábado pela manha".
      const quando = [d.date_pref, PERIODO_NA_FRASE[d.period]].filter(Boolean).join(' ');
      return `Perfeito. Sua preferência é *${quando}*.\n\n` +
             'Posso encaminhar seu atendimento para nossa atendente verificar os horários disponíveis?\n\n' +
             menu(CONFIRM) + RODAPE_MENU;
    }

    default:
      // Nunca deve acontecer: proximoPasso() só devolve passos conhecidos.
      warn('flow.perguntaSemCaso', { passo: step });
      return 'Como podemos ajudar você hoje?\n\n' + menu(INTENTS) + RODAPE_MENU;
  }
}

/**
 * Só a pergunta pendente, sem o preâmbulo de boas-vindas.
 *
 * Usada ao retomar depois de uma queda: repetir o texto inteiro de abertura
 * soaria como se a conversa tivesse sido esquecida.
 */
function perguntaCurta(step, d) {
  const carro = apelidoVeiculo(d.vehicle);
  switch (step) {
    case 'ask_name':     return 'qual é o seu nome?';
    case 'ask_intent':   return `sobre o que você quer falar?\n\n${menu(INTENTS)}`;
    case 'ask_category': return `qual é o tipo do seu veículo?\n\n${menu(CATEGORIES)}`;
    case 'ask_model':    return 'qual é o modelo do veículo?';
    case 'ask_service':  return `o que você está buscando para o seu *${carro}*?\n\n${menu(SERVICES)}`;
    case 'ask_need':     return `o que mais está incomodando você no veículo?\n\n${menu(NEEDS)}`;
    case 'ask_level':    return `qual resultado você está buscando para o seu *${carro}*?\n\n${menu(LEVELS_MENU)}`;
    case 'ask_period':   return `qual período seria melhor para você?\n\n${menu(PERIODS_MENU)}`;
    case 'ask_date':     return `para quando você gostaria?\n\n${menu(DATES)}`;
    case 'confirm':      return `posso encaminhar seu atendimento para nossa atendente?\n\n${menu(CONFIRM)}`;
    default:             return `sobre o que você quer falar?\n\n${menu(INTENTS)}`;
  }
}

/**
 * Retoma as conversas interrompidas por uma queda de conexão.
 *
 * Enquanto o WhatsApp está fora, a mensagem do cliente não chega — ele fica
 * esperando resposta que nunca vem e o lead se perde em silêncio. Ao voltar,
 * o sistema pede desculpa e repete a pergunta que estava pendente.
 *
 * Conservador de propósito: só depois de queda longa, poucos por vez, com
 * intervalo entre envios e nunca duas vezes para a mesma pessoa.
 */
async function executarRetomada({ caiuEm = null, ultimasHoras = null, limite = null }) {
  const max = limite ?? num('RECOVERY_MAX', 20);

  // Dois usos, janelas diferentes:
  //  - automático: quem falou ANTES da queda e ficou sem resposta
  //  - manual: qualquer conversa parada no meio, nas últimas N horas
  const alvo = caiuEm
    ? { desde: new Date(Date.now() - REARM_HOURS() * 3600_000).toISOString(),
        ate: caiuEm, referencia: caiuEm }
    : { desde: new Date(Date.now() - (ultimasHoras || 6) * 3600_000).toISOString(),
        ate: null, referencia: new Date(Date.now() - 3600_000).toISOString() };

  const sessoes = await getSessoesInterrompidas({ ...alvo, limite: max });

  if (!sessoes.length) {
    info('retomada.nadaAFazer', { desde: alvo.desde, ate: alvo.ate });
    return { retomadas: 0, telefones: [] };
  }

  const telefones = [];
  for (const sessao of sessoes) {
    const d = { ...(sessao.data || {}), phone: sessao.phone };
    const passo = PASSOS.has(sessao.step) ? sessao.step : proximoPasso(d);

    const texto =
      'Oi! Tivemos uma instabilidade aqui e sua mensagem não chegou até mim.\n\n' +
      `Retomando: ${perguntaCurta(passo, d)}`;

    try {
      const envio = await reply(sessao.phone, texto);
      if (!envio.enviado) {
        warn('retomada.bloqueada', {
          de: sessao.phone,
          escopo: envio.destinoBloqueado ? 'destinatário' : 'canal'
        });
        if (!envio.destinoBloqueado) break;
        continue;
      }
      await marcarRetomada(sessao.phone);
      telefones.push(sessao.phone);
      info('retomada.enviada', { de: sessao.phone, passo, cliente: d.name || '—' });
      await sleep(4000);   // espaça os envios: rajada derruba a sessão de novo
    } catch (e) {
      warn('retomada.falhou', { de: sessao.phone, erro: e.message });
    }
  }

  info('retomada.concluida', { retomadas: telefones.length, janela: caiuEm ? 'pós-queda' : `${ultimasHoras || 6}h` });
  return { retomadas: telefones.length, telefones };
}

let filaRetomada = Promise.resolve();

export function retomarConversas(options = {}) {
  const job = filaRetomada.then(
    () => executarRetomada(options),
    () => executarRetomada(options)
  );
  filaRetomada = job.catch(() => {});
  return job;
}

/* ---------------- Interpretação da resposta ---------------- */

/**
 * Aplica a resposta ao passo que estava pendente.
 * @returns {{ok:boolean, extra?:string}} extra = mensagem a enviar antes da próxima pergunta
 */
function interpretar(step, text, d) {
  switch (step) {
    case 'ask_name': {
      const nome = nameFromAnswer(text);
      if (!nome) return { ok: false };
      d.name = nome;
      return { ok: true };
    }

    case 'ask_intent': {
      const escolha = matchOption(text, INTENTS);
      if (escolha) {
        d.intent = INTENTS.find(i => i.label === escolha).key;
        return { ok: true };
      }
      return { ok: false };
    }

    case 'ask_category': {
      const escolha = matchOption(text, CATEGORIES);
      if (escolha) { d.category = escolha; return { ok: true }; }
      const { category } = extractVehicle(text);
      if (category) { d.category = category; return { ok: true }; }
      return { ok: false };
    }

    case 'ask_model': {
      const { category, vehicle } = extractVehicle(text);
      if (vehicle) {
        d.vehicle = vehicle;
        if (category) d.category = category;   // modelo conhecido corrige a categoria
        return { ok: true };
      }
      // Modelo desconhecido ainda é um modelo válido.
      const livre = String(text).trim().slice(0, 80);
      if (livre.length >= 2) { d.vehicle = livre; return { ok: true }; }
      return { ok: false };
    }

    case 'ask_service': {
      const escolha = matchOption(text, SERVICES);
      if (!escolha) return { ok: false };
      d.service = escolha;
      return { ok: true };
    }

    case 'ask_need': {
      const escolha = matchOption(text, NEEDS);
      if (!escolha) return { ok: false };
      d.need = escolha;
      // A dor informada define o serviço: é a recomendação em ação.
      d.service = NEED_TO_SERVICE[escolha] || 'Lavagem';
      d.recommended = true;
      return {
        ok: true,
        extra: `Pelo que você me contou, o mais indicado para o seu *${apelidoVeiculo(d.vehicle)}* ` +
               `é *${d.service}*.`
      };
    }

    case 'ask_level': {
      const escolha = matchOption(text, LEVELS_MENU);
      if (!escolha) return { ok: false };

      if (escolha === RECOMENDACAO) {
        d.level = SERVICE_TO_LEVEL[d.service] || 'Completa';
        d.recommended = true;
        return {
          ok: true,
          extra: `Pelo que você me contou, ${d.name}, a opção *${d.level}* parece ser a mais ` +
                 `adequada para o seu *${apelidoVeiculo(d.vehicle)}*.`
        };
      }
      d.level = escolha;
      return { ok: true };
    }

    case 'ask_period': {
      const escolha = matchOption(text, PERIODS_MENU);
      if (escolha === OUTRO_DIA) {
        // Não define período: pergunta a data primeiro e volta ao período depois.
        d.date_open = true;
        return { ok: true, skipTo: 'ask_date' };
      }
      if (escolha) { d.period = escolha; return { ok: true }; }
      const p = extractPeriod(text);
      if (p) { d.period = p; return { ok: true }; }
      return { ok: false };
    }

    case 'ask_date': {
      if (d.date_open) {
        const livre = extractDate(text) || String(text).trim().slice(0, 60);
        if (livre.length < 2) return { ok: false };
        d.date_pref = livre;
        d.date_open = false;
        return { ok: true };
      }
      const escolha = matchOption(text, DATES);
      if (escolha === OUTRA_DATA) { d.date_open = true; return { ok: true }; }
      if (escolha) { d.date_pref = escolha; return { ok: true }; }
      const dt = extractDate(text);
      if (dt) { d.date_pref = dt; return { ok: true }; }
      return { ok: false };
    }

    case 'confirm': {
      const escolha = matchOption(text, CONFIRM);
      if (escolha === 'Sim, pode encaminhar') { d.confirmed = true; return { ok: true }; }
      if (escolha === 'Quero alterar') {
        delete d.period; delete d.date_pref; d.date_open = false;
        return { ok: true, extra: 'Sem problema, vamos ajustar.' };
      }
      if (escolha === 'Tenho uma dúvida antes') {
        d.confirmed = true;
        d.has_question = true;
        return { ok: true };
      }
      // "sim", "pode", "ok" contam como confirmação.
      if (/\b(sim|pode|claro|isso|ok|beleza|confirmo|vamos)\b/.test(norm(text))) {
        d.confirmed = true;
        return { ok: true };
      }
      return { ok: false };
    }

    default:
      return { ok: false };
  }
}

/* ---------------- Handoff ---------------- */

async function encerrar(phone, d, inboxId = null) {
  // A triagem é criada uma vez e o id fica na sessão. Se o envio final for
  // barrado/falhar, a próxima mensagem tenta concluir sem duplicar o lead.
  const triage = d.triage_id ? { id: d.triage_id } : await saveTriage(d);
  d.triage_id = triage.id;
  await saveSession(phone, { step: 'handoff_pending', data: d, handed_off: false });

  const aberto = isOpenNow();
  const nome = d.name || '';

  let msg = `Perfeito, ${nome}! ✅\n\n` +
            'Já deixei as informações do seu atendimento organizadas.\n\n';

  msg += aberto
    ? 'Agora vou direcionar você para nossa atendente, que verificará a disponibilidade e ' +
      'continuará o atendimento por aqui.\n\nVocê não precisará repetir tudo novamente. ' +
      '*Por favor, aguarde um instante.*'
    : 'Nossa atendente continuará o atendimento por aqui e você não precisará repetir nada.\n\n' +
      `Estamos fechados neste momento — *por favor, aguarde*: retornamos ${nextOpening()}.`;

  if (d.intent === 'valores') {
    msg += '\n\nEla também vai te passar os valores do serviço.';
  }

  const envio = await reply(phone, `${msg}\n\n${ASSINATURA}`);
  if (!envio?.enviado) {
    warn('flow.handoffPendente', { triagem: triage.id, de: phone });
    return { triage, enviado: false };
  }

  if (inboxId) d._last_inbox_id = inboxId;
  await saveSession(phone, { step: 'done', data: d, handed_off: true });

  info('flow.handoff', {
    triagem: triage.id, cliente: nome, de: phone,
    categoria: d.category, veiculo: d.vehicle,
    servico: d.service || d.intent, nivel: d.level,
    quando: [d.date_pref, d.period].filter(Boolean).join(' ') || 'sem preferência',
    noHorario: aberto
  });
  return { triage, enviado: true };
}

/* ---------------- Entrada ---------------- */

export async function handleMessage({ phone, text, pushName, inboxId = null }) {
  let session = await getSession(phone);

  // Se o envio ocorreu e só a conclusão do inbox falhou, o retry encontra o
  // marcador salvo junto com a sessão e apenas encerra o inbox. Sem isto, a
  // mesma mensagem antiga seria interpretada no passo novo e responderia em
  // duplicidade. A Evolution 2.3.7 não oferece chave de idempotência no
  // sendText, portanto este marcador é a proteção durável disponível no app.
  if (inboxId && session?.data?._last_inbox_id === inboxId) {
    info('flow.inboxJaProcessado', { de: phone, inboxId });
    return { action: 'duplicate' };
  }

  await logMessage(phone, 'in', text);

  // 24h desde o último contato: bot rearmado, atende como contato novo.
  if (session) {
    const horas = (Date.now() - new Date(session.updated_at).getTime()) / 3600_000;
    if (horas >= REARM_HOURS()) {
      info('flow.rearmado', { de: phone, horasSemContato: horas.toFixed(1) });
      session = null;
    }
  }

  // Já com a atendente: bot em silêncio, só empurra a janela.
  if (session?.handed_off) {
    const dados = { ...(session.data || {}) };
    if (inboxId) dados._last_inbox_id = inboxId;
    await saveSession(phone, { data: dados });
    info('flow.silenciado', { de: phone, motivo: 'em atendimento humano' });
    return { action: 'silenced' };
  }

  const primeiroContato = !session;
  const d = normalizarLegado({ ...(session?.data || {}), phone });

  // Sessão gravada por uma versão anterior do fluxo pode ter um passo que já
  // não existe. Tratá-la como passo desconhecido evita responder "null" a
  // quem estava no meio de uma conversa quando o deploy aconteceu.
  const bruto = session?.step || 'ask_name';
  const passoAnterior = PASSOS.has(bruto) ? bruto : null;

  /* 1. Responde ao que foi perguntado. */
  let extra = null;
  if (!primeiroContato && passoAnterior) {
    const r = interpretar(passoAnterior, text, d);
    if (r.extra) extra = r.extra;

    if (!r.ok) {
      // Não entendeu a resposta direta — talvez a informação esteja no texto solto.
      const antes = JSON.stringify(d);
      Object.assign(d, semSobrescrever(d, extractAll(text)));
      if (JSON.stringify(d) === antes) {
        await saveSession(phone, { step: passoAnterior, data: d });
        info('flow.naoEntendi', { de: phone, passo: passoAnterior, texto: text });
        const resposta = await reply(phone, 'Desculpe, não compreendi. 🙂\n\n' + pergunta(passoAnterior, d));
        if (!resposta?.enviado) {
          return { action: 'send_blocked', step: passoAnterior };
        }
        if (inboxId) d._last_inbox_id = inboxId;
        await saveSession(phone, { step: passoAnterior, data: d, handed_off: false });
        return { action: 'retry' };
      }
    }
  }

  /* 2. Aproveita tudo o que a mensagem revelou, sem sobrescrever o contexto. */
  Object.assign(d, semSobrescrever(d, extractAll(text)));

  // No primeiro contato o nome só vale se dito explicitamente; o passo
  // ask_name é que aceita resposta solta como nome.
  if (primeiroContato && !d.name && pushName) {
    // pushName é nome de perfil, não confiável para tratar o cliente:
    // guarda como pista para a atendente, sem pular a pergunta.
    d.profile_name = String(pushName).trim().slice(0, 60);
  }

  /* 3. Próxima pergunta — ou o handoff. */
  const passo = proximoPasso(d);

  if (passo === 'done') {
    const fim = await encerrar(phone, d, inboxId);
    return { action: fim.enviado ? 'handoff' : 'handoff_pending' };
  }

  const partes = [];

  // Quem já se apresenta na primeira mensagem pula a pergunta do nome — mas
  // não deve perder as boas-vindas.
  if (primeiroContato && passo !== 'ask_name') {
    partes.push(
      `Olá, *${d.name}*! 👋 Bem-vindo à *M & A Lavagens e Estética*.\n\n` +
      'Já anotei o que você me passou. Só preciso de um detalhe para encaminhar ' +
      'seu atendimento à nossa atendente.'
    );
  }
  if (extra) partes.push(extra);
  partes.push(pergunta(passo, d));

  const resposta = await reply(phone, partes.join('\n\n'));
  if (!resposta?.enviado) {
    // Não avança para uma pergunta que o cliente nunca recebeu. A próxima
    // mensagem retoma do último passo confirmado, em vez de desalinhá-lo.
    warn('flow.passoNaoAvancou', { de: phone, passoPretendido: passo });
    return { action: 'send_blocked', step: passoAnterior || 'ask_name' };
  }

  if (inboxId) d._last_inbox_id = inboxId;
  await saveSession(phone, { step: passo, data: d, handed_off: false });
  info('flow.passo', { de: phone, passo, cliente: d.name || '—' });

  return { action: primeiroContato ? 'started' : 'ok', step: passo };
}

/** Só preenche lacunas: o que o cliente já afirmou tem prioridade. */
function semSobrescrever(atual, achados) {
  const out = {};
  for (const [k, v] of Object.entries(achados)) {
    if (atual[k] == null || atual[k] === '') out[k] = v;
  }
  return out;
}

export { SEM_CERTEZA, RECOMENDACAO };
