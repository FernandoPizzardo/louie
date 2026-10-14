'use strict';
/**
 * config.js — loads/saves the JSON config, mirroring Charles' XML
 * <configuration> (proxyConfiguration, sslLocations, throttlingConfiguration,
 * map mappings, toolConfiguration/toolEnabled). We use JSON for readability but
 * keep the same section names so the mapping to the real app is 1:1.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DIR = path.join(os.homedir(), '.charles-clone');

function defaults() {
  return {
    proxyPort: 8888,          // Charles' famous default
    webPort: 8889,
    bindHost: '127.0.0.1',
    caDir: path.join(DEFAULT_DIR, 'ca'),
    // SSL Proxying locations — only these hosts get MITM'd (like sslLocations)
    sslLocations: [],
    enabled: {
      blocklist: false,
      mapRemote: false,
      mapLocal: false,
      rewrite: false,
      throttle: false,
      noCache: false,
    },
    blocklist: [],            // [{host,port,path}]
    blockAction: 'drop',      // 'drop' (Charles default) | '403'
    mapRemote: [],            // [{from:{...}, to:{protocol,host,port}}]
    mapLocal: [],             // [{location:{...}, localPath, contentType}]
    rewrite: [],              // [{enabled,location,rules:[{type,target,action,name,match,replace,flags}]}]
    throttle: { latency: 0, bandwidthDown: 0, bandwidthUp: 0, hosts: [] },
  };
}

function load(file) {
  const cfg = defaults();
  cfg._file = file || path.join(DEFAULT_DIR, 'config.json');
  cfg._persist = () => {
    const { _file, _persist, ...rest } = cfg;
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    fs.writeFileSync(_file, JSON.stringify(rest, null, 2));
  };
  if (fs.existsSync(cfg._file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cfg._file, 'utf8'));
      Object.assign(cfg, saved);
      cfg.enabled = { ...defaults().enabled, ...(saved.enabled || {}) };
    } catch (_) { /* corrupt config -> keep defaults */ }
  }
  return cfg;
}

module.exports = { load, defaults, DEFAULT_DIR };
