const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const fallbackStart = source.indexOf('function inspectionChargeFollowUps(');
const fallbackEnd = source.indexOf('async function loadDashboardFollowUps', fallbackStart);
const incidentStart = source.indexOf('async function _createInspectionViolationIncident(');
const incidentEnd = source.indexOf('let _cachedIncidentDocs', incidentStart);
const deleteStart = source.indexOf('window.deleteUrgentFollowUp =');
const deleteEnd = source.indexOf('window.openIncidentPhotoUpload =', deleteStart);

function harness(existing) {
  const stores = {
    incidents: new Map(existing ? [['existing', existing]] : []),
    expenses: new Map([['expense1', {}]]),
    generalNotes: new Map([['turo_incident_existing', { done: true }]]),
  };
  const queries = [];
  function reference(collection, id) {
    return {
      id,
      get: async () => ({ exists: stores[collection].has(id), data: () => stores[collection].get(id) }),
      update: async data => stores[collection].set(id, { ...stores[collection].get(id), ...data }),
      set: async data => stores[collection].set(id, { ...stores[collection].get(id), ...data }),
    };
  }
  const context = {
    db: { batch() {
      const writes = [];
      return { update: (ref, data) => writes.push(() => ref.update(data)), commit: async () => {
        for (const write of writes) await write();
      } };
    }, collection(collection) { return {
      doc: id => reference(collection, id),
      add: async data => { stores[collection].set('new', data); return reference(collection, 'new'); },
      where(field, operator, value) {
        queries.push([field, operator, value]);
        return { get: async () => ({ docs: [...stores[collection]].filter(([, data]) => data[field] === value)
          .map(([id, data]) => ({ id, ref: reference(collection, id), data: () => data })) }) };
      },
    }; } },
    firebase: { firestore: {
      Timestamp: { fromDate: date => date },
      FieldValue: { serverTimestamp: () => 'server-time', delete: () => null, arrayUnion: (...photos) => photos },
    } },
    currentUser: { uid: 'manager', email: 'manager@example.test' },
    currentUserRole: 'manager',
    window: {},
    confirm: async () => true,
    loadDashboardFollowUps() {},
    toast() {},
    logUserActivity() {},
    todayDateString: () => '2026-10-21',
    _incidentRequiresTuroInvoice: () => true,
  };
  vm.runInNewContext(source.slice(fallbackStart, fallbackEnd) + source.slice(incidentStart, incidentEnd) + source.slice(deleteStart, deleteEnd) +
    '\nglobalThis.create = _createInspectionViolationIncident; globalThis.followUps = inspectionChargeFollowUps;', context);
  return { context, stores, queries };
}

function expense(id, patch = {}) {
  return { id, data: () => ({ source: 'inspection', settlementStatus: 'open', chargeKind: 'fuel', vehiclePlate: 'TEST', ...patch }) };
}

test('existing failed inspection reopens its Home task without a composite query', async () => {
  const { context, stores, queries } = harness({ vehicleId: 'vehicle1', inspectionKey: 'refueled', status: 'in-progress' });
  stores.generalNotes.set('turo_incident_existing', { done: true, deleted: true });
  const result = await context.create({ vehicleId: 'vehicle1', plate: 'TEST', item: { key: 'refueled', label: 'Vehicle Refueled', incidentType: 'refuel' }, expenseId: 'expense1' });
  assert.equal(result.reused, true);
  assert.deepEqual(queries, [['vehicleId', '==', 'vehicle1']]);
  const task = stores.generalNotes.get('turo_incident_existing');
  assert.equal(task.done, false);
  assert.equal(task.deleted, false);
  assert.equal(task.urgent, true);
  assert.equal(task.expenseId, 'expense1');
  assert.equal(stores.expenses.get('expense1').incidentId, 'existing');
});

