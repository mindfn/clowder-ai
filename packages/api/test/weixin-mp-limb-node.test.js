import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { PluginLimbAdapter } from '../dist/domains/limb/PluginLimbAdapter.js';
import { createWeixinMpHandlers } from '../dist/plugins/weixin-mp/index.js';

const WEIXIN_MP_LIMB_PATH = fileURLToPath(new URL('../src/plugins/weixin-mp/limbs/weixin-mp.yml', import.meta.url));

describe('PluginLimbAdapter (weixin-mp)', () => {
  it('declares publish commands with an invokable auth level', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const registry = new LimbRegistry();
    registry.setDeps({
      accessPolicy: new LimbAccessPolicy(),
      leaseManager: new LimbLeaseManager(),
      actionLog: new LimbActionLog(),
    });
    const calls = [];
    await registry.register({
      nodeId: declaration.nodeId,
      displayName: declaration.displayName,
      platform: declaration.platform,
      capabilities: declaration.capabilities,
      invoke: async (command) => {
        calls.push(command);
        return { success: true };
      },
    });

    const draft = await registry.invoke(declaration.nodeId, 'weixin_mp.create_draft', {}, { catId: 'codex' });
    const upload = await registry.invoke(declaration.nodeId, 'weixin_mp.upload_image', {}, { catId: 'codex' });

    assert.equal(draft.success, true);
    assert.equal(upload.success, true);
    assert.deepEqual(calls, ['weixin_mp.create_draft', 'weixin_mp.upload_image']);
    const publishCap = declaration.capabilities.find((cap) => cap.cap === 'content_publish');
    assert.equal(publishCap?.authLevel, 'leased');
  });

  it('returns error for unknown commands', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
    });

    const result = await adapter.invoke('weixin_mp.nonexistent', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Unknown command/);
  });

  it('validates required params before execution', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
    });

    // submit_publish still has required params (mediaId)
    const result = await adapter.invoke('weixin_mp.submit_publish', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Missing required params.*mediaId/);
  });

  it('routes invoke commands to registered handlers', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const handlers = {
      'weixin-mp:convert_markdown': async (params) => ({
        success: true,
        data: { html: `<p>${params.markdown}</p>` },
      }),
    };
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });

    const result = await adapter.invoke('weixin_mp.convert_markdown', { markdown: 'hello' });
    assert.equal(result.success, true);
    assert.equal(result.data.html, '<p>hello</p>');
  });

  it('loads YAML with auth, error, and command type fields', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);

    assert.ok(decl.auth);
    assert.equal(decl.auth.type, 'client_credentials');
    assert.equal(decl.auth.tokenPlacement, 'query');
    assert.deepEqual(decl.auth.tokenExpiredCodes, [40001, 40014, 42001]);

    assert.ok(decl.error);
    assert.equal(decl.error.codePath, 'errcode');

    assert.equal(decl.commands['weixin_mp.check_status']?.type, 'invoke');
    assert.equal(decl.commands['weixin_mp.create_draft']?.type, 'invoke');
    assert.equal(decl.commands['weixin_mp.list_drafts']?.type, 'rest');
    assert.equal(decl.commands['weixin_mp.list_drafts']?.endpoint, '/draft/batchget');
  });

  it('refreshes upload tokens after WeChat token-expired errors', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const uploadUrls = [];
    let tokenCalls = 0;
    let invalidateCalls = 0;
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => ({
        contentType: 'image/png',
        body: Buffer.from('png'),
      }),
      uploadFormData: async (url) => {
        uploadUrls.push(url);
        if (uploadUrls.length === 1) {
          return { errcode: 40001, errmsg: 'invalid credential' };
        }
        return { errcode: 0, url: 'https://mmbiz.qpic.cn/fresh.png' };
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? 'stale-token' : 'fresh-token';
      },
      invalidateAccessToken: async () => {
        invalidateCalls += 1;
      },
      isTokenExpiredError: (code) => code === 40001,
    };

    const result = await adapter.invoke('weixin_mp.upload_image', { uri: 'https://example.com/image.png' });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.data, { url: 'https://mmbiz.qpic.cn/fresh.png' });
    assert.equal(invalidateCalls, 1);
    assert.equal(tokenCalls, 2);
    assert.match(uploadUrls[0], /access_token=stale-token/);
    assert.match(uploadUrls[1], /access_token=fresh-token/);
  });
});

// ─── Upload with unified uri param ──────────────────────────

