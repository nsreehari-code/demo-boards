'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const Database = require('better-sqlite3');

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS_PER_QUERY = 200;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/;

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  if (value == null) return '';
  const text = typeof value === 'object' && '#text' in value ? value['#text'] : value;
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_match, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function elementMatches(xml, name) {
  const escaped = escapeRegExp(name);
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'gi'))]
    .map((match) => ({ attributes: match[1], content: match[2] }));
}

function firstElementContent(xml, ...names) {
  for (const name of names) {
    const match = elementMatches(xml, name)[0];
    if (match) return match.content;
  }
  return '';
}

function attributeValue(attributes, name) {
  const escaped = escapeRegExp(name);
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes || '');
  return match ? cleanText(match[1] ?? match[2]) : '';
}

function rssItemFromXml(xml) {
  return {
    title: firstElementContent(xml, 'title'),
    link: firstElementContent(xml, 'link'),
    guid: firstElementContent(xml, 'guid'),
    id: firstElementContent(xml, 'id'),
    description: firstElementContent(xml, 'description'),
    summary: firstElementContent(xml, 'summary'),
    'content:encoded': firstElementContent(xml, 'content:encoded'),
    pubDate: firstElementContent(xml, 'pubDate'),
    published: firstElementContent(xml, 'published'),
    updated: firstElementContent(xml, 'updated'),
    author: elementMatches(xml, 'author').map((entry) => entry.content),
    'dc:creator': elementMatches(xml, 'dc:creator').map((entry) => entry.content),
    category: elementMatches(xml, 'category').map((entry) => entry.content),
  };
}

function atomEntryFromXml(xml) {
  return {
    id: firstElementContent(xml, 'id'),
    title: firstElementContent(xml, 'title'),
    summary: firstElementContent(xml, 'summary'),
    content: firstElementContent(xml, 'content'),
    published: firstElementContent(xml, 'published'),
    updated: firstElementContent(xml, 'updated'),
    link: [...xml.matchAll(/<link\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/link\s*>)/gi)]
      .map((match) => ({ '@_href': attributeValue(match[1], 'href'), '@_rel': attributeValue(match[1], 'rel') })),
    author: elementMatches(xml, 'author').map((entry) => ({ name: firstElementContent(entry.content, 'name') || entry.content })),
    category: [...xml.matchAll(/<category\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/category\s*>)/gi)]
      .map((match) => ({ '@_term': attributeValue(match[1], 'term') })),
  };
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableItemId(sourceId, guid) {
  return crypto.createHash('sha256').update(`${sourceId}\n${guid}`).digest('hex');
}

function contentHash(item) {
  return crypto.createHash('sha256')
    .update([item.title, item.summary, item.contentText, item.canonicalUrl].join('\n'))
    .digest('hex');
}

function parseRssItem(sourceId, item, retrievedAt) {
  const canonicalUrl = cleanText(item.link?.['@_href'] || item.link);
  const guid = cleanText(item.guid?.['#text'] || item.guid || item.id || canonicalUrl || item.title);
  if (!guid) return null;
  const title = cleanText(item.title);
  const summary = cleanText(item.description || item.summary);
  const contentText = cleanText(item['content:encoded'] || item.content || item.description || item.summary);
  const authors = asArray(item.author || item['dc:creator']).map(cleanText).filter(Boolean);
  const tags = asArray(item.category).map((entry) => cleanText(entry?.['#text'] || entry)).filter(Boolean);
  const normalized = {
    id: stableItemId(sourceId, guid),
    sourceId,
    guid,
    canonicalUrl,
    title,
    summary,
    contentText,
    authors,
    tags,
    publishedAt: normalizedDate(item.pubDate || item.published || item.updated),
    retrievedAt,
  };
  return { ...normalized, contentHash: contentHash(normalized) };
}