test('new cleaning failure saves photos and creates a Home task', async () => {
  const { context, stores } = harness();
  await context.create({ vehicleId: 'vehicle1', plate: 'TEST', item: { key: 'cleaned', label: 'Vehicle Cleaned', incidentType: 'cleaning' }, photoUrls: ['https://example.test/photo.jpg'] });
  assert.equal(stores.incidents.get('new').photoUrls[0], 'https://example.test/photo.jpg');
  const task = stores.generalNotes.get('turo_incident_new');
  assert.equal(task.incidentDocId, 'new');
  assert.equal(task.done, false);
});

test('re-failing cleaning reuses its Incident and restores a completed Home task', async () => {
  const { context, stores } = harness({ vehicleId: 'vehicle1', inspectionKey: 'cleaned', status: 'open' });
  const result = await context.create({ vehicleId: 'vehicle1', plate: 'TEST', item: { key: 'cleaned', label: 'Vehicle Cleaned', incidentType: 'cleaning' }, photoUrls: ['https://example.test/new.jpg'] });
  assert.equal(result.reused, true);
  assert.equal(stores.generalNotes.get('turo_incident_existing').done, false);
  assert.equal(stores.incidents.get('existing').photoUrls[0], 'https://example.test/new.jpg');
});

test('pending fuel and parking Expenses remain discoverable without linked Home tasks', () => {
  const { context } = harness();
  const rows = context.followUps([expense('fuel'), expense('parking', { chargeKind: 'parking' })], []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].expenseId, 'fuel');
  assert.equal(rows[1].expenseId, 'parking');
  assert.equal(rows[0].urgent, true);
  assert.equal(rows[0].collection, 'expenses');
});

test('Home fallback deduplicates linked tasks and excludes settled, deleted, and unrelated Expenses', () => {
  const { context } = harness();
  const docs = [expense('by-expense'), expense('by-incident', { incidentId: 'incident1' }),
    expense('settled', { settlementStatus: 'settled' }), expense('deleted', { deleted: true }),
    expense('manual', { source: 'manual' })];
  assert.equal(context.followUps(docs, [{ expenseId: 'by-expense' }, { incidentDocId: 'incident1' }]).length, 0);
});

test('deleting a recovered notification preserves the Expense and removes linked Home tasks', async () => {
  const { context, stores } = harness();
  stores.expenses.set('expense1', expense('expense1').data());
  stores.generalNotes.set('linked', { expenseId: 'expense1', done: false });
  await context.window.deleteUrgentFollowUp('expense1', 'expenses');
  const saved = stores.expenses.get('expense1');
  assert.equal(saved.homeFollowUpDeleted, true);
  assert.equal(saved.homeFollowUpDeletedBy, 'manager');
  assert.equal(saved.deleted, undefined);
  assert.equal(saved.settlementStatus, 'open');
  assert.equal(stores.generalNotes.get('linked').deleted, true);
  assert.equal(context.followUps([{ id: 'expense1', data: () => saved }], []).length, 0);
});

test('deleting an older Incident task also suppresses its Expense fallback without deleting the Incident', async () => {
  const { context, stores } = harness({ vehicleId: 'vehicle1', status: 'open' });
  stores.generalNotes.set('legacy', { incidentDocId: 'existing', done: false });
  stores.expenses.set('expense1', expense('expense1', { incidentId: 'existing' }).data());
  await context.window.deleteUrgentFollowUp('legacy', 'generalNotes');
  assert.equal(stores.generalNotes.get('legacy').deleted, true);
  assert.equal(stores.expenses.get('expense1').homeFollowUpDeleted, true);
  assert.equal(stores.incidents.get('existing').status, 'open');
});

test('canceling notification deletion changes no records', async () => {
  const { context, stores } = harness();
  context.confirm = async () => false;
  await context.window.deleteUrgentFollowUp('expense1', 'expenses');
  assert.deepEqual(stores.expenses.get('expense1'), {});
});

test('ordinary users cannot delete Home notifications', async () => {
  const { context, stores } = harness();
  context.currentUserRole = 'user';
  context.confirm = async () => { throw new Error('Unauthorized user reached confirmation'); };
  await context.window.deleteUrgentFollowUp('expense1', 'expenses');
  assert.deepEqual(stores.expenses.get('expense1'), {});
});