import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Mongo } from 'meteor/mongo';
import { IContext } from '/imports/typings/IContext';
import { ProductServerBase } from '/imports/api/productServerBase';
import { segurancaApi } from '/imports/security/api/segurancaApi';
import { getUserServer } from '/imports/modules/userprofile/api/userProfileServerApi';
import { IToDo, ToDoPriority, toDosSch } from './toDosSch';
import { Recurso } from '../config/recursos';

interface IToDoTombstone {
  _id?: string;
  documentId: string;
  deletedAt: Date;
  createdby: string;
  personal: boolean;
}
const toDosTombstones = new Mongo.Collection<IToDoTombstone>('toDosTombstones');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type ToDosListInput = {
  search?: string;
  status?: 'todas' | 'abertas' | 'concluidas';
  page?: number;
};

const listInputPattern = {
  search: Match.Optional(String),
  status: Match.Optional(Match.OneOf('todas', 'abertas', 'concluidas')),
  page: Match.Optional(Match.Integer),
};

function buildVisibleSelector(
  userId: string,
  input: ToDosListInput = {}
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [
    { $or: [{ personal: { $ne: true } }, { createdby: userId }] },
  ];

  const search = input.search?.trim();
  if (search) {
    if (search.length > 80) {
      throw new Meteor.Error('validation-error', 'Busca muito longa.');
    }
    clauses.push({ description: { $regex: escapeRegExp(search), $options: 'i' } });
  }

  if (input.status === 'abertas') {
    clauses.push({ completed: { $ne: true } });
  } else if (input.status === 'concluidas') {
    clauses.push({ completed: true });
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

class ToDosServerApi extends ProductServerBase<IToDo> {
  constructor() {
    super('toDos', toDosSch);
    this.registerMobilePublications();
    this.registerMethod('saveEditable', this.saveEditable.bind(this));
    this.registerMethod('alternarConclusao', this.alternarConclusao.bind(this));
    this.registerMethod('mobileUpsert', this.mobileUpsert.bind(this));
    this.registerMethod('mobilePull', this.mobilePull.bind(this));
    this.registerMethod('setCompletion', this.setCompletion.bind(this));
  }

  private registerMobilePublications() {
    const collection = this.getCollectionInstance();

    Meteor.publish('toDos.toDosList', async function (input: ToDosListInput = {}) {
      check(input, listInputPattern);

      const user = await getUserServer();
      if (!user?.email) {
        throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
      }
      segurancaApi.validarAcessoRecursos(user, [Recurso.TODOS_VIEW]);

      const page = Math.max(1, input.page ?? 1);
      const selector = buildVisibleSelector(user._id!, input);

      let count = 0;
      let countReady = false;

      const countHandle = await (collection
        .find(selector, { fields: { _id: 1 } }) as any)
        .observeChangesAsync({
            added: () => {
            count++;
            if (countReady) this.changed('toDosListMeta', 'current', { count });
            },
            removed: () => {
            count--;
            if (countReady) this.changed('toDosListMeta', 'current', { count });
            },
        });

      this.added('toDosListMeta', 'current', { count });
      countReady = true;

      const pageHandle = await (collection
        .find(selector, {
            fields: {
            description: 1,
            priority: 1,
            deadline: 1,
            personal: 1,
            completed: 1,
            completedAt: 1,
            authorName: 1,
            createdby: 1,
            lastupdate: 1,
            },
            sort: { completed: 1, lastupdate: -1, _id: 1 },
            skip: (page - 1) * 4,
            limit: 4,
        }) as any)
        .observeChangesAsync({
            added: (id: string, fields: Record<string, unknown>) => this.added('toDosListView', id, fields),
            changed: (id: string, fields: Record<string, unknown>) => this.changed('toDosListView', id, fields),
            removed: (id: string) => this.removed('toDosListView', id),
        });

      this.ready();
      this.onStop(() => {
        pageHandle.stop();
        countHandle.stop();
      });
    });

    Meteor.publish('toDos.toDosDetail', async function (id: string) {
      check(id, String);

      const user = await getUserServer();
      if (!user?.email) {
        throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
      }
      segurancaApi.validarAcessoRecursos(user, [Recurso.TODOS_VIEW]);

      const handle = await (collection
        .find(
            { $and: [{ _id: id }, buildVisibleSelector(user._id!)] },
            {
            fields: {
                description: 1,
                priority: 1,
                deadline: 1,
                personal: 1,
                completed: 1,
                completedAt: 1,
                authorName: 1,
                createdby: 1,
                createdat: 1,
                lastupdate: 1,
            },
            }
        ) as any)
        .observeChangesAsync({
            added: (docId: string, fields: Record<string, unknown>) => this.added('toDosDetailView', docId, fields),
            changed: (docId: string, fields: Record<string, unknown>) => this.changed('toDosDetailView', docId, fields),
            removed: (docId: string) => this.removed('toDosDetailView', docId),
        });

      this.ready();
      this.onStop(() => handle.stop());
    });
  }

  async beforeInsert(doc: Partial<IToDo>, context: IContext): Promise<boolean> {
    if (!context.user?.email) {
      throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
    }
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_CREATE]);

    delete doc.completed;
    delete doc.completedAt;

    const profile = await Meteor.users.findOneAsync(context.user._id!, {
      fields: { 'profile.name': 1 },
    });
    doc.authorName = profile?.profile?.name ?? context.user.email ?? 'Desconhecido';
    doc.completed = false;

    return true;
  }

  async beforeUpdate(doc: Partial<IToDo>, context: IContext): Promise<boolean> {
    if (!context.user?.email) {
      throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
    }
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

    const existing = await this.getCollectionInstance().findOneAsync(
      { _id: doc._id, createdby: context.user._id },
      { fields: { _id: 1 } }
    );
    if (!existing) {
      throw new Meteor.Error('not-authorized', 'Somente o autor pode editar esta tarefa.');
    }

    delete doc.completed;
    delete doc.completedAt;
    delete doc.authorName;
    delete doc.createdby;

    return true;
  }

  async beforeRemove(doc: IToDo, context: IContext): Promise<boolean> {
    if (!context.user?.email) {
        throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
    }
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_REMOVE]);

    const existing = await this.getCollectionInstance().findOneAsync(
        { _id: doc._id, createdby: context.user._id },
        { fields: { _id: 1, personal: 1 } }
    );
    if (!existing) {
        throw new Meteor.Error('not-authorized', 'Somente o autor pode excluir esta tarefa.');
    }

    // Grava tombstone antes de excluir
    await toDosTombstones.insertAsync({
        documentId: doc._id!,
        deletedAt: new Date(),
        createdby: context.user._id!,
        personal: existing.personal ?? false,
    });

    return true;
    }

  private async saveEditable(doc: Partial<IToDo>, context: IContext) {
    check(doc, Object);
    if (!context.user?.email) {
      throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
    }

    if (!doc._id) {
      await this.beforeInsert(doc, context);
      return this.serverInsert(doc, context);
    }

    await this.beforeUpdate(doc, context);

    const now = new Date();
    const $set: Record<string, unknown> = {
      description: doc.description,
      priority: doc.priority,
      personal: doc.personal ?? false,
      lastupdate: now,
      updatedby: context.user._id,
    };

    const modifier: Record<string, unknown> = { $set };

    if (doc.deadline == null) {
      modifier.$unset = { deadline: '' };
    } else {
      $set.deadline = doc.deadline;
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

  private async alternarConclusao(id: string, context: IContext) {
    check(id, String);
    if (!context.user?.email) {
      throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
    }
    segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

    const tarefa = await this.getCollectionInstance().findOneAsync(
      { _id: id, createdby: context.user._id },
      { fields: { completed: 1 } }
    );

    if (!tarefa) {
      throw new Meteor.Error('not-authorized', 'Somente o autor pode alterar esta tarefa.');
    }

    const completed = !tarefa.completed;
    const now = new Date();

    await this.getCollectionInstance().updateAsync(
      { _id: id, createdby: context.user._id },
      {
        $set: {
          completed,
          completedAt: completed ? now : null,
          lastupdate: now,
          updatedby: context.user._id,
        },
      }
    );

    return {
      completed,
      mensagem: completed
        ? 'Tarefa concluída com sucesso.'
        : 'Tarefa reaberta com sucesso.',
    };
  }
  private async mobileUpsert(
        payload: { document: Partial<IToDo>; baseVersion?: Date },
        context: IContext
    ) {
        check(payload, Object);
        if (!context.user?.email) {
            throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
        }

        const doc = payload.document;
        const baseVersion = payload.baseVersion;
        const collection = this.getCollectionInstance();

        if (!doc._id) {
            throw new Meteor.Error('validation-error', 'ID obrigatório no mobileUpsert.');
        }

        const existing = await collection.findOneAsync(
            { _id: doc._id },
            { fields: { createdby: 1, lastupdate: 1 } }
        );

        // Insert idempotente
        if (!existing) {
            segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_CREATE]);
            const profile = await Meteor.users.findOneAsync(context.user._id!, {
            fields: { 'profile.name': 1 },
            });
            const now = new Date();
            await collection.insertAsync({
            _id: doc._id,
            description: doc.description ?? '',
            priority: doc.priority ?? ToDoPriority.BAIXA,
            personal: doc.personal ?? false,
            completed: false,
            authorName: profile?.profile?.name ?? context.user.email ?? 'Desconhecido',
            createdby: context.user._id!,
            createdat: now,
            lastupdate: now,
            } as IToDo);
            const inserted = await collection.findOneAsync({ _id: doc._id });
            return inserted;
        }

        // Update com verificação de ownership e conflito de versão
        if (existing.createdby !== context.user._id) {
            throw new Meteor.Error('not-authorized', 'Somente o autor pode editar esta tarefa.');
        }
        segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

        if (
            baseVersion != null &&
            existing.lastupdate != null &&
            new Date(existing.lastupdate).getTime() > new Date(baseVersion).getTime()
        ) {
            throw new Meteor.Error('sync-conflict', 'O documento foi alterado por outro cliente.');
        }

        const now = new Date();
        const $set: Record<string, unknown> = {
            description: doc.description,
            priority: doc.priority,
            personal: doc.personal ?? false,
            lastupdate: now,
            updatedby: context.user._id,
        };
        const modifier: Record<string, unknown> = { $set };
        if (doc.deadline == null) {
            modifier.$unset = { deadline: '' };
        } else {
            $set.deadline = doc.deadline;
        }

        await collection.updateAsync({ _id: doc._id }, modifier);
        const updated = await collection.findOneAsync({ _id: doc._id });
        return updated;
    }

    private async mobilePull(
        payload: { since?: Date },
        context: IContext
    ) {
        check(payload, Object);
        if (!context.user?.email) {
            throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
        }
        segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_VIEW]);

        const collection = this.getCollectionInstance();
        const since = payload.since ? new Date(payload.since) : null;

        const baseSelector = buildVisibleSelector(context.user._id!);
        const query = since
            ? { $and: [baseSelector, { lastupdate: { $gt: since } }] }
            : baseSelector;

        const documents = await collection
            .find(query, {
            fields: {
                description: 1,
                priority: 1,
                deadline: 1,
                personal: 1,
                completed: 1,
                completedAt: 1,
                authorName: 1,
                createdby: 1,
                createdat: 1,
                lastupdate: 1,
            },
            sort: { lastupdate: 1, _id: 1 },
            limit: 50,
            })
            .fetchAsync();

        // Tombstones visíveis para este usuário:
        // - tarefas públicas que ele podia ver (personal: false)
        // - tarefas pessoais dele mesmo (createdby === userId)
        const tombstoneQuery: Record<string, unknown> = {
            $or: [
            { personal: false },
            { personal: true, createdby: context.user._id },
            ],
        };
        if (since) {
            (tombstoneQuery as any).deletedAt = { $gt: since };
        }

        const tombstones = await toDosTombstones
            .find(tombstoneQuery, {
            fields: { documentId: 1, deletedAt: 1 },
            sort: { deletedAt: 1 },
            })
            .fetchAsync();

        const cursor = documents.length > 0
            ? documents[documents.length - 1].lastupdate?.toISOString()
            : null;

        return {
            documents,
            deletedIds: tombstones.map((t) => t.documentId),
            cursor,
            hasMore: documents.length === 50,
        };
        }

    private async setCompletion(
        payload: { id: string; completed: boolean; operationId: string },
        context: IContext
        ) {
        check(payload, Object);
        if (!context.user?.email) {
            throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
        }
        segurancaApi.validarAcessoRecursos(context.user, [Recurso.TODOS_UPDATE]);

        const tarefa = await this.getCollectionInstance().findOneAsync(
            { _id: payload.id, createdby: context.user._id },
            { fields: { completed: 1 } }
        );

        if (!tarefa) {
            throw new Meteor.Error('not-authorized', 'Somente o autor pode alterar esta tarefa.');
        }

        // Idempotente: se já está no estado desejado, retorna sem alterar
        if (tarefa.completed === payload.completed) {
            return {
            completed: payload.completed,
            mensagem: payload.completed
                ? 'Tarefa já estava concluída.'
                : 'Tarefa já estava aberta.',
            };
        }

        const now = new Date();
        await this.getCollectionInstance().updateAsync(
            { _id: payload.id, createdby: context.user._id },
            {
            $set: {
                completed: payload.completed,
                completedAt: payload.completed ? now : null,
                lastupdate: now,
                updatedby: context.user._id,
            },
            }
        );

        return {
            completed: payload.completed,
            mensagem: payload.completed
            ? 'Tarefa concluída com sucesso.'
            : 'Tarefa reaberta com sucesso.',
        };
    }
}

export const toDosServerApi = new ToDosServerApi();
export { toDosTombstones };