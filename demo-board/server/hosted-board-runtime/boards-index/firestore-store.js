export function createFirestoreBoardsStore({ registry, adapterServices }) {
  const ref = registry?.boardsIndexRef;
  const deprecatedContainerRef = registry?.deprecatedContainerRef;
  const firestore = adapterServices?.firestore;
  if (!firestore) {
    throw new Error('firestore boards-index store requires adapterServices.firestore');
  }
  const collectionPath = ref.value;
  const collection = firestore.collection(collectionPath);

  async function list() {
    const snap = await collection.get();
    return snap.docs.map((doc) => ({ id: doc.id, record: doc.data() }));
  }

  async function get(id) {
    const snap = await collection.doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async function has(id) {
    const snap = await collection.doc(id).get();
    return snap.exists;
  }

  async function put(id, record) {
    const docRef = collection.doc(id);
    const existing = await docRef.get();
    if (existing.exists) {
      const err = new Error(`board '${id}' already exists`);
      err.code = 'EEXIST';
      throw err;
    }
    await docRef.create(record);
  }

  async function set(id, record) {
    await collection.doc(id).set(record);
  }

  function formatArchiveStamp(date = new Date()) {
    const pad2 = (value) => String(value).padStart(2, '0');
    return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  }

  async function deprecate(id) {
    const docRef = collection.doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return null;
    }
    const record = existing.data() ?? null;
    if (!deprecatedContainerRef) {
      await docRef.delete();
      return {
        archiveId: '',
        archiveRecordPath: '',
        archiveWorkspaceDir: '',
      };
    }
    if (deprecatedContainerRef.kind !== 'firestore') {
      throw new Error(`firestore boards-index deprecatedContainer must be a firestore ref or null (got '${deprecatedContainerRef.kind}')`);
    }
    const archiveId = `${id}-${formatArchiveStamp()}`;
    await firestore.collection(deprecatedContainerRef.value).doc(archiveId).set(record);
    await docRef.delete();
    return {
      archiveId,
      archiveRecordPath: `${deprecatedContainerRef.value}/${archiveId}`,
      archiveWorkspaceDir: '',
    };
  }

  return { kind: 'firestore', list, get, has, put, set, deprecate };
}
