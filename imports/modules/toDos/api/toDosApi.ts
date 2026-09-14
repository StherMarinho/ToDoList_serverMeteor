import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { ProductServerBase } from '/imports/api/productServerBase';
import { segurancaApi } from '/imports/security/SecurityApi';
import { getUserServer, assertAuthenticated } from '/imports/server/serverMethods';
import { IToDo, ToDoPriority, toDosSch } from './toDosSch';
import { Recurso } from '../config/recursos';

// Escapa caracteres especiais de regex para uso seguro em buscas
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// DTO de entrada da lista — o servidor aceita apenas essas chaves
export type ToDosListInput = {
  search?: string;
  status?: 'todas' | 'abertas' | 'concluidas';
  page?: number;
};

// Pattern de validação do DTO para o check() do Meteor
const listInputPattern = {
  search: Match.Optional(String),
  status: Match.Optional(
    Match.OneOf('todas', 'abertas', 'concluidas')
  ),
  page: Match.Optional(Match.Integer),
};

// Campos que o usuário pode enviar ao salvar
const EDITABLE_FIELDS = ['descricao', 'prioridade', 'prazo', 'pessoal'] as const;

function buildVisibleSelector(
  userId: string,
  input: ToDosListInput = {}
): Record<string, unknown> {
  // Regra: tarefas públicas OU tarefas pessoais do próprio autor
  const clauses: Record<string, unknown>[] = [
    { $or: [{ pessoal: { $ne: true } }, { createdby: userId }] },
  ];

  const search = input.search?.trim();
  if (search) {
    if (search.length > 80) {
      throw new Meteor.Error('validation-error', 'Busca muito longa.');
    }
    clauses.push({
      descricao: { $regex: escapeRegExp(search), $options: 'i' },
    });
  }

  if (input.status === 'abertas') {
    clauses.push({ concluida: { $ne: true } });
  } else if (input.status === 'concluidas') {
    clauses.push({ concluida: true });
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

class ToDosServerApi extends ProductServerBase<IToDo> {
  constructor() {
    super('toDos', toDosSch);
    this.registerMobilePublications();
    this.registerMethod('saveEditable', this.saveEditable.bind(this));
    this.registerMethod('alternarConclusao', this.alternarConclusao.bind(this));
  }

  // Publications 
  private registerMobilePublications() {
    const collection = this.getCollectionInstance();

    // Lista paginada + total reativo
    Meteor.publish('toDos.toDosList', async function (input: ToDosListInput = {}) {
      check(input, listInputPattern);

      const user = await getUserServer();
      if (!user?.email) {
        throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
      }
      segurancaApi.validarAcessoRecursos(user, [Recurso.TODOS_VIEW]);

      const page = Math.max(1, input.page ?? 1);
      const selector = buildVisibleSelector(user._id!, input);

      // Observer do total — só publica o número, nunca os documentos
      let count = 0;
      let countReady = false;
      const countHandle = await collection
        .find(selector, { fields: { _id: 1 } })
        .observeChangesAsync({
          added: () => {
            count++;
            if (countReady) {
              this.changed('toDosListMeta', 'current', { count });
            }
          },
          removed: () => {
            count--;
            if (countReady) {
              this.changed('toDosListMeta', 'current', { count });
            }
          },
        });

      this.added('toDosListMeta', 'current', { count });
      countReady = true;

      // Observer da janela paginada
      const pageHandle = await collection
        .find(selector, {
          fields: {
            descricao: 1,
            prioridade: 1,
            prazo: 1,
            pessoal: 1,
            concluida: 1,
            concluidaEm: 1,
            autorNome: 1,
            createdby: 1,
            lastupdate: 1,
          },
          sort: { lastupdate: -1, _id: 1 },
          skip: (page - 1) * 4,
          limit: 4,
        })
        .observeChangesAsync({
          added: (id, fields) => this.added('toDosListView', id, fields),
          changed: (id, fields) => this.changed('toDosListView', id, fields),
          removed: (id) => this.removed('toDosListView', id),
        });

      this.ready();
      this.onStop(() => {
        pageHandle.stop();
        countHandle.stop();
      });
    });

    // Detalhe de um documento específico
    Meteor.publish('toDos.toDosDetail', async function (id: string) {
      check(id, String);

      const user = await getUserServer();
      if (!user?.email) {
        throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
      }
      segurancaApi.validarAcessoRecursos(user, [Recurso.TODOS_VIEW]);

      const cursor = collection.find(
        // Aplica o seletor de visibilidade também no detalhe
        { $and: [{ _id: id }, buildVisibleSelector(user._id!)] },
        {
          fields: {
            descricao: 1,
            prioridade: 1,
            prazo: 1,
            pessoal: 1,
            concluida: 1,
            concluidaEm: 1,
            autorNome: 1,
            createdby: 1,
            createdat: 1,
            lastupdate: 1,
          },
        }
      );

      const handle = await cursor.observeChangesAsync({
        added: (docId, fields) => this.added('toDosDetailView', docId, fields),
        changed: (docId, fields) => this.changed('toDosDetailView', docId, fields),
        removed: (docId) => this.removed('toDosDetailView', docId),
      });

      this.ready();
      this.onStop(() => handle.stop());
    });
  }

  //  Hooks 

  // Executado antes de qualquer insert
  async beforeInsert(doc: Partial<IToDo>, context: IContext) {
    assertAuthenticated(context);
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_CREATE]);

    // Garante que campos controlados nunca venham do cliente
    delete doc.concluida;
    delete doc.concluidaEm;

    // Desnormaliza o nome do autor para exibição sem join
    const profile = await Meteor.users.findOneAsync(context.user._id!, {
      fields: { 'profile.name': 1 },
    });
    doc.autorNome = profile?.profile?.name ?? context.user.email ?? 'Desconhecido';
    doc.concluida = false;
  }

  // Executado antes de qualquer update genérico
  async beforeUpdate(doc: Partial<IToDo>, context: IContext) {
    assertAuthenticated(context);
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

    const existing = await this.getCollectionInstance().findOneAsync(
      { _id: doc._id, createdby: context.user._id },
      { fields: { _id: 1 } }
    );
    if (!existing) {
      throw new Meteor.Error('not-authorized', 'Somente o autor pode editar esta tarefa.');
    }

    // Remove campos que o cliente não pode controlar
    delete doc.concluida;
    delete doc.concluidaEm;
    delete doc.autorNome;
    delete doc.createdby;
  }

  // Executado antes de qualquer remove
  async beforeRemove(doc: IToDo, context: IContext) {
    assertAuthenticated(context);
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_REMOVE]);

    const existing = await this.getCollectionInstance().findOneAsync(
      { _id: doc._id, createdby: context.user._id },
      { fields: { _id: 1 } }
    );
    if (!existing) {
      throw new Meteor.Error('not-authorized', 'Somente o autor pode excluir esta tarefa.');
    }
  }

  //  Methods 

  // Salva apenas campos editáveis — diferencia prazo definido de prazo removido
  private async saveEditable(doc: Partial<IToDo>, context: IContext) {
    check(doc, Object);
    assertAuthenticated(context);

    // Criação
    if (!doc._id) {
      segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_CREATE]);
      await this.beforeInsert(doc, context);
      return this.serverInsert(doc, context);
    }

    // Edição
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);
    await this.beforeUpdate(doc, context);

    const now = new Date();
    const $set: Record<string, unknown> = {
      descricao: doc.descricao,
      prioridade: doc.prioridade,
      pessoal: doc.pessoal ?? false,
      lastupdate: now,
      updatedby: context.user._id,
    };

    const modifier: Record<string, unknown> = { $set };

    // null significa "remover o prazo" — usa $unset para limpar o campo
    if (doc.prazo == null) {
      modifier.$unset = { prazo: '' };
    } else {
      $set.prazo = doc.prazo;
    }

    const changed = await this.getCollectionInstance().updateAsync(
      { _id: doc._id, createdby: context.user._id },
      modifier
    );

    if (changed !== 1) {
      throw new Meteor.Error('document-not-found', 'Tarefa não encontrada.');
    }

    return doc._id;
  }

  // Alterna conclusão de forma atômica — concluida e concluidaEm mudam juntos
  private async alternarConclusao(id: string, context: IContext) {
    check(id, String);
    assertAuthenticated(context);
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

    const tarefa = await this.getCollectionInstance().findOneAsync(
      { _id: id, createdby: context.user._id },
      { fields: { concluida: 1 } }
    );

    if (!tarefa) {
      throw new Meteor.Error('not-authorized', 'Somente o autor pode alterar esta tarefa.');
    }

    const concluida = !tarefa.concluida;
    const now = new Date();

    await this.getCollectionInstance().updateAsync(
      { _id: id, createdby: context.user._id },
      {
        $set: {
          concluida,
          concluidaEm: concluida ? now : null,
          lastupdate: now,
          updatedby: context.user._id,
        },
      }
    );

    return {
      concluida,
      mensagem: concluida
        ? 'Tarefa concluída com sucesso.'
        : 'Tarefa reaberta com sucesso.',
    };
  }
}

export const toDosServerApi = new ToDosServerApi();