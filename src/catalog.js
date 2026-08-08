/**
 * Catálogos do atendimento e o conhecimento usado para extrair contexto
 * do texto livre do cliente.
 *
 * Fica separado do fluxo porque muda por motivo diferente: aqui se mexe
 * quando o negócio muda (novo serviço, novo modelo popular); em flow.js
 * se mexe quando a conversa muda.
 */

// `syn` são as palavras que o cliente realmente usa. Sem elas, "preço" e
// "só lavar" não casavam com nenhuma opção.
export const INTENTS = [
  { key: 'lavar',    emoji: '🚘', label: 'Quero lavar meu veículo',
    syn: ['lavar', 'lavagem', 'lavou', 'limpar', 'limpeza'] },
  { key: 'estetica', emoji: '✨', label: 'Estética / detalhamento',
    syn: ['estetica', 'detalhamento', 'detailing', 'polimento', 'vitrificacao'] },
  { key: 'agendar',  emoji: '📅', label: 'Quero agendar',
    syn: ['agendar', 'agendamento', 'marcar', 'horario', 'reservar'] },
  { key: 'valores',  emoji: '💰', label: 'Consultar valores',
    syn: ['valor', 'valores', 'preco', 'precos', 'quanto', 'orcamento', 'tabela'] },
  { key: 'duvida',   emoji: '❓', label: 'Tenho outra dúvida',
    syn: ['duvida', 'pergunta', 'informacao', 'outra coisa'] }
];

export const CATEGORIES = [
  { emoji: '🚗', label: 'Hatch / Compacto', syn: ['hatch', 'compacto', 'popular', 'pequeno'] },
  { emoji: '🚘', label: 'Sedan',            syn: ['sedan', 'seda'] },
  { emoji: '🚙', label: 'SUV',              syn: ['suv', 'utilitario'] },
  { emoji: '🛻', label: 'Picape',           syn: ['picape', 'pickup', 'pick up', 'caminhonete'] },
  { emoji: '🚐', label: 'Outro',            syn: ['outro', 'outra', 'moto', 'van', 'kombi', 'caminhao'] }
];

export const SERVICES = [
  { emoji: '🧼', label: 'Lavagem',
    syn: ['lavagem', 'lavar', 'lavagem simples', 'lavagem comum', 'limpar', 'limpeza'] },
  { emoji: '✨', label: 'Lavagem detalhada',
    syn: ['detalhada', 'detalhado', 'detalhamento', 'lavagem detalhada', 'detailing'] },
  { emoji: '🛋️', label: 'Higienização interna',
    syn: ['higienizacao', 'higienizar', 'estofado', 'estofados', 'banco', 'bancos', 'interna', 'interior'] },
  { emoji: '💎', label: 'Polimento / pintura',
    syn: ['polimento', 'polir', 'pintura', 'espelhamento', 'risco', 'riscos'] },
  { emoji: '🛡️', label: 'Proteção / vitrificação',
    syn: ['protecao', 'proteger', 'vitrificacao', 'vitrificar', 'coating', 'selante', 'cristalizacao'] },
  { emoji: '🔎', label: 'Ainda não sei qual escolher',
    syn: ['nao sei', 'ainda nao sei', 'sei nao', 'me ajuda', 'nao tenho certeza'] },
  { emoji: '➕', label: 'Outro serviço', syn: ['outro servico', 'outro'] }
];

export const NEEDS = [
  { label: 'Sujeira do dia a dia',        syn: ['sujeira', 'poeira', 'barro', 'lama', 'sujo'] },
  { label: 'Bancos/estofados sujos',      syn: ['banco', 'bancos', 'estofado', 'estofados', 'tecido'] },
  { label: 'Manchas ou mau cheiro',       syn: ['mancha', 'manchas', 'cheiro', 'mau cheiro', 'odor', 'mofo'] },
  { label: 'Pintura sem brilho',          syn: ['sem brilho', 'opaca', 'fosca', 'desbotada', 'brilho'] },
  { label: 'Riscos/marcas na pintura',    syn: ['risco', 'riscos', 'arranhao', 'marca', 'marcas'] },
  { label: 'Quero deixar o carro impecável', syn: ['impecavel', 'novo', 'zero', 'perfeito', 'showroom'] },
  { label: 'Outro problema',              syn: ['outro problema', 'outro', 'outra coisa'] }
];

