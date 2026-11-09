'use strict';
// Opt-in PostgreSQL runtime adapter for the quotations and bank-transfer orders.
// JSON remains the default unless POSTGRES_RUNTIME_COLLECTIONS explicitly opts in.
const crypto = require('node:crypto');
let poolPromise;
const mutationQueues = new Map();
async function withLocalMutationLock(key, task) {
  const prior = mutationQueues.get(key) || Promise.resolve();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const queued = prior.then(() => gate); mutationQueues.set(key, queued);
  await prior;
  try { return await task(); } finally { release(); if (mutationQueues.get(key) === queued) mutationQueues.delete(key); }
}
const allowed = new Set(['quotes.json', 'bank-transfers.json', 'products.json', 'categories.json', 'inquiries.json', 'crm.json', 'payments.json', 'customers.json', 'customer-sessions.json', 'admin-sessions.json', 'settings.json', 'email-outbox.json']);
const enabled = name => {
  const requested = String(process.env.POSTGRES_RUNTIME_COLLECTIONS || '').split(',').map(x => x.trim()).filter(Boolean);
  return !!process.env.DATABASE_URL && requested.includes(name.replace(/\.json$/, '')) && allowed.has(name);
};
function pool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL runtime mode.');
  if (!poolPromise) {
    const { Pool } = require('pg');
    poolPromise = Promise.resolve(new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 5),
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000
    }));
  }
  return poolPromise;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function keyFor(item, index) {
  const key = item && (item.id || item.email || item.tokenHash || item.orderId);
  return key != null && String(key).trim() ? String(key).trim() : `row-${index}-${hash(item).slice(0,16)}`;
}
async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS kejun_json_records (
    collection TEXT NOT NULL, record_key TEXT NOT NULL, payload JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload_sha256 TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection,record_key))`);
  await client.query('ALTER TABLE kejun_json_records ADD COLUMN IF NOT EXISTS payload_sha256 TEXT');
  await client.query('ALTER TABLE kejun_json_records ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL DEFAULT 0');
  await client.query(`CREATE TABLE IF NOT EXISTS kejun_migration_runs (
    run_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source_dir TEXT NOT NULL,
    row_count INTEGER NOT NULL, manifest JSONB NOT NULL, applied BOOLEAN NOT NULL DEFAULT FALSE)`);
}
async function readCollection(name, jsonRead) {
  if (!enabled(name)) return jsonRead(name);
  const p = await pool();
  const client = await p.connect();
  try {
    await ensureSchema(client);
    const collection = name.replace(/\.json$/, '');
    const result = await client.query('SELECT payload FROM kejun_json_records WHERE collection=$1 ORDER BY ordinal ASC, imported_at ASC, record_key ASC', [collection]);
    return result.rows.map(row => row.payload);
  } finally { client.release(); }
}
async function writeCollection(name, rows, jsonWrite) {
  if (!enabled(name)) return jsonWrite(name, rows);
  if (!Array.isArray(rows)) throw new Error(`PostgreSQL collection ${name} must be an array.`);
  const p = await pool();
  const client = await p.connect();
  const collection = name.replace(/\.json$/, '');
  try {
    await client.query('BEGIN');
    await ensureSchema(client);
    // Serialize collection rewrites inside this process/database. Runtime rollout is intended for one app instance.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:' || $1))", [collection]);
    const incoming = new Set();
    for (let i=0; i<rows.length; i++) {
      const payload = rows[i], recordKey = keyFor(payload, i);
      if (incoming.has(recordKey)) throw new Error(`Duplicate key in ${name}: ${recordKey}`);
      incoming.add(recordKey);
      await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at)
        VALUES($1,$2,$3::jsonb,$4,$5,NOW())
        ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=EXCLUDED.ordinal,imported_at=NOW()`,
        [collection, recordKey, JSON.stringify(payload), hash(payload), i]);
    }
    if (incoming.size) await client.query('DELETE FROM kejun_json_records WHERE collection=$1 AND NOT (record_key = ANY($2::text[]))', [collection, [...incoming]]);
    else await client.query('DELETE FROM kejun_json_records WHERE collection=$1', [collection]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}

