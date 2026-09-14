import { userprofileServerApi } from '../modules/userprofile/api/userProfileServerApi';
import { exampleServerApi } from '../modules/example/api/exampleServerApi';
import { toDosServerApi } from '../modules/toDos/api/toDosApi';
import { attachmentsCollection } from '../api/attachmentsCollection';
import { Meteor } from 'meteor/meteor';

Meteor.startup(async () => {
	const userProfiles = userprofileServerApi.getCollectionInstance();
	const toDos = toDosServerApi.getCollectionInstance();

	await Promise.all([
		userProfiles.createIndexAsync({ email: 1 }),
		userProfiles.createIndexAsync({ username: 1 }),
		userProfiles.createIndexAsync({ status: 1, createdat: -1 }),
		userProfiles.createIndexAsync({ roles: 1 }),
		userProfiles.createIndexAsync({ 'otheraccounts._id': 1 }),
		exampleServerApi.getCollectionInstance().createIndexAsync({ lastupdate: 1, _id: 1 }),
		exampleServerApi.tombstones.createIndexAsync({ deletedAt: 1, documentId: 1 }),
		attachmentsCollection.attachments.collection.createIndexAsync({
			'meta.docId': 1,
			'meta.fieldName': 1,
			uploadedAt: 1
		}),
		toDos.createIndexAsync({ pessoal: 1, createdby: 1, lastupdate: -1 }),
        toDos.createIndexAsync({ createdby: 1, lastupdate: -1 }),
        toDos.createIndexAsync({ concluida: 1, lastupdate: -1 }),
	]);
});
