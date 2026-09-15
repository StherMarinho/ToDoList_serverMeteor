import { ProductBase } from '/imports/api/productBase';
import { toDosSch, IToDo } from './toDosSch';

class ToDosApi extends ProductBase<IToDo> {
    constructor() {
        super('toDos', toDosSch, {
            enableCallMethodObserver: true,
            enableSubscribeObserver: true,
        });
    }
}

export const toDosApi = new ToDosApi();