function parseAtomItem(sourceId, entry, retrievedAt) {
  const links = asArray(entry.link);
  const alternate = links.find((link) => !link?.['@_rel'] || link['@_rel'] === 'alternate') || links[0];
  const canonicalUrl = cleanText(alternate?.['@_href'] || alternate);
  const guid = cleanText(entry.id || canonicalUrl || entry.title);
  if (!guid) return null;
  const authors = asArray(entry.author).map((author) => cleanText(author?.name || author)).filter(Boolean);
  const tags = asArray(entry.category).map((category) => cleanText(category?.['@_term'] || category)).filter(Boolean);
  const title = cleanText(entry.title);
  const summary = cleanText(entry.summary);
  const contentText = cleanText(entry.content || entry.summary);
  const normalized = {
    id: stableItemId(sourceId, guid),
    sourceId,
    guid,
    canonicalUrl,
    title,
    summary,
    contentText,
    authors,
    tags,
    publishedAt: normalizedDate(entry.published || entry.updated),
    retrievedAt,
  };
  return { ...normalized, contentHash: contentHash(normalized) };
}

function parseFeedXml(sourceId, xml, retrievedAt = nowIso()) {
  if (typeof xml !== 'string' || xml.length === 0 || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new Error('Feed XML is empty or exceeds the supported size');
  }
  const channel = firstElementContent(xml, 'channel');
  if (/<rss\b/i.test(xml) && channel) {
    return {
      format: 'rss',
      title: cleanText(firstElementContent(channel, 'title')),
      items: elementMatches(channel, 'item')
        .map((entry) => parseRssItem(sourceId, rssItemFromXml(entry.content), retrievedAt))
        .filter(Boolean),
    };
  }
  const feed = firstElementContent(xml, 'feed');
  if (/<feed\b/i.test(xml) && feed) {
    return {
      format: 'atom',
      title: cleanText(firstElementContent(feed, 'title')),
      items: elementMatches(feed, 'entry')
        .map((entry) => parseAtomItem(sourceId, atomEntryFromXml(entry.content), retrievedAt))
        .filter(Boolean),
    };
  }
  throw new Error('Response is not a supported RSS or Atom feed');
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || octets[0] >= 224;
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fe8') || value.startsWith('fe9')
      || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('fc') || value.startsWith('fd');
  }
  return true;
}

async function validateNetworkUrl(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Feed URL must be an absolute URL');
  }
  const allowedProtocols = options.allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) throw new Error('Feed URL must use HTTPS');
  if (url.username || url.password) throw new Error('Feed URL must not include credentials');
  if (!options.allowPrivateNetworks) {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error('Feed URL resolves to a private or unsafe network address');
    }
  }
  return url;
}

