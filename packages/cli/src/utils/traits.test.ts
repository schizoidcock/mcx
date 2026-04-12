import { describe, it, expect } from 'bun:test';
import { analyzeCodeTraits, analyzeShellTraits, formatTraitWarnings } from './traits';

describe('analyzeCodeTraits', () => {
  describe('destructive', () => {
    it('detects fs.unlinkSync', () => {
      const result = analyzeCodeTraits('fs.unlinkSync("file.txt")', 'javascript');
      expect(result.traits).toContain('destructive');
    });

    it('detects rimraf', () => {
      const result = analyzeCodeTraits('await rimraf("./dist")', 'javascript');
      expect(result.traits).toContain('destructive');
    });

    it('ignores Map.delete()', () => {
      const result = analyzeCodeTraits('myMap.delete("key")', 'javascript');
      expect(result.traits).not.toContain('destructive');
    });

    it('ignores Set.delete()', () => {
      const result = analyzeCodeTraits('mySet.delete(item)', 'javascript');
      expect(result.traits).not.toContain('destructive');
    });

    it('ignores DELETE in string literals', () => {
      const result = analyzeCodeTraits('const sql = "SELECT * FROM users WHERE id = 1"', 'javascript');
      expect(result.traits).not.toContain('destructive');
    });

    it('detects SQL DELETE in query', () => {
      const result = analyzeCodeTraits('db.execute("DELETE FROM users WHERE id = 1")', 'javascript');
      expect(result.traits).toContain('destructive');
    });

    it('detects fs.rmSync', () => {
      const result = analyzeCodeTraits('fs.rmSync("./build", { recursive: true })', 'javascript');
      expect(result.traits).toContain('destructive');
    });

    it('detects DROP TABLE', () => {
      const result = analyzeCodeTraits('db.query("DROP TABLE users")', 'javascript');
      expect(result.traits).toContain('destructive');
    });
  });

  describe('external', () => {
    it('detects fetch() with URL', () => {
      const result = analyzeCodeTraits('const res = await fetch("https://api.example.com/data")', 'javascript');
      expect(result.traits).toContain('external');
    });

    it('detects axios.get', () => {
      const result = analyzeCodeTraits('const data = await axios.get("https://api.example.com")', 'javascript');
      expect(result.traits).toContain('external');
    });

    it('ignores URL in console.log', () => {
      const result = analyzeCodeTraits('console.log("Visit https://example.com")', 'javascript');
      expect(result.traits).not.toContain('external');
    });

    it('detects http.get', () => {
      const result = analyzeCodeTraits('http.get("http://example.com", callback)', 'javascript');
      expect(result.traits).toContain('external');
    });

    it('detects axios.post', () => {
      const result = analyzeCodeTraits('await axios.post("/api/endpoint", data)', 'javascript');
      expect(result.traits).toContain('external');
    });
  });

  describe('slow', () => {
    it('detects await in forEach', () => {
      const result = analyzeCodeTraits(
        'items.forEach(async (item) => { await processItem(item); })',
        'javascript',
      );
      expect(result.traits).toContain('slow');
    });

    it('detects await in for loop', () => {
      const result = analyzeCodeTraits(
        'for (let i = 0; i < items.length; i++) { await processItem(items[i]); }',
        'javascript',
      );
      expect(result.traits).toContain('slow');
    });

    it('detects puppeteer', () => {
      const result = analyzeCodeTraits(
        'const browser = await puppeteer.launch(); const page = await browser.newPage();',
        'javascript',
      );
      expect(result.traits).toContain('slow');
    });

    it('detects playwright', () => {
      const result = analyzeCodeTraits(
        'const browser = await chromium.launch();',
        'javascript',
      );
      expect(result.traits).toContain('slow');
    });
  });

  describe('stateful', () => {
    it('detects WebSocket', () => {
      const result = analyzeCodeTraits('const ws = new WebSocket("wss://example.com")', 'javascript');
      expect(result.traits).toContain('stateful');
    });

    it('detects setInterval', () => {
      const result = analyzeCodeTraits('setInterval(() => poll(), 5000)', 'javascript');
      expect(result.traits).toContain('stateful');
    });

    it('detects createConnection', () => {
      const result = analyzeCodeTraits('const conn = net.createConnection({ port: 3000 })', 'javascript');
      expect(result.traits).toContain('stateful');
    });

    it('detects EventEmitter', () => {
      const result = analyzeCodeTraits('const emitter = new EventEmitter()', 'javascript');
      expect(result.traits).toContain('stateful');
    });
  });

  describe('preprocessing', () => {
    it('ignores patterns in comments', () => {
      const result = analyzeCodeTraits(
        '// fs.unlinkSync("file.txt") - do not use this',
        'javascript',
      );
      expect(result.traits).not.toContain('destructive');
    });

    it('ignores patterns in block comments', () => {
      const result = analyzeCodeTraits(
        '/* rimraf("./dist") is dangerous */',
        'javascript',
      );
      expect(result.traits).not.toContain('destructive');
    });

    it('respects @mcx-ignore directive', () => {
      const result = analyzeCodeTraits(
        '// @mcx-ignore\nfs.unlinkSync("file.txt")',
        'javascript',
      );
      expect(result.traits).not.toContain('destructive');
    });

    it('respects @mcx-ignore on same line', () => {
      const result = analyzeCodeTraits(
        'fs.unlinkSync("file.txt") // @mcx-ignore',
        'javascript',
      );
      expect(result.traits).not.toContain('destructive');
    });
  });
});

