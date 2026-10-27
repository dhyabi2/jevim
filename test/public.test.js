import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JEVIM_DATA = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'jevim-public-'));
const { checkWebsite, privateAddress } = await import('../server/public.mjs');

test('private, loopback, link-local and metadata addresses are private', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
                    '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(privateAddress(ip), false, ip);
  }
});

test('the start page must be a public http(s) site', async () => {
  assert.match((await checkWebsite('ftp://example.com')).error, /http and https/);
  assert.match((await checkWebsite('http://localhost:8080')).error, /public/);
  assert.match((await checkWebsite('http://127.0.0.1:8081/')).error, /public/);
  assert.match((await checkWebsite('https://169.254.169.254/latest')).error, /public/);
  assert.match((await checkWebsite('http://[::1]/')).error, /public/);
  assert.match((await checkWebsite('printer.local')).error, /public/);
  assert.equal((await checkWebsite('http://8.8.8.8/')).url, 'http://8.8.8.8/');
  assert.match((await checkWebsite('not a url at all')).error, /web address|find/);
});
