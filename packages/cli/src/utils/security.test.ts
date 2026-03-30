import { describe, test, expect } from 'bun:test';
import {
  isDangerousEnvKey,
  isBlockedUrl,
  DANGEROUS_ENV_KEYS,
  CLOUD_METADATA_HOSTS,
} from './security';

describe('isDangerousEnvKey', () => {
  test('blocks Node.js runtime injection vars', () => {
    expect(isDangerousEnvKey('NODE_OPTIONS')).toBe(true);
    expect(isDangerousEnvKey('NODE_EXTRA_CA_CERTS')).toBe(true);
    expect(isDangerousEnvKey('NODE_PATH')).toBe(true);
    expect(isDangerousEnvKey('BUN_OPTIONS')).toBe(true);
  });

  test('blocks Python injection vars', () => {
    expect(isDangerousEnvKey('PYTHONSTARTUP')).toBe(true);
    expect(isDangerousEnvKey('PYTHONPATH')).toBe(true);
    expect(isDangerousEnvKey('PYTHONHOME')).toBe(true);
  });

  test('blocks shared library injection vars', () => {
    expect(isDangerousEnvKey('LD_PRELOAD')).toBe(true);
    expect(isDangerousEnvKey('LD_LIBRARY_PATH')).toBe(true);
    expect(isDangerousEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true);
  });

  test('blocks shell injection vars', () => {
    expect(isDangerousEnvKey('SHELL')).toBe(true);
    expect(isDangerousEnvKey('BASH_ENV')).toBe(true);
    expect(isDangerousEnvKey('PATH')).toBe(true);
    expect(isDangerousEnvKey('IFS')).toBe(true);
  });

  test('blocks Git command injection vars', () => {
    expect(isDangerousEnvKey('GIT_SSH_COMMAND')).toBe(true);
    expect(isDangerousEnvKey('GIT_ASKPASS')).toBe(true);
  });

  test('blocks system identity vars', () => {
    expect(isDangerousEnvKey('HOME')).toBe(true);
    expect(isDangerousEnvKey('USER')).toBe(true);
    expect(isDangerousEnvKey('PWD')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isDangerousEnvKey('node_options')).toBe(true);
    expect(isDangerousEnvKey('Node_Options')).toBe(true);
    expect(isDangerousEnvKey('path')).toBe(true);
  });

  test('allows safe env vars', () => {
    expect(isDangerousEnvKey('API_KEY')).toBe(false);
    expect(isDangerousEnvKey('DATABASE_URL')).toBe(false);
    expect(isDangerousEnvKey('MY_CUSTOM_VAR')).toBe(false);
    expect(isDangerousEnvKey('ALEGRA_TOKEN')).toBe(false);
  });
});

describe('DANGEROUS_ENV_KEYS', () => {
  test('contains expected count of dangerous keys', () => {
    // Sanity check - should have ~45+ dangerous keys
    expect(DANGEROUS_ENV_KEYS.size).toBeGreaterThan(40);
  });
});