describe('analyzeShellTraits', () => {
  describe('destructive', () => {
    it('detects rm -rf', () => {
      const result = analyzeShellTraits('rm -rf ./dist');
      expect(result.traits).toContain('destructive');
    });

    it('detects git reset --hard', () => {
      const result = analyzeShellTraits('git reset --hard HEAD~1');
      expect(result.traits).toContain('destructive');
    });

    it('detects git push --force', () => {
      const result = analyzeShellTraits('git push origin main --force');
      expect(result.traits).toContain('destructive');
    });

    it('detects git push -f', () => {
      const result = analyzeShellTraits('git push -f origin main');
      expect(result.traits).toContain('destructive');
    });

    it('detects dd command', () => {
      const result = analyzeShellTraits('dd if=/dev/zero of=/dev/sda');
      expect(result.traits).toContain('destructive');
    });
  });

  describe('slow', () => {
    it('detects npm install', () => {
      const result = analyzeShellTraits('npm install express');
      expect(result.traits).toContain('slow');
    });

    it('detects docker build', () => {
      const result = analyzeShellTraits('docker build -t myapp .');
      expect(result.traits).toContain('slow');
    });

    it('detects git clone', () => {
      const result = analyzeShellTraits('git clone https://github.com/user/repo.git');
      expect(result.traits).toContain('slow');
    });

    it('detects bun install', () => {
      const result = analyzeShellTraits('bun install');
      expect(result.traits).toContain('slow');
    });

    it('detects yarn install', () => {
      const result = analyzeShellTraits('yarn install');
      expect(result.traits).toContain('slow');
    });
  });

  describe('external', () => {
    it('detects curl', () => {
      const result = analyzeShellTraits('curl https://api.example.com/data');
      expect(result.traits).toContain('external');
    });

    it('detects ssh', () => {
      const result = analyzeShellTraits('ssh user@remote-server.com');
      expect(result.traits).toContain('external');
    });

    it('detects aws cli', () => {
      const result = analyzeShellTraits('aws s3 cp file.txt s3://bucket/');
      expect(result.traits).toContain('external');
    });

    it('detects wget', () => {
      const result = analyzeShellTraits('wget https://example.com/file.zip');
      expect(result.traits).toContain('external');
    });
  });

  describe('stateful', () => {
    it('detects background process', () => {
      const result = analyzeShellTraits('node server.js &');
      expect(result.traits).toContain('stateful');
    });

    it('detects nohup', () => {
      const result = analyzeShellTraits('nohup node server.js > server.log 2>&1 &');
      expect(result.traits).toContain('stateful');
    });

    it('detects docker run', () => {
      const result = analyzeShellTraits('docker run -d -p 3000:3000 myapp');
      expect(result.traits).toContain('stateful');
    });

    it('detects pm2 start', () => {
      const result = analyzeShellTraits('pm2 start server.js');
      expect(result.traits).toContain('stateful');
    });
  });
});

