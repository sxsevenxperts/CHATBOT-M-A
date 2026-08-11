import {
  ultimoVereditoEnvio, registrarEventoCanal, registrarAutoBlockCondicional
} from './database.js';
import { sincronizar as sincronizarFreio } from './freio.js';

let filaCanal = Promise.resolve();

function serializarCanal(tarefa) {
  const job = filaCanal.then(tarefa, tarefa);
  filaCanal = job.catch(() => {});
  return job;
}

/**
 * Reconcilia memória e banco, persistindo o instante em que uma pane global
 * realmente engatou o freio. Sem o AUTO_BLOCK, um ACK tardio de mensagem
 * anterior poderia reduzir a contagem histórica e religar o bot por engano.
 */
async function reconciliarSemLock(origem = 'banco', {
  incluirTestes = process.env.NODE_ENV === 'test'
} = {}) {
  let veredito = await ultimoVereditoEnvio({ incluirTestes });
  let estado = sincronizarFreio(veredito, origem);

  if (estado.bloqueado && !veredito?.bloqueioPersistido) {
    await registrarAutoBlockCondicional(
      veredito,
      estado.motivo || 'pane global de entrega'
    );
    veredito = await ultimoVereditoEnvio({ incluirTestes });
    estado = sincronizarFreio(veredito, `${origem}:persistido`);
  }

  return { estado, veredito };
}

export function reconciliarFreioPersistido(origem = 'banco', options = {}) {
  return serializarCanal(() => reconciliarSemLock(origem, options));
}

/** Persiste uma decisão administrativa e atualiza a memória na mesma fila. */
export function registrarEventoEReconciliar(status, detalhe = null, origem = 'dashboard', options = {}) {
  return serializarCanal(async () => {
    await registrarEventoCanal(status, detalhe);
    return reconciliarSemLock(origem, options);
  });
}