async function readDocument(name, jsonRead) {
  if (!enabled(name)) return jsonRead(name);
  const p = await pool(), client = await p.connect();
  try {
    await ensureSchema(client);
    const collection = name.replace(/\.json$/, '');
    const result = await client.query('SELECT payload FROM kejun_json_records WHERE collection=$1 AND record_key=$2 LIMIT 1', [collection, '__document__']);
    return result.rows.length ? result.rows[0].payload : {};
  } finally { client.release(); }
}
async function writeDocument(name, value, jsonWrite) {
  if (!enabled(name)) return jsonWrite(name, value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`PostgreSQL document ${name} must be an object.`);
  const p = await pool(), client = await p.connect(), collection = name.replace(/\.json$/, '');
  try {
    await client.query('BEGIN'); await ensureSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:' || $1))", [collection]);
    await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at) VALUES($1,'__document__',$2::jsonb,$3,0,NOW()) ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=0,imported_at=NOW()`, [collection, JSON.stringify(value), hash(value)]);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
}

// Atomic document mutation for settings: avoid stale read-then-write lost updates.
async function mutateDocument(name, mutator, jsonRead, jsonWrite) {
  if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
  if (!enabled(name)) {
    return withLocalMutationLock(name, async () => {
      const current = await Promise.resolve(jsonRead(name));
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`JSON document ${name} must be an object.`);
      const outcome = await mutator(current);
      if (outcome && outcome.write !== false) {
        const next = Object.prototype.hasOwnProperty.call(outcome, 'document') ? outcome.document : current;
        if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`JSON document ${name} must be an object.`);
        await Promise.resolve(jsonWrite(name, next));
      }
      return outcome ? outcome.result : undefined;
    });
  }
  const p = await pool(), client = await p.connect(), collection = name.replace(/\.json$/, '');
  try {
    await client.query('BEGIN'); await ensureSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:' || $1))", [collection]);
    const fetched = await client.query('SELECT payload FROM kejun_json_records WHERE collection=$1 AND record_key=$2 FOR UPDATE', [collection, '__document__']);
    const current = fetched.rows.length ? fetched.rows[0].payload : {};
    const outcome = await mutator(current);
    if (outcome && outcome.write !== false) {
      const next = Object.prototype.hasOwnProperty.call(outcome, 'document') ? outcome.document : current;
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`PostgreSQL document ${name} must be an object.`);
      await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at)
        VALUES($1,'__document__',$2::jsonb,$3,0,NOW())
        ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=0,imported_at=NOW()`, [collection, JSON.stringify(next), hash(next)]);
    }
    await client.query('COMMIT');
    return outcome ? outcome.result : undefined;
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}

async function mutateCollection(name, mutator, jsonRead, jsonWrite) {
  if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
  if (!enabled(name)) {
    return withLocalMutationLock(name, async () => {
      const rows = await Promise.resolve(jsonRead(name));
      if (!Array.isArray(rows)) throw new Error(`JSON collection ${name} must be an array.`);
      const outcome = await mutator(rows);
      if (outcome && outcome.write !== false) await Promise.resolve(jsonWrite(name, outcome.rows || rows));
      return outcome ? outcome.result : undefined;
    });
  }
  const p = await pool(), client = await p.connect(), collection = name.replace(/\.json$/, '');
  try {
    await client.query('BEGIN');
    await ensureSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:' || $1))", [collection]);
    const current = await client.query('SELECT record_key,payload,ordinal FROM kejun_json_records WHERE collection=$1 ORDER BY ordinal ASC, imported_at ASC, record_key ASC FOR UPDATE', [collection]);
    const rows = current.rows.map(row => row.payload);
    const outcome = await mutator(rows);
    if (outcome && outcome.write !== false) {
      const nextRows = outcome.rows || rows;
      if (!Array.isArray(nextRows)) throw new Error(`PostgreSQL collection ${name} must be an array.`);
      const incoming = new Set();
      for (let i=0; i<nextRows.length; i++) {
        const payload = nextRows[i], recordKey = keyFor(payload, i);
        if (incoming.has(recordKey)) throw new Error(`Duplicate key in ${name}: ${recordKey}`);
        incoming.add(recordKey);
        await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at)
          VALUES($1,$2,$3::jsonb,$4,$5,NOW()) ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=EXCLUDED.ordinal,imported_at=NOW()`,
          [collection, recordKey, JSON.stringify(payload), hash(payload), i]);
      }
      if (incoming.size) await client.query('DELETE FROM kejun_json_records WHERE collection=$1 AND NOT (record_key = ANY($2::text[]))', [collection, [...incoming]]);
      else await client.query('DELETE FROM kejun_json_records WHERE collection=$1', [collection]);
    }
    await client.query('COMMIT');
    return outcome ? outcome.result : undefined;
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}

async function writeCollectionsAtomic(entries, jsonCommit) {
  const usePg = entries.some(([name]) => enabled(name));
  if (!usePg) return jsonCommit();
  if (!entries.every(([name]) => enabled(name))) throw new Error('Both quotes and bank-transfers must be enabled together for atomic quote/order commits.');
  const p = await pool(), client = await p.connect();
  try {
    await client.query('BEGIN');
    await ensureSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:quote-order-commit'))");
    for (const [name, rows] of entries) {
      const collection = name.replace(/\.json$/, ''), incoming = new Set();
      if (!Array.isArray(rows)) throw new Error(`PostgreSQL collection ${name} must be an array.`);
      for (let i=0; i<rows.length; i++) {
        const payload=rows[i], recordKey=keyFor(payload,i);
        if(incoming.has(recordKey)) throw new Error(`Duplicate key in ${name}: ${recordKey}`);
        incoming.add(recordKey);
        await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at)
          VALUES($1,$2,$3::jsonb,$4,$5,NOW()) ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=EXCLUDED.ordinal,imported_at=NOW()`,
          [collection,recordKey,JSON.stringify(payload),hash(payload),i]);
      }
      if(incoming.size) await client.query('DELETE FROM kejun_json_records WHERE collection=$1 AND NOT (record_key = ANY($2::text[]))',[collection,[...incoming]]);
      else await client.query('DELETE FROM kejun_json_records WHERE collection=$1',[collection]);
    }
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); }
}

