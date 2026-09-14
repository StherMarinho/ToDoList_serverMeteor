import { IDoc } from '/imports/typings/IDoc';
import { ISchema } from '/imports/typings/ISchema';

export enum ToDoPriority {
  BAIXA = 'baixa',
  MEDIA = 'media',
  ALTA = 'alta',
}

export const toDosSch: ISchema<IToDo> = {
  description: {
    type: String,
    label: 'Descrição',
    defaultValue: '',
    optional: false,
    validationFunction: (value: string) => {
      const size = value?.trim().length ?? 0;
      return size < 3 || size > 200
        ? 'Informe entre 3 e 200 caracteres.'
        : undefined;
    },
  },
  priority: {
    type: String,
    label: 'Prioridade',
    defaultValue: ToDoPriority.MEDIA,
    optional: false,
    options: () => [
      { value: ToDoPriority.BAIXA, label: 'Baixa' },
      { value: ToDoPriority.MEDIA, label: 'Média' },
      { value: ToDoPriority.ALTA, label: 'Alta' },
    ],
  },
  deadline: {
    type: Date,
    label: 'Prazo',
    optional: true,
  },
  personal: {
    type: Boolean,
    label: 'Tarefa pessoal',
    defaultValue: false,
    optional: true,
  },
  completed: {
    type: Boolean,
    label: 'Concluída',
    defaultValue: false,
    optional: true,
    readOnly: true,
  },
  completedAt: {
    type: Date,
    label: 'Concluída em',
    optional: true,
    readOnly: true,
  },
  authorName: {
    type: String,
    label: 'Criada por',
    optional: true,
    readOnly: true,
  },
};

export interface IToDo extends IDoc {
  description: string;
  priority: ToDoPriority;
  deadline?: Date;
  personal: boolean;
  completed: boolean;
  completedAt?: Date | null;
  authorName?: string;
}