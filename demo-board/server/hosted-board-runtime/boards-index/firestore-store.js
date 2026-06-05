export function createFirestoreBoardsStore({ ref, adapterServices }) {
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

  return { kind: 'firestore', list, get, has, put, set };
}
