export function createFirestoreBoardLayoutsStore({ registry, adapterServices }) {
  const ref = registry?.boardsLayoutRef;
  const firestore = adapterServices?.firestore;
  if (!firestore) {
    throw new Error('firestore boards-layout store requires adapterServices.firestore');
  }
  const collection = firestore.collection(ref.value);

  async function get(id) {
    const snap = await collection.doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async function set(id, layout) {
    await collection.doc(id).set(layout);
  }

  async function remove(id) {
    await collection.doc(id).delete();
  }

  return { kind: 'firestore', get, set, remove };
}