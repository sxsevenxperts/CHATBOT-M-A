/**
 * Serializa tarefas por chave.
 *
 * Motivo, medido em scripts/carga.js: duas mensagens do MESMO número chegando
 * juntas eram processadas em paralelo. As duas liam a mesma sessão, as duas
 * decidiam o mesmo passo, e o cliente recebia as boas-vindas duas vezes — com
 * a segunda mensagem (o nome dele) descartada.
 *
 * Isso não é caso de borda: no WhatsApp é normal mandar "oi" e o nome em
 * seguida, sem esperar resposta.
 *
 * A fila é por telefone, então conversas diferentes seguem em paralelo — a
 * vazão não muda. O escopo é o processo: com mais de uma réplica seria preciso
 * um lock no banco. O serviço roda com replicas = 1.
 */

const filas = new Map();

/**
 * @param {string} chave  telefone do cliente
 * @param {() => Promise<any>} tarefa
 */
export function serializar(chave, tarefa) {
  const anterior = filas.get(chave) || Promise.resolve();

  // Encadeia mesmo se a anterior rejeitou: uma falha não pode travar a fila.
  const atual = anterior.then(() => tarefa(), () => tarefa());

  // Marcador silencioso, para o encadeamento não propagar rejeição.
  const marcador = atual.then(() => {}, () => {});
  filas.set(chave, marcador);

  marcador.then(() => {
    // Só limpa se ninguém entrou na fila depois — evita crescer sem limite.
    if (filas.get(chave) === marcador) filas.delete(chave);
  });

  return atual;
}

/** Quantas filas estão abertas agora. Útil em /health. */
export const filasAbertas = () => filas.size;