describe('formatTraitWarnings', () => {
  it('formats multiple warnings', () => {
    const analysis = {
      traits: ['destructive', 'slow'] as ('destructive' | 'slow')[],
      warnings: [
        { trait: 'destructive' as const, patterns: ['trash-cli'], suggestion: 'Moves files to trash' },
        { trait: 'slow' as const, patterns: ['eslint-offline'], suggestion: 'May take time' },
      ],
      severity: 'caution' as const,
      summary: '2 warnings',
    };
    const output = formatTraitWarnings(analysis);
    expect(output).toContain('🔴');
    expect(output).toContain('destructive');
    expect(output).toContain('slow');
    expect(output).toContain('trash-cli');
  });

  it('returns empty string for no warnings', () => {
    const analysis = {
      traits: [],
      warnings: [],
      severity: 'info' as const,
      summary: 'No warnings',
    };
    const output = formatTraitWarnings(analysis);
    expect(output).toBe('');
  });

  it('uses correct severity icons', () => {
    const warning = formatTraitWarnings({
      traits: ['slow'],
      warnings: [{ trait: 'slow' as const, patterns: ['npm'], suggestion: 'Use cache' }],
      severity: 'warning' as const,
      summary: '1 warning',
    });
    expect(warning).toContain('⚠️');

    const info = formatTraitWarnings({
      traits: ['external'],
      warnings: [{ trait: 'external' as const, patterns: ['fetch'], suggestion: 'Network call' }],
      severity: 'info' as const,
      summary: '1 info',
    });
    expect(info).toContain('💡');
  });

  it('includes suggestion in output', () => {
    const analysis = {
      traits: ['destructive'] as ('destructive')[],
      warnings: [
        { trait: 'destructive' as const, patterns: ['unlinkSync'], suggestion: 'This will permanently delete the file' },
      ],
      severity: 'caution' as const,
      summary: '1 warning',
    };
    const output = formatTraitWarnings(analysis);
    expect(output).toContain('permanently delete');
  });
});

describe('edge cases', () => {
  it('handles empty code', () => {
    const result = analyzeCodeTraits('', 'javascript');
    expect(result.traits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles code with only comments', () => {
    const result = analyzeCodeTraits('// just a comment', 'javascript');
    expect(result.traits).toEqual([]);
  });

  it('handles very long code without timeout', () => {
    const longCode = 'const x = 1;\n'.repeat(10000);
    const start = Date.now();
    const result = analyzeCodeTraits(longCode, 'javascript');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result.traits).toEqual([]);
  });

  it('does not ReDoS on adversarial input', () => {
    // A string designed to trigger catastrophic backtracking in naive regexes
    const adversarial = 'a'.repeat(50) + '.forEach(' + 'a'.repeat(50);
    const start = Date.now();
    analyzeCodeTraits(adversarial, 'javascript');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('handles shell with empty string', () => {
    const result = analyzeShellTraits('');
    expect(result.traits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles multiple traits in one snippet', () => {
    const code = [
      'const ws = new WebSocket("wss://example.com");',
      'fs.unlinkSync("temp.txt");',
      'await axios.get("https://api.example.com");',
    ].join('\n');
    const result = analyzeCodeTraits(code, 'javascript');
    expect(result.traits).toContain('stateful');
    expect(result.traits).toContain('destructive');
    expect(result.traits).toContain('external');
  });
});