async function mutateCollections(names, mutator, jsonRead, jsonWrite, jsonCommit) {
  const uniqueNames = [...new Set(names)].sort();
  if (!uniqueNames.length || typeof mutator !== 'function') throw new TypeError('names and mutator are required');
  const usePg = uniqueNames.some(name => enabled(name));
  if (usePg && !uniqueNames.every(name => enabled(name))) throw new Error('All collections in a multi-collection mutation must use the same storage backend.');
  if (!usePg) {
    const withLocks = async (index, task) => index >= uniqueNames.length ? task() : withLocalMutationLock(uniqueNames[index], () => withLocks(index + 1, task));
    return withLocks(0, async () => {
      const collections = {};
      for (const name of uniqueNames) collections[name] = await Promise.resolve(jsonRead(name));
      const outcome = await mutator(collections);
      if (outcome && outcome.write !== false) {
        const next = outcome.collections || collections;
        if (jsonCommit) await jsonCommit(next);
        else for (const name of uniqueNames) await Promise.resolve(jsonWrite(name, next[name]));
      }
      return outcome ? outcome.result : undefined;
    });
  }
  const p = await pool(), client = await p.connect();
  try {
    await client.query('BEGIN'); await ensureSchema(client);
    for (const name of uniqueNames) await client.query("SELECT pg_advisory_xact_lock(hashtext('kejun-runtime:' || $1))", [name.replace(/\.json$/, '')]);
    const collections = {};
    for (const name of uniqueNames) {
      const collection = name.replace(/\.json$/, '');
      const current = await client.query('SELECT payload FROM kejun_json_records WHERE collection=$1 ORDER BY ordinal ASC, imported_at ASC, record_key ASC FOR UPDATE', [collection]);
      collections[name] = current.rows.map(row => row.payload);
    }
    const outcome = await mutator(collections);
    if (outcome && outcome.write !== false) {
      const next = outcome.collections || collections;
      for (const name of uniqueNames) {
        const rows = next[name], collection = name.replace(/\.json$/, ''), incoming = new Set();
        if (!Array.isArray(rows)) throw new Error(`PostgreSQL collection ${name} must be an array.`);
        for (let i=0; i<rows.length; i++) {
          const payload=rows[i], recordKey=keyFor(payload,i);
          if(incoming.has(recordKey)) throw new Error(`Duplicate key in ${name}: ${recordKey}`);
          incoming.add(recordKey);
          await client.query(`INSERT INTO kejun_json_records(collection,record_key,payload,payload_sha256,ordinal,imported_at) VALUES($1,$2,$3::jsonb,$4,$5,NOW()) ON CONFLICT(collection,record_key) DO UPDATE SET payload=EXCLUDED.payload,payload_sha256=EXCLUDED.payload_sha256,ordinal=EXCLUDED.ordinal,imported_at=NOW()`, [collection,recordKey,JSON.stringify(payload),hash(payload),i]);
        }
        if(incoming.size) await client.query('DELETE FROM kejun_json_records WHERE collection=$1 AND NOT (record_key = ANY($2::text[]))',[collection,[...incoming]]);
        else await client.query('DELETE FROM kejun_json_records WHERE collection=$1',[collection]);
      }
    }
    await client.query('COMMIT'); return outcome ? outcome.result : undefined;
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
}

module.exports = { enabled, readCollection, writeCollection, mutateCollection, mutateCollections, readDocument, writeDocument, mutateDocument, writeCollectionsAtomic };
