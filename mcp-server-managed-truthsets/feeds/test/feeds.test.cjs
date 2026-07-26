'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFeedsApp, parseFeedXml } = require('../lib/feeds-core.cjs');

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Security Research</title>
  <item><guid>campaign-1</guid><title>Service principal abuse targets AI workloads</title>
    <link>https://research.example/campaign-1</link>
    <description><![CDATA[Researchers observed identity abuse against finance agents.]]></description>
    <pubDate>Wed, 22 Jul 2026 08:00:00 GMT</pubDate><category>Identity</category></item>
  <item><guid>campaign-2</guid><title>New ransomware campaign</title>
    <link>https://research.example/campaign-2</link><description>Organizations should review recovery controls.</description>
    <pubDate>Wed, 22 Jul 2026 07:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Security Advisories</title>
  <entry><id>advisory-1</id><title>Identity protection update</title>
    <link rel="alternate" href="https://advisories.example/identity-1" />
    <summary>New controls for &amp; identity workloads.</summary>
    <content type="html"><![CDATA[Protect <strong>agent identities</strong> first.]]></content>
    <published>2026-07-22T10:00:00Z</published>
    <author><name>Security Team</name></author><category term="Identity" />
  </entry>
</feed>`;

test('parses RSS into stable normalized records', () => {
  const result = parseFeedXml('research', RSS, '2026-07-22T09:00:00.000Z');
  assert.equal(result.format, 'rss');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].sourceId, 'research');
  assert.equal(result.items[0].tags[0], 'Identity');
  assert.match(result.items[0].id, /^[a-f0-9]{64}$/);
});

test('parses Atom links, authors, categories, and content', () => {
  const result = parseFeedXml('advisories', ATOM, '2026-07-22T11:00:00.000Z');
  assert.equal(result.format, 'atom');
  assert.equal(result.title, 'Security Advisories');
  assert.equal(result.items[0].canonicalUrl, 'https://advisories.example/identity-1');
  assert.deepEqual(result.items[0].authors, ['Security Team']);
  assert.deepEqual(result.items[0].tags, ['Identity']);
  assert.equal(result.items[0].contentText, 'Protect agent identities first.');
});

test('manages, refreshes, searches, retrieves, and disables a feed source', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-feeds-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    if (request.headers['if-none-match'] === '"fixture-v1"') {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"fixture-v1"' });
    response.end(RSS);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const app = createFeedsApp({ dbPath: path.join(tempDir, 'feeds.db') });
  const runtimeOptions = { allowHttp: true, allowPrivateNetworks: true };
  const added = await app.addSource({
    id: 'security-research',
    title: 'Security Research',
    url: `http://127.0.0.1:${address.port}/feed.xml`,
    category: 'research',
    tags: ['security'],
  }, runtimeOptions);
  assert.equal(added.created, true);
  assert.equal(added.source.status, 'healthy');

  const read = app.readItems({ source_ids: ['security-research'] });
  assert.equal(read.items.length, 2);
  const search = app.searchItems({ query: 'service principal' });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, 'Service principal abuse targets AI workloads');
  assert.equal(app.getItem({ item_id: search.items[0].id }).item.contentHash.length, 64);

  const secondRefresh = await app.refreshSources({ source_ids: ['security-research'] }, runtimeOptions);
  assert.equal(secondRefresh.results[0].status, 'not_modified');
  assert.equal(requestCount, 2);

  const disabled = app.deleteSource({ source_id: 'security-research' });
  assert.equal(disabled.mode, 'disable');
  assert.equal(disabled.retainedItemCount, 2);
  assert.equal(app.listSources().sources[0].status, 'disabled');
});