describe('upload_image / upload_material with uri param', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUploadAdapter(uploadResults) {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const uploadUrls = [];
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => {
        throw new Error('should not fetch URL when local path is provided');
      },
      uploadFormData: async (url) => {
        uploadUrls.push(url);
        return uploadResults;
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };
    return { adapter, uploadUrls };
  }

  it('uploads image from local file path via uri', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const imgPath = join(tmpDir, 'test.png');
    await writeFile(imgPath, Buffer.from('fake-png-bytes'));

    const { adapter } = makeUploadAdapter({ errcode: 0, url: 'https://mmbiz.qpic.cn/local.png' });
    const result = await adapter.invoke('weixin_mp.upload_image', { uri: imgPath });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.url, 'https://mmbiz.qpic.cn/local.png');
  });

  it('uploads material from local file path via uri', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const imgPath = join(tmpDir, 'cover.jpg');
    await writeFile(imgPath, Buffer.from('fake-jpg-bytes'));

    const { adapter } = makeUploadAdapter({ errcode: 0, media_id: 'mid_123', url: 'https://mmbiz.qpic.cn/cover.jpg' });
    const result = await adapter.invoke('weixin_mp.upload_material', { uri: imgPath });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'mid_123');
  });

  it('returns error when uri not provided', async () => {
    const { adapter } = makeUploadAdapter({});
    const result = await adapter.invoke('weixin_mp.upload_image', {});

    assert.equal(result.success, false);
    assert.match(result.error, /uri/);
  });

  it('returns error for unsupported file extension', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const badPath = join(tmpDir, 'doc.pdf');
    await writeFile(badPath, Buffer.from('fake-pdf'));

    const { adapter } = makeUploadAdapter({});
    const result = await adapter.invoke('weixin_mp.upload_image', { uri: badPath });
    assert.equal(result.success, false);
    assert.match(result.error, /Unsupported image extension.*\.pdf/);
  });

  it('YAML declares uri param for upload commands', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const imgParams = decl.commands['weixin_mp.upload_image']?.params;
    const matParams = decl.commands['weixin_mp.upload_material']?.params;

    assert.ok(imgParams.uri, 'upload_image should have uri param');
    assert.ok(matParams.uri, 'upload_material should have uri param');
    assert.equal(imgParams.uri.required, true, 'uri should be required');
  });
});

// ─── Content file path tests ────────────────────────────────

describe('convert_markdown / create_draft with file path params', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function makeContentAdapter(jsonPostResults) {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const postBodies = [];
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => {
        throw new Error('unused');
      },
      uploadFormData: async () => {
        throw new Error('unused');
      },
      jsonPost: async (_url, body) => {
        postBodies.push(body);
        return jsonPostResults;
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };
    return { adapter, postBodies };
  }

  it('converts markdown from a local file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-md-'));
    const mdPath = join(tmpDir, 'article.md');
    await writeFile(mdPath, '# Hello\n\nWorld', 'utf-8');

    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.convert_markdown', { markdownFilePath: mdPath });

    assert.equal(result.success, true, result.error);
    assert.ok(result.data.html.includes('Hello'), 'HTML should contain heading text');
  });

  it('returns error when neither markdown nor markdownFilePath provided', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.convert_markdown', {});

    assert.equal(result.success, false);
    assert.match(result.error, /markdown or markdownFilePath is required/);
  });

  it('creates draft with inline content', async () => {
    const { adapter, postBodies } = makeContentAdapter({ errcode: 0, media_id: 'draft_001' });
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'Test Article',
      content: '<p>Hello</p>',
      thumbMediaId: 'thumb_001',
      author: 'Cat',
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'draft_001');
    assert.equal(postBodies[0].articles[0].title, 'Test Article');
    assert.equal(postBodies[0].articles[0].content, '<p>Hello</p>');
    assert.equal(postBodies[0].articles[0].author, 'Cat');
  });

  it('creates draft from a local HTML file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-draft-'));
    const htmlPath = join(tmpDir, 'article.html');
    await writeFile(htmlPath, '<section>Long article content here</section>', 'utf-8');

    const { adapter, postBodies } = makeContentAdapter({ errcode: 0, media_id: 'draft_002' });
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'File Article',
      contentFilePath: htmlPath,
      thumbMediaId: 'thumb_002',
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'draft_002');
    assert.ok(postBodies[0].articles[0].content.includes('Long article content'));
  });

  it('returns error when neither content nor contentFilePath provided', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'No Content',
      thumbMediaId: 'thumb_003',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /content or contentFilePath is required/);
  });

  it('returns error when required draft params missing', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.create_draft', {
      content: '<p>test</p>',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /title.*thumbMediaId/);
  });

  it('YAML declares file path params for content commands', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const mdParams = decl.commands['weixin_mp.convert_markdown']?.params;
    const draftParams = decl.commands['weixin_mp.create_draft']?.params;

    assert.ok(mdParams.markdownFilePath, 'convert_markdown should have markdownFilePath param');
    assert.ok(draftParams.contentFilePath, 'create_draft should have contentFilePath param');
    assert.equal(draftParams.content?.required, undefined, 'content should not be required');
  });
});
