import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadWebAdminAssets } from '../src/web-admin-assets.js';

test('only reviewed browser assets are exposed, with all initial page resources present', async () => {
  const assets = await loadWebAdminAssets();
  const index = assets.get('/').content.toString('utf8');
  assert.match(index, /Welcome back/);
  assert.equal(assets.size, 13);
  for (const match of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(assets.has(match[1]), match[1]);
  }
  assert.equal(assets.has('/web-accounts.json'), false);
  assert.equal(assets.has('/install.html'), false);
  assert.equal(assets.has('/../src/web-admin-auth.js'), false);
  assert.equal(assets.get('/app-icon-192.png').type, 'image/png');
  assert.equal(assets.get('/manifest.webmanifest').type, 'application/manifest+json');
});