async function readResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error(`Feed exceeds ${maxBytes} byte limit`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Feed exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchFeed(source, options = {}) {
  let currentUrl = await validateNetworkUrl(source.url, options);
  const headers = { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' };
  if (source.etag) headers['If-None-Match'] = source.etag;
  if (source.lastModified) headers['If-Modified-Since'] = source.lastModified;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    let response;
    try {
      response = await (options.fetchImpl || fetch)(currentUrl, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) throw new Error('Feed redirect limit exceeded');
      currentUrl = await validateNetworkUrl(new URL(location, currentUrl).href, options);
      continue;
    }
    if (response.status === 304) {
      return { notModified: true, etag: source.etag, lastModified: source.lastModified };
    }
    if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`);
    const body = await readResponseBody(response, options.maxBytes || MAX_FEED_BYTES);
    return {
      notModified: false,
      body,
      finalUrl: currentUrl.href,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  }
  throw new Error('Feed redirect limit exceeded');
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL DEFAULT 'managed',
      enabled INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      etag TEXT,
      last_modified TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feed_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      canonical_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      authors_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT,
      retrieved_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(source_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_source_published ON feed_items(source_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_items_published ON feed_items(published_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS feed_items_fts USING fts5(
      item_id UNINDEXED,
      title,
      summary,
      content_text,
      authors,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS refresh_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS source_audit_events (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'mcp',
      occurred_at TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function sourceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    category: row.category,
    tags: JSON.parse(row.tags_json),
    origin: row.origin,
    enabled: row.enabled === 1,
    archivedAt: row.archived_at,
    revision: row.revision,
    status: row.status,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    contentText: row.content_text,
    authors: JSON.parse(row.authors_json),
    tags: JSON.parse(row.tags_json),
    publishedAt: row.published_at,
    retrievedAt: row.retrieved_at,
    contentHash: row.content_hash,
    ...(typeof row.rank === 'number' ? { rank: row.rank } : {}),
  };
}

function recordAudit(db, sourceId, action, actor, detail = {}) {
  db.prepare(`INSERT INTO source_audit_events (id, source_id, action, actor, occurred_at, detail_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), sourceId, action, actor || 'mcp', nowIso(), JSON.stringify(detail));
}

function seedSources(db, seedPath) {
  if (!seedPath || !fs.existsSync(seedPath)) return;
  const sources = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const timestamp = nowIso();
  const insert = db.prepare(`INSERT OR IGNORE INTO sources
    (id, title, url, category, tags_json, origin, enabled, revision, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'baseline', 1, 1, 'pending', ?, ?)`);
  const transaction = db.transaction(() => {
    for (const source of sources) {
      insert.run(source.id, source.title, source.url, source.category || '', JSON.stringify(source.tags || []), timestamp, timestamp);
    }
  });
  transaction();
}

function createFeedsApp(options) {
  if (!options?.dbPath) throw new Error('feeds dbPath is required');
  const dbPath = path.resolve(options.dbPath);
  const refreshLocks = new Map();

  function withDb(callback) {
    const db = openDatabase(dbPath);
    try {
      seedSources(db, options.seedPath);
      return callback(db);
    } finally {
      db.close();
    }
  }

  function listSources(args = {}) {
    return withDb((db) => {
      const where = args.include_archived ? '' : 'WHERE archived_at IS NULL';
      const rows = db.prepare(`SELECT * FROM sources ${where} ORDER BY title COLLATE NOCASE`).all();
      return { sources: rows.map(sourceFromRow) };
    });
  }

  async function addSource(args = {}, runtimeOptions = {}) {
    const id = String(args.id || '').trim().toLowerCase();
    if (!SOURCE_ID_RE.test(id)) throw new Error('Source id must be 2-80 lowercase letters, numbers, dots, underscores, or hyphens');
    const title = String(args.title || '').trim();
    if (!title) throw new Error('Source title is required');
    const url = (await validateNetworkUrl(args.url, runtimeOptions)).href;
    const existing = withDb((db) => db.prepare('SELECT * FROM sources WHERE id = ? OR url = ?').get(id, url));
    if (existing && !args.replace) throw new Error(`Feed source already exists: ${existing.id}`);
    if (existing && args.expected_revision != null && Number(args.expected_revision) !== existing.revision) {
      throw new Error(`Source revision conflict: expected ${args.expected_revision}, current ${existing.revision}`);
    }
    const timestamp = nowIso();
    withDb((db) => db.transaction(() => {
      if (existing) {
        db.prepare(`UPDATE sources SET id = ?, title = ?, url = ?, category = ?, tags_json = ?, enabled = 1,
          archived_at = NULL, revision = revision + 1, status = 'pending', updated_at = ? WHERE id = ?`)
          .run(id, title, url, args.category || '', JSON.stringify(args.tags || []), timestamp, existing.id);
      } else {
        db.prepare(`INSERT INTO sources
          (id, title, url, category, tags_json, origin, enabled, revision, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'managed', 1, 1, 'pending', ?, ?)`)
          .run(id, title, url, args.category || '', JSON.stringify(args.tags || []), timestamp, timestamp);
      }
      recordAudit(db, id, existing ? 'source.updated' : 'source.added', args.actor, { url });
    })());
    if (args.refresh !== false) await refreshOne(id, runtimeOptions);
    return withDb((db) => ({ created: !existing, source: sourceFromRow(db.prepare('SELECT * FROM sources WHERE id = ?').get(id)) }));
  }

  function deleteSource(args = {}) {
    const id = String(args.source_id || '').trim();
    const mode = args.mode || 'disable';
    if (!['disable', 'archive', 'purge'].includes(mode)) throw new Error('Delete mode must be disable, archive, or purge');
    return withDb((db) => db.transaction(() => {
      const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      if (!source) throw new Error(`Unknown feed source: ${id}`);
      if (args.expected_revision != null && Number(args.expected_revision) !== source.revision) {
        throw new Error(`Source revision conflict: expected ${args.expected_revision}, current ${source.revision}`);
      }
      const retainedItemCount = db.prepare('SELECT count(*) count FROM feed_items WHERE source_id = ?').get(id).count;
      if (mode === 'purge') {
        const itemIds = db.prepare('SELECT id FROM feed_items WHERE source_id = ?').all(id).map((row) => row.id);
        const removeFts = db.prepare('DELETE FROM feed_items_fts WHERE item_id = ?');
        for (const itemId of itemIds) removeFts.run(itemId);
        db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      } else {
        db.prepare(`UPDATE sources SET enabled = 0, archived_at = ?, revision = revision + 1,
          status = ?, updated_at = ? WHERE id = ?`)
          .run(mode === 'archive' ? nowIso() : null, mode === 'archive' ? 'archived' : 'disabled', nowIso(), id);
      }
      recordAudit(db, id, `source.${mode}`, args.actor, { retainedItemCount: mode === 'purge' ? 0 : retainedItemCount });
      return { sourceId: id, mode, retainedItemCount: mode === 'purge' ? 0 : retainedItemCount };
    })());
  }

  async function refreshOne(sourceId, runtimeOptions = {}) {
    if (refreshLocks.has(sourceId)) return refreshLocks.get(sourceId);
    const operation = (async () => {
      const sourceRow = withDb((db) => db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId));
      if (!sourceRow) throw new Error(`Unknown feed source: ${sourceId}`);
      if (sourceRow.enabled !== 1 || sourceRow.archived_at) throw new Error(`Feed source is not enabled: ${sourceId}`);
      const source = { ...sourceFromRow(sourceRow), etag: sourceRow.etag, lastModified: sourceRow.last_modified };
      const runId = crypto.randomUUID();
      const startedAt = nowIso();
      withDb((db) => {
        db.prepare(`INSERT INTO refresh_runs (id, source_id, started_at, status) VALUES (?, ?, ?, 'running')`)
          .run(runId, sourceId, startedAt);
        db.prepare(`UPDATE sources SET status = 'refreshing', last_attempt_at = ?, last_error = NULL WHERE id = ?`)
          .run(startedAt, sourceId);
      });
      try {
        const response = await fetchFeed(source, runtimeOptions);
        if (response.notModified) {
          withDb((db) => db.transaction(() => {
            db.prepare(`UPDATE sources SET status = 'healthy', last_success_at = ?, updated_at = ? WHERE id = ?`)
              .run(nowIso(), nowIso(), sourceId);
            db.prepare(`UPDATE refresh_runs SET completed_at = ?, status = 'not_modified' WHERE id = ?`)
              .run(nowIso(), runId);
          })());
          return { sourceId, status: 'not_modified', itemCount: 0, changedCount: 0 };
        }
        const parsed = parseFeedXml(sourceId, response.body);
        const result = withDb((db) => db.transaction(() => {
          const current = db.prepare('SELECT revision FROM sources WHERE id = ?').get(sourceId);
          if (!current || current.revision !== sourceRow.revision) throw new Error('Source changed while refresh was running');
          const existingHash = db.prepare('SELECT content_hash FROM feed_items WHERE id = ?');
          const upsert = db.prepare(`INSERT INTO feed_items
            (id, source_id, guid, canonical_url, title, summary, content_text, authors_json, tags_json, published_at, retrieved_at, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET canonical_url = excluded.canonical_url, title = excluded.title,
              summary = excluded.summary, content_text = excluded.content_text, authors_json = excluded.authors_json,
              tags_json = excluded.tags_json, published_at = excluded.published_at,
              retrieved_at = excluded.retrieved_at, content_hash = excluded.content_hash`);
          const removeFts = db.prepare('DELETE FROM feed_items_fts WHERE item_id = ?');
          const insertFts = db.prepare(`INSERT INTO feed_items_fts
            (item_id, title, summary, content_text, authors, tags) VALUES (?, ?, ?, ?, ?, ?)`);
          let changedCount = 0;
          for (const item of parsed.items) {
            const previous = existingHash.get(item.id);
            if (!previous || previous.content_hash !== item.contentHash) changedCount += 1;
            upsert.run(item.id, item.sourceId, item.guid, item.canonicalUrl, item.title, item.summary,
              item.contentText, JSON.stringify(item.authors), JSON.stringify(item.tags), item.publishedAt,
              item.retrievedAt, item.contentHash);
            removeFts.run(item.id);
            insertFts.run(item.id, item.title, item.summary, item.contentText, item.authors.join(' '), item.tags.join(' '));
          }
          const completedAt = nowIso();
          db.prepare(`UPDATE sources SET title = CASE WHEN title = '' THEN ? ELSE title END, url = ?, etag = ?,
            last_modified = ?, status = 'healthy', last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
            .run(parsed.title, response.finalUrl, response.etag, response.lastModified, completedAt, completedAt, sourceId);
          db.prepare(`UPDATE refresh_runs SET completed_at = ?, status = 'completed', item_count = ?, changed_count = ? WHERE id = ?`)
            .run(completedAt, parsed.items.length, changedCount, runId);
          return { sourceId, status: 'completed', format: parsed.format, itemCount: parsed.items.length, changedCount };
        })());
        return result;
      } catch (error) {
        withDb((db) => db.transaction(() => {
          db.prepare(`UPDATE sources SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`)
            .run(error.message, nowIso(), sourceId);
          db.prepare(`UPDATE refresh_runs SET completed_at = ?, status = 'failed', error = ? WHERE id = ?`)
            .run(nowIso(), error.message, runId);
        })());
        throw error;
      }
    })();
    refreshLocks.set(sourceId, operation);
    try {
      return await operation;
    } finally {
      refreshLocks.delete(sourceId);
    }
  }

  async function refreshSources(args = {}, runtimeOptions = {}) {
    const sourceIds = args.source_ids?.length
      ? args.source_ids
      : withDb((db) => db.prepare('SELECT id FROM sources WHERE enabled = 1 AND archived_at IS NULL ORDER BY id').all().map((row) => row.id));
    const results = [];
    for (const sourceId of sourceIds) {
      try {
        results.push(await refreshOne(sourceId, runtimeOptions));
      } catch (error) {
        results.push({ sourceId, status: 'failed', error: error.message });
      }
    }
    return { results };
  }

  function readItems(args = {}) {
    return withDb((db) => {
      const conditions = ['s.archived_at IS NULL'];
      const params = [];
      if (args.source_ids?.length) {
        conditions.push(`i.source_id IN (${args.source_ids.map(() => '?').join(', ')})`);
        params.push(...args.source_ids);
      }
      if (args.published_after) {
        conditions.push('i.published_at >= ?');
        params.push(normalizedDate(args.published_after) || args.published_after);
      }
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), MAX_ITEMS_PER_QUERY);
      params.push(limit);
      const rows = db.prepare(`SELECT i.*, s.title source_title FROM feed_items i JOIN sources s ON s.id = i.source_id
        WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(i.published_at, i.retrieved_at) DESC LIMIT ?`).all(...params);
      return { items: rows.map(itemFromRow) };
    });
  }

  function searchItems(args = {}) {
    const terms = String(args.query || '').match(/[\p{L}\p{N}_-]+/gu) || [];
    if (terms.length === 0) throw new Error('Search query must contain at least one word or number');
    const match = terms.slice(0, 12).map((term) => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
    return withDb((db) => {
      const conditions = ['feed_items_fts MATCH ?', 's.archived_at IS NULL'];
      const params = [match];
      if (args.source_ids?.length) {
        conditions.push(`i.source_id IN (${args.source_ids.map(() => '?').join(', ')})`);
        params.push(...args.source_ids);
      }
      if (args.published_after) {
        conditions.push('i.published_at >= ?');
        params.push(normalizedDate(args.published_after) || args.published_after);
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      params.push(limit);
      const rows = db.prepare(`SELECT i.*, s.title source_title, bm25(feed_items_fts) rank
        FROM feed_items_fts JOIN feed_items i ON i.id = feed_items_fts.item_id
        JOIN sources s ON s.id = i.source_id WHERE ${conditions.join(' AND ')} ORDER BY rank LIMIT ?`).all(...params);
      return { query: args.query, items: rows.map(itemFromRow) };
    });
  }

  function getItem(args = {}) {
    return withDb((db) => {
      const row = db.prepare(`SELECT i.*, s.title source_title FROM feed_items i
        JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(args.item_id);
      return { item: itemFromRow(row) };
    });
  }

  return { listSources, addSource, deleteSource, refreshSources, readItems, searchItems, getItem };
}

module.exports = { createFeedsApp, parseFeedXml, validateNetworkUrl };