describe('isBlockedUrl', () => {
  describe('cloud metadata endpoints', () => {
    test('blocks AWS metadata endpoint', () => {
      const result = isBlockedUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Cloud metadata endpoint blocked');
    });

    test('blocks GCP metadata endpoint', () => {
      expect(isBlockedUrl('http://metadata.google.internal/').blocked).toBe(true);
      expect(isBlockedUrl('http://metadata.goog/').blocked).toBe(true);
    });

    test('blocks AWS ECS task metadata', () => {
      expect(isBlockedUrl('http://169.254.170.2/v2/metadata').blocked).toBe(true);
    });
  });

  describe('private IPv4 ranges (RFC 1918)', () => {
    test('blocks 10.x.x.x', () => {
      const result = isBlockedUrl('http://10.0.0.1/');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Private IP (10.x.x.x)');
    });

    test('blocks 172.16-31.x.x', () => {
      expect(isBlockedUrl('http://172.16.0.1/').blocked).toBe(true);
      expect(isBlockedUrl('http://172.20.0.1/').blocked).toBe(true);
      expect(isBlockedUrl('http://172.31.255.255/').blocked).toBe(true);
      // 172.15 should NOT be blocked (not in range)
      expect(isBlockedUrl('http://172.15.0.1/').blocked).toBe(false);
      // 172.32 should NOT be blocked (not in range)
      expect(isBlockedUrl('http://172.32.0.1/').blocked).toBe(false);
    });

    test('blocks 192.168.x.x', () => {
      const result = isBlockedUrl('http://192.168.1.1/');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Private IP (192.168.x.x)');
    });
  });

  describe('special IPv4 addresses', () => {
    test('blocks loopback 127.x.x.x', () => {
      expect(isBlockedUrl('http://127.0.0.1/').blocked).toBe(true);
      expect(isBlockedUrl('http://127.0.0.1:8080/').blocked).toBe(true);
      expect(isBlockedUrl('http://127.255.255.255/').blocked).toBe(true);
    });

    test('blocks link-local 169.254.x.x', () => {
      expect(isBlockedUrl('http://169.254.1.1/').blocked).toBe(true);
    });

    test('blocks 0.0.0.0', () => {
      expect(isBlockedUrl('http://0.0.0.0/').blocked).toBe(true);
    });

    test('blocks broadcast 255.255.255.255', () => {
      expect(isBlockedUrl('http://255.255.255.255/').blocked).toBe(true);
    });
  });

  describe('IPv6 addresses', () => {
    test('blocks IPv6 loopback ::1', () => {
      const result = isBlockedUrl('http://[::1]/');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('IPv6 loopback');
    });

    test('blocks IPv6 link-local fe80::', () => {
      expect(isBlockedUrl('http://[fe80::1]/').blocked).toBe(true);
    });

    test('blocks IPv6 unique local fc00::/fd00::', () => {
      expect(isBlockedUrl('http://[fc00::1]/').blocked).toBe(true);
      expect(isBlockedUrl('http://[fd00::1]/').blocked).toBe(true);
    });

    // Note: IPv4-mapped addresses like ::ffff:10.0.0.1 get normalized by URL parser
    // to ::ffff:a00:1 (hex format), which we don't currently detect. This is a known
    // limitation - the direct IPv4 form (10.0.0.1) is blocked, just not the mapped form.
    test('allows normalized IPv4-mapped IPv6 (known limitation)', () => {
      // URL parser normalizes ::ffff:10.0.0.1 to ::ffff:a00:1
      const result = isBlockedUrl('http://[::ffff:10.0.0.1]/');
      // Currently not blocked due to normalization - document this behavior
      expect(result.blocked).toBe(false);
    });
  });

  describe('hostname variants', () => {
    test('blocks localhost', () => {
      expect(isBlockedUrl('http://localhost/').blocked).toBe(true);
      expect(isBlockedUrl('http://localhost:3000/').blocked).toBe(true);
    });

    test('blocks *.localhost subdomains', () => {
      expect(isBlockedUrl('http://api.localhost/').blocked).toBe(true);
      expect(isBlockedUrl('http://sub.api.localhost:8080/').blocked).toBe(true);
    });

    test('blocks .local TLD', () => {
      expect(isBlockedUrl('http://myserver.local/').blocked).toBe(true);
    });

    test('blocks .internal TLD', () => {
      expect(isBlockedUrl('http://api.internal/').blocked).toBe(true);
    });
  });

  describe('allowed URLs', () => {
    test('allows public domains', () => {
      expect(isBlockedUrl('https://api.example.com/').blocked).toBe(false);
      expect(isBlockedUrl('https://google.com/').blocked).toBe(false);
      expect(isBlockedUrl('https://github.com/api/v3').blocked).toBe(false);
    });

    test('allows public IPs', () => {
      expect(isBlockedUrl('http://8.8.8.8/').blocked).toBe(false);
      expect(isBlockedUrl('http://1.1.1.1/').blocked).toBe(false);
      expect(isBlockedUrl('http://93.184.216.34/').blocked).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('blocks invalid URLs', () => {
      const result = isBlockedUrl('not-a-url');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Invalid URL');
    });

    test('is case-insensitive for hostnames', () => {
      expect(isBlockedUrl('http://LOCALHOST/').blocked).toBe(true);
      expect(isBlockedUrl('http://Metadata.Google.Internal/').blocked).toBe(true);
    });
  });
});

describe('CLOUD_METADATA_HOSTS', () => {
  test('contains AWS metadata', () => {
    expect(CLOUD_METADATA_HOSTS.has('169.254.169.254')).toBe(true);
  });

  test('contains GCP metadata', () => {
    expect(CLOUD_METADATA_HOSTS.has('metadata.google.internal')).toBe(true);
    expect(CLOUD_METADATA_HOSTS.has('metadata.goog')).toBe(true);
  });
});
