import { INTENTS, CATEGORIES, SERVICES, LEVELS, PERIODS, MODELS, BRANDS } from './catalog.js';

/**
 * Extração de contexto do texto livre.
 *
 * Regra central de UX: nunca perguntar de novo o que o cliente já disse.
 * "Meu nome é Sérgio, tenho uma Hilux e quero lavagem completa sábado"
 * precisa resolver nome + categoria + veículo + serviço + nível + dia numa
 * tacada, e o fluxo pular direto para o que faltar.
 *
 * Só devolve o que reconhece com confiança. Preferimos perguntar de novo a
 * gravar um dado errado no contexto que a atendente vai usar.
 */

export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const cap = s => s.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/* ---------------- Nome ---------------- */

// Só padrões explícitos: adivinhar nome de frase solta erra muito.
const NAME_PATTERNS = [
  /\bmeu nome (?:e|é|eh)\s+([a-zà-ú]+(?:\s+[a-zà-ú]+){0,2})/i,
  /\bme chamo\s+([a-zà-ú]+(?:\s+[a-zà-ú]+){0,2})/i,
  /\b(?:sou|aqui (?:e|é|eh))\s+(?:o|a)\s+([a-zà-ú]+(?:\s+[a-zà-ú]+){0,1})/i,
  /\bpode me chamar de\s+([a-zà-ú]+)/i
];

const NOT_NAMES = new Set([
  'sim', 'nao', 'ok', 'oi', 'ola', 'ai', 'ei', 'opa', 'eae', 'eai', 'alo', 'hello', 'hi',
  'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'blz', 'beleza',
  'cliente', 'carro', 'moto', 'lavagem', 'valor', 'preco', 'agendar', 'oii', 'oie',
  'hoje', 'amanha', 'sabado', 'domingo', 'quero', 'gostaria', 'queria', 'test', 'teste'
]);

export function extractName(text) {
  for (const re of NAME_PATTERNS) {
    const m = String(text).match(re);
    if (!m) continue;
    const bruto = m[1].trim().split(/\s+/).filter(w => !NOT_NAMES.has(norm(w)));
    if (bruto.length) return cap(bruto.slice(0, 2).join(' '));
  }
  return null;
}

/**
 * Nome quando a pergunta foi "qual é o seu nome?" — aí a resposta É o nome.
 *
 * Rejeita saudação e interjeição: "Ai", "Oi", "Blz" não são nome. Um cliente
 * que só disse "oi" recebe a pergunta de novo, em vez de ser chamado de "Oi"
 * pelo resto da conversa — aconteceu num teste.
 */
