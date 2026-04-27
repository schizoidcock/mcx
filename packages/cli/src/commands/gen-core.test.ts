import { describe, test, expect } from 'bun:test';
import {
  generateMethodName,
  detectContextParam,
  generateAdapter,
  capitalize,
  type ParsedEndpoint,
  type OpenAPIOperation,
} from './gen-core';

describe('generateMethodName', () => {
  const emptyOp: OpenAPIOperation = {};

  test('generates basic method names from path', () => {
    expect(generateMethodName('get', '/users', emptyOp)).toBe('getUsers');
    expect(generateMethodName('post', '/users', emptyOp)).toBe('createUsers');
    expect(generateMethodName('put', '/users', emptyOp)).toBe('updateUsers');
    expect(generateMethodName('delete', '/users', emptyOp)).toBe('deleteUsers');
  });

  test('handles nested paths', () => {
    expect(generateMethodName('get', '/api/v1/users', emptyOp)).toBe('getApiV1Users');
    expect(generateMethodName('get', '/projects/items', emptyOp)).toBe('getProjectsItems');
  });

  test('adds ByParamName suffix for path params', () => {
    expect(generateMethodName('get', '/users/{id}', emptyOp)).toBe('getUsersById');
    expect(generateMethodName('get', '/scripts/{script_name}', emptyOp)).toBe('getScriptsByScriptName');
    expect(generateMethodName('get', '/users/{user_id}/posts/{post_id}', emptyOp))
      .toBe('getUsersPostsByUserIdAndByPostId');
  });

  test('converts snake_case params to TitleCase in suffix', () => {
    expect(generateMethodName('get', '/items/{item_id}', emptyOp)).toBe('getItemsByItemId');
    expect(generateMethodName('get', '/projects/{project_id}', emptyOp)).toBe('getProjectsByProjectId');
  });

  test('converts kebab-case params to TitleCase in suffix', () => {
    expect(generateMethodName('get', '/items/{item-id}', emptyOp)).toBe('getItemsByItemId');
  });

  test('handles paths starting with method name', () => {
    // When path starts with method name, it returns as-is (lowercased first word)
    expect(generateMethodName('get', '/getUser', emptyOp)).toBe('getuser');
    expect(generateMethodName('delete', '/deleteItem', emptyOp)).toBe('deleteitem');
  });
});

describe('capitalize', () => {
  test('capitalizes first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
    expect(capitalize('world')).toBe('World');
  });

  test('handles single char', () => {
    expect(capitalize('a')).toBe('A');
  });

  test('handles empty string', () => {
    expect(capitalize('')).toBe('');
  });

  test('preserves rest of string', () => {
    expect(capitalize('hELLO')).toBe('HELLO');
  });
});

describe('detectContextParam', () => {
  test('returns null for too few endpoints', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/projects/{project_id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/items', method: 'get', operation: {}, methodName: 'get', category: 'general' },
    ];
    expect(detectContextParam(endpoints)).toBeNull();
  });

  test('detects common param appearing in >= 50% of endpoints', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/projects/{project_id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/items', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/settings', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/users', method: 'get', operation: {}, methodName: 'get', category: 'general' },
    ];
    const result = detectContextParam(endpoints);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('project_id');
    expect(result?.camelName).toBe('projectId');
    expect(result?.titleName).toBe('ProjectId');
  });

  test('skips generic params like {id}', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/items/{id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/users/{id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/posts/{id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
    ];
    expect(detectContextParam(endpoints)).toBeNull();
  });

  test('skips short params', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/items/{xy}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/users/{xy}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/posts/{xy}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
    ];
    expect(detectContextParam(endpoints)).toBeNull();
  });

  test('returns most common param when multiple candidates', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/projects/{project_id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/items', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/users/{user_id}', method: 'get', operation: {}, methodName: 'get', category: 'general' },
      { path: '/projects/{project_id}/settings', method: 'get', operation: {}, methodName: 'get', category: 'general' },
    ];
    const result = detectContextParam(endpoints);
    expect(result?.name).toBe('project_id');
    expect(result?.count).toBe(4);
  });
});

describe('generateAdapter', () => {
  test('generates adapter with encodeURIComponent for path params', () => {
    const endpoints: ParsedEndpoint[] = [
      {
        path: '/scripts/{script_name}',
        method: 'get',
        operation: {
          parameters: [{ name: 'script_name', in: 'path', required: true }],
        },
        methodName: 'getScriptsByScriptName',
        category: 'general',
      },
    ];

    const code = generateAdapter('test', endpoints, 'https://api.example.com');

    // Should use encodeURIComponent for path params
    expect(code).toContain('encodeURIComponent');
    expect(code).toContain('String(params.script_name)');
  });

  test('generates valid adapter structure', () => {
    const endpoints: ParsedEndpoint[] = [
      {
        path: '/users',
        method: 'get',
        operation: { summary: 'List users' },
        methodName: 'getUsers',
        category: 'general',
      },
    ];

    const code = generateAdapter('myApi', endpoints, 'https://api.example.com');

    expect(code).toContain('export const myApi');
    expect(code).toContain("name: 'myApi'");
    expect(code).toContain('getUsers:');
    expect(code).toContain('https://api.example.com');
  });

  test('escapes special characters in baseUrl', () => {
    const endpoints: ParsedEndpoint[] = [
      {
        path: '/test',
        method: 'get',
        operation: {},
        methodName: 'getTest',
        category: 'general',
      },
    ];

    // baseUrl with special chars should be escaped
    const code = generateAdapter('test', endpoints, "https://api.example.com/v1's");
    expect(code).toContain("\\'s"); // Single quote should be escaped
  });

  test('handles bearer auth', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/test', method: 'get', operation: {}, methodName: 'getTest', category: 'general' },
    ];

    const code = generateAdapter('test', endpoints, 'https://api.example.com', { type: 'bearer' });
    expect(code).toContain('Authorization');
    expect(code).toContain('Bearer');
  });

  test('handles apiKey auth', () => {
    const endpoints: ParsedEndpoint[] = [
      { path: '/test', method: 'get', operation: {}, methodName: 'getTest', category: 'general' },
    ];

    const code = generateAdapter('test', endpoints, 'https://api.example.com', {
      type: 'apiKey',
      headerName: 'X-API-Key',
    });
    expect(code).toContain('X-API-Key');
  });

  test('throws on invalid adapter name', () => {
    const endpoints: ParsedEndpoint[] = [];
    expect(() => generateAdapter('invalid-name', endpoints, 'https://api.example.com'))
      .toThrow('Invalid adapter name');
    expect(() => generateAdapter('123invalid', endpoints, 'https://api.example.com'))
      .toThrow('Invalid adapter name');
  });
});