/** Da dor relatada para o serviço indicado. Base da recomendação. */
export const NEED_TO_SERVICE = {
  'Sujeira do dia a dia': 'Lavagem',
  'Bancos/estofados sujos': 'Higienização interna',
  'Manchas ou mau cheiro': 'Higienização interna',
  'Pintura sem brilho': 'Polimento / pintura',
  'Riscos/marcas na pintura': 'Polimento / pintura',
  'Quero deixar o carro impecável': 'Lavagem detalhada',
  'Outro problema': 'Lavagem'
};

export const LEVELS = [
  { emoji: '⚡', label: 'Essencial', hint: 'manutenção e limpeza do dia a dia',
    syn: ['essencial', 'simples', 'basica', 'basico', 'rapida', 'rapido'] },
  { emoji: '⭐', label: 'Completa',  hint: 'cuidado interno + externo',
    syn: ['completa', 'completo', 'full'] },
  { emoji: '💎', label: 'Premium',   hint: 'tratamento mais detalhado',
    syn: ['premium', 'top', 'melhor', 'caprichada'] }
];

export const PERIODS = [
  { emoji: '☀️', label: 'Manhã',          syn: ['manha', 'de manha', 'matutino', 'cedo'] },
  { emoji: '🌤️', label: 'Tarde',          syn: ['tarde', 'a tarde', 'vespertino'] },
  { emoji: '🌙', label: 'Final da tarde', syn: ['final da tarde', 'fim da tarde', 'fim do dia', 'final do dia'] }
];

export const DATES = [
  { label: 'Amanhã',           syn: ['amanha'] },
  { label: 'Próximo dia útil', syn: ['dia util', 'proximo dia', 'durante a semana'] },
  { label: 'Sábado',           syn: ['sabado', 'sabadao', 'fim de semana'] },
  { label: 'Outra data',       syn: ['outra data', 'outro dia', 'outra'] }
];

/** Nível recomendado por serviço, quando o cliente pede indicação. */
export const SERVICE_TO_LEVEL = {
  'Lavagem': 'Essencial',
  'Lavagem detalhada': 'Completa',
  'Higienização interna': 'Completa',
  'Polimento / pintura': 'Premium',
  'Proteção / vitrificação': 'Premium'
};

/**
 * Modelos populares por categoria.
 *
 * Serve para não perguntar a categoria quando o cliente já disse o modelo:
 * "tenho uma Hilux" já resolve categoria = Picape.
 */
export const MODELS = {
  'Picape': ['hilux', 'ranger', 's10', 'l200', 'toro', 'montana', 'saveiro', 'strada',
             'amarok', 'frontier', 'oroch', 'maverick', 'ram', 'rampage', 'dakota', 'courier'],
  'SUV': ['compass', 'renegade', 'tracker', 'kicks', 'creta', 'hrv', 'hr-v', 'crv', 'cr-v',
          'tucson', 'sportage', 't-cross', 'tcross', 'nivus', 'corolla cross', 'sw4', 'pajero',
          'duster', 'territory', 'equinox', 'tiggo', 'haval', 'captur', 'taos', 'bronco',
          'pulse', 'fastback', 'seltos', 'kardian', 'basalt', 'commander', 'trailblazer',
          'ecosport', 'jimny', 'wr-v', 'zr-v', 'song', 'yuan', 'dolphin'],
  'Sedan': ['corolla', 'civic', 'jetta', 'cruze', 'virtus', 'onix plus', 'hb20s', 'sentra',
            'city', 'versa', 'voyage', 'prisma', 'logan', 'cronos', 'camry', 'accord',
            'grand siena', 'siena', 'cerato', 'elantra', 'a3 sedan', 'classe c', 'seal'],
  'Hatch / Compacto': ['onix', 'hb20', 'gol', 'palio', 'uno', 'mobi', 'argo', 'polo', 'golf',
                       'fox', 'march', 'sandero', 'ka', 'fiesta', 'i30', 'celta', 'up', 'kwid',
                       'c3', 'picanto', 'soul', 'clio', 'corsa', 'agile', 'punto', 'bravo',
                       'stilo', 'focus', 'sonic', 'yaris', 'city hatch']
};

/** Marcas: ajudam a reconhecer "tenho uma Jeep Compass" ou só "Jeep". */
export const BRANDS = [
  'toyota', 'honda', 'volkswagen', 'vw', 'chevrolet', 'gm', 'fiat', 'ford', 'hyundai',
  'kia', 'nissan', 'renault', 'jeep', 'peugeot', 'citroen', 'citroën', 'mitsubishi',
  'ram', 'byd', 'gwm', 'haval', 'caoa', 'chery', 'audi', 'bmw', 'mercedes', 'volvo',
  'land rover', 'porsche', 'suzuki', 'subaru', 'mini', 'jac', 'troller'
];