export function nameFromAnswer(text) {
  const explicito = extractName(text);
  if (explicito) return explicito;

  const limpo = String(text).replace(/[^\p{L}\s'-]/gu, ' ').trim();
  // >2 letras: nome real tem ao menos três. "Ai"/"Oi" caem aqui e na lista.
  const palavras = limpo.split(/\s+/).filter(w => w.length > 2 && !NOT_NAMES.has(norm(w)));
  if (!palavras.length || palavras.length > 4) return null;
  return cap(palavras.slice(0, 2).join(' '));
}

/* ---------------- Veículo ---------------- */

export function extractVehicle(text) {
  const t = norm(text);
  let categoria = null, modelo = null;

  // Modelo primeiro: ele já entrega a categoria.
  for (const [cat, lista] of Object.entries(MODELS)) {
    // Mais longos antes: "corolla cross" não deve casar como "corolla".
    for (const m of [...lista].sort((a, b) => b.length - a.length)) {
      if (new RegExp(`(^|[^a-z0-9])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) {
        modelo = m; categoria = cat; break;
      }
    }
    if (modelo) break;
  }

  // Categoria dita na mão.
  if (!categoria) {
    if (/\b(suv|utilitario esportivo)\b/.test(t)) categoria = 'SUV';
    else if (/\b(picape|pick[- ]?up|caminhonete)\b/.test(t)) categoria = 'Picape';
    else if (/\bsedan?\b/.test(t)) categoria = 'Sedan';
    else if (/\b(hatch|compacto|popular)\b/.test(t)) categoria = 'Hatch / Compacto';
    else if (/\b(moto|motocicleta|van|kombi|furgao|caminhao)\b/.test(t)) categoria = 'Outro';
  }

  // Marca + modelo, para exibir "Jeep Compass" e não só "compass".
  let exibicao = modelo;
  if (modelo) {
    const marca = BRANDS.find(b => new RegExp(`(^|[^a-z])${b}([^a-z]|$)`).test(t));
    exibicao = cap(marca ? `${marca} ${modelo}` : modelo);
  }

  return { category: categoria, vehicle: exibicao };
}

/* ---------------- Serviço, nível, intenção ---------------- */

export function extractService(text) {
  const t = norm(text);
  if (/\b(vitrific|coating|selante|protecao|proteger|cristaliz)/.test(t)) return 'Proteção / vitrificação';
  if (/\b(polimento|polir|espelhamento|risco|riscos|arranhao)/.test(t))   return 'Polimento / pintura';
  if (/\b(higieniz|estofado|banco|forracao|interna|cheiro|odor)/.test(t)) return 'Higienização interna';
  // "completa"/"premium" são NÍVEL, não serviço: "lavagem completa" precisa
  // virar serviço=Lavagem + nível=Completa, senão o nível se perde.
  if (/\b(detalhad|detalhament)\b/.test(t) && /\blav/.test(t)) return 'Lavagem detalhada';
  if (/\b(lavagem|lavar|lavo|limpeza|limpar)\b/.test(t))                  return 'Lavagem';
  if (/\b(estetica|detailing)\b/.test(t))                                 return 'Lavagem detalhada';
  return null;
}

export function extractLevel(text) {
  const t = norm(text);
  if (/\bpremium\b/.test(t))                 return 'Premium';
  if (/\b(completa|completo|full)\b/.test(t)) return 'Completa';
  if (/\b(essencial|simples|basica|basico|rapida|rapido)\b/.test(t)) return 'Essencial';
  return null;
}

export function extractIntent(text) {
  const t = norm(text);
  if (/\b(agendar|agendamento|marcar|horario|reservar|vaga)\b/.test(t)) return 'agendar';
  if (/\b(valor|valores|preco|precos|quanto custa|quanto fica|orcamento|tabela)\b/.test(t)) return 'valores';
  if (/\b(vitrific|polimento|estetica|detailing|detalhament)\b/.test(t)) return 'estetica';
  if (/\b(lavagem|lavar|limpeza)\b/.test(t)) return 'lavar';
  if (/\b(duvida|pergunta|informacao|saber mais)\b/.test(t)) return 'duvida';
  return null;
}

/* ---------------- Quando ---------------- */

export function extractPeriod(text) {
  const t = norm(text);
  if (/\b(final da tarde|fim da tarde|fim do dia|final do dia|17h|18h)\b/.test(t)) return 'Final da tarde';
  if (/\b(manha|matutino|cedo|de manha)\b/.test(t)) return 'Manhã';
  if (/\b(tarde|vespertino|a tarde)\b/.test(t))     return 'Tarde';
  return null;
}

const WEEKDAYS = [
  ['domingo', 'domingo'], ['segunda', 'Segunda-feira'], ['terca', 'Terça-feira'],
  ['quarta', 'Quarta-feira'], ['quinta', 'Quinta-feira'], ['sexta', 'Sexta-feira'],
  ['sabado', 'Sábado']
];

export function extractDate(text) {
  const t = norm(text);
  if (/\bdepois de amanha\b/.test(t)) return 'Depois de amanhã';
  if (/\bamanha\b/.test(t))           return 'Amanhã';
  if (/\bhoje\b/.test(t))             return 'Hoje';
  if (/\b(proximo dia util|dia util)\b/.test(t)) return 'Próximo dia útil';

  for (const [chave, rotulo] of WEEKDAYS) {
    if (new RegExp(`\\b${chave}`).test(t)) return rotulo;
  }

  const dia = t.match(/\bdia\s+(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/);
  if (dia) return dia[2] ? `Dia ${dia[1]}/${dia[2]}` : `Dia ${dia[1]}`;

  const data = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  if (data) return `Dia ${data[1]}/${data[2]}`;

  return null;
}

/* ---------------- Extração completa ---------------- */

/**
 * Lê uma mensagem e devolve só os campos reconhecidos.
 * Nunca sobrescreve o que já está no contexto — quem chama decide.
 */
export function extractAll(text) {
  const { category, vehicle } = extractVehicle(text);
  const achados = {
    name: extractName(text),
    intent: extractIntent(text),
    category,
    vehicle,
    service: extractService(text),
    level: extractLevel(text),
    period: extractPeriod(text),
    date_pref: extractDate(text)
  };

  // Remove nulos para o merge ficar trivial no fluxo.
  return Object.fromEntries(Object.entries(achados).filter(([, v]) => v != null));
}

/* ---------------- Escolha em menu ---------------- */

/**
 * Palavras que aparecem em vários rótulos e por isso não distinguem nada.
 * Sem removê-las, "quero lavar" empatava entre "Quero lavar meu veículo" e
 * "Quero agendar" — e o bot pedia para repetir.
 */
const RUIDO = new Set([
  'quero', 'queria', 'gostaria', 'meu', 'minha', 'veiculo', 'carro', 'uma', 'um',
  'tenho', 'qual', 'sei', 'escolher', 'ainda', 'nao', 'mais', 'para', 'pra', 'com'
]);

function significativas(label) {
  const todas = norm(label).split(/[\s/]+/).filter(Boolean);
  const filtradas = todas.filter(w => w.length > 3 && !RUIDO.has(w));
  // Rótulos feitos só de ruído ("Outro") ficariam sem nada para casar.
  return filtradas.length ? filtradas : todas.filter(w => w.length > 2);
}

/**
 * Casa a resposta com uma opção do menu.
 *
 * Em camadas, da mais confiável para a mais frouxa:
 *   1. número  2. rótulo exato  3. sinônimo do catálogo
 *   4. rótulo mais longo contido na resposta  5. palavra significativa
 *
 * A camada 4 existe porque "quero uma lavagem detalhada" contém tanto
 * "Lavagem" quanto "Lavagem detalhada": o mais longo é o certo.
 *
 * @param {string} text
 * @param {Array<{label:string, syn?:string[]}>} options
 * @returns {string|null} o rótulo escolhido
 */
export function matchOption(text, options) {
  const t = norm(text);
  if (!t) return null;

  // 1 · número
  const num = t.match(/^([1-9])[\s).:·\-]*$/);
  if (num) {
    const i = Number(num[1]) - 1;
    if (i >= 0 && i < options.length) return options[i].label;
  }

  // 2 · rótulo exato
  const exato = options.find(o => norm(o.label) === t);
  if (exato) return exato.label;

  // 3 · sinônimo — preferindo o mais específico (mais longo)
  const porSinonimo = options
    .flatMap(o => (o.syn || []).map(s => ({ label: o.label, s: norm(s) })))
    .filter(({ s }) => s && new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t))
    .sort((a, b) => b.s.length - a.s.length);
  if (porSinonimo.length) return porSinonimo[0].label;

  // 4 · rótulo inteiro contido na resposta — o mais longo ganha
  const contidos = options
    .filter(o => t.includes(norm(o.label)))
    .sort((a, b) => norm(b.label).length - norm(a.label).length);
  if (contidos.length) return contidos[0].label;

  // 5 · palavra significativa; ambiguidade real devolve null e o fluxo repergunta
  const parciais = options.filter(o => significativas(o.label).some(w => t.includes(w)));
  return parciais.length === 1 ? parciais[0].label : null;
}

export const OPTION_LISTS = { INTENTS, CATEGORIES, SERVICES, LEVELS, PERIODS };
