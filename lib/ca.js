'use strict';
/**
 * ca.js — Certificate Authority engine (mirrors Charles' CertificateStore +
 * SSLSocketConfigurationGenerator).
 *
 * Charles' MITM works by holding a self-signed root CA that the user trusts in
 * the OS keychain. On each SSL-proxied CONNECT, it mints a fresh leaf cert for
 * the requested host, signed by that root, and uses it to terminate the client's
 * TLS handshake. We do exactly the same with the openssl CLI (already present)
 * so there are zero native/JS crypto deps.
 *
 * Evidence in the real app:
 *   ~/Library/Application Support/Charles/ca/charles-proxy-ssl-proxying-certificate.pem  (root CA)
 *   ~/Library/Application Support/Charles/certs/*.keystore                                (781 per-host leaf certs)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const OPENSSL = process.env.CHARLES_OPENSSL || 'openssl';

class CertificateAuthority {
  constructor(dir) {
    this.dir = dir || path.join(os.homedir(), '.charles-clone', 'ca');
    this.certDir = path.join(this.dir, 'leaf');
    fs.mkdirSync(this.certDir, { recursive: true });
    this.keyPath = path.join(this.dir, 'ca.key');
    this.crtPath = path.join(this.dir, 'ca.crt');
    this.serialPath = path.join(this.dir, 'ca.srl');
    this.cache = new Map(); // host -> { key, cert } (PEM strings)
    this.generated = 0;
  }

  /** Create the root CA if absent (Charles: "Help > SSL Proxying > Install Charles Root Certificate"). */
  ensureRoot(cn = 'Charles-Clone CA') {
    if (fs.existsSync(this.keyPath) && fs.existsSync(this.crtPath)) return false;
    const host = os.hostname().split('.')[0];
    const d = new Date();
    const stamp = `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()}`;
    // CN has a hard 64-char limit in openssl — keep it compact like Charles does.
    const commonName = `${cn} (${stamp}, ${host})`.slice(0, 64);
    const subj = `/CN=${commonName}/OU=https://charlesproxy.com/ssl/O=Charles Clone/C=NZ`;
    this._run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', this.keyPath, '-out', this.crtPath, '-subj', subj,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', 'subjectKeyIdentifier=hash']);
    fs.chmodSync(this.keyPath, 0o600);
    return true;
  }

  rootCertPem() { return fs.readFileSync(this.crtPath, 'utf8'); }

  /**
   * Get (or mint) a leaf cert for `host`, signed by the root CA.
   * Returns { key, cert } as PEM strings, cached in memory + on disk,
   * exactly like Charles' per-host .keystore files under certs/.
   */
  forHost(host) {
    host = String(host).toLowerCase().replace(/[^a-z0-9.*-]/g, '_');
    if (this.cache.has(host)) return this.cache.get(host);

    // Cache key on disk by a stable hash of the host (Charles uses similar hashed filenames).
    const slug = crypto.createHash('sha1').update(host).digest('hex').slice(0, 32);
    const keyPath = path.join(this.certDir, `${slug}.key`);
    const crtPath = path.join(this.certDir, `${slug}.crt`);

    let key, cert;
    if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
      key = fs.readFileSync(keyPath, 'utf8');
      cert = fs.readFileSync(crtPath, 'utf8');
    } else {
      ({ key, cert } = this._mintLeaf(host, slug));
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
      fs.writeFileSync(crtPath, cert);
      this.generated++;
    }
    const pair = { key, cert };
    this.cache.set(host, pair);
    return pair;
  }

  _mintLeaf(host, slug) {
    const csrPath = path.join(this.certDir, `${slug}.csr`);
    const extPath = path.join(this.certDir, `${slug}.ext`);
    const crtPath = path.join(this.certDir, `${slug}.crt`);
    const keyPath = path.join(this.certDir, `${slug}.key`);

    // SAN list: the host plus a wildcard for its parent (Charles signs wildcard leaves too).
    const sans = [`DNS:${host}`];
    const parts = host.split('.');
    if (!host.includes('*') && parts.length >= 2) sans.push(`DNS:*.${parts.slice(1).join('.')}`);

    fs.writeFileSync(extPath,
      'basicConstraints=CA:FALSE\n' +
      'keyUsage=digitalSignature,keyEncipherment\n' +
      'extendedKeyUsage=serverAuth\n' +
      'subjectAltName=' + sans.join(',') + '\n');

    this._run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
      '-out', csrPath, '-subj', `/CN=${host}`]);
    this._run(['x509', '-req', '-in', csrPath, '-CA', this.crtPath, '-CAkey', this.keyPath,
      '-CAserial', this.serialPath, '-CAcreateserial', '-out', crtPath,
      '-days', '365', '-sha256', '-extfile', extPath]);
    try { fs.unlinkSync(csrPath); fs.unlinkSync(extPath); } catch (_) {}
    return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(crtPath, 'utf8') };
  }

  _run(args) {
    return execFileSync(OPENSSL, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
}

module.exports = { CertificateAuthority };
