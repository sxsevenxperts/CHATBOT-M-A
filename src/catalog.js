/**
 * Catálogos do atendimento e o conhecimento usado para extrair contexto
 * do texto livre do cliente.
 *
 * Fica separado do fluxo porque muda por motivo diferente: aqui se mexe
 * quando o negócio muda (novo serviço, novo modelo popular); em flow.js
 * se mexe quando a conversa muda.
 */

export const INTENTS = [
  { key: 'lavar',    emoji: '🚘', label: 'Quero lavar meu veículo' },
  { key: 'estetica', emoji: '✨', label: 'Estética / detalhamento' },
  { key: 'agendar',  emoji: '📅', label: 'Quero agendar' },
  { key: 'valores',  emoji: '💰', label: 'Consultar valores' },
  { key: 'duvida',   emoji: '❓', label: 'Tenho outra dúvida' }
];

export const CATEGORIES = [
  { emoji: '🚗', label: 'Hatch / Compacto' },
  { emoji: '🚘', label: 'Sedan' },
  { emoji: '🚙', label: 'SUV' },
  { emoji: '🛻', label: 'Picape' },
  { emoji: '🚐', label: 'Outro' }
];

export const SERVICES = [
  { emoji: '🧼', label: 'Lavagem' },
  { emoji: '✨', label: 'Lavagem detalhada' },
  { emoji: '🛋️', label: 'Higienização interna' },
  { emoji: '💎', label: 'Polimento / pintura' },
  { emoji: '🛡️', label: 'Proteção / vitrificação' },
  { emoji: '🔎', label: 'Ainda não sei qual escolher' },
  { emoji: '➕', label: 'Outro serviço' }
];

export const NEEDS = [
  { label: 'Sujeira do dia a dia' },
  { label: 'Bancos/estofados sujos' },
  { label: 'Manchas ou mau cheiro' },
  { label: 'Pintura sem brilho' },
  { label: 'Riscos/marcas na pintura' },
  { label: 'Quero deixar o carro impecável' },
  { label: 'Outro problema' }
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
  { emoji: '⚡', label: 'Essencial', hint: 'manutenção e limpeza do dia a dia' },
  { emoji: '⭐', label: 'Completa',  hint: 'cuidado interno + externo' },
  { emoji: '💎', label: 'Premium',   hint: 'tratamento mais detalhado' }
];

export const PERIODS = [
  { emoji: '☀️', label: 'Manhã' },
  { emoji: '🌤️', label: 'Tarde' },
  { emoji: '🌙', label: 'Final da tarde' }
];

export const DATES = [
  { label: 'Amanhã' },
  { label: 'Próximo dia útil' },
  { label: 'Sábado' },
  { label: 'Outra data' }